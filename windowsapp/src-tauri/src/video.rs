//! Trading Video Maker back end: runs the bundled ffmpeg on this computer.
//!
//! A job is either "convert the whole recording to mp4" or "cut the listed windows and join them".
//! The cut path first remuxes the webm to mkv without re-encoding (MediaRecorder files have no
//! duration or seek index), then encodes each window on its own (fast, accurate seeking, constant
//! memory), then joins the segments without re-encoding.
//!
//! Everything that builds arguments or parses ffmpeg output is a plain function so it can be unit
//! tested; the job runner takes a progress callback and a cancel handle.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const OUTPUT_FPS: u32 = 30;

// ---------------------------------------------------------------------------------------------
// Finding ffmpeg
// ---------------------------------------------------------------------------------------------

/// Places to look for ffmpeg, best first: an explicit override, the copy installed beside the app,
/// then whatever is on PATH (used by developers and tests).
pub fn ffmpeg_candidates(exe_dir: Option<&Path>, override_path: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = override_path.filter(|p| !p.trim().is_empty()) {
        out.push(PathBuf::from(p));
    }
    if let Some(dir) = exe_dir {
        out.push(dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }));
    }
    out.push(PathBuf::from("ffmpeg"));
    out
}

fn base_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// First candidate that runs `-version`, with its first output line.
pub fn resolve_ffmpeg() -> Option<(PathBuf, String)> {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let override_path = std::env::var("TRADEMATANGI_FFMPEG").ok();
    for candidate in ffmpeg_candidates(exe_dir.as_deref(), override_path.as_deref()) {
        let output = base_command(&candidate).arg("-version").stdin(Stdio::null()).output();
        if let Ok(out) = output {
            if out.status.success() {
                let first = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("ffmpeg").to_string();
                return Some((candidate, first));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Parsing ffmpeg output
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Clone)]
pub struct ProbeInfo {
    pub has_video: bool,
    pub has_audio: bool,
    /// None for MediaRecorder webm files, which carry no duration.
    pub duration_sec: Option<f64>,
}

/// Reads the report `ffmpeg -i file` prints on stderr.
pub fn parse_probe(stderr: &str) -> ProbeInfo {
    let mut info = ProbeInfo::default();
    for line in stderr.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("Stream #") {
            if trimmed.contains(": Video:") {
                info.has_video = true;
            }
            if trimmed.contains(": Audio:") {
                info.has_audio = true;
            }
        } else if let Some(rest) = trimmed.strip_prefix("Duration:") {
            let value = rest.split(',').next().unwrap_or("").trim();
            info.duration_sec = parse_clock(value);
        }
    }
    info
}

/// "01:02:03.50" -> seconds. "N/A" -> None.
pub fn parse_clock(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

#[derive(Debug, PartialEq)]
pub enum ProgressLine {
    /// Seconds of output written so far.
    OutTime(f64),
    End,
    Other,
}

/// One line of `-progress pipe:1` output.
pub fn parse_progress_line(line: &str) -> ProgressLine {
    let line = line.trim();
    if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
        // ffmpeg reports both in microseconds (the "_ms" name is a long-standing misnomer).
        return v.parse::<f64>().map(|us| ProgressLine::OutTime((us / 1_000_000.0).max(0.0))).unwrap_or(ProgressLine::Other);
    }
    if line == "progress=end" {
        return ProgressLine::End;
    }
    ProgressLine::Other
}

// ---------------------------------------------------------------------------------------------
// Building ffmpeg arguments
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoder {
    X264,
    Nvenc,
    Qsv,
    Amf,
}

impl Encoder {
    pub fn label(self) -> &'static str {
        match self {
            Encoder::X264 => "x264 (CPU)",
            Encoder::Nvenc => "NVIDIA NVENC",
            Encoder::Qsv => "Intel Quick Sync",
            Encoder::Amf => "AMD AMF",
        }
    }

    fn codec(self) -> &'static str {
        match self {
            Encoder::X264 => "libx264",
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Qsv => "h264_qsv",
            Encoder::Amf => "h264_amf",
        }
    }

    /// Video encoder options for a quality level (lower `crf` = better, larger).
    pub fn quality_args(self, crf: u32) -> Vec<String> {
        let q = crf.to_string();
        let args: Vec<&str> = match self {
            Encoder::X264 => vec!["-preset", "veryfast", "-crf", &q],
            Encoder::Nvenc => vec!["-preset", "p4", "-rc", "vbr", "-cq", &q, "-b:v", "0"],
            Encoder::Qsv => vec!["-preset", "veryfast", "-global_quality", &q],
            Encoder::Amf => vec!["-quality", "balanced", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q],
        };
        args.into_iter().map(String::from).collect()
    }
}

#[derive(Debug, Clone)]
pub struct EncodeSpec {
    pub input: String,
    pub output: String,
    pub start_sec: Option<f64>,
    pub duration_sec: Option<f64>,
    pub has_audio: bool,
    pub encoder: Encoder,
    pub crf: u32,
}

fn s(v: &str) -> String {
    v.to_string()
}

fn secs(v: f64) -> String {
    format!("{:.3}", v.max(0.0))
}

/// Re-encode (all of the input, or one window of it) to H.264 + AAC at a constant frame rate.
pub fn encode_args(spec: &EncodeSpec) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-nostats", "-progress", "pipe:1"].iter().map(|x| s(x)).collect();
    // -ss before -i seeks quickly; with re-encoding it is still frame accurate.
    if let Some(start) = spec.start_sec {
        a.extend([s("-ss"), secs(start)]);
    }
    if let Some(d) = spec.duration_sec {
        a.extend([s("-t"), secs(d)]);
    }
    a.extend([s("-i"), spec.input.clone()]);
    // Constant frame rate and even dimensions (required by yuv420p H.264).
    a.extend([
        s("-vf"),
        format!("fps={OUTPUT_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"),
        s("-c:v"),
        s(spec.encoder.codec()),
    ]);
    a.extend(spec.encoder.quality_args(spec.crf));
    if spec.has_audio {
        a.extend(["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"].iter().map(|x| s(x)));
    } else {
        a.push(s("-an"));
    }
    a.extend([s("-movflags"), s("+faststart"), spec.output.clone()]);
    a
}

/// Copy a webm into a Matroska file without re-encoding. The result has a duration and a seek index.
pub fn remux_args(input: &str, output: &str) -> Vec<String> {
    ["-hide_banner", "-y", "-nostdin", "-nostats", "-progress", "pipe:1", "-fflags", "+genpts", "-i", input, "-c", "copy", output]
        .iter()
        .map(|x| s(x))
        .collect()
}

/// Join already-encoded segments (same codec settings) without re-encoding.
pub fn concat_args(list_file: &str, output: &str) -> Vec<String> {
    ["-hide_banner", "-y", "-nostdin", "-nostats", "-progress", "pipe:1", "-f", "concat", "-safe", "0", "-i", list_file, "-c", "copy", "-movflags", "+faststart", output]
        .iter()
        .map(|x| s(x))
        .collect()
}

/// Contents of the list file for the concat demuxer. Paths use forward slashes; quotes are escaped.
pub fn concat_list(paths: &[String]) -> String {
    let mut out = String::new();
    for p in paths {
        let escaped = p.replace('\\', "/").replace('\'', "'\\''");
        out.push_str(&format!("file '{escaped}'\n"));
    }
    out
}

/// A tiny encode used to check that a hardware encoder really works on this machine.
pub fn encoder_test_args(encoder: Encoder) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2:r=30", "-c:v", encoder.codec()]
        .iter()
        .map(|x| s(x))
        .collect();
    a.extend(encoder.quality_args(28));
    a.extend(["-pix_fmt", "yuv420p", "-f", "null", "-"].iter().map(|x| s(x)));
    a
}

// ---------------------------------------------------------------------------------------------
// Running ffmpeg
// ---------------------------------------------------------------------------------------------

/// Lets the UI cancel a running job: sets a flag and kills the current ffmpeg process.
#[derive(Default)]
pub struct JobControl {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl JobControl {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(Debug)]
pub enum RunError {
    Cancelled,
    Failed(String),
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Runs ffmpeg once. `on_out_time` gets the seconds of output written so far.
pub fn run_ffmpeg(ffmpeg: &Path, args: &[String], control: &JobControl, on_out_time: &mut dyn FnMut(f64)) -> Result<(), RunError> {
    if control.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let mut child = base_command(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::Failed(format!("Could not start ffmpeg: {e}")))?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    *control.child.lock().map_err(|_| RunError::Failed("Job state is locked".into()))? = Some(child);

    // Drain stderr on its own thread so a full pipe can never stall ffmpeg.
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            text = String::from_utf8_lossy(&bytes).into_owned();
        }
        text
    });

    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let ProgressLine::OutTime(t) = parse_progress_line(&line) {
                on_out_time(t);
            }
        }
    }

    let status = {
        let mut guard = control.child.lock().map_err(|_| RunError::Failed("Job state is locked".into()))?;
        let result = guard.as_mut().map(|c| c.wait());
        *guard = None;
        result
    };
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if control.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    match status {
        Some(Ok(st)) if st.success() => Ok(()),
        Some(Ok(st)) => Err(RunError::Failed(format!("ffmpeg stopped with {st}.\n{}", last_lines(&stderr_text, 6)))),
        Some(Err(e)) => Err(RunError::Failed(format!("ffmpeg could not be waited on: {e}"))),
        None => Err(RunError::Failed("ffmpeg did not start".into())),
    }
}

/// Reads the stream layout of a file (`ffmpeg -i`, which exits non-zero without an output; that is fine).
pub fn probe(ffmpeg: &Path, input: &str) -> Result<ProbeInfo, String> {
    let out = base_command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i", input])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    let info = parse_probe(&String::from_utf8_lossy(&out.stderr));
    if !info.has_video {
        return Err(format!("ffmpeg could not find a video stream in this file.\n{}", last_lines(&String::from_utf8_lossy(&out.stderr), 4)));
    }
    Ok(info)
}

/// Hardware encoders are used only when a one-frame test encode succeeds on this machine.
pub fn choose_encoder(ffmpeg: &Path, prefer_hardware: bool) -> Encoder {
    if !prefer_hardware {
        return Encoder::X264;
    }
    for candidate in [Encoder::Nvenc, Encoder::Qsv, Encoder::Amf] {
        let ok = base_command(ffmpeg)
            .args(encoder_test_args(candidate))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|st| st.success())
            .unwrap_or(false);
        if ok {
            return candidate;
        }
    }
    Encoder::X264
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct CutWindowReq {
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "endSec")]
    pub end_sec: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoJobRequest {
    pub input: String,
    pub output: String,
    /// Empty = convert the whole recording.
    #[serde(default)]
    pub windows: Vec<CutWindowReq>,
    /// Length of the recording in seconds, used for progress when converting the whole file.
    #[serde(default, rename = "totalSec")]
    pub total_sec: Option<f64>,
    #[serde(default = "default_crf")]
    pub crf: u32,
    #[serde(default = "default_hardware", rename = "preferHardware")]
    pub prefer_hardware: bool,
}

fn default_crf() -> u32 {
    23
}
fn default_hardware() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Progress {
    pub phase: String,
    pub percent: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobResult {
    pub output: String,
    pub encoder: String,
    #[serde(rename = "keptSec")]
    pub kept_sec: f64,
}

pub fn validate_request(req: &VideoJobRequest) -> Result<(), String> {
    if req.input.trim().is_empty() || req.output.trim().is_empty() {
        return Err("Choose an input recording and an output file.".into());
    }
    if Path::new(&req.input) == Path::new(&req.output) {
        return Err("The output file must be different from the recording.".into());
    }
    if !req.output.to_lowercase().ends_with(".mp4") {
        return Err("The output file must end in .mp4.".into());
    }
    for w in &req.windows {
        if !(w.start_sec.is_finite() && w.end_sec.is_finite()) || w.start_sec < 0.0 || w.end_sec <= w.start_sec {
            return Err("A cut window has an invalid start or end.".into());
        }
    }
    if !(10..=40).contains(&req.crf) {
        return Err("Quality (CRF) must be between 10 and 40.".into());
    }
    Ok(())
}

fn percent(done: f64, total: f64) -> f64 {
    if total <= 0.0 {
        0.0
    } else {
        (done / total * 100.0).clamp(0.0, 99.0)
    }
}

/// Runs a job to completion. Temporary files live in `work_dir`, which is removed before returning.
pub fn run_job(
    ffmpeg: &Path,
    req: &VideoJobRequest,
    work_dir: &Path,
    control: &JobControl,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<JobResult, RunError> {
    validate_request(req).map_err(RunError::Failed)?;
    let outcome = run_job_inner(ffmpeg, req, work_dir, control, on_progress);
    let _ = std::fs::remove_dir_all(work_dir);
    if matches!(outcome, Err(_)) {
        // Never leave a half-written output behind.
        let _ = std::fs::remove_file(&req.output);
    }
    outcome
}

struct StepProgress<'a> {
    /// Seconds of output already produced by earlier steps.
    base: f64,
    total: f64,
    message: &'a str,
}

/// One encode step, retried once with x264 if a hardware encoder fails.
fn encode_step(
    ffmpeg: &Path,
    control: &JobControl,
    spec_for: &dyn Fn(Encoder) -> EncodeSpec,
    step: StepProgress,
    on_progress: &mut dyn FnMut(Progress),
    encoder: &mut Encoder,
) -> Result<(), RunError> {
    let mut attempt = |enc: Encoder| {
        run_ffmpeg(ffmpeg, &encode_args(&spec_for(enc)), control, &mut |t| {
            on_progress(Progress { phase: "encoding".into(), percent: percent(step.base + t, step.total), message: step.message.to_string() })
        })
    };
    match attempt(*encoder) {
        Err(RunError::Failed(_)) if *encoder != Encoder::X264 => {
            *encoder = Encoder::X264;
            attempt(Encoder::X264)
        }
        other => other,
    }
}

fn run_job_inner(
    ffmpeg: &Path,
    req: &VideoJobRequest,
    work_dir: &Path,
    control: &JobControl,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<JobResult, RunError> {
    let info = probe(ffmpeg, &req.input).map_err(RunError::Failed)?;
    let mut encoder = choose_encoder(ffmpeg, req.prefer_hardware);
    std::fs::create_dir_all(work_dir).map_err(|e| RunError::Failed(format!("Could not create a working folder: {e}")))?;

    let total = if req.windows.is_empty() {
        req.total_sec.or(info.duration_sec).unwrap_or(0.0)
    } else {
        req.windows.iter().map(|w| w.end_sec - w.start_sec).sum()
    };

    if req.windows.is_empty() {
        on_progress(Progress { phase: "encoding".into(), percent: 0.0, message: "Converting to mp4".into() });
        let input = req.input.clone();
        let output = req.output.clone();
        let crf = req.crf;
        let has_audio = info.has_audio;
        encode_step(
            ffmpeg,
            control,
            &|enc| EncodeSpec { input: input.clone(), output: output.clone(), start_sec: None, duration_sec: None, has_audio, encoder: enc, crf },
            StepProgress { base: 0.0, total, message: "Converting to mp4" },
            on_progress,
            &mut encoder,
        )?;
        return Ok(JobResult { output: req.output.clone(), encoder: encoder.label().into(), kept_sec: total });
    }

    on_progress(Progress { phase: "preparing".into(), percent: 0.0, message: "Preparing the recording".into() });
    let remuxed = work_dir.join("source.mkv").to_string_lossy().into_owned();
    run_ffmpeg(ffmpeg, &remux_args(&req.input, &remuxed), control, &mut |_| {})?;

    let mut segments = Vec::new();
    let mut done = 0.0;
    let count = req.windows.len();
    for (i, w) in req.windows.iter().enumerate() {
        let segment = work_dir.join(format!("segment_{i:03}.mp4")).to_string_lossy().into_owned();
        let length = w.end_sec - w.start_sec;
        let (input, crf, has_audio) = (remuxed.clone(), req.crf, info.has_audio);
        let seg_out = segment.clone();
        let message = format!("Cutting part {} of {}", i + 1, count);
        encode_step(
            ffmpeg,
            control,
            &|enc| EncodeSpec { input: input.clone(), output: seg_out.clone(), start_sec: Some(w.start_sec), duration_sec: Some(length), has_audio, encoder: enc, crf },
            StepProgress { base: done, total, message: &message },
            on_progress,
            &mut encoder,
        )?;
        segments.push(segment);
        done += length;
    }

    on_progress(Progress { phase: "joining".into(), percent: 99.0, message: "Joining the parts".into() });
    let list_path = work_dir.join("segments.txt");
    std::fs::write(&list_path, concat_list(&segments)).map_err(|e| RunError::Failed(format!("Could not write the segment list: {e}")))?;
    run_ffmpeg(ffmpeg, &concat_args(&list_path.to_string_lossy(), &req.output), control, &mut |_| {})?;
    Ok(JobResult { output: req.output.clone(), encoder: encoder.label().into(), kept_sec: total })
}

/// Reads the length of a finished file by asking ffmpeg (`Duration:` line). Used by tests and checks.
pub fn media_duration(ffmpeg: &Path, file: &str) -> Option<f64> {
    probe(ffmpeg, file).ok().and_then(|p| p.duration_sec)
}

/// Shared handle for the one job that may run at a time.
#[derive(Default, Clone)]
pub struct VideoJobState(pub Arc<Mutex<Option<Arc<JobControl>>>>);

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(start: Option<f64>, dur: Option<f64>, audio: bool, enc: Encoder) -> EncodeSpec {
        EncodeSpec { input: "in.mkv".into(), output: "out.mp4".into(), start_sec: start, duration_sec: dur, has_audio: audio, encoder: enc, crf: 23 }
    }

    #[test]
    fn candidates_prefer_override_then_installed_copy_then_path() {
        let c = ffmpeg_candidates(Some(Path::new("/app")), Some("/custom/ffmpeg"));
        assert_eq!(c[0], PathBuf::from("/custom/ffmpeg"));
        assert!(c[1].starts_with("/app"));
        assert_eq!(c[2], PathBuf::from("ffmpeg"));
        assert_eq!(ffmpeg_candidates(None, Some("  ")), vec![PathBuf::from("ffmpeg")]);
    }

    #[test]
    fn probe_reads_streams_and_a_missing_duration() {
        let text = "Input #0, matroska,webm, from 'a.webm':\n  Duration: N/A, start: 0.000000, bitrate: N/A\n  Stream #0:0: Video: vp9, yuv420p, 1920x1080\n  Stream #0:1: Audio: opus, 48000 Hz, stereo\n";
        let info = parse_probe(text);
        assert_eq!(info, ProbeInfo { has_video: true, has_audio: true, duration_sec: None });
        let text2 = "  Duration: 00:01:02.50, start: 0.0, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264\n";
        assert_eq!(parse_probe(text2), ProbeInfo { has_video: true, has_audio: false, duration_sec: Some(62.5) });
        assert_eq!(parse_probe("nothing useful"), ProbeInfo::default());
    }

    #[test]
    fn clock_parsing() {
        assert_eq!(parse_clock("01:02:03.50"), Some(3723.5));
        assert_eq!(parse_clock("N/A"), None);
        assert_eq!(parse_clock("12:34"), None);
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress_line("out_time_us=2500000"), ProgressLine::OutTime(2.5));
        assert_eq!(parse_progress_line("out_time_ms=1000000"), ProgressLine::OutTime(1.0));
        assert_eq!(parse_progress_line("out_time_us=N/A"), ProgressLine::Other);
        assert_eq!(parse_progress_line("out_time_us=-5"), ProgressLine::OutTime(0.0));
        assert_eq!(parse_progress_line("progress=end"), ProgressLine::End);
        assert_eq!(parse_progress_line("frame=12"), ProgressLine::Other);
    }

    #[test]
    fn encode_args_for_a_window_with_audio() {
        let a = encode_args(&spec(Some(12.5), Some(30.0), true, Encoder::X264));
        let joined = a.join(" ");
        assert!(joined.contains("-ss 12.500 -t 30.000 -i in.mkv"), "{joined}");
        assert!(joined.contains("fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"));
        assert!(joined.contains("-c:v libx264 -preset veryfast -crf 23"));
        assert!(joined.contains("-c:a aac -b:a 128k"));
        assert!(joined.ends_with("-movflags +faststart out.mp4"));
        // The seek must come before the input for fast, accurate cutting.
        assert!(joined.find("-ss").unwrap() < joined.find("-i in.mkv").unwrap());
    }

    #[test]
    fn encode_args_without_audio_or_window() {
        let a = encode_args(&spec(None, None, false, Encoder::X264)).join(" ");
        assert!(a.contains("-an"));
        assert!(!a.contains("-ss") && !a.contains(" -t "));
        assert!(!a.contains("-c:a"));
    }

    #[test]
    fn hardware_encoder_options() {
        assert!(encode_args(&spec(None, None, true, Encoder::Nvenc)).join(" ").contains("-c:v h264_nvenc -preset p4 -rc vbr -cq 23"));
        assert!(encode_args(&spec(None, None, true, Encoder::Qsv)).join(" ").contains("-c:v h264_qsv -preset veryfast -global_quality 23"));
        assert!(encode_args(&spec(None, None, true, Encoder::Amf)).join(" ").contains("-c:v h264_amf -quality balanced -rc cqp -qp_i 23 -qp_p 23"));
    }

    #[test]
    fn remux_and_concat_args() {
        assert!(remux_args("a.webm", "b.mkv").join(" ").contains("-fflags +genpts -i a.webm -c copy b.mkv"));
        assert!(concat_args("l.txt", "o.mp4").join(" ").contains("-f concat -safe 0 -i l.txt -c copy -movflags +faststart o.mp4"));
    }

    #[test]
    fn concat_list_escapes_paths() {
        let list = concat_list(&["C:\\Users\\me\\a b\\seg_000.mp4".into(), "/tmp/it's/seg.mp4".into()]);
        assert_eq!(list, "file 'C:/Users/me/a b/seg_000.mp4'\nfile '/tmp/it'\\''s/seg.mp4'\n");
    }

    #[test]
    fn request_validation() {
        let ok = VideoJobRequest { input: "a.webm".into(), output: "b.mp4".into(), windows: vec![CutWindowReq { start_sec: 1.0, end_sec: 5.0 }], total_sec: None, crf: 23, prefer_hardware: false };
        assert!(validate_request(&ok).is_ok());
        let mut bad = ok.clone();
        bad.output = "b.mkv".into();
        assert!(validate_request(&bad).unwrap_err().contains(".mp4"));
        let mut same = ok.clone();
        same.output = "a.webm".into();
        assert!(validate_request(&same).is_err());
        let mut window = ok.clone();
        window.windows = vec![CutWindowReq { start_sec: 5.0, end_sec: 5.0 }];
        assert!(validate_request(&window).is_err());
        let mut crf = ok.clone();
        crf.crf = 5;
        assert!(validate_request(&crf).is_err());
        let mut empty = ok;
        empty.input = " ".into();
        assert!(validate_request(&empty).is_err());
    }

    #[test]
    fn progress_percent_is_capped_below_done() {
        assert_eq!(percent(50.0, 100.0), 50.0);
        assert_eq!(percent(500.0, 100.0), 99.0);
        assert_eq!(percent(5.0, 0.0), 0.0);
    }

    // ---- Integration tests: run the real ffmpeg when one is available ----------------------

    fn ffmpeg_or_skip() -> Option<PathBuf> {
        let found = resolve_ffmpeg().map(|(p, _)| p);
        if found.is_none() {
            eprintln!("skipping: no ffmpeg available");
        }
        found
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tm-video-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 20 s test recording like MediaRecorder makes: webm piped without a duration.
    fn make_webm(ffmpeg: &Path, dir: &Path, with_audio: bool) -> Option<String> {
        let out = dir.join("in.webm");
        let mut args: Vec<String> = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=321x181:rate=25:duration=20"].iter().map(|x| x.to_string()).collect();
        if with_audio {
            args.extend(["-f", "lavfi", "-i", "sine=frequency=440:duration=20"].iter().map(|x| x.to_string()));
        }
        args.extend(["-c:v", "libvpx", "-b:v", "500k"].iter().map(|x| x.to_string()));
        if with_audio {
            args.extend(["-c:a", "libopus"].iter().map(|x| x.to_string()));
        }
        // Writing to a non-seekable pipe leaves the duration out of the header, like a browser recording.
        let mut child = base_command(ffmpeg).args(&args).args(["-f", "webm", "pipe:1"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let mut bytes = Vec::new();
        child.stdout.take()?.read_to_end(&mut bytes).ok()?;
        if !child.wait().ok()?.success() || bytes.is_empty() {
            return None;
        }
        std::fs::write(&out, bytes).ok()?;
        Some(out.to_string_lossy().into_owned())
    }

    fn request(input: &str, dir: &Path, windows: Vec<(f64, f64)>) -> VideoJobRequest {
        VideoJobRequest {
            input: input.into(),
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            windows: windows.into_iter().map(|(a, b)| CutWindowReq { start_sec: a, end_sec: b }).collect(),
            total_sec: Some(20.0),
            crf: 28,
            prefer_hardware: false,
        }
    }

    #[test]
    fn integration_cuts_windows_and_joins_them() {
        let Some(ffmpeg) = ffmpeg_or_skip() else { return };
        let dir = temp_dir("cut");
        let Some(input) = make_webm(&ffmpeg, &dir, true) else { return eprintln!("skipping: ffmpeg cannot make a test webm") };
        assert_eq!(media_duration(&ffmpeg, &input), None, "a browser-style webm has no duration");
        let req = request(&input, &dir, vec![(2.0, 6.0), (10.0, 13.0)]);
        let mut seen = Vec::new();
        let result = run_job(&ffmpeg, &req, &dir.join("work"), &JobControl::default(), &mut |p| seen.push(p)).expect("job failed");
        let dur = media_duration(&ffmpeg, &result.output).expect("output has a duration");
        assert!((dur - 7.0).abs() < 0.5, "expected about 7 s, got {dur}");
        let info = probe(&ffmpeg, &result.output).unwrap();
        assert!(info.has_video && info.has_audio);
        assert!(seen.iter().any(|p| p.phase == "encoding") && seen.iter().any(|p| p.phase == "joining"));
        assert!(seen.windows(2).all(|w| w[1].percent >= 0.0));
        assert!(!dir.join("work").exists(), "temp files are removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integration_converts_the_whole_recording_without_audio() {
        let Some(ffmpeg) = ffmpeg_or_skip() else { return };
        let dir = temp_dir("convert");
        let Some(input) = make_webm(&ffmpeg, &dir, false) else { return eprintln!("skipping: ffmpeg cannot make a test webm") };
        let req = request(&input, &dir, vec![]);
        let result = run_job(&ffmpeg, &req, &dir.join("work"), &JobControl::default(), &mut |_| {}).expect("job failed");
        let dur = media_duration(&ffmpeg, &result.output).expect("duration");
        assert!((dur - 20.0).abs() < 0.6, "expected about 20 s, got {dur}");
        assert!(!probe(&ffmpeg, &result.output).unwrap().has_audio);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integration_cancel_stops_the_job_and_leaves_nothing_behind() {
        let Some(ffmpeg) = ffmpeg_or_skip() else { return };
        let dir = temp_dir("cancel");
        let Some(input) = make_webm(&ffmpeg, &dir, true) else { return eprintln!("skipping: ffmpeg cannot make a test webm") };
        let req = request(&input, &dir, vec![(0.0, 19.0)]);
        let control = JobControl::default();
        control.cancel();
        let outcome = run_job(&ffmpeg, &req, &dir.join("work"), &control, &mut |_| {});
        assert!(matches!(outcome, Err(RunError::Cancelled)));
        assert!(!Path::new(&req.output).exists());
        assert!(!dir.join("work").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integration_reports_a_clear_error_for_a_file_that_is_not_a_video() {
        let Some(ffmpeg) = ffmpeg_or_skip() else { return };
        let dir = temp_dir("bad");
        let input = dir.join("notvideo.webm");
        std::fs::write(&input, b"this is not a video").unwrap();
        let req = request(&input.to_string_lossy(), &dir, vec![]);
        match run_job(&ffmpeg, &req, &dir.join("work"), &JobControl::default(), &mut |_| {}) {
            Err(RunError::Failed(m)) => assert!(m.contains("video stream"), "{m}"),
            other => panic!("expected a failure, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
