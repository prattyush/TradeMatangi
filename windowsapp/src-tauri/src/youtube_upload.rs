//! Upload a finished mp4 to YouTube (Phase 24, sprint Y2).
//!
//! Uses YouTube's resumable upload: one request that starts an upload session, then the file in
//! chunks, each with a `Content-Range`. After a dropped connection or a 5xx the session is asked how
//! much it already has and the upload continues from there. The session address returned by YouTube
//! is itself the credential for the chunk requests, so a long upload does not depend on the access
//! token staying valid.

use serde::Deserialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const API_BASE: &str = "https://www.googleapis.com";
/// Must be a multiple of 256 KiB (YouTube's rule for every chunk except the last).
pub const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FAILURES: u32 = 5;
const TITLE_MAX_CHARS: usize = 100;
const DESCRIPTION_MAX_BYTES: usize = 5000;
/// "People & Blogs": assignable in every region.
const CATEGORY_ID: &str = "22";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub path: String,
    pub title: String,
    pub description: String,
    /// "private" | "unlisted" | "public"
    pub privacy: String,
}

#[derive(Debug, PartialEq)]
pub struct UploadResult {
    pub video_id: String,
    pub url: String,
    /// What YouTube actually applied. It forces "private" for API projects that have not been audited.
    pub privacy: String,
}

#[derive(Debug, PartialEq)]
pub enum UploadError {
    Cancelled,
    Failed(String),
}

#[derive(Default)]
pub struct UploadControl {
    cancelled: AtomicBool,
}

impl UploadControl {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Handle for the one upload that may run at a time.
#[derive(Default, Clone)]
pub struct UploadState(pub Arc<Mutex<Option<Arc<UploadControl>>>>);

pub struct UploadConfig {
    pub api_base: String,
    pub chunk: u64,
    /// First wait before a retry; doubles for each further failure (capped at 30 s).
    pub retry_base: Duration,
    pub max_failures: u32,
}

impl Default for UploadConfig {
    fn default() -> Self {
        UploadConfig { api_base: API_BASE.into(), chunk: CHUNK_BYTES, retry_base: Duration::from_secs(2), max_failures: MAX_FAILURES }
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

pub fn watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

/// Video ids are 11 characters of letters, digits, `-` and `_`; refuse anything else before it is used in a URL.
pub fn is_video_id(value: &str) -> bool {
    (6..=20).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn validate(req: &UploadRequest) -> Result<(), String> {
    let path = Path::new(&req.path);
    if !req.path.to_ascii_lowercase().ends_with(".mp4") {
        return Err("Only .mp4 files can be uploaded.".into());
    }
    let size = std::fs::metadata(path).map_err(|_| "The video file was not found. Make the video again or choose another file.".to_string())?.len();
    if size == 0 {
        return Err("The video file is empty.".into());
    }
    let title = req.title.trim();
    if title.is_empty() {
        return Err("Enter a title for the video.".into());
    }
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(format!("The title is too long: YouTube allows {TITLE_MAX_CHARS} characters."));
    }
    if title.contains(['<', '>']) || req.description.contains(['<', '>']) {
        return Err("YouTube does not allow the characters < and > in the title or description. Remove them and try again.".into());
    }
    if req.description.len() > DESCRIPTION_MAX_BYTES {
        return Err(format!("The description is too long: YouTube allows {DESCRIPTION_MAX_BYTES} bytes."));
    }
    if !["private", "unlisted", "public"].contains(&req.privacy.as_str()) {
        return Err("Choose Private, Unlisted or Public.".into());
    }
    Ok(())
}

pub fn init_body(req: &UploadRequest) -> serde_json::Value {
    serde_json::json!({
        "snippet": { "title": req.title.trim(), "description": req.description, "categoryId": CATEGORY_ID },
        "status": { "privacyStatus": req.privacy, "selfDeclaredMadeForKids": false },
    })
}

/// First and last byte (inclusive) of the next chunk.
pub fn chunk_range(offset: u64, total: u64, chunk: u64) -> (u64, u64) {
    (offset, (offset + chunk).min(total) - 1)
}

pub fn content_range(start: u64, end: u64, total: u64) -> String {
    format!("bytes {start}-{end}/{total}")
}

/// `Range: bytes=0-8388607` means YouTube has that many bytes; the next byte to send is `end + 1`.
pub fn next_offset_from_range(header: Option<&str>) -> u64 {
    header
        .and_then(|h| h.trim().strip_prefix("bytes="))
        .and_then(|r| r.split_once('-'))
        .and_then(|(_, end)| end.trim().parse::<u64>().ok())
        .map(|end| end + 1)
        .unwrap_or(0)
}

/// Plain wording for YouTube's error answers.
pub fn friendly_api_error(status: u16, body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let reason = json.pointer("/error/errors/0/reason").and_then(|v| v.as_str()).unwrap_or("");
    let message = json.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("");
    match reason {
        "quotaExceeded" | "dailyLimitExceeded" | "rateLimitExceeded" => {
            "YouTube's daily limit for this app is used up (about 6 uploads a day). Try again tomorrow.".into()
        }
        "uploadLimitExceeded" => "This YouTube channel has reached its upload limit. Try again later.".into(),
        "youtubeSignupRequired" => "The Google account you connected has no YouTube channel. Create one at youtube.com, then connect again.".into(),
        "authError" | "authorizationRequired" | "forbidden" | "insufficientPermissions" => {
            "YouTube refused the upload permission. Disconnect YouTube here, connect again and tick the upload box.".into()
        }
        "invalidTitle" | "invalidDescription" | "invalidTags" | "invalidCategoryId" | "invalidVideoMetadata" => {
            format!("YouTube rejected the title or description: {}", if message.is_empty() { reason } else { message })
        }
        _ => match status {
            401 => "The YouTube connection is no longer valid. Disconnect YouTube here and connect again.".into(),
            _ if message.is_empty() => format!("YouTube answered with error {status}."),
            _ => format!("YouTube answered with error {status}: {message}"),
        },
    }
}

fn megabytes(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
}

// ── Upload ───────────────────────────────────────────────────────────────────

enum Step {
    Done(UploadResult),
    /// Next byte YouTube wants.
    Next(u64),
    Retry(String),
    Fatal(String),
}

fn interpret(response: Result<reqwest::blocking::Response, reqwest::Error>) -> Step {
    let response = match response {
        Ok(response) => response,
        Err(e) => return Step::Retry(e.to_string()),
    };
    let status = response.status().as_u16();
    let range = response.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = response.text().unwrap_or_default();
    match status {
        200 | 201 => {
            let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            match json.get("id").and_then(|v| v.as_str()) {
                Some(id) => Step::Done(UploadResult {
                    video_id: id.to_string(),
                    url: watch_url(id),
                    privacy: json.pointer("/status/privacyStatus").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                }),
                None => Step::Fatal("YouTube finished the upload but returned no video id. Check YouTube Studio before uploading again.".into()),
            }
        }
        308 => Step::Next(next_offset_from_range(range.as_deref())),
        500 | 502 | 503 | 504 => Step::Retry(format!("YouTube answered {status}")),
        404 | 410 => Step::Fatal("The upload session expired. Start the upload again.".into()),
        _ => Step::Fatal(friendly_api_error(status, &body)),
    }
}

fn start_session(client: &reqwest::blocking::Client, cfg: &UploadConfig, token: &str, req: &UploadRequest, total: u64) -> Result<String, UploadError> {
    let url = format!("{}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", cfg.api_base);
    let response = client
        .post(url)
        .bearer_auth(token)
        .header("X-Upload-Content-Length", total.to_string())
        .header("X-Upload-Content-Type", "video/mp4")
        .json(&init_body(req))
        .send()
        .map_err(|e| UploadError::Failed(format!("Could not reach YouTube: {e}")))?;
    let status = response.status().as_u16();
    if status != 200 {
        let body = response.text().unwrap_or_default();
        return Err(UploadError::Failed(friendly_api_error(status, &body)));
    }
    response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| UploadError::Failed("YouTube did not start an upload session.".into()))
}

/// Waits `delay`, waking early if the upload is cancelled.
fn pause(control: &UploadControl, delay: Duration) {
    let mut left = delay;
    let slice = Duration::from_millis(50);
    while !left.is_zero() && !control.is_cancelled() {
        let step = left.min(slice);
        std::thread::sleep(step);
        left -= step;
    }
}

pub fn run_upload(
    cfg: &UploadConfig,
    token: &str,
    req: &UploadRequest,
    control: &UploadControl,
    progress: &mut dyn FnMut(f64, String),
) -> Result<UploadResult, UploadError> {
    validate(req).map_err(UploadError::Failed)?;
    let mut file = File::open(&req.path).map_err(|e| UploadError::Failed(format!("Could not open the video: {e}")))?;
    let total = file.metadata().map_err(|e| UploadError::Failed(e.to_string()))?.len();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| UploadError::Failed(e.to_string()))?;

    if control.is_cancelled() {
        return Err(UploadError::Cancelled);
    }
    progress(0.0, "Starting the upload…".into());
    let session = start_session(&client, cfg, token, req, total)?;

    let mut offset = 0_u64;
    let mut failures = 0_u32;
    loop {
        if control.is_cancelled() {
            return Err(UploadError::Cancelled);
        }
        let (start, end) = chunk_range(offset, total, cfg.chunk);
        let mut buf = vec![0_u8; (end - start + 1) as usize];
        file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).map_err(|e| UploadError::Failed(format!("Could not read the video file: {e}")))?;
        let sent = client.put(&session).header("Content-Range", content_range(start, end, total)).header("Content-Type", "video/mp4").body(buf).send();
        match interpret(sent) {
            Step::Done(result) => {
                progress(100.0, "Uploaded".into());
                return Ok(result);
            }
            Step::Next(next) => {
                offset = next;
                failures = 0;
                let percent = (offset as f64 / total as f64 * 100.0).min(99.0);
                progress(percent, format!("Uploading {} of {}", megabytes(offset), megabytes(total)));
            }
            Step::Fatal(message) => return Err(UploadError::Failed(message)),
            Step::Retry(reason) => {
                failures += 1;
                if failures > cfg.max_failures {
                    return Err(UploadError::Failed(format!("The upload kept failing ({reason}). Check the internet connection and try again.")));
                }
                progress((offset as f64 / total as f64 * 100.0).min(99.0), format!("Connection problem, retrying ({failures}/{})…", cfg.max_failures));
                pause(control, (cfg.retry_base * 2_u32.pow(failures - 1)).min(Duration::from_secs(30)));
                if control.is_cancelled() {
                    return Err(UploadError::Cancelled);
                }
                // Ask YouTube how much it really has before sending anything again.
                let query = client.put(&session).header("Content-Range", format!("bytes */{total}")).body(Vec::new()).send();
                match interpret(query) {
                    Step::Done(result) => {
                        progress(100.0, "Uploaded".into());
                        return Ok(result);
                    }
                    Step::Next(next) => offset = next,
                    Step::Fatal(message) => return Err(UploadError::Failed(message)),
                    Step::Retry(_) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;
    use std::net::TcpListener;

    fn req(path: &str) -> UploadRequest {
        UploadRequest { path: path.into(), title: "NIFTY 2026-11-06 trades".into(), description: "0:00 Introduction\n1:10 Trade 1 · +2.0%".into(), privacy: "private".into() }
    }

    fn temp_mp4(name: &str, size: usize) -> String {
        let dir = std::env::temp_dir().join(format!("tm-upload-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("v.mp4");
        std::fs::write(&path, vec![7_u8; size]).unwrap();
        path.to_string_lossy().into_owned()
    }

    // ── fake YouTube ─────────────────────────────────────────────────────────

    struct Seen {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body_len: usize,
    }
    enum Reply {
        Send(u16, Vec<(&'static str, String)>, String),
        /// Close the connection without answering.
        Drop,
    }

    fn fake_youtube(mut handler: impl FnMut(&Seen, usize) -> Reply + Send + 'static) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let shared = log.clone();
        std::thread::spawn(move || {
            let mut count = 0;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut data = Vec::new();
                let mut buf = [0_u8; 65536];
                let head_end = loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break None;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(pos + 4);
                    }
                };
                let Some(head_end) = head_end else { continue };
                let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or("").to_string();
                let mut parts = first.split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
                    .collect();
                let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while data.len() - head_end < want {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let seen = Seen { method, path, headers, body_len: data.len() - head_end };
                let reply = handler(&seen, count);
                count += 1;
                shared.lock().unwrap().push(seen);
                match reply {
                    Reply::Drop => {}
                    Reply::Send(status, extra, body) => {
                        let mut out = format!("HTTP/1.1 {status} X\r\n");
                        for (k, v) in extra {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
                        let _ = stream.write_all(out.as_bytes());
                    }
                }
            }
        });
        (base, log)
    }

    fn cfg(base: &str) -> UploadConfig {
        UploadConfig { api_base: base.into(), chunk: 262_144, retry_base: Duration::from_millis(1), max_failures: 3 }
    }

    /// "bytes 0-262143/600000" -> (0, 262143, 600000); "bytes */600000" -> None.
    fn parse_content_range(v: &str) -> Option<(u64, u64, u64)> {
        let r = v.strip_prefix("bytes ")?;
        let (range, total) = r.split_once('/')?;
        let (s, e) = range.split_once('-')?;
        Some((s.parse().ok()?, e.parse().ok()?, total.parse().ok()?))
    }

    /// A well-behaved YouTube: remembers how many bytes it holds.
    fn good_youtube(base_cell: Arc<Mutex<String>>, held: Arc<Mutex<u64>>, final_privacy: &'static str) -> impl FnMut(&Seen, usize) -> Reply + Send + 'static {
        move |seen, _| {
            if seen.method == "POST" {
                return Reply::Send(200, vec![("Location", format!("{}/session/abc", base_cell.lock().unwrap()))], String::new());
            }
            let cr = seen.headers.get("content-range").cloned().unwrap_or_default();
            if let Some((s, e, total)) = parse_content_range(&cr) {
                assert_eq!(s, *held.lock().unwrap(), "chunks must start where YouTube left off");
                *held.lock().unwrap() = e + 1;
                if e + 1 < total {
                    return Reply::Send(308, vec![("Range", format!("bytes=0-{e}"))], String::new());
                }
                return Reply::Send(200, vec![], format!(r#"{{"id":"VID12345678","status":{{"privacyStatus":"{final_privacy}"}}}}"#));
            }
            // status query
            let h = *held.lock().unwrap();
            if h == 0 {
                Reply::Send(308, vec![], String::new())
            } else {
                Reply::Send(308, vec![("Range", format!("bytes=0-{}", h - 1))], String::new())
            }
        }
    }

    fn start_good(final_privacy: &'static str, wrap: impl Fn(&Seen, usize) -> Option<Reply> + Send + 'static) -> (String, Arc<Mutex<Vec<Seen>>>, Arc<Mutex<u64>>) {
        let base_cell = Arc::new(Mutex::new(String::new()));
        let held = Arc::new(Mutex::new(0_u64));
        let mut inner = good_youtube(base_cell.clone(), held.clone(), final_privacy);
        let (base, log) = fake_youtube(move |seen, n| wrap(seen, n).unwrap_or_else(|| inner(seen, n)));
        *base_cell.lock().unwrap() = base.clone();
        (base, log, held)
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    #[test]
    fn chunk_ranges_cover_the_file_exactly() {
        assert_eq!(chunk_range(0, 600_000, 262_144), (0, 262_143));
        assert_eq!(chunk_range(262_144, 600_000, 262_144), (262_144, 524_287));
        assert_eq!(chunk_range(524_288, 600_000, 262_144), (524_288, 599_999));
        assert_eq!(chunk_range(0, 100, 262_144), (0, 99));
        assert_eq!(content_range(0, 99, 100), "bytes 0-99/100");
    }

    #[test]
    fn range_header_gives_the_next_byte() {
        assert_eq!(next_offset_from_range(Some("bytes=0-8388607")), 8_388_608);
        assert_eq!(next_offset_from_range(None), 0);
        assert_eq!(next_offset_from_range(Some("garbage")), 0);
    }

    #[test]
    fn video_ids_are_checked_before_use_in_a_url() {
        assert!(is_video_id("dQw4w9WgXcQ") && is_video_id("a-b_c1"));
        assert!(!is_video_id("") && !is_video_id("abc") && !is_video_id("a b c d e f") && !is_video_id("x/../y12345") && !is_video_id("a?b=cdefg"));
    }

    #[test]
    fn init_body_has_title_description_and_private_by_default_flag() {
        let b = init_body(&req("x.mp4"));
        assert_eq!(b["snippet"]["title"], "NIFTY 2026-11-06 trades");
        assert_eq!(b["status"]["privacyStatus"], "private");
        assert_eq!(b["status"]["selfDeclaredMadeForKids"], false);
        assert!(b["snippet"]["description"].as_str().unwrap().starts_with("0:00 Introduction"));
    }

    #[test]
    fn validation_catches_bad_requests() {
        let ok = temp_mp4("validate", 10);
        assert!(validate(&req(&ok)).is_ok());
        let mut r = req(&ok);
        r.title = "   ".into();
        assert!(validate(&r).unwrap_err().contains("title"));
        r.title = "x".repeat(101);
        assert!(validate(&r).unwrap_err().contains("too long"));
        r.title = "a<b".into();
        assert!(validate(&r).unwrap_err().contains("< and >"));
        let mut r = req(&ok);
        r.description = "x".repeat(5001);
        assert!(validate(&r).unwrap_err().contains("description"));
        r.description = "a > b".into();
        assert!(validate(&r).is_err());
        let mut r = req(&ok);
        r.privacy = "secret".into();
        assert!(validate(&r).is_err());
        assert!(validate(&req("/no/such/file.mp4")).unwrap_err().contains("not found"));
        assert!(validate(&req(&ok.replace(".mp4", ".webm"))).unwrap_err().contains(".mp4"));
        let empty = temp_mp4("empty", 0);
        assert!(validate(&req(&empty)).unwrap_err().contains("empty"));
        // 100 characters that take more than 100 bytes are fine: YouTube counts characters.
        let mut r = req(&ok);
        r.title = "é".repeat(100);
        assert!(validate(&r).is_ok());
    }

    #[test]
    fn api_errors_get_plain_wording() {
        let quota = r#"{"error":{"code":403,"message":"q","errors":[{"reason":"quotaExceeded"}]}}"#;
        assert!(friendly_api_error(403, quota).contains("tomorrow"));
        let signup = r#"{"error":{"errors":[{"reason":"youtubeSignupRequired"}]}}"#;
        assert!(friendly_api_error(401, signup).contains("no YouTube channel"));
        let title = r#"{"error":{"message":"Bad title","errors":[{"reason":"invalidTitle"}]}}"#;
        assert!(friendly_api_error(400, title).contains("Bad title"));
        assert!(friendly_api_error(401, "").contains("connect again"));
        assert!(friendly_api_error(418, "not json").contains("418"));
    }

    // ── against the fake server ──────────────────────────────────────────────

    #[test]
    fn uploads_in_chunks_and_reports_the_video() {
        let path = temp_mp4("happy", 600_000);
        let (base, log, held) = start_good("private", |_, _| None);
        let mut seen_progress = Vec::new();
        let result = run_upload(&cfg(&base), "tok", &req(&path), &UploadControl::default(), &mut |p, _| seen_progress.push(p)).unwrap();
        assert_eq!(result, UploadResult { video_id: "VID12345678".into(), url: "https://www.youtube.com/watch?v=VID12345678".into(), privacy: "private".into() });
        assert_eq!(*held.lock().unwrap(), 600_000);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 4, "start + 3 chunks");
        assert_eq!(log[0].method, "POST");
        assert!(log[0].path.contains("uploadType=resumable") && log[0].path.contains("part=snippet,status"));
        assert_eq!(log[0].headers.get("authorization").map(String::as_str), Some("Bearer tok"));
        assert_eq!(log[0].headers.get("x-upload-content-length").map(String::as_str), Some("600000"));
        assert_eq!(log[3].headers.get("content-range").map(String::as_str), Some("bytes 524288-599999/600000"));
        assert_eq!(log[3].body_len, 75_712);
        assert!(!log[1].headers.contains_key("authorization"), "the session address is the credential for chunks");
        assert!(seen_progress.windows(2).all(|w| w[0] <= w[1]), "progress never goes backwards: {seen_progress:?}");
        assert_eq!(*seen_progress.last().unwrap(), 100.0);
    }

    #[test]
    fn resumes_from_what_youtube_holds_after_a_dropped_connection() {
        let path = temp_mp4("resume", 600_000);
        // Request 0 = start, 1 = chunk 1, 2 = chunk 2: dropped after YouTube stored it.
        let (base, log, _) = start_good("private", |seen, n| {
            if n == 2 && seen.method == "PUT" {
                Some(Reply::Drop)
            } else {
                None
            }
        });
        // The dropped chunk was never recorded by `good_youtube` (the wrapper answered instead of it),
        // so YouTube still holds only chunk 1 and the client must resend chunk 2 from 262144.
        let result = run_upload(&cfg(&base), "tok", &req(&path), &UploadControl::default(), &mut |_, _| {}).unwrap();
        assert_eq!(result.video_id, "VID12345678");
        let ranges: Vec<String> = log.lock().unwrap().iter().filter_map(|s| s.headers.get("content-range").cloned()).collect();
        assert_eq!(ranges[0], "bytes 0-262143/600000");
        assert_eq!(ranges[1], "bytes 262144-524287/600000"); // dropped
        assert_eq!(ranges[2], "bytes */600000"); // asked how much it has
        assert_eq!(ranges[3], "bytes 262144-524287/600000"); // resumed from there
        assert_eq!(ranges[4], "bytes 524288-599999/600000");
    }

    #[test]
    fn a_5xx_is_retried_and_a_persistent_one_gives_up_with_a_clear_message() {
        let path = temp_mp4("5xx", 300_000);
        let (base, _, _) = start_good("private", |seen, n| if n == 1 && seen.method == "PUT" { Some(Reply::Send(503, vec![], String::new())) } else { None });
        assert!(run_upload(&cfg(&base), "tok", &req(&path), &UploadControl::default(), &mut |_, _| {}).is_ok());

        let base_cell = Arc::new(Mutex::new(String::new()));
        let cell = base_cell.clone();
        let (base2, log2) = fake_youtube(move |seen, _| {
            if seen.method == "POST" {
                Reply::Send(200, vec![("Location", format!("{}/s", cell.lock().unwrap()))], String::new())
            } else {
                Reply::Send(503, vec![], String::new())
            }
        });
        *base_cell.lock().unwrap() = base2.clone();
        let err = run_upload(&cfg(&base2), "tok", &req(&path), &UploadControl::default(), &mut |_, _| {}).unwrap_err();
        match err {
            UploadError::Failed(m) => assert!(m.contains("kept failing"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert!(log2.lock().unwrap().len() > 1, "it tried more than once");
    }

    #[test]
    fn quota_and_signup_errors_on_start_are_explained() {
        let path = temp_mp4("quota", 1000);
        let (base, _) = fake_youtube(|_, _| Reply::Send(403, vec![], r#"{"error":{"message":"x","errors":[{"reason":"quotaExceeded"}]}}"#.into()));
        match run_upload(&cfg(&base), "tok", &req(&path), &UploadControl::default(), &mut |_, _| {}).unwrap_err() {
            UploadError::Failed(m) => assert!(m.contains("tomorrow"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reports_the_privacy_youtube_actually_applied() {
        let path = temp_mp4("forced", 1000);
        let (base, _, _) = start_good("private", |_, _| None);
        let mut r = req(&path);
        r.privacy = "public".into();
        let result = run_upload(&cfg(&base), "tok", &r, &UploadControl::default(), &mut |_, _| {}).unwrap();
        assert_eq!((r.privacy.as_str(), result.privacy.as_str()), ("public", "private"));
    }

    #[test]
    fn cancel_before_and_during_the_upload() {
        let path = temp_mp4("cancel", 600_000);
        let (base, log, _) = start_good("private", |_, _| None);
        let control = UploadControl::default();
        control.cancel();
        assert_eq!(run_upload(&cfg(&base), "tok", &req(&path), &control, &mut |_, _| {}).unwrap_err(), UploadError::Cancelled);
        assert_eq!(log.lock().unwrap().len(), 0, "nothing is sent when cancelled first");

        let control = UploadControl::default();
        let result = run_upload(&cfg(&base), "tok", &req(&path), &control, &mut |p, _| {
            if p > 0.0 {
                control.cancel();
            }
        });
        assert_eq!(result.unwrap_err(), UploadError::Cancelled);
    }

    #[test]
    fn a_missing_video_id_in_the_final_answer_is_reported() {
        let path = temp_mp4("noid", 1000);
        let base_cell = Arc::new(Mutex::new(String::new()));
        let cell = base_cell.clone();
        let (base, _) = fake_youtube(move |seen, _| {
            if seen.method == "POST" {
                Reply::Send(200, vec![("Location", format!("{}/s", cell.lock().unwrap()))], String::new())
            } else {
                Reply::Send(200, vec![], "{}".into())
            }
        });
        *base_cell.lock().unwrap() = base.clone();
        match run_upload(&cfg(&base), "tok", &req(&path), &UploadControl::default(), &mut |_, _| {}).unwrap_err() {
            UploadError::Failed(m) => assert!(m.contains("no video id")),
            other => panic!("{other:?}"),
        }
    }
}
