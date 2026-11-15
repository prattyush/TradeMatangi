//! YouTube upload connection (Phase 24, sprint Y1).
//!
//! A second Google sign-in, separate from the app login, that asks for one permission only:
//! `youtube.upload`. The refresh token lives in the Windows Credential Manager under its own
//! entry. It is never sent to the Trade Matangi server and the WebView never sees it.
//! Sprint Y2 uses `access_token()` to upload.

use super::{
    desktop_google_config, google_token_error, google_token_form, open_external_url, percent_decode, percent_encode,
    random_url_token, DesktopGoogleConfig, CREDENTIAL_SERVICE, GOOGLE_REDIRECT_PORT,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const YOUTUBE_UPLOAD_SCOPE: &str = "https://www.googleapis.com/auth/youtube.upload";
/// Needed only to change an uploaded video's visibility. Asked together with the upload permission; the user may
/// leave it unticked on Google's screen, in which case uploading still works.
pub const YOUTUBE_MANAGE_SCOPE: &str = "https://www.googleapis.com/auth/youtube.force-ssl";
const KEY_TARGET: &str = "TradeMatangi.Desktop.YouTube";
const KEY_ACCOUNT: &str = "youtube-upload";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
/// Refresh a little before the access token really expires.
const EXPIRY_MARGIN_SECS: i64 = 60;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct YoutubeTokens {
    pub refresh_token: String,
    #[serde(default)]
    pub access_token: String,
    /// Unix seconds.
    #[serde(default)]
    pub expires_at: i64,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// Space-separated scopes Google granted (empty for connections made before this was stored).
    #[serde(default)]
    pub scope: String,
}

impl YoutubeTokens {
    pub fn can_change_visibility(&self) -> bool {
        self.scope.split_whitespace().any(|s| s == YOUTUBE_MANAGE_SCOPE)
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeStatus {
    pub connected: bool,
    /// The connection also has the permission to change a video's visibility.
    pub can_change_visibility: bool,
    /// Why the connection is gone, when it was connected before.
    pub message: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum RefreshError {
    /// Google no longer accepts the refresh token (revoked, or expired while the app is in Testing).
    Revoked,
    Other(String),
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
        percent_encode(client_id),
        percent_encode(redirect_uri),
        percent_encode(&format!("{YOUTUBE_UPLOAD_SCOPE} {YOUTUBE_MANAGE_SCOPE}")),
        percent_encode(challenge),
        percent_encode(state),
    )
}

pub fn refresh_form<'a>(tokens: &'a YoutubeTokens) -> Vec<(&'static str, &'a str)> {
    let mut form = vec![
        ("client_id", tokens.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", tokens.refresh_token.as_str()),
    ];
    if let Some(secret) = tokens.client_secret.as_deref().filter(|value| !value.is_empty()) {
        form.push(("client_secret", secret));
    }
    form
}

pub fn is_fresh(tokens: &YoutubeTokens, now: i64) -> bool {
    !tokens.access_token.is_empty() && tokens.expires_at - EXPIRY_MARGIN_SECS > now
}

/// Reads Google's token response. `previous_refresh` is kept when a refresh response has no new one.
pub fn parse_token_response(
    body: &str,
    now: i64,
    client_id: &str,
    client_secret: Option<&str>,
    previous_refresh: Option<&str>,
) -> Result<YoutubeTokens, String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| "Google returned an unreadable token response".to_string())?;
    let access = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("Google did not return an access token")?;
    let granted = value.get("scope").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if let Some(scope) = value.get("scope").and_then(|v| v.as_str()) {
        if !scope.split_whitespace().any(|s| s == YOUTUBE_UPLOAD_SCOPE) {
            return Err("The YouTube upload permission was not granted. On Google's screen, tick the box that lets Trade Matangi upload videos, then connect again.".into());
        }
    }
    let refresh = value
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .or(previous_refresh)
        .ok_or("Google did not return a refresh token. Remove Trade Matangi at myaccount.google.com/permissions and connect again.")?;
    let expires_in = value.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    Ok(YoutubeTokens {
        refresh_token: refresh.to_string(),
        access_token: access.to_string(),
        expires_at: now + expires_in,
        client_id: client_id.to_string(),
        client_secret: client_secret.filter(|s| !s.is_empty()).map(str::to_string),
        scope: granted,
    })
}

/// Turns Google's OAuth error text into something the user can act on.
pub fn friendly_error(detail: &str) -> String {
    if detail.contains("access_denied") {
        "Google refused the YouTube sign-in. If the app is still in Testing, add this Google account under Audience > Test users in the Google Cloud console.".into()
    } else if detail.contains("redirect_uri_mismatch") {
        "Google rejected the sign-in address. The Google client must be of type Desktop app.".into()
    } else if detail.contains("invalid_client") {
        "Google does not recognise the app's client id or secret. Check the desktop client in accesskeys.ini.".into()
    } else {
        detail.to_string()
    }
}

#[derive(Debug, PartialEq)]
pub struct Callback {
    pub code: String,
    pub state: String,
}

/// `request` is the raw HTTP request that Google's redirect sends to the local port.
pub fn parse_callback(request: &str) -> Result<Callback, String> {
    let line = request.lines().next().ok_or("Google returned an empty callback")?;
    let path = line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split_whitespace().next())
        .ok_or("Google returned an invalid callback")?;
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let (mut code, mut state, mut error) = (None, None, None);
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let value = percent_decode(value)?;
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(friendly_error(&error));
    }
    Ok(Callback {
        code: code.ok_or("Google did not return an authorization code")?,
        state: state.ok_or("Google did not return the sign-in state")?,
    })
}

// ── Credential Manager ────────────────────────────────────────────────────────

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new_with_target(KEY_TARGET, CREDENTIAL_SERVICE, KEY_ACCOUNT).map_err(|e| e.to_string())
}

pub fn load() -> Result<Option<YoutubeTokens>, String> {
    match entry()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| format!("The saved YouTube connection is unreadable: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Windows Credential Manager could not read the YouTube connection: {e}")),
    }
}

/// Writes `raw` and reads it back through a brand-new entry. A store that accepts the write but does not keep it
/// (the keyring crate without its Windows backend does exactly that) must fail here, not later as "not connected".
fn store_and_verify(raw: &str, make_entry: impl Fn() -> Result<keyring::Entry, String>) -> Result<(), String> {
    make_entry()?.set_password(raw).map_err(|e| format!("Windows Credential Manager could not save the YouTube connection: {e}"))?;
    match make_entry()?.get_password() {
        Ok(saved) if saved == raw => Ok(()),
        Ok(_) => Err("Windows Credential Manager changed the YouTube connection while saving it. Connect again.".into()),
        Err(e) => Err(format!("Windows Credential Manager did not keep the YouTube connection ({e}). It was not saved.")),
    }
}

fn save(tokens: &YoutubeTokens) -> Result<(), String> {
    let raw = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    store_and_verify(&raw, entry)
}

fn delete() {
    if let Ok(entry) = entry() {
        let _ = entry.delete_credential();
    }
}

// ── Sign-in in the system browser ────────────────────────────────────────────

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0_u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{body}");
}

fn authorize_in_browser(config: DesktopGoogleConfig) -> Result<YoutubeTokens, String> {
    let listener = TcpListener::bind(("127.0.0.1", GOOGLE_REDIRECT_PORT))
        .map_err(|e| format!("Could not start the local YouTube sign-in callback (is a Google sign-in already open?): {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{GOOGLE_REDIRECT_PORT}/oauth/callback");
    let verifier = random_url_token()?;
    let state = random_url_token()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    open_external_url(&authorize_url(&config.client_id, &redirect_uri, &challenge, &state))?;

    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    let callback = loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let request = read_request(&mut stream);
                // Browsers also ask for /favicon.ico; only the OAuth redirect counts.
                if !request.starts_with("GET /oauth/callback") {
                    respond(&mut stream, "404 Not Found", "");
                    continue;
                }
                let parsed = parse_callback(&request);
                let page = if parsed.is_ok() {
                    "<h2>Google answered Trade Matangi</h2><p>You can close this browser tab. The desktop app now finishes the connection and tells you whether YouTube is connected.</p>"
                } else {
                    "<h2>YouTube was not connected</h2><p>You can close this browser tab and read the message in the desktop app.</p>"
                };
                respond(&mut stream, "200 OK", page);
                break parsed?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("YouTube sign-in timed out. Click Connect YouTube to try again.".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("YouTube sign-in callback failed: {e}")),
        }
    };
    if callback.state != state {
        return Err("YouTube sign-in state validation failed".into());
    }
    let form = google_token_form(&config.client_id, config.client_secret.as_deref(), &callback.code, &verifier, &redirect_uri);
    let response = reqwest::blocking::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&form)
        .send()
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(friendly_error(&google_token_error(status, &body)));
    }
    parse_token_response(&body, now_secs(), &config.client_id, config.client_secret.as_deref(), None)
}

// ── Public operations ────────────────────────────────────────────────────────

pub async fn connect(base_url: &str) -> Result<(), String> {
    let config = desktop_google_config(base_url).await?;
    let tokens = tauri::async_runtime::spawn_blocking(move || authorize_in_browser(config))
        .await
        .map_err(|e| format!("YouTube sign-in did not complete: {e}"))??;
    save(&tokens)
}

async fn refresh(tokens: &YoutubeTokens) -> Result<YoutubeTokens, RefreshError> {
    let response = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&refresh_form(tokens))
        .send()
        .await
        .map_err(|e| RefreshError::Other(e.to_string()))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| RefreshError::Other(e.to_string()))?;
    if !status.is_success() {
        let detail = google_token_error(status, &body);
        return Err(if detail.contains("invalid_grant") { RefreshError::Revoked } else { RefreshError::Other(friendly_error(&detail)) });
    }
    let mut next = parse_token_response(&body, now_secs(), &tokens.client_id, tokens.client_secret.as_deref(), Some(&tokens.refresh_token))
        .map_err(RefreshError::Other)?;
    if next.scope.is_empty() {
        next.scope = tokens.scope.clone();
    }
    Ok(next)
}

const EXPIRED_MESSAGE: &str = "The YouTube connection ended. Google expires it after about 7 days while the app is in Testing, or when access is removed. Connect again.";

/// A valid access token for the upload (Y2). Refreshes and stores it when needed.
#[allow(dead_code)] // used by the upload in Y2
pub async fn access_token() -> Result<String, String> {
    let Some(tokens) = load()? else { return Err("YouTube is not connected. Click Connect YouTube first.".into()) };
    if is_fresh(&tokens, now_secs()) {
        return Ok(tokens.access_token);
    }
    match refresh(&tokens).await {
        Ok(next) => {
            save(&next)?;
            Ok(next.access_token)
        }
        Err(RefreshError::Revoked) => {
            delete();
            Err(EXPIRED_MESSAGE.into())
        }
        Err(RefreshError::Other(e)) => Err(e),
    }
}

/// Like `access_token`, but only when the connection was given the permission to change a video's visibility.
pub async fn manage_token() -> Result<String, String> {
    match load()? {
        None => Err("YouTube is not connected. Click Connect YouTube first.".into()),
        Some(tokens) if !tokens.can_change_visibility() => Err(
            "Changing a video's visibility needs one more permission. Disconnect YouTube here, connect again and tick the permission to manage your YouTube videos.".into(),
        ),
        Some(_) => access_token().await,
    }
}

pub async fn status() -> Result<YoutubeStatus, String> {
    let Some(tokens) = load()? else { return Ok(YoutubeStatus { connected: false, can_change_visibility: false, message: None }) };
    let manage = tokens.can_change_visibility();
    if is_fresh(&tokens, now_secs()) {
        return Ok(YoutubeStatus { connected: true, can_change_visibility: manage, message: None });
    }
    match refresh(&tokens).await {
        Ok(next) => {
            save(&next)?;
            Ok(YoutubeStatus { connected: true, can_change_visibility: next.can_change_visibility(), message: None })
        }
        Err(RefreshError::Revoked) => {
            delete();
            Ok(YoutubeStatus { connected: false, can_change_visibility: false, message: Some(EXPIRED_MESSAGE.into()) })
        }
        // Offline or a Google hiccup: keep the connection, the upload will report a real problem.
        Err(RefreshError::Other(_)) => Ok(YoutubeStatus { connected: true, can_change_visibility: manage, message: None }),
    }
}

pub async fn disconnect() -> Result<(), String> {
    if let Some(tokens) = load().unwrap_or(None) {
        // Best effort: ask Google to forget the grant too.
        let _ = reqwest::Client::new()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", tokens.refresh_token.as_str())])
            .timeout(Duration::from_secs(10))
            .send()
            .await;
    }
    delete();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(access: &str, expires_at: i64) -> YoutubeTokens {
        YoutubeTokens { refresh_token: "r".into(), access_token: access.into(), expires_at, client_id: "cid".into(), client_secret: Some("sec".into()), scope: String::new() }
    }

    #[test]
    fn saving_fails_loudly_when_the_store_does_not_keep_the_value() {
        // Without a real backend the keyring crate hands out a fresh empty entry each time (the "mock" store),
        // which is how the Windows build lost the YouTube connection. Linux CI runs on that same store.
        let error = store_and_verify("secret", entry).unwrap_err();
        assert!(error.contains("did not keep the YouTube connection"), "{error}");
        assert!(error.contains("not saved"), "{error}");
    }

    #[test]
    fn authorize_url_asks_for_upload_and_manage_and_offline_access() {
        let url = authorize_url("cid.apps", "http://127.0.0.1:8765/oauth/callback", "chal", "st");
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.upload%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.force-ssl&"), "{url}");
        assert!(!url.contains("openid") && !url.contains("email"));
        assert!(url.contains("access_type=offline") && url.contains("prompt=consent"));
        assert!(url.contains("code_challenge_method=S256") && url.contains("state=st"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Foauth%2Fcallback"));
    }

    #[test]
    fn granted_scopes_are_stored_and_manage_is_optional() {
        let both = format!(r#"{{"access_token":"a","refresh_token":"rt","scope":"{YOUTUBE_UPLOAD_SCOPE} {YOUTUBE_MANAGE_SCOPE}"}}"#);
        assert!(parse_token_response(&both, 0, "cid", None, None).unwrap().can_change_visibility());
        // Upload ticked, manage left unticked: the connection works for uploading only.
        let upload_only = format!(r#"{{"access_token":"a","refresh_token":"rt","scope":"{YOUTUBE_UPLOAD_SCOPE}"}}"#);
        let t = parse_token_response(&upload_only, 0, "cid", None, None).unwrap();
        assert!(!t.can_change_visibility());
        assert_eq!(t.scope, YOUTUBE_UPLOAD_SCOPE);
        // Manage alone is not enough: uploading is the point of the connection.
        let manage_only = format!(r#"{{"access_token":"a","refresh_token":"rt","scope":"{YOUTUBE_MANAGE_SCOPE}"}}"#);
        assert!(parse_token_response(&manage_only, 0, "cid", None, None).unwrap_err().contains("permission was not granted"));
    }

    #[test]
    fn callback_is_parsed_and_errors_are_reported() {
        let ok = parse_callback("GET /oauth/callback?state=abc&code=4%2F0Ab HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!(ok, Callback { code: "4/0Ab".into(), state: "abc".into() });
        assert!(parse_callback("GET /oauth/callback?error=access_denied&state=abc HTTP/1.1").unwrap_err().contains("Test users"));
        assert!(parse_callback("GET /oauth/callback?state=abc HTTP/1.1").is_err());
        assert!(parse_callback("GET /oauth/callback?code=c HTTP/1.1").is_err());
        assert!(parse_callback("POST /x HTTP/1.1").is_err());
        assert!(parse_callback("").is_err());
    }

    #[test]
    fn first_token_response_needs_a_refresh_token_and_the_upload_scope() {
        let body = format!(r#"{{"access_token":"a","expires_in":3599,"refresh_token":"rt","scope":"{YOUTUBE_UPLOAD_SCOPE}","token_type":"Bearer"}}"#);
        let t = parse_token_response(&body, 1000, "cid", Some("sec"), None).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_str(), t.expires_at), ("a", "rt", 4599));
        assert_eq!(t.client_secret.as_deref(), Some("sec"));

        let no_refresh = r#"{"access_token":"a","expires_in":3599}"#;
        assert!(parse_token_response(no_refresh, 0, "cid", None, None).unwrap_err().contains("refresh token"));

        let wrong_scope = r#"{"access_token":"a","refresh_token":"rt","scope":"openid email"}"#;
        assert!(parse_token_response(wrong_scope, 0, "cid", None, None).unwrap_err().contains("permission was not granted"));
        assert!(parse_token_response("not json", 0, "cid", None, None).is_err());
        assert!(parse_token_response(r#"{"refresh_token":"rt"}"#, 0, "cid", None, None).is_err());
    }

    #[test]
    fn refresh_response_keeps_the_old_refresh_token_and_drops_an_empty_secret() {
        let body = r#"{"access_token":"new","expires_in":3600}"#;
        let t = parse_token_response(body, 10, "cid", Some(""), Some("old")).unwrap();
        assert_eq!((t.refresh_token.as_str(), t.access_token.as_str()), ("old", "new"));
        assert_eq!(t.client_secret, None);
    }

    #[test]
    fn access_token_freshness_has_a_safety_margin() {
        assert!(is_fresh(&tokens("a", 1000), 900));
        assert!(!is_fresh(&tokens("a", 1000), 950), "within the 60 s margin");
        assert!(!is_fresh(&tokens("", 1000), 0), "no access token yet");
    }

    #[test]
    fn refresh_form_sends_the_secret_only_when_there_is_one() {
        let with = tokens("a", 0);
        assert!(refresh_form(&with).contains(&("client_secret", "sec")));
        let mut without = tokens("a", 0);
        without.client_secret = None;
        assert!(!refresh_form(&without).iter().any(|(k, _)| *k == "client_secret"));
        assert!(refresh_form(&with).contains(&("grant_type", "refresh_token")));
    }

    #[test]
    fn google_errors_get_plain_wording() {
        assert!(friendly_error("access_denied").contains("Test users"));
        assert!(friendly_error("Google token exchange failed: redirect_uri_mismatch").contains("Desktop app"));
        assert!(friendly_error("invalid_client - Unauthorized").contains("client"));
        assert_eq!(friendly_error("something else"), "something else");
    }

    #[test]
    fn stored_tokens_round_trip_and_status_never_carries_a_token() {
        let t = tokens("a", 5);
        let back: YoutubeTokens = serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(back, t);
        let old: YoutubeTokens = serde_json::from_str(r#"{"refresh_token":"r","client_id":"c"}"#).unwrap();
        assert_eq!((old.access_token.as_str(), old.expires_at), ("", 0));
        let status = serde_json::to_string(&YoutubeStatus { connected: true, can_change_visibility: false, message: None }).unwrap();
        assert_eq!(status, r#"{"connected":true,"canChangeVisibility":false,"message":null}"#);
    }
}
