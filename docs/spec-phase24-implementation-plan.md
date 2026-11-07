# Phase 24 — Desktop Tools: Trading Video Maker — implementation plan

Requirements: `docs/spec-phase24.md` (the user's text, unchanged). This file is the agreed design and sprint plan (approved 2026-11-07). Update the status table at the end of every sprint.

## Status

| Sprint | Scope | Branch target | Status |
|---|---|---|---|
| 0 | Docs and plan | dev | Merged (#780) |
| 1 | Recorder metadata (`.rec.json`) | dev AND preprod (same branch, two PRs) | Merged to both (#781 preprod, #782 dev). Manual check in `docs/recording-metadata.md` pending |
| 2 | Timeline, cut plan, chapters (pure logic) | dev | Not started |
| 3 | Rust: ffmpeg job, file picker, packaging | dev | Not started |
| 4 | Tools menu and Video Maker UI | dev | Not started |
| 5 | Hardening and acceptance | dev | Not started |
| 6 | Promote the tool to preprod | on request only | Not started |

## Context
`docs/spec-phase24.md` asks for a desktop-only tool that takes a screen recording (`.webm`), converts it to a seekable `.mp4`, cuts it down to the periods around real trades, and produces a YouTube chapter list ("m:ss Trade N, P&L %").
Why desktop only: the work (video decode and encode) should use the user's own CPU, RAM and disk, not the shared server.

Decisions from the user (2026-11-07):
- **Old videos are not needed.** So every video will have a metadata file written by the recorder, and the tool reads it. There are no manual sync points to type.
- **Bundle ffmpeg in the Windows installer.**
- **Only new recordings are supported** (no old videos).
- **The recorder `.json` change must also reach `preprod`**, because the user will record during the real-trading test there. This is an agreed exception to "preprod takes bug fixes only". The Video Maker tool itself (Sprints 2-4) stays on `dev` only; it just reads the `.json` that preprod-recorded videos carry.

## Feasibility: yes, with one change to recording
| Part | Verdict | Notes |
|---|---|---|
| webm → mp4 | Feasible | ffmpeg decodes VP9/Opus and encodes H.264/AAC. MediaRecorder webm has no duration and no seek index (that is why the website video has no seek bar), so the output is re-encoded at a constant 30 fps. |
| Cutting trade windows | Feasible | One ffmpeg run with `trim` + `concat` filters decodes once and encodes only the kept parts. Frame-accurate. |
| Using the host PC | Feasible | ffmpeg runs as a local child process. It reports progress, can be cancelled, and can use a hardware encoder (NVENC, QuickSync, AMD) if present. |
| Syncing video to trades | Feasible only with recorder metadata | The recording has no clock today (no start time, no session id). Pausing the recorder removes the paused time from the file, and replay "speed" is seconds-per-market-second (0.05 means 20x fast), with pauses that freeze market time but not the video. So two typed sync points would drift. Logging the clocks while recording is exact. |
| Installer size | Acceptable | A GPL ffmpeg is about 100-130 MB. NSIS compresses it to roughly +40-60 MB on the current ~220 MB installer. |
| Licence | Needs care | H.264 (libx264) is only in **GPL** ffmpeg builds (my earlier "LGPL" wording was wrong). Running it as a separate program is allowed, but the installer must carry the GPL licence text and a link to the ffmpeg source. |

Risks to watch:
- `trading.current_time` / `sim.currentSimTime` must update often enough to be a good clock (confirm in Sprint 1; fall back to the latest tick time if not).
- 1-hour 1080p VP9 decode plus x264 encode: expect about 2-4x real time on a modern CPU. Only the kept parts are encoded, which cuts this a lot. Show progress and allow cancel.
- The ffmpeg binary (~100 MB) must not be committed to git (GitHub's limit is 100 MB per file). CI downloads a pinned build and checks its SHA-256.

## Design

### 1. Recorder metadata (shared by website and desktop)
`shared/useRecording.ts` (used by both apps) gets an optional `clock` callback: `() => { sessionId, sessionType, symbol, date, marketTime }[]`.
While recording, once per second, it logs a sample. It also logs start, pause, resume and stop. It writes `<name>.rec.json` next to the video:
```
{ version, appVersion, wallStartMs, events:[{t:"start|pause|resume|stop", wallMs}],
  sessions:[{sessionId, sessionType, symbol, date, candleSeconds, replaySpeed?, stepwise?}],
  samples:[{wallMs, sessionId, marketTime}] }
```
- Video time for a wall time = wall time minus all paused spans since the start.
- Market time → wall time uses the samples, so the tool needs neither replay speed nor session pauses. It works the same for replay, stepwise, paper and real. For paper and real, the trade time is the receipt time plus 19800 s, so it also matches directly.
- Website: `App.tsx:2372` passes the clock (`sim.sessionId`, `sim.currentSimTime`), and the hook downloads the `.json` after the `.webm`. Desktop: `ScreenController` (`windowsapp/src/App.tsx:2801`) passes `trading.session.session_id` and `trading.current_time`.
- Both apps save the `.json` the same way as the video (a download beside it, same base name). The desktop keeps the WebView's blob download for now. (Possible later improvement, not in Sprint 1: save natively from Rust, which stops holding an hour of video in RAM and removes the unverified WebView download behaviour.)
- **Safe for real trading:** the sampling code only reads state that already exists, runs in a timer, and is wrapped in try/catch. A failure only means no `.json` (the video is still saved). It never touches orders, sessions or streams, and it adds no backend calls. It does not change how the video itself is recorded.
- Limit: a recording covers the sessions of the screen it was started from. Pop-out windows are not sampled.

### 2. Tools menu
- Add `'Tools'` to `mainTab` and the `viewSelector` (`windowsapp/src/App.tsx:528, 797-806, 812-821`). Copy the lazy, visited, hidden-when-inactive pattern used by `DesktopAnalysis` (`App.tsx:57`). The Tools view must render `{viewSelector}` itself so the user can switch back. Main window only (`!assignedId`).
- New `windowsapp/src/tools/` with `ToolsView.tsx` (a tool list with only "Trading Video Maker" for now), `VideoMaker.tsx` and `videoTools.css`. Style matches the dark theme (`styles.css` palette: `#10131a`, `#181d27`, `#2563eb` and so on).

### 3. Video Maker screen (one page, three steps)
1. **Choose recording.** A native file picker (Rust `rfd` crate behind a command, in the no-plugin style of this app). It reads the `.rec.json` beside the video. If it is missing, show a clear error that only videos recorded with this version are supported.
2. **Pick what to cut.** It shows the date and the sessions found in the metadata. Select one session or "All". Trades are loaded from the backend (see below). The tool then shows a **plan table**: each trade (number, session, contract, entry, exit, P&L %), the merged cut windows with their video times, the kept duration versus the original, and the chapter text. A small "shift video by ±N seconds" nudge covers recorder start-up lag.
3. **Make video.** Options: "Convert whole video to mp4" or "Cut to trade windows" (default), an output folder, and quality (H.264 CRF; auto-pick a hardware encoder if available). Shows progress and a cancel button. The result shows the file path, an "Open folder" button, and the description with a Copy button and a `.txt` file saved beside the mp4.

### 4. Pure logic (unit tested, `windowsapp/src/tools/`)
- `videoTimeline.ts`: wall ↔ video time with pauses; market time → wall time from samples (interpolated, tolerant of gaps, duplicates and a clock that goes backwards).
- `cutPlan.ts`: trade window = start of the bar containing the entry minus 1 bar, to end of the bar containing the exit plus 1 bar. It merges overlapping or touching windows, clamps to the video length, and skips trades fully outside it. An open or unfinished trade runs to the end of the recording.
  - Checked against the spec's example (3-minute bars, trades 09:30-09:38, 09:39-09:45, 09:57-10:02) → 09:27-09:48 and 09:54-10:06, with the first two merged.
- `chapters.ts`: `0:00 Introduction`, then `m:ss Trade N · CE 24000 · +2.4%` (`h:mm:ss` after an hour). The time is the entry moment in the output video, a few seconds ahead of the entry. Rules: first chapter at `0:00`; YouTube needs at least 3 chapters and 10 s apart (warn if not met).
- `ffmpegArgs.ts`: builds the argument list (filter_complex `trim`/`atrim`/`concat`, `-fps_mode cfr -r 30`, `-movflags +faststart`, `-progress pipe:1`).

### 5. Backend data (no new endpoint expected)
- Sessions and trades come from existing desktop routes, through the existing `createAnalysisApi` in `windowsapp/src/analysisApi.ts`: `getAnalysisSessions` (a single date is `start_date = end_date`), `sessions/{id}` and `round-trips?session_id=`.
- The cut uses `entry_trades[0].timestamp` and `exit_trades.at(-1).timestamp`. The label is `index + 1`, and `pnl_pct` is net P&L as a percent of the session capital.
- Candle interval comes from the metadata (the recorder knows it). Fallback: `strategy_interval_secs` on the session. Needs a check: `SessionSummary` does not return it. If missing, add that one field to the desktop response (small backend change).
- "Trade N" for "All": numbered in entry-time order across sessions, with the session shown in the plan table. For a single session it is the round-trip number. CE and PE trades held at the same time are separate trades (separate chapters).

### 6. Rust and packaging
- `src-tauri/Cargo.toml`: add `rfd` (file picker). Use `std::process::Command` through `spawn_blocking`, with `CREATE_NO_WINDOW` as `open_external_url` (`lib.rs:336`) already does. No shell plugin.
- New commands in `lib.rs` (added to `generate_handler!`, `lib.rs:2101`): `pick_recording`, `read_text_file`, `video_job_start/cancel`. Progress is emitted as a `desktop-video-progress` event (same pattern as the stream events). The job handle lives in `HostState` next to the stream abort handles.
- `tauri.conf.json`: `bundle.externalBin: ["binaries/ffmpeg"]`, with a `media-src` entry added only if a preview is built (none planned). The installer also ships the GPL licence and a source link.
- Linux/WSL dev: fall back to the system `ffmpeg` on PATH if no bundled binary is found, so tests can run here.
- `.github/workflows/desktop-windows.yml`: a step to download a pinned ffmpeg build into `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` and verify its SHA-256 before `tauri build`. Add a `scripts/fetch-ffmpeg.sh` for local builds.

## Sprints
Rules for every sprint: one feature branch and PR; code, tests and docs together (`docs/spec-phase24.md` plus a new `docs/spec-phase24-implementation-plan.md` that records status); you merge every PR with a merge commit; no sprint starts before the previous PR is merged. Counts to keep green: backend baseline (3 known swing failures), windowsapp vitest 389, cargo 23, frontend `tsc`.

### Sprint 0 — Docs and plan (dev, small)
- Commit `docs/spec-phase24.md` and add `docs/spec-phase24-implementation-plan.md` (this plan, sprint by sprint) and a CLAUDE.md phase row ("Phase XXIV, in progress").
- **Done when:** both docs are on `dev`. No code.

### Sprint 1 — Recorder metadata (PRs into BOTH `dev` and `preprod`)
Why first and alone: you need the `.json` on `preprod` before the real-trading test starts, and it must be small and safe.
- `shared/useRecording.ts`: optional `clock` callback; a 1 s sampler (try/catch, never throws); event log for start, pause, resume, stop; build `<name>.rec.json`; download it right after the video. Pure builder in new `shared/recordingMeta.ts` (testable without a browser).
- Website `frontend/src/App.tsx:2372`: pass `sim.sessionId`, `sim.sessionType`, `sim.symbol`, `sim.date`, `sim.currentSimTime`, candle interval, speed, stepwise flag.
- Desktop `windowsapp/src/App.tsx:2801`: pass `trading.session.session_id`, `trading.current_time`, mode, date, tile interval.
- Tests: `recordingMeta` unit tests (pause spans, multiple pauses, stop while paused, samples with a repeated or backwards clock, no session yet, sampler error is swallowed) in the frontend node test style and a desktop vitest.
- Branching: branch off `origin/preprod`; open two PRs from the same branch (into `dev` and into `preprod`); check both merge cleanly with `git merge-tree`; run `bash scripts/check-preprod-synced.sh` after you merge.
- Docs: format of `.rec.json` in `docs/spec-phase24.md`; note in `docs/bugs.md`/CLAUDE.md that this is a recorded exception to "preprod bug fixes only".
- **Done when:** 3 test recordings (replay, stepwise, paper) each give a correct `.json` (start, pause/resume, samples); the video still saves if the `.json` code is forced to fail; a recording is made during the real-trading test on `preprod`.
- **Your steps:** deploy `preprod` website; install a new desktop build.

### Sprint 2 — Timeline, cut plan and chapters (dev, pure logic, no UI)
- `windowsapp/src/tools/videoTimeline.ts`: wall time ↔ video time (pauses); market time → wall time from samples (interpolation, gaps, duplicates, backwards clock); adjustable nudge.
- `windowsapp/src/tools/cutPlan.ts`: lead/lag by bars; merge overlapping or touching windows; clamp to the video; skip trades outside it; open trade runs to the end. Spec example is a test: 3-minute bars, trades 09:30-09:38, 09:39-09:45, 09:57-10:02 → 09:27-09:48 and 09:54-10:06.
- `windowsapp/src/tools/chapters.ts`: `0:00 Introduction`, `m:ss Trade N · contract · ±x.x%`, `h:mm:ss` over an hour, warnings for fewer than 3 chapters or chapters under 10 s apart.
- `windowsapp/src/tools/tradeWindows.ts`: turn `round-trips` data and session list into trades (number = index+1 for one session; entry-time order across sessions for "All"; CE and PE separate).
- Tests: about 40 vitest cases, including replay with a pause, stepwise, paper and real, two overlapping trades, and a trade at the very end of the video.
- **Done when:** all green and tsc clean. Nothing visible changes in the app.

### Sprint 3 — Rust: ffmpeg job, file picker, packaging (dev)
- `Cargo.toml`: add `rfd`. New commands in `lib.rs`: `pick_recording` (video, auto-finds the `.rec.json`, or lets the user pick it), `read_text_file`, `write_text_file`, `video_job_start`, `video_job_cancel`, `reveal_in_folder`. Progress via a `desktop-video-progress` event; job handle in `HostState`; ffmpeg started with `CREATE_NO_WINDOW`.
- `windowsapp/src/tools/ffmpegArgs.ts` (from Sprint 2 plan): convert-only and cut-and-concat commands; hardware encoder detection with x264 fallback.
- Packaging: `tauri.conf.json` `bundle.externalBin`; `scripts/fetch-ffmpeg.sh`; CI step in `.github/workflows/desktop-windows.yml` that downloads a pinned GPL build and checks its SHA-256; licence text and ffmpeg source link shipped in the installer; fall back to system `ffmpeg` for WSL dev.
- Tests: Rust unit tests for the argument builder and progress parser; an integration test (skipped if no ffmpeg) that generates a test webm without duration, converts and cuts it, then checks with `ffprobe` that the mp4 has a duration, is seekable, and has the expected cut length.
- **Done when:** the cargo tests pass (23 plus new); the Windows CI build contains `ffmpeg.exe`; installer size is recorded in the doc.

### Sprint 4 — Tools menu and Video Maker UI (dev)
- `mainTab` gets `'Tools'`; `viewSelector` option; lazy Tools view with its own `{viewSelector}`; main window only.
- `ToolsView.tsx` (tool list) and `VideoMaker.tsx` (3 steps: choose recording; choose date and session or "All", plan table with trades, windows, kept duration, chapters, nudge; make video with progress, cancel, output folder, "Open folder", Copy description, `.txt` saved beside the mp4). Styles in `videoTools.css`, matching the desktop theme.
- Server: uses the desktop's current server URL and `createAnalysisApi`; shows a clear message if the sessions in the `.json` are not found on that server. If `strategy_interval_secs` is missing from the session response, add that one field to the desktop analysis response (small backend change and test).
- Error states: missing `.json`, unreadable video, ffmpeg missing, disk full, user cancel, session not found, no trades in the video.
- Tests: view-model tests (state transitions, plan table, error messages) in vitest; no browser tests.
- **Done when:** tsc, vitest and cargo are green and the manual acceptance list in `docs/phase24-manual-acceptance.md` is written.

### Sprint 5 — Hardening and acceptance (dev)
- Long recordings: a 1-2 hour test video, progress accuracy, cancel cleanup of temp files, a low-disk message, ffmpeg crash handling.
- Fix whatever your manual run on the dev-installed desktop (Windows) finds, using a real recording made on `preprod` in Sprint 1.
- **Done when:** you have run the tool on a real-trading recording and approved the cuts and the description.

### Sprint 6 — Promote the tool to `preprod` (only when you ask)
- Same pattern as the Phase 23 promotion: sync `preprod` into `dev`, then a pinned release branch into `preprod`, then you test.

## Verification
- `cd windowsapp && npm test` (baseline 389 vitest) and `node node_modules/typescript/bin/tsc --noEmit` there; `cargo test` (baseline 23); `cd frontend && node node_modules/typescript/bin/tsc --noEmit` for the shared hook change.
- Generate a test webm with ffmpeg (`testsrc` + sine) and a matching `.rec.json`; run the job and check the mp4 plays, has a duration, and `ffprobe` reports the expected cut length. Check the pause case: a recording with a pause lands the cut at the right trade.
- Manual (Windows build, which needs a new installer): record a replay, a stepwise session, and a paper session, then run the tool. Check that the cuts show each trade with a bar before and after, that the seek bar works, that the chapters in the description match the video, and that cancel and an unreadable file fail cleanly.

## Assumptions to confirm (change only if wrong)
- The lead and lag rule above (entry bar start minus 1 bar, exit bar end plus 1 bar) matches your example.
- Only the main window's screen is recorded and cut (no pop-out windows).
- The mp4 uses H.264 + AAC at 30 fps; the original webm is never modified or deleted.
- Sprint 1 (recorder `.json`) goes to both `dev` and `preprod` as above. Sprints 2-4 (the tool) go to `dev` only. The recorder change also reaches the website (as a second `.json` download).
- The tool promotes to `preprod` later only if you ask for it.
- **Your intended workflow works:** record real trading on `preprod` (website or desktop) → you get `video.webm` + `video.rec.json` → open both in the **dev-installed desktop** Tools view. The tool only reads those two files and calls the existing analysis routes (`sessions`, `round-trips`) that `preprod` already has, so it needs nothing else from `preprod`. Point the dev desktop's server URL at the backend that holds the real session (the `preprod`/real-trading server), because the trades are fetched from there.

## Out of scope
Uploading to YouTube, a video preview player or editor, older recordings without metadata, and macOS/Linux installers.
