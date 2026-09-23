use futures_util::StreamExt;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::task::AbortHandle;

const CREDENTIAL_SERVICE: &str = "in.trade-matangi.desktop-charts";
const CREDENTIAL_ACCOUNT: &str = "desktop-session";
// An explicit target avoids a derived Windows Credential Manager name that
// can be unavailable to an installed NSIS application after sign-in.
const CREDENTIAL_TARGET: &str = "TradeMatangi.Desktop.Session";
const GOOGLE_REDIRECT_PORT: u16 = 8765;

/// A small, token-free diagnostic trail for installed Windows builds.  It is
/// intentionally kept outside the keyring and never includes credentials,
/// URLs, request bodies, or server responses.
fn diagnostic_log(message: &str) {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = PathBuf::from(local_app_data)
        .join("Trade Matangi Charts")
        .join("logs");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("desktop.log"))
    {
        let _ = writeln!(file, "{seconds} {message}");
    }
}

/// Persist a compact, structured renderer/stream trace for diagnosing WebView
/// failures. Market OHLC values are intentionally retained; credentials and
/// HTTP request metadata must never be supplied to this function.
fn live_diagnostic(kind: &str, payload: &serde_json::Value) {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = PathBuf::from(local_app_data)
        .join("Trade Matangi Charts")
        .join("logs");
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("desktop-live.ndjson");
    const MAX_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
    if fs::metadata(&path).map(|meta| meta.len() > MAX_JOURNAL_BYTES).unwrap_or(false) {
        let previous = directory.join("desktop-live.previous.ndjson");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, previous);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let entry = serde_json::json!({ "timestamp_ms": timestamp, "kind": kind, "payload": payload });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", entry);
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

const TOKEN_REFRESH_SKEW: Duration = Duration::from_secs(60);

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

#[derive(Clone, Serialize)]
pub struct DesktopStreamSnapshot {
    key: String,
    last_event_id: u64,
    latest_payload: serde_json::Value,
    connection: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DesktopLiveTick {
    timestamp: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: Option<f64>,
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
    serde_json::from_str(&raw)
        .map_err(|error| keyring::Error::BadEncoding(error.to_string().into_bytes()))
}

fn stored_tokens() -> Result<TokenBundle, String> {
    match tokens_from(credentials()?) {
        Ok(tokens) => {
            diagnostic_log("credential read: explicit target");
            Ok(tokens)
        }
        Err(keyring::Error::NoEntry) => {
            diagnostic_log("credential read: explicit target absent; trying legacy target");
            tokens_from(legacy_credentials()?).map_err(|error| {
                diagnostic_log(&format!("credential read: legacy target failed: {error}"));
                error.to_string()
            })
        }
        Err(error) => {
            diagnostic_log(&format!("credential read: explicit target failed: {error}"));
            Err(error.to_string())
        }
    }
}

async fn authenticate(base_url: &str, email: &str, password: &str) -> Result<TokenBundle, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/desktop/token", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "email": email, "password": password, "device_name": "Trade Matangi Desktop" }))
        .send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err("Login failed: check your email and password".into());
    }
    response
        .json::<TokenBundle>()
        .await
        .map_err(|error| error.to_string())
}

async fn authenticate_google(
    base_url: &str,
    id_token: &str,
    account_name: Option<String>,
) -> Result<TokenBundle, String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/auth/desktop/google-token",
            base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({ "id_token": id_token, "account_name": account_name, "device_name": "Trade Matangi Desktop" }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| value.get("detail").and_then(|detail| detail.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("Google login failed ({status})"));
        return Err(detail);
    }
    response
        .json::<TokenBundle>()
        .await
        .map_err(|error| error.to_string())
}

async fn refresh_desktop_tokens(base_url: &str, refresh_token: &str) -> Result<TokenBundle, String> {
    let response = reqwest::Client::new()
        .post(format!("{}/api/auth/desktop/refresh", base_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Desktop session refresh failed ({})", response.status()));
    }
    response.json::<TokenBundle>().await.map_err(|error| error.to_string())
}

fn random_url_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn percent_encode(value: &str) -> String {
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
        output
    })
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Malformed OAuth callback".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "Malformed OAuth callback".to_string())?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| "Malformed OAuth callback".to_string())?);
            index += 3;
        } else if bytes[index] == b'+' {
            decoded.push(b' ');
            index += 1;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "Malformed OAuth callback".into())
}

fn google_authorize_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&code_challenge={}&code_challenge_method=S256&state={}",
        percent_encode(client_id),
        percent_encode(redirect_uri),
        percent_encode(challenge),
        percent_encode(state),
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DesktopGoogleConfig {
    client_id: String,
    client_secret: Option<String>,
}

fn google_token_form<'a>(
    client_id: &'a str,
    client_secret: Option<&'a str>,
    code: &'a str,
    verifier: &'a str,
    redirect_uri: &'a str,
) -> Vec<(&'static str, &'a str)> {
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(client_secret) = client_secret.filter(|value| !value.is_empty()) {
        form.push(("client_secret", client_secret));
    }
    form
}

fn google_token_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            let error = value.get("error").and_then(|value| value.as_str()).unwrap_or("");
            let description = value
                .get("error_description")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            match (error.is_empty(), description.is_empty()) {
                (false, false) => Some(format!("{error} - {description}")),
                (false, true) => Some(error.to_string()),
                (true, false) => Some(description.to_string()),
                (true, true) => None,
            }
        })
        .or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(300).collect())
            }
        })
        .unwrap_or_else(|| status.to_string());
    format!("Google token exchange failed: {detail}")
}

#[cfg(target_os = "windows")]
fn windows_url_launcher(url: &str) -> (&'static str, Vec<&str>) {
    ("rundll32.exe", vec!["url.dll,FileProtocolHandler", url])
}

fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let (program, args) = windows_url_launcher(url);
        let first_error = Command::new(program)
            .creation_flags(0x08000000)
            .args(&args)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string());
        if let Err(error) = first_error {
            Command::new("explorer.exe")
                .creation_flags(0x08000000)
                .arg(url)
                .spawn()
                .map_err(|fallback_error| {
                    format!(
                        "Could not open the system browser: {error}; fallback failed: {fallback_error}"
                    )
                })?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open the system browser: {error}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open the system browser: {error}"))?;
    }
    Ok(())
}

fn authorize_google_in_browser(config: DesktopGoogleConfig) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", GOOGLE_REDIRECT_PORT))
        .map_err(|error| format!("Could not start the local Google sign-in callback: {error}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{GOOGLE_REDIRECT_PORT}/oauth/callback");
    let verifier = random_url_token()?;
    let state = random_url_token()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let authorize_url = google_authorize_url(&config.client_id, &redirect_uri, &challenge, &state);
    open_external_url(&authorize_url)?;

    let (mut stream, _) = listener
        .accept()
        .map_err(|error| format!("Google sign-in callback failed: {error}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut request = [0_u8; 8192];
    let bytes_read = stream
        .read(&mut request)
        .map_err(|error| format!("Could not read Google sign-in callback: {error}"))?;
    let request_line = std::str::from_utf8(&request[..bytes_read])
        .map_err(|_| "Google sign-in returned an invalid callback".to_string())?
        .lines()
        .next()
        .ok_or_else(|| "Google sign-in returned an empty callback".to_string())?;
    let path = request_line
        .strip_prefix("GET ")
        .and_then(|value| value.split_whitespace().next())
        .ok_or_else(|| "Google sign-in returned an invalid callback".to_string())?;
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut returned_state = None;
    let mut error = None;
    for parameter in query.split('&') {
        let Some((key, value)) = parameter.split_once('=') else { continue };
        let value = percent_decode(value)?;
        match key {
            "code" => code = Some(value),
            "state" => returned_state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    let response = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<h2>Trade Matangi sign-in complete</h2><p>You can close this browser tab and return to the desktop app.</p>";
    let _ = stream.write_all(response);
    if let Some(error) = error {
        return Err(format!("Google sign-in was cancelled: {error}"));
    }
    if returned_state.as_deref() != Some(state.as_str()) {
        return Err("Google sign-in state validation failed".into());
    }
    let code = code.ok_or_else(|| "Google sign-in did not return an authorization code".to_string())?;
    let form = google_token_form(
        &config.client_id,
        config.client_secret.as_deref(),
        &code,
        &verifier,
        &redirect_uri,
    );
    let response = reqwest::blocking::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(google_token_error(status, &body));
    }
    let token = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| error.to_string())?;
    token
        .get("id_token")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Google token exchange did not return an ID token".into())
}

async fn desktop_google_config(base_url: &str) -> Result<DesktopGoogleConfig, String> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/auth/desktop/google-config",
            base_url.trim_end_matches('/')
        ))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Desktop Google sign-in is not configured ({})", response.status()));
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    let client_id = body
        .get("client_id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Desktop Google sign-in returned no client ID".to_string())?;
    let client_secret = body
        .get("client_secret")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(DesktopGoogleConfig {
        client_id,
        client_secret,
    })
}

/// Tokens stay in the Windows Credential Manager through the OS keyring.
/// The WebView can ask the host to perform a refresh but never reads refresh
/// credentials or writes them to a config/store file.
fn persist_desktop_tokens(tokens: &TokenBundle) -> Result<(), String> {
    let encoded = serde_json::to_string(&tokens).map_err(|error| error.to_string())?;
    let entry = credentials()?;
    diagnostic_log("credential write: starting");
    entry.set_password(&encoded).map_err(|error| {
        diagnostic_log(&format!("credential write: failed: {error}"));
        format!("Windows Credential Manager could not save the desktop session: {error}")
    })?;

    match credentials()?.get_password() {
        Ok(saved) if saved == encoded => {
            diagnostic_log("credential write verification: fresh read success")
        }
        Ok(_) => diagnostic_log("credential write verification: fresh read value mismatch"),
        Err(error) => diagnostic_log(&format!(
            "credential write verification: fresh read failed: {error}"
        )),
    }
    Ok(())
}

#[tauri::command]
fn save_desktop_tokens(tokens: TokenBundle, host: tauri::State<HostState>) -> Result<(), String> {
    persist_desktop_tokens(&tokens)?;
    host.set_tokens(tokens);
    Ok(())
}

#[tauri::command]
fn clear_desktop_tokens() -> Result<(), String> {
    for entry in [credentials()?, legacy_credentials()?] {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
async fn desktop_login(
    base_url: String,
    email: String,
    password: String,
    host: tauri::State<'_, HostState>,
) -> Result<(), String> {
    let tokens = authenticate(&base_url, &email, &password).await?;
    persist_desktop_tokens(&tokens)?;
    host.set_tokens(tokens);
    host.set_connection("connected");
    Ok(())
}

#[tauri::command]
async fn desktop_google_login(
    base_url: String,
    account_name: Option<String>,
    host: tauri::State<'_, HostState>,
) -> Result<(), String> {
    let host = host.inner().clone();
    let id_token = host.take_pending_google_token().unwrap_or_else(|| String::new());
    let id_token = if id_token.is_empty() {
        let config = desktop_google_config(&base_url).await?;
        tauri::async_runtime::spawn_blocking(move || authorize_google_in_browser(config))
            .await
            .map_err(|error| format!("Google sign-in did not complete: {error}"))??
    } else {
        id_token
    };
    let tokens = match authenticate_google(&base_url, &id_token, account_name.clone()).await {
        Ok(tokens) => tokens,
        Err(error) if account_name.is_none() && error.contains("account_name") => {
            host.set_pending_google_token(id_token);
            return Err("account_name required".into());
        }
        Err(error) => return Err(error),
    };
    persist_desktop_tokens(&tokens)?;
    host.set_tokens(tokens);
    host.set_connection("connected");
    Ok(())
}

#[tauri::command]
async fn desktop_connection_state(
    base_url: String,
    host: tauri::State<'_, HostState>,
) -> Result<String, String> {
    let host = host.inner().clone();
    let token = match host.access_token(&base_url).await {
        Ok(token) => token,
        Err(_) => return Ok("authentication_required".into()),
    };
    let result = reqwest::Client::new()
        .get(format!(
            "{}/api/desktop/v1/capabilities",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .await;
    let state = match result {
        Ok(response) if response.status().is_success() => "connected",
        Ok(response) if response.status().as_u16() == 401 => "authentication_required",
        _ => "offline",
    };
    host.set_connection(state);
    Ok(state.into())
}

#[tauri::command]
async fn desktop_historical_page(
    base_url: String,
    symbol: String,
    trading_date: String,
    interval_minutes: u32,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/desktop/v1/historical/pages",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .query(&[
            ("symbol", symbol),
            ("trading_date", trading_date),
            ("interval_minutes", interval_minutes.to_string()),
            ("context_days", "5".into()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("History request failed ({})", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

async fn desktop_get(
    base_url: String,
    path: &str,
    query: Vec<(&str, String)>,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let response = reqwest::Client::new()
        .get(format!(
            "{}/api/desktop/v1/{}",
            base_url.trim_end_matches('/'),
            path
        ))
        .bearer_auth(token)
        .query(&query)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Desktop request failed ({})", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_catalogue(
    base_url: String,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "catalogue", vec![], host).await
}

#[tauri::command]
async fn desktop_option_metadata(
    base_url: String,
    symbol: String,
    as_of_date: String,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    desktop_get(
        base_url,
        "option-metadata",
        vec![("symbol", symbol), ("as_of_date", as_of_date)],
        host,
    )
    .await
}

#[tauri::command]
async fn desktop_option_historical_page(
    base_url: String,
    symbol: String,
    trading_date: String,
    expiry: String,
    strike: u32,
    right: String,
    interval_minutes: u32,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    desktop_get(
        base_url,
        "options/historical/pages",
        vec![
            ("symbol", symbol),
            ("trading_date", trading_date),
            ("expiry", expiry),
            ("strike", strike.to_string()),
            ("right", right),
            ("interval_minutes", interval_minutes.to_string()),
            ("context_days", "5".into()),
        ],
        host,
    )
    .await
}

#[tauri::command]
async fn desktop_chart_settings(
    base_url: String,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    desktop_get(base_url, "chart-settings", vec![], host).await
}

#[tauri::command]
async fn save_desktop_chart_settings(
    base_url: String,
    settings: serde_json::Value,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let response = reqwest::Client::new()
        .put(format!(
            "{}/api/desktop/v1/chart-settings",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({"settings": settings}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Settings request failed ({})", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_replay_request(
    base_url: String,
    path: String,
    method: String,
    body: serde_json::Value,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let url = format!(
        "{}/api/desktop/v1/replay/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let client = reqwest::Client::new();
    let request = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url).json(&body),
        "PUT" => client.put(url).json(&body),
        _ => return Err("Unsupported replay request".into()),
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("Replay request failed ({status}): {}", detail.chars().take(240).collect::<String>()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_live_request(
    base_url: String,
    path: String,
    method: String,
    body: serde_json::Value,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let url = format!(
        "{}/api/desktop/v1/live/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let client = reqwest::Client::new();
    let request = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url).json(&body),
        "PUT" => client.put(url).json(&body),
        "DELETE" => client.delete(url),
        _ => return Err("Unsupported live request".into()),
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Live request failed ({})", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_drawing_request(
    base_url: String,
    path: String,
    method: String,
    body: serde_json::Value,
    host: tauri::State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(&base_url).await?;
    let url = format!(
        "{}/api/desktop/v1/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let client = reqwest::Client::new();
    let request = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url).json(&body),
        "PATCH" => client.patch(url).json(&body),
        "PUT" => client.put(url).json(&body),
        "DELETE" => client.delete(url).json(&body),
        _ => return Err("Unsupported drawing request".into()),
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let request_kind = if path.trim_start_matches('/').starts_with("trading/") {
            "Trading"
        } else {
            "Desktop"
        };
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(": {}", detail.chars().take(500).collect::<String>())
        };
        return Err(format!(
            "{} request failed ({}){}",
            request_kind, status, suffix
        ));
    }
    if status.as_u16() == 204 {
        return Ok(serde_json::Value::Null);
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_logout(base_url: String, host: tauri::State<'_, HostState>) -> Result<(), String> {
    if let Ok(tokens) = host.token() {
        let result = reqwest::Client::new()
            .post(format!("{}/api/auth/desktop/logout", base_url.trim_end_matches('/')))
            .json(&serde_json::json!({ "refresh_token": tokens.refresh_token }))
            .send()
            .await;
        if let Err(error) = result {
            diagnostic_log(&format!("desktop logout revoke failed: {error}"));
        }
    }
    clear_desktop_tokens()?;
    host.clear_tokens();
    host.set_connection("authentication_required");
    Ok(())
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("desktop-cache.sqlite3"))
}

fn cache(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let connection =
        rusqlite::Connection::open(cache_path(app)?).map_err(|error| error.to_string())?;
    ensure_cache_schema(&connection)?;
    Ok(connection)
}

fn ensure_cache_schema(connection: &rusqlite::Connection) -> Result<(), String> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS offline_mutations (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS desktop_live_ticks (
            stream_id TEXT NOT NULL,
            instrument_key TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL,
            recorded_at INTEGER NOT NULL,
            PRIMARY KEY (stream_id, instrument_key, timestamp)
        );
        CREATE INDEX IF NOT EXISTS idx_desktop_live_ticks_lookup
            ON desktop_live_ticks (stream_id, instrument_key, timestamp);
        ",
    )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Queue a screen/drawing write while offline. The server remains authoritative
/// and will reconcile by mutation ID and revision after reconnect.
#[tauri::command]
fn queue_offline_mutation(
    app: tauri::AppHandle,
    kind: String,
    payload: String,
) -> Result<i64, String> {
    let connection = cache(&app)?;
    connection
        .execute(
            "INSERT INTO offline_mutations (kind, payload) VALUES (?1, ?2)",
            [&kind, &payload],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

#[tauri::command]
fn pending_offline_mutations(app: tauri::AppHandle) -> Result<Vec<QueuedMutation>, String> {
    let connection = cache(&app)?;
    let mut statement = connection
        .prepare("SELECT id, kind, payload FROM offline_mutations ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(QueuedMutation {
                id: row.get(0)?,
                kind: row.get(1)?,
                payload: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn acknowledge_offline_mutation(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    cache(&app)?
        .execute("DELETE FROM offline_mutations WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn record_desktop_live_tick(
    app: tauri::AppHandle,
    stream_id: String,
    instrument_key: String,
    tick: DesktopLiveTick,
) -> Result<(), String> {
    let connection = cache(&app)?;
    record_desktop_live_tick_in_connection(&connection, stream_id, instrument_key, tick)
}

fn record_desktop_live_tick_in_connection(
    connection: &rusqlite::Connection,
    stream_id: String,
    instrument_key: String,
    tick: DesktopLiveTick,
) -> Result<(), String> {
    let recorded_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    connection
        .execute(
            "
            INSERT INTO desktop_live_ticks
                (stream_id, instrument_key, timestamp, open, high, low, close, volume, recorded_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(stream_id, instrument_key, timestamp) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume,
                recorded_at = excluded.recorded_at
            ",
            rusqlite::params![
                stream_id,
                instrument_key,
                tick.timestamp,
                tick.open,
                tick.high,
                tick.low,
                tick.close,
                tick.volume,
                recorded_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Persist a reconciled refresh in one native call.  The cache stores raw
/// seconds only; chart candles never enter this table.
#[tauri::command]
fn record_desktop_live_ticks(
    app: tauri::AppHandle,
    stream_id: String,
    instrument_key: String,
    ticks: Vec<DesktopLiveTick>,
) -> Result<(), String> {
    let connection = cache(&app)?;
    record_desktop_live_ticks_in_connection(&connection, stream_id, instrument_key, ticks)
}

fn record_desktop_live_ticks_in_connection(
    connection: &rusqlite::Connection,
    stream_id: String,
    instrument_key: String,
    ticks: Vec<DesktopLiveTick>,
) -> Result<(), String> {
    let recorded_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let mut statement = transaction
        .prepare(
            "
            INSERT INTO desktop_live_ticks
                (stream_id, instrument_key, timestamp, open, high, low, close, volume, recorded_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(stream_id, instrument_key, timestamp) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume,
                recorded_at = excluded.recorded_at
            ",
        )
        .map_err(|error| error.to_string())?;
    for tick in ticks {
        statement
            .execute(rusqlite::params![
                stream_id,
                instrument_key,
                tick.timestamp,
                tick.open,
                tick.high,
                tick.low,
                tick.close,
                tick.volume,
                recorded_at,
            ])
            .map_err(|error| error.to_string())?;
    }
    drop(statement);
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_live_ticks(
    app: tauri::AppHandle,
    stream_id: String,
    instrument_key: String,
    since_timestamp: Option<i64>,
) -> Result<Vec<DesktopLiveTick>, String> {
    let connection = cache(&app)?;
    desktop_live_ticks_in_connection(&connection, stream_id, instrument_key, since_timestamp)
}

fn desktop_live_ticks_in_connection(
    connection: &rusqlite::Connection,
    stream_id: String,
    instrument_key: String,
    since_timestamp: Option<i64>,
) -> Result<Vec<DesktopLiveTick>, String> {
    let mut statement = connection
        .prepare(
            "
            SELECT timestamp, open, high, low, close, volume
            FROM desktop_live_ticks
            WHERE stream_id = ?1
              AND instrument_key = ?2
              AND (?3 IS NULL OR timestamp >= ?3)
            ORDER BY timestamp
            ",
        )
        .map_err(|error| error.to_string())?;
    let ticks = statement
        .query_map(
            rusqlite::params![stream_id, instrument_key, since_timestamp],
            |row| {
                Ok(DesktopLiveTick {
                    timestamp: row.get(0)?,
                    open: row.get(1)?,
                    high: row.get(2)?,
                    low: row.get(3)?,
                    close: row.get(4)?,
                    volume: row.get(5)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ticks)
}

#[tauri::command]
fn clear_desktop_live_ticks(app: tauri::AppHandle, stream_id: String) -> Result<(), String> {
    cache(&app)?
        .execute("DELETE FROM desktop_live_ticks WHERE stream_id = ?1", [stream_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Durable native state: it continues receiving stream events with no WebView listener.
#[derive(Clone)]
pub struct HostState(Arc<Mutex<LatestState>>, Arc<tokio::sync::Mutex<()>>);

impl Default for HostState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(LatestState::default())), Arc::new(tokio::sync::Mutex::new(())))
    }
}

#[derive(Default)]
struct LatestState {
    last_event_id: u64,
    latest_payload: String,
    connection: String,
    tokens: Option<TokenBundle>,
    pending_google_token: Option<String>,
    token_expires_at: Option<SystemTime>,
    streams: HashMap<String, NativeStreamState>,
}

struct NativeStreamState {
    last_event_id: u64,
    latest_payload: serde_json::Value,
    pending_payloads: Vec<serde_json::Value>,
    connection: String,
    abort: AbortHandle,
}

impl HostState {
    pub fn record(&self, event_id: u64, payload: String) {
        let mut state = self.0.lock().expect("host state lock");
        if event_id > state.last_event_id {
            state.last_event_id = event_id;
            state.latest_payload = payload;
        }
    }
    fn snapshot(&self) -> HostSnapshot {
        let state = self.0.lock().expect("host state lock");
        HostSnapshot {
            last_event_id: state.last_event_id,
            latest_payload: state.latest_payload.clone(),
            connection: state.connection.clone(),
        }
    }
    fn set_connection(&self, connection: &str) {
        self.0.lock().expect("host state lock").connection = connection.into();
    }
    fn start_stream(&self, key: &str, abort: AbortHandle) {
        let mut state = self.0.lock().expect("host state lock");
        if let Some(existing) = state.streams.remove(key) {
            existing.abort.abort();
        }
        state.streams.insert(
            key.into(),
            NativeStreamState {
                last_event_id: 0,
                latest_payload: serde_json::Value::Null,
                pending_payloads: Vec::new(),
                connection: "reconnecting".into(),
                abort,
            },
        );
    }
    fn stop_stream(&self, key: &str) {
        let mut state = self.0.lock().expect("host state lock");
        if let Some(existing) = state.streams.remove(key) {
            existing.abort.abort();
        }
    }
    fn set_stream_connection(&self, key: &str, connection: &str) {
        if let Some(stream) = self.0.lock().expect("host state lock").streams.get_mut(key) {
            stream.connection = connection.into();
        }
    }
    fn record_stream(&self, key: &str, event_id: u64, payload: serde_json::Value) {
        if let Some(stream) = self.0.lock().expect("host state lock").streams.get_mut(key) {
            if event_id >= stream.last_event_id {
                stream.last_event_id = event_id;
                stream.latest_payload = payload.clone();
                stream.pending_payloads.push(payload);
                if stream.pending_payloads.len() > 1024 {
                    let remove = stream.pending_payloads.len() - 1024;
                    stream.pending_payloads.drain(..remove);
                }
            }
        }
    }
    fn stream_snapshot(&self, key: &str) -> DesktopStreamSnapshot {
        let mut state = self.0.lock().expect("host state lock");
        let Some(stream) = state.streams.get_mut(key) else {
            return DesktopStreamSnapshot {
                key: key.into(),
                last_event_id: 0,
                latest_payload: serde_json::Value::Null,
                connection: "offline".into(),
            };
        };
        let latest_payload = if stream.pending_payloads.len() > 1 {
            let events = std::mem::take(&mut stream.pending_payloads);
            serde_json::json!({"type": "batch", "events": events})
        } else if stream.pending_payloads.len() == 1 {
            stream.pending_payloads.pop().unwrap_or_else(|| stream.latest_payload.clone())
        } else {
            stream.latest_payload.clone()
        };
        DesktopStreamSnapshot {
            key: key.into(),
            last_event_id: stream.last_event_id,
            latest_payload,
            connection: stream.connection.clone(),
        }
    }
    fn stream_cursor(&self, key: &str) -> u64 {
        self.0
            .lock()
            .expect("host state lock")
            .streams
            .get(key)
            .map(|value| value.last_event_id)
            .unwrap_or(0)
    }
    fn set_tokens(&self, tokens: TokenBundle) {
        let expires_at = SystemTime::now() + Duration::from_secs(tokens.expires_in);
        let mut state = self.0.lock().expect("host state lock");
        state.tokens = Some(tokens);
        state.token_expires_at = Some(expires_at);
    }
    fn clear_tokens(&self) {
        let mut state = self.0.lock().expect("host state lock");
        state.tokens = None;
        state.pending_google_token = None;
        for (_, stream) in state.streams.drain() {
            stream.abort.abort();
        }
    }
    fn set_pending_google_token(&self, token: String) {
        self.0.lock().expect("host state lock").pending_google_token = Some(token);
    }
    fn take_pending_google_token(&self) -> Option<String> {
        self.0.lock().expect("host state lock").pending_google_token.take()
    }
    fn token(&self) -> Result<TokenBundle, String> {
        if let Some(tokens) = self.0.lock().expect("host state lock").tokens.clone() {
            diagnostic_log("credential read: host memory");
            return Ok(tokens);
        }
        let tokens = stored_tokens()?;
        let mut state = self.0.lock().expect("host state lock");
        state.tokens = Some(tokens.clone());
        // A persisted bundle may have expired while the app was closed. Force
        // the first API call to rotate it instead of trusting expires_in.
        state.token_expires_at = Some(SystemTime::UNIX_EPOCH);
        Ok(tokens)
    }

    async fn access_token(&self, base_url: &str) -> Result<String, String> {
        let needs_refresh = {
            let state = self.0.lock().expect("host state lock");
            match (&state.tokens, state.token_expires_at) {
                (Some(_), Some(expires_at)) => expires_at <= SystemTime::now() + TOKEN_REFRESH_SKEW,
                _ => true,
            }
        };
        let tokens = self.token()?;
        if !needs_refresh {
            return Ok(tokens.access_token);
        }
        let _refresh_guard = self.1.lock().await;
        let still_needs_refresh = {
            let state = self.0.lock().expect("host state lock");
            state.token_expires_at.map(|expires_at| expires_at <= SystemTime::now() + TOKEN_REFRESH_SKEW).unwrap_or(true)
        };
        if still_needs_refresh {
            diagnostic_log("credential refresh: starting");
            let refreshed = refresh_desktop_tokens(base_url, &tokens.refresh_token).await?;
            persist_desktop_tokens(&refreshed)?;
            self.set_tokens(refreshed.clone());
            diagnostic_log("credential refresh: success");
            return Ok(refreshed.access_token);
        }
        self.0.lock().expect("host state lock").tokens.as_ref().map(|value| value.access_token.clone()).ok_or_else(|| "Desktop session is not authenticated".into())
    }
}

#[tauri::command]
fn host_snapshot(host: tauri::State<HostState>) -> HostSnapshot {
    host.snapshot()
}

#[tauri::command]
fn desktop_stream_snapshot(
    key: String,
    host: tauri::State<HostState>,
) -> DesktopStreamSnapshot {
    host.stream_snapshot(&key)
}

/// The WebView uses this for renderer-side failures and chart-operation
/// breadcrumbs. It is deliberately a write-only journal; no diagnostic data
/// is returned to JavaScript.
#[tauri::command]
fn record_desktop_renderer_diagnostic(kind: String, payload: serde_json::Value) {
    live_diagnostic(&format!("renderer:{kind}"), &payload);
}

#[tauri::command]
fn stop_desktop_stream(key: String, host: tauri::State<HostState>) {
    host.stop_stream(&key);
}

fn desktop_api_url(base_url: &str, path: &str) -> String {
    format!(
        "{}/api/desktop/v1/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

async fn fetch_stream_snapshot(
    client: &reqwest::Client,
    base_url: &str,
    snapshot_path: &str,
    host: &HostState,
) -> Result<serde_json::Value, String> {
    let token = host.access_token(base_url).await?;
    let response = client
        .get(desktop_api_url(base_url, snapshot_path))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Snapshot request failed ({})", response.status()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

fn parse_sse_frame(frame: &str) -> (Option<u64>, Option<String>, Option<String>) {
    let id = frame
        .lines()
        .find_map(|line| line.strip_prefix("id: "))
        .and_then(|id| id.parse().ok());
    let event = frame
        .lines()
        .find_map(|line| line.strip_prefix("event: "))
        .map(str::to_string);
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    let data = if data.is_empty() { None } else { Some(data) };
    (id, event, data)
}

#[tauri::command]
async fn start_desktop_stream(
    base_url: String,
    key: String,
    events_path: String,
    snapshot_path: String,
    host: tauri::State<'_, HostState>,
) -> Result<(), String> {
    let host = host.inner().clone();
    let stream_host = host.clone();
    let stream_key = key.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = ready_rx.await;
        let client = reqwest::Client::new();
        let mut backoff = 1_u64;
        loop {
            stream_host.set_stream_connection(&stream_key, "reconnecting");
            let token = match stream_host.access_token(&base_url).await {
                Ok(token) => token,
                Err(error) => {
                    diagnostic_log(&format!("desktop stream auth failed: {error}"));
                    stream_host.set_stream_connection(&stream_key, "authentication_required");
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(30);
                    continue;
                }
            };
            let mut request = client
                .get(desktop_api_url(&base_url, &events_path))
                .bearer_auth(token)
                .header("Accept", "text/event-stream");
            let event_id = stream_host.stream_cursor(&stream_key);
            if event_id > 0 {
                request = request.header("Last-Event-ID", event_id.to_string());
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    stream_host.set_stream_connection(&stream_key, "connected");
                    backoff = 1;
                    let mut stream = response.bytes_stream();
                    let mut buffer = String::new();
                    while let Some(chunk) = stream.next().await {
                        let bytes = match chunk {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                diagnostic_log(&format!("desktop stream read failed: {error}"));
                                break;
                            }
                        };
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(end) = buffer.find("\n\n") {
                            let frame = buffer[..end].to_string();
                            buffer = buffer[end + 2..].to_string();
                            let (id, event_name, data) = parse_sse_frame(&frame);
                            let event_id = id.unwrap_or_else(|| stream_host.stream_cursor(&stream_key));
                            if let Some(data) = data {
                                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&data) {
                                    if payload.get("type").and_then(|value| value.as_str()) == Some("candle") {
                                        live_diagnostic("native_sse_candle", &serde_json::json!({
                                            "stream_key": &stream_key,
                                            "event_id": event_id,
                                            "event": &payload,
                                        }));
                                    } else {
                                        live_diagnostic("native_sse_event", &serde_json::json!({
                                            "stream_key": &stream_key,
                                            "event_id": event_id,
                                            "type": payload.get("type"),
                                        }));
                                    }
                                    stream_host.record_stream(&stream_key, event_id, payload);
                                } else {
                                    live_diagnostic("native_sse_parse_failed", &serde_json::json!({
                                        "stream_key": &stream_key,
                                        "event_id": event_id,
                                        "event": event_name,
                                    }));
                                    let snapshot_started = SystemTime::now();
                                    if let Ok(snapshot) = fetch_stream_snapshot(&client, &base_url, &snapshot_path, &stream_host).await {
                                        let elapsed_ms = snapshot_started.elapsed().map(|value| value.as_millis()).unwrap_or(0);
                                        live_diagnostic("native_snapshot_recovery_received", &serde_json::json!({
                                            "stream_key": &stream_key,
                                            "event_id": event_id,
                                            "elapsed_ms": elapsed_ms,
                                            "bytes": snapshot.to_string().len(),
                                        }));
                                        stream_host.record_stream(&stream_key, event_id, snapshot);
                                    } else {
                                        live_diagnostic("native_snapshot_recovery_failed", &serde_json::json!({
                                            "stream_key": &stream_key,
                                            "event_id": event_id,
                                            "event": event_name,
                                        }));
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(response) if response.status().as_u16() == 401 => {
                    stream_host.set_stream_connection(&stream_key, "authentication_required");
                }
                Ok(response) => {
                    diagnostic_log(&format!("desktop stream connect failed: {}", response.status()));
                    stream_host.set_stream_connection(&stream_key, "offline");
                }
                Err(error) => {
                    diagnostic_log(&format!("desktop stream connect error: {error}"));
                    stream_host.set_stream_connection(&stream_key, "offline");
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    host.start_stream(&key, task.abort_handle());
    let _ = ready_tx.send(());
    Ok(())
}

#[tauri::command]
async fn start_sse_subscription(
    url: String,
    host: tauri::State<'_, HostState>,
) -> Result<(), String> {
    let host = host.inner().clone();
    let access_token = host.token()?.access_token;
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut backoff = 1_u64;
        loop {
            host.set_connection("reconnecting");
            let mut request = client
                .get(&url)
                .bearer_auth(&access_token)
                .header("Accept", "text/event-stream");
            let event_id = host.snapshot().last_event_id;
            if event_id > 0 {
                request = request.header("Last-Event-ID", event_id.to_string());
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    host.set_connection("connected");
                    backoff = 1;
                    let mut stream = response.bytes_stream();
                    let mut buffer = String::new();
                    while let Some(Ok(bytes)) = stream.next().await {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(end) = buffer.find("\n\n") {
                            let frame = buffer[..end].to_string();
                            buffer = buffer[end + 2..].to_string();
                            let id = frame
                                .lines()
                                .find_map(|line| line.strip_prefix("id: "))
                                .and_then(|id| id.parse().ok());
                            let data = frame.lines().find_map(|line| line.strip_prefix("data: "));
                            if let (Some(id), Some(data)) = (id, data) {
                                host.record(id, data.into());
                            }
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
        .invoke_handler(tauri::generate_handler![
            save_desktop_tokens,
            clear_desktop_tokens,
            desktop_login,
            desktop_google_login,
            desktop_connection_state,
            desktop_historical_page,
            desktop_catalogue,
            desktop_option_metadata,
            desktop_option_historical_page,
            desktop_chart_settings,
            save_desktop_chart_settings,
            desktop_replay_request,
            desktop_live_request,
            desktop_drawing_request,
            desktop_logout,
            queue_offline_mutation,
            pending_offline_mutations,
            acknowledge_offline_mutation,
            record_desktop_live_tick,
            record_desktop_live_ticks,
            desktop_live_ticks,
            clear_desktop_live_ticks,
            host_snapshot,
            desktop_stream_snapshot,
            record_desktop_renderer_diagnostic,
            start_desktop_stream,
            stop_desktop_stream,
            start_sse_subscription
        ])
        .run(tauri::generate_context!())
        .expect("tauri application error");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_authorize_url_contains_required_oauth_parameters() {
        let url = google_authorize_url(
            "desktop-client-id.apps.googleusercontent.com",
            "http://127.0.0.1:8765/oauth/callback",
            "challenge/with+reserved=",
            "state&value",
        );

        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("client_id=desktop-client-id.apps.googleusercontent.com"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Foauth%2Fcallback"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("scope=openid%20email%20profile"));
        assert!(url.contains("code_challenge=challenge%2Fwith%2Breserved%3D"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state%26value"));
    }

    #[test]
    fn google_token_form_omits_empty_client_secret() {
        let form = google_token_form(
            "desktop-client-id",
            None,
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:8765/oauth/callback",
        );

        assert!(form.contains(&("client_id", "desktop-client-id")));
        assert!(form.contains(&("code", "authorization-code")));
        assert!(form.contains(&("code_verifier", "pkce-verifier")));
        assert!(form.contains(&("grant_type", "authorization_code")));
        assert!(form.contains(&("redirect_uri", "http://127.0.0.1:8765/oauth/callback")));
        assert!(!form.iter().any(|(key, _)| *key == "client_secret"));
    }

    #[test]
    fn google_token_form_includes_configured_client_secret() {
        let form = google_token_form(
            "desktop-client-id",
            Some("desktop-secret"),
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:8765/oauth/callback",
        );

        assert!(form.contains(&("client_secret", "desktop-secret")));
    }

    #[test]
    fn google_token_error_uses_google_json_detail() {
        let message = google_token_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":"invalid_request","error_description":"client_secret is missing"}"#,
        );

        assert_eq!(
            message,
            "Google token exchange failed: invalid_request - client_secret is missing"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_url_launcher_passes_oauth_url_as_single_argument() {
        let oauth_url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=id&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Foauth%2Fcallback&response_type=code";
        let (program, args) = windows_url_launcher(oauth_url);

        assert_eq!(program, "rundll32.exe");
        assert_eq!(args, vec!["url.dll,FileProtocolHandler", oauth_url]);
    }

    #[test]
    fn fake_sse_updates_host_state_without_a_webview_listener() {
        let host = HostState::default();
        host.record(1, "first".into());
        host.record(2, "second".into());
        host.record(1, "stale".into());
        let state = host.0.lock().unwrap();
        assert_eq!(state.last_event_id, 2);
        assert_eq!(state.latest_payload, "second");
    }

    #[test]
    fn sse_parser_reads_event_name_and_multiline_data() {
        let (id, event, data) = parse_sse_frame("id: 42\nevent: candle\ndata: {\"a\":1}\ndata: {\"b\":2}");

        assert_eq!(id, Some(42));
        assert_eq!(event.as_deref(), Some("candle"));
        assert_eq!(data.as_deref(), Some("{\"a\":1}\n{\"b\":2}"));
    }

    #[test]
    fn desktop_live_tick_cache_updates_duplicate_second_in_place() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        ensure_cache_schema(&connection).unwrap();
        record_desktop_live_tick_in_connection(
            &connection,
            "stream-1".into(),
            "instrument-1".into(),
            DesktopLiveTick {
                timestamp: 100,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: None,
            },
        )
        .unwrap();
        record_desktop_live_tick_in_connection(
            &connection,
            "stream-1".into(),
            "instrument-1".into(),
            DesktopLiveTick {
                timestamp: 100,
                open: 1.0,
                high: 3.0,
                low: 0.25,
                close: 2.5,
                volume: Some(10.0),
            },
        )
        .unwrap();

        let ticks = desktop_live_ticks_in_connection(
            &connection,
            "stream-1".into(),
            "instrument-1".into(),
            Some(90),
        )
        .unwrap();

        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0].timestamp, 100);
        assert_eq!(ticks[0].high, 3.0);
        assert_eq!(ticks[0].low, 0.25);
        assert_eq!(ticks[0].close, 2.5);
        assert_eq!(ticks[0].volume, Some(10.0));
        assert!(desktop_live_ticks_in_connection(
            &connection,
            "stream-1".into(),
            "instrument-1".into(),
            Some(101),
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn desktop_live_tick_batch_upsert_keeps_each_second_once() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        ensure_cache_schema(&connection).unwrap();
        record_desktop_live_ticks_in_connection(
            &connection,
            "stream-1".into(),
            "instrument-1".into(),
            vec![
                DesktopLiveTick { timestamp: 100, open: 1.0, high: 2.0, low: 0.5, close: 1.5, volume: None },
                DesktopLiveTick { timestamp: 101, open: 2.0, high: 3.0, low: 1.5, close: 2.5, volume: None },
                DesktopLiveTick { timestamp: 100, open: 1.0, high: 4.0, low: 0.5, close: 3.5, volume: None },
            ],
        )
        .unwrap();

        let ticks = desktop_live_ticks_in_connection(&connection, "stream-1".into(), "instrument-1".into(), None).unwrap();
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks[0].high, 4.0);
        assert_eq!(ticks[0].close, 3.5);
    }
}
