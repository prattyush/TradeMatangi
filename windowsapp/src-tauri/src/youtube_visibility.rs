//! Change an uploaded video's visibility (Phase 24, after Y3).
//!
//! `videos.update` needs the `youtube.force-ssl` permission, which the connection only has when the user ticked it
//! on Google's screen. YouTube clears any `status` field that the request leaves out (for example `embeddable`), so
//! the current status is read first and sent back with only `privacyStatus` changed.

use super::youtube_upload::{friendly_api_error, is_video_id};
use serde_json::{json, Value};

pub const PRIVACIES: [&str; 3] = ["private", "unlisted", "public"];
/// The only status fields `videos.update` accepts. Read-only ones (`uploadStatus`, `madeForKids`...) are dropped.
const SETTABLE: [&str; 5] = ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"];

/// The `videos.update` body: the video's current settable status with `privacyStatus` replaced and `publishAt` removed
/// (it is only allowed on a never-published private video).
pub fn update_body(video_id: &str, current: &Value, privacy: &str) -> Result<Value, String> {
    let status = current
        .pointer("/items/0/status")
        .ok_or("YouTube found no video with that id on the connected account.")?;
    let mut next = serde_json::Map::new();
    for key in SETTABLE {
        if let Some(value) = status.get(key) {
            next.insert(key.to_string(), value.clone());
        }
    }
    next.insert("privacyStatus".into(), json!(privacy));
    Ok(json!({ "id": video_id, "status": Value::Object(next) }))
}

pub fn friendly_visibility_error(status: u16, body: &str) -> String {
    let json: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let reason = json.pointer("/error/errors/0/reason").and_then(|v| v.as_str()).unwrap_or("");
    match reason {
        "forbidden" | "insufficientPermissions" | "authError" | "authorizationRequired" => {
            "YouTube did not allow the change. Disconnect YouTube here, connect again and tick the permission to manage your videos. If the video is locked by YouTube, change it in YouTube Studio.".into()
        }
        "videoNotFound" | "notFound" => "YouTube found no such video on the connected account.".into(),
        _ if status == 403 => "YouTube refused to change this video's visibility. Change it in YouTube Studio.".into(),
        _ => friendly_api_error(status, body),
    }
}

/// Sets the visibility and returns what YouTube reports afterwards.
pub fn set_visibility(api_base: &str, token: &str, video_id: &str, privacy: &str) -> Result<String, String> {
    if !is_video_id(video_id) {
        return Err("That is not a YouTube video id.".into());
    }
    if !PRIVACIES.contains(&privacy) {
        return Err("Visibility must be private, unlisted or public.".into());
    }
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let listed = client
        .get(format!("{api_base}/youtube/v3/videos"))
        .query(&[("part", "status"), ("id", video_id)])
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("Could not reach YouTube: {e}"))?;
    let (code, text) = (listed.status().as_u16(), listed.text().unwrap_or_default());
    if code != 200 {
        return Err(friendly_visibility_error(code, &text));
    }
    let current: Value = serde_json::from_str(&text).map_err(|_| "YouTube returned an unreadable answer.".to_string())?;
    let body = update_body(video_id, &current, privacy)?;
    let updated = client
        .put(format!("{api_base}/youtube/v3/videos"))
        .query(&[("part", "status")])
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|e| format!("Could not reach YouTube: {e}"))?;
    let (code, text) = (updated.status().as_u16(), updated.text().unwrap_or_default());
    if code != 200 {
        return Err(friendly_visibility_error(code, &text));
    }
    let answer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(answer.pointer("/status/privacyStatus").and_then(|v| v.as_str()).unwrap_or(privacy).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn listed() -> Value {
        json!({ "items": [{ "id": "dQw4w9WgXcQ", "status": {
            "uploadStatus": "processed", "privacyStatus": "private", "publishAt": "2030-01-01T00:00:00Z",
            "license": "youtube", "embeddable": true, "publicStatsViewable": false, "madeForKids": false, "selfDeclaredMadeForKids": false } }] })
    }

    #[test]
    fn body_keeps_the_settable_status_and_changes_only_the_privacy() {
        let body = update_body("dQw4w9WgXcQ", &listed(), "unlisted").unwrap();
        assert_eq!(body["id"], "dQw4w9WgXcQ");
        let status = body["status"].as_object().unwrap();
        assert_eq!(status["privacyStatus"], "unlisted");
        assert_eq!(status["embeddable"], true);
        assert_eq!(status["license"], "youtube");
        assert_eq!(status["publicStatsViewable"], false);
        assert_eq!(status["selfDeclaredMadeForKids"], false);
        for dropped in ["uploadStatus", "madeForKids", "publishAt"] {
            assert!(!status.contains_key(dropped), "{dropped} must not be sent");
        }
    }

    #[test]
    fn body_needs_a_video_in_the_answer() {
        assert!(update_body("dQw4w9WgXcQ", &json!({ "items": [] }), "unlisted").unwrap_err().contains("no video"));
    }

    #[test]
    fn wording_of_permission_and_lock_errors() {
        let denied = r#"{"error":{"errors":[{"reason":"insufficientPermissions"}],"message":"x"}}"#;
        assert!(friendly_visibility_error(403, denied).contains("connect again"));
        assert!(friendly_visibility_error(403, "{}").contains("YouTube Studio"));
        assert!(friendly_visibility_error(404, r#"{"error":{"errors":[{"reason":"videoNotFound"}]}}"#).contains("no such video"));
    }

    #[test]
    fn input_is_checked_before_anything_is_sent() {
        assert!(set_visibility("http://127.0.0.1:1", "t", "bad", "unlisted").unwrap_err().contains("video id"));
        assert!(set_visibility("http://127.0.0.1:1", "t", "dQw4w9WgXcQ", "secret").unwrap_err().contains("Visibility"));
    }

    /// One answer per request, in order. Returns the base address and the requests seen as (method+path, authorization, body).
    fn fake(answers: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<(String, String, String)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (stream, (status, body)) in listener.incoming().zip(answers) {
                let mut stream = stream.unwrap();
                let mut data = Vec::new();
                let mut buf = [0_u8; 8192];
                let head_end = loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    data.extend_from_slice(&buf[..n]);
                    if let Some(p) = data.windows(4).position(|w| w == b"\r\n\r\n") { break p + 4; }
                    if n == 0 { break data.len(); }
                };
                let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
                let want: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
                while data.len() - head_end < want {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 { break; }
                    data.extend_from_slice(&buf[..n]);
                }
                let request_line = head.lines().next().unwrap_or("").split(" HTTP").next().unwrap_or("").to_string();
                let auth = head.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
                log.lock().unwrap().push((request_line, auth, String::from_utf8_lossy(&data[head_end..]).into_owned()));
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        (base, seen)
    }

    #[test]
    fn reads_the_status_then_updates_it_with_the_token() {
        let updated = json!({ "id": "dQw4w9WgXcQ", "status": { "privacyStatus": "unlisted" } }).to_string();
        let (base, seen) = fake(vec![(200, listed().to_string()), (200, updated)]);
        let applied = set_visibility(&base, "TOKEN", "dQw4w9WgXcQ", "unlisted").unwrap();
        assert_eq!(applied, "unlisted");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "GET /youtube/v3/videos?part=status&id=dQw4w9WgXcQ");
        assert_eq!(seen[1].0, "PUT /youtube/v3/videos?part=status");
        assert!(seen[0].1.contains("Bearer TOKEN") && seen[1].1.contains("Bearer TOKEN"));
        let sent: Value = serde_json::from_str(&seen[1].2).unwrap();
        assert_eq!(sent["status"]["privacyStatus"], "unlisted");
        assert_eq!(sent["status"]["embeddable"], true);
    }

    #[test]
    fn a_refusal_is_explained_and_reports_what_youtube_still_has() {
        let denied = r#"{"error":{"errors":[{"reason":"forbidden"}],"message":"Forbidden"}}"#.to_string();
        let (base, _) = fake(vec![(200, listed().to_string()), (403, denied)]);
        assert!(set_visibility(&base, "TOKEN", "dQw4w9WgXcQ", "unlisted").unwrap_err().contains("connect again"));
    }

    #[test]
    fn reports_the_visibility_youtube_applied_even_if_it_differs() {
        let kept = json!({ "id": "dQw4w9WgXcQ", "status": { "privacyStatus": "private" } }).to_string();
        let (base, _) = fake(vec![(200, listed().to_string()), (200, kept)]);
        assert_eq!(set_visibility(&base, "T", "dQw4w9WgXcQ", "unlisted").unwrap(), "private");
    }
}
