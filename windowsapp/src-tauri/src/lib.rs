use std::sync::{Arc, Mutex};
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
use tauri::Manager;

const CREDENTIAL_SERVICE: &str = "in.trade-matangi.desktop-charts";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";
// An explicit target avoids a derived Windows Credential Manager name that
// can be unavailable to an installed NSIS application after sign-in.
const CREDENTIAL_TARGET: &str = "TradeMatangi.Desktop.Session";

/// A small, token-free diagnostic trail for installed Windows builds.  It is
/// intentionally kept outside the keyring and never includes credentials,
/// URLs, request bodies, or server responses.
fn diagnostic_log(message: &str) {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else { return };
    let directory = PathBuf::from(local_app_data).join("Trade Matangi Charts").join("logs");
    if fs::create_dir_all(&directory).is_err() { return; }
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or(0);
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(directory.join("desktop.log")) {
        let _ = writeln!(file, "{seconds} {message}");
    }
}

#[derive(Serialize, Deserialize)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

#[derive(Serialize)]
pub struct QueuedMutation {
    id: i64,
    kind: String,
    payload: String,
}

#[derive(Clone, Serialize)]
pub struct HostSnapshot {
    last_event_id: u64,
    latest_payload: String,
    connection: String,
}

fn credentials() -> Result<keyring::Entry, String> {
    keyring::Entry::new_with_target(CREDENTIAL_TARGET, CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|error| error.to_string())
}

/// Preserve sign-in on upgrade from releases using keyring's derived target.
fn legacy_credentials() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|error| error.to_string())
}

fn tokens_from(entry: keyring::Entry) -> Result<TokenBundle, keyring::Error> {
    let raw = entry.get_password()?;
    serde_json::from_str(&raw).map_err(|error| keyring::Error::BadEncoding(error.to_string().into_bytes()))
}

fn stored_tokens() -> Result<TokenBundle, String> {
    match tokens_from(credentials()?) {
        Ok(tokens) => { diagnostic_log("credential read: explicit target"); Ok(tokens) },
        Err(keyring::Error::NoEntry) => {
            diagnostic_log("credential read: explicit target absent; trying legacy target");
            tokens_from(legacy_credentials()?).map_err(|error| {
                diagnostic_log(&format!("credential read: legacy target failed: {error}"));
                error.to_string()
            })
        }
        Err(error) => { diagnostic_log(&format!("credential read: explicit target failed: {error}")); Err(error.to_string()) },
    }
}

async fn authenticate(base_url: &str, email: &str, password: &str) -> Result<TokenBundle, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/desktop/token", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "email": email, "password": password, "device_name": "Trade Matangi Desktop" }))
        .send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err("Login failed: check your email and password".into()); }
    response.json::<TokenBundle>().await.map_err(|error| error.to_string())
}

/// Tokens stay in the Windows Credential Manager through the OS keyring.
/// The WebView can ask the host to perform a refresh but never reads refresh
/// credentials or writes them to a config/store file.
#[tauri::command]
fn save_desktop_tokens(tokens: TokenBundle) -> Result<(), String> {
    let encoded = serde_json::to_string(&tokens).map_err(|error| error.to_string())?;
    let entry = credentials()?;
    diagnostic_log("credential write: starting");
    entry.set_password(&encoded).map_err(|error| {
        diagnostic_log(&format!("credential write: failed: {error}"));
        format!("Windows Credential Manager could not save the desktop session: {error}")
    })?;
    // Fail sign-in immediately if Windows did not make this entry readable to
    // this installed application, rather than failing later while loading data.
    let saved = entry.get_password().map_err(|error| {
        diagnostic_log(&format!("credential write verification: failed: {error}"));
        format!("Windows Credential Manager did not retain the desktop session: {error}")
    })?;
    if saved != encoded {
        diagnostic_log("credential write verification: value mismatch");
        return Err("Windows Credential Manager did not retain the desktop session. Remove the Trade Matangi credential in Credential Manager and sign in again.".into());
    }
    diagnostic_log("credential write verification: success");
    Ok(())
}

#[tauri::command]
fn clear_desktop_tokens() -> Result<(), String> {
    for entry in [credentials()?, legacy_credentials()?] {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
async fn desktop_login(base_url: String, email: String, password: String, host: tauri::State<'_, HostState>) -> Result<(), String> {
    let tokens = authenticate(&base_url, &email, &password).await?;
    save_desktop_tokens(tokens)?;
    host.set_connection("connected");
    Ok(())
}

#[tauri::command]
async fn desktop_connection_state(base_url: String, host: tauri::State<'_, HostState>) -> Result<String, String> {
    let host = host.inner().clone();
    let token = match stored_tokens() { Ok(tokens) => tokens.access_token, Err(_) => return Ok("authentication_required".into()) };
    let result = reqwest::Client::new().get(format!("{}/api/desktop/v1/capabilities", base_url.trim_end_matches('/'))).bearer_auth(token).send().await;
    let state = match result { Ok(response) if response.status().is_success() => "connected", Ok(response) if response.status().as_u16() == 401 => "authentication_required", _ => "offline" };
    host.set_connection(state);
    Ok(state.into())
}

#[tauri::command]
async fn desktop_historical_page(base_url: String, symbol: String, trading_date: String, interval_minutes: u32) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let response = reqwest::Client::new()
        .get(format!("{}/api/desktop/v1/historical/pages", base_url.trim_end_matches('/')))
        .bearer_auth(token)
        .query(&[("symbol", symbol), ("trading_date", trading_date), ("interval_minutes", interval_minutes.to_string()), ("context_days", "5".into())])
        .send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("History request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

async fn desktop_get(base_url: String, path: &str, query: Vec<(&str, String)>) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let response = reqwest::Client::new()
        .get(format!("{}/api/desktop/v1/{}", base_url.trim_end_matches('/'), path))
        .bearer_auth(token).query(&query).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Desktop request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_catalogue(base_url: String) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "catalogue", vec![]).await
}

#[tauri::command]
async fn desktop_option_metadata(base_url: String, symbol: String, as_of_date: String) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "option-metadata", vec![("symbol", symbol), ("as_of_date", as_of_date)]).await
}

#[tauri::command]
async fn desktop_option_historical_page(base_url: String, symbol: String, trading_date: String, expiry: String, strike: u32, right: String, interval_minutes: u32) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "options/historical/pages", vec![
        ("symbol", symbol), ("trading_date", trading_date), ("expiry", expiry),
        ("strike", strike.to_string()), ("right", right),
        ("interval_minutes", interval_minutes.to_string()), ("context_days", "5".into()),
    ]).await
}

#[tauri::command]
async fn desktop_chart_settings(base_url: String) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "chart-settings", vec![]).await
}

#[tauri::command]
async fn save_desktop_chart_settings(base_url: String, settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let response = reqwest::Client::new().put(format!("{}/api/desktop/v1/chart-settings", base_url.trim_end_matches('/')))
        .bearer_auth(token).json(&serde_json::json!({"settings": settings})).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Settings request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_replay_request(base_url: String, path: String, method: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let url = format!("{}/api/desktop/v1/replay/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
    let client = reqwest::Client::new();
    let request = match method.as_str() {
        "GET" => client.get(url), "POST" => client.post(url).json(&body), _ => return Err("Unsupported replay request".into()),
    };
    let response = request.bearer_auth(token).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Replay request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_live_request(base_url: String, path: String, method: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let url = format!("{}/api/desktop/v1/live/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
    let client = reqwest::Client::new();
    let request = match method.as_str() {
        "GET" => client.get(url), "POST" => client.post(url).json(&body), "PUT" => client.put(url).json(&body), _ => return Err("Unsupported live request".into()),
    };
    let response = request.bearer_auth(token).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Live request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_drawing_request(base_url: String, path: String, method: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = stored_tokens()?.access_token;
    let url = format!("{}/api/desktop/v1/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
    let client = reqwest::Client::new();
    let request = match method.as_str() { "GET" => client.get(url), "POST" => client.post(url).json(&body), "PUT" => client.put(url).json(&body), "DELETE" => client.delete(url).json(&body), _ => return Err("Unsupported drawing request".into()) };
    let response = request.bearer_auth(token).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err(format!("Drawing request failed ({})", response.status())); }
    response.json::<serde_json::Value>().await.map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_logout(host: tauri::State<HostState>) -> Result<(), String> {
    clear_desktop_tokens()?;
    host.set_connection("authentication_required");
    Ok(())
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("desktop-cache.sqlite3"))
}

fn cache(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let connection = rusqlite::Connection::open(cache_path(app)?).map_err(|error| error.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS offline_mutations (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

/// Queue a screen/drawing write while offline. The server remains authoritative
/// and will reconcile by mutation ID and revision after reconnect.
#[tauri::command]
fn queue_offline_mutation(app: tauri::AppHandle, kind: String, payload: String) -> Result<i64, String> {
    let connection = cache(&app)?;
    connection.execute("INSERT INTO offline_mutations (kind, payload) VALUES (?1, ?2)", [&kind, &payload]).map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

#[tauri::command]
fn pending_offline_mutations(app: tauri::AppHandle) -> Result<Vec<QueuedMutation>, String> {
    let connection = cache(&app)?;
    let mut statement = connection.prepare("SELECT id, kind, payload FROM offline_mutations ORDER BY id").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok(QueuedMutation { id: row.get(0)?, kind: row.get(1)?, payload: row.get(2)? }))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn acknowledge_offline_mutation(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    cache(&app)?.execute("DELETE FROM offline_mutations WHERE id = ?1", [id]).map_err(|error| error.to_string())?;
    Ok(())
}

/// Durable native state: it continues receiving stream events with no WebView listener.
#[derive(Default, Clone)]
pub struct HostState(Arc<Mutex<LatestState>>);
#[derive(Default)]
struct LatestState { last_event_id: u64, latest_payload: String, connection: String }

impl HostState {
    pub fn record(&self, event_id: u64, payload: String) {
        let mut state = self.0.lock().expect("host state lock");
        if event_id > state.last_event_id { state.last_event_id = event_id; state.latest_payload = payload; }
    }
    fn snapshot(&self) -> HostSnapshot {
        let state = self.0.lock().expect("host state lock");
        HostSnapshot { last_event_id: state.last_event_id, latest_payload: state.latest_payload.clone(), connection: state.connection.clone() }
    }
    fn set_connection(&self, connection: &str) { self.0.lock().expect("host state lock").connection = connection.into(); }
}

#[tauri::command]
fn host_snapshot(host: tauri::State<HostState>) -> HostSnapshot { host.snapshot() }

#[tauri::command]
async fn start_sse_subscription(url: String, host: tauri::State<'_, HostState>) -> Result<(), String> {
    let host = host.inner().clone();
    let access_token = stored_tokens()?.access_token;
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut backoff = 1_u64;
        loop {
            host.set_connection("reconnecting");
            let mut request = client.get(&url).bearer_auth(&access_token).header("Accept", "text/event-stream");
            let event_id = host.snapshot().last_event_id;
            if event_id > 0 { request = request.header("Last-Event-ID", event_id.to_string()); }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    host.set_connection("connected"); backoff = 1;
                    let mut stream = response.bytes_stream(); let mut buffer = String::new();
                    while let Some(Ok(bytes)) = stream.next().await {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(end) = buffer.find("\n\n") {
                            let frame = buffer[..end].to_string(); buffer = buffer[end + 2..].to_string();
                            let id = frame.lines().find_map(|line| line.strip_prefix("id: ")).and_then(|id| id.parse().ok());
                            let data = frame.lines().find_map(|line| line.strip_prefix("data: "));
                            if let (Some(id), Some(data)) = (id, data) { host.record(id, data.into()); }
                        }
                    }
                }
                _ => host.set_connection("offline"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(HostState::default())
        .invoke_handler(tauri::generate_handler![save_desktop_tokens, clear_desktop_tokens, desktop_login, desktop_connection_state, desktop_historical_page, desktop_catalogue, desktop_option_metadata, desktop_option_historical_page, desktop_chart_settings, save_desktop_chart_settings, desktop_replay_request, desktop_live_request, desktop_drawing_request, desktop_logout, queue_offline_mutation, pending_offline_mutations, acknowledge_offline_mutation, host_snapshot, start_sse_subscription])
        .run(tauri::generate_context!())
        .expect("tauri application error");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fake_sse_updates_host_state_without_a_webview_listener() {
        let host = HostState::default();
        host.record(1, "first".into()); host.record(2, "second".into()); host.record(1, "stale".into());
        let state = host.0.lock().unwrap();
        assert_eq!(state.last_event_id, 2); assert_eq!(state.latest_payload, "second");
    }
}
