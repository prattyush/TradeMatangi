use std::sync::{Arc, Mutex};
use std::{fs, path::PathBuf};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;
use tauri::Manager;

const CREDENTIAL_SERVICE: &str = "in.trade-matangi.desktop-charts";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";

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
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT).map_err(|error| error.to_string())
}

fn stored_tokens() -> Result<TokenBundle, String> {
    let raw = credentials()?.get_password().map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

/// Tokens stay in the Windows Credential Manager through the OS keyring.
/// The WebView can ask the host to perform a refresh but never reads refresh
/// credentials or writes them to a config/store file.
#[tauri::command]
fn save_desktop_tokens(tokens: TokenBundle) -> Result<(), String> {
    let encoded = serde_json::to_string(&tokens).map_err(|error| error.to_string())?;
    credentials()?.set_password(&encoded).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_desktop_tokens() -> Result<(), String> {
    match credentials()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
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
        .invoke_handler(tauri::generate_handler![save_desktop_tokens, clear_desktop_tokens, queue_offline_mutation, pending_offline_mutations, acknowledge_offline_mutation, host_snapshot, start_sse_subscription])
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
