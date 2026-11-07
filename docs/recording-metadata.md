# Screen recording metadata (`.rec.json`)

Phase 24, Sprint 1. Every screen recording made from the website or the desktop app now also saves `<video name>.rec.json` next to the `.webm` (a second download, a short moment after the video). The desktop Video Maker (Phase 24, later sprints) reads it to find each trade in the video.

**Branch note:** this is a feature, but the user asked for it on `preprod` as well as `dev` so that recordings made during the real-trading test carry the file. It is a recorded exception to "preprod takes bug fixes only". The Video Maker tool itself stays on `dev`.

## Why a file is needed
- The `.webm` has no clock: no start time, no session id.
- Pausing the recording removes the paused time from the video.
- A replay's market time has no fixed relation to wall time (speed is wall seconds per market second, and session pauses freeze market time while the video keeps running).

## What is saved
```json
{
  "version": 1,
  "source": "website" | "desktop",
  "videoFile": "TradeMatangi_NIFTY_2026-11-06_sim.webm",
  "wallStartMs": 1762400000000,
  "wallStopMs": 1762403600000,
  "videoDurationMs": 3300000,
  "events":   [{ "t": "start|pause|resume|stop", "wallMs": 0 }],
  "sessions": [{ "sessionId": "", "sessionType": "sim|paper|real|stepwise", "symbol": "", "date": "YYYY-MM-DD",
                 "candleSeconds": 180, "replaySpeed": 1, "stepwise": false }],
  "samples":  [{ "wallMs": 0, "sessionId": "", "marketTime": 0 }]
}
```
- `wall*` values are true UTC Unix milliseconds from the computer's clock.
- `marketTime` is Unix seconds in the IST-as-UTC convention used for all candle and trade timestamps, so it compares directly with a trade's `timestamp`.
- One sample per session per second, including while the recording is paused (so a trade made during a pause can be recognised as "not in the video"). Repeated market times are kept on purpose: in a stepwise session they show when the clock jumped.
- Video time for a wall time = wall time minus all paused spans before it.
- `videoDurationMs` is the recording time minus paused time. The webm itself has no duration.
- Capped at 40,000 samples (about 11 hours); older samples are thinned beyond that.

## Where the clock comes from
| App | Session | Market time |
|---|---|---|
| Website | `sim.sessionId` | newest of the equity / CE / PE tick times |
| Desktop, Replay and Stepwise | `trading.session` | replay cursor, else the trading snapshot's `current_time` |
| Desktop, Paper and Real | `trading.session` | wall clock + 19,800 s (IST) |

Code: `shared/recordingMeta.ts` (builder), `shared/recordingClocks.ts` (the two clocks), `shared/useRecording.ts` (sampler and download). Tests: `windowsapp/src/recordingMeta.test.ts`.

## Safety
The metadata code only reads state that already exists, runs on a 1-second timer, and every call into it is wrapped so that a failure only means a missing or incomplete `.json`. It makes no backend calls and never touches orders, sessions or streams. The video is saved first and exactly as before.

## Limits
- A recording covers the session shown on the screen where it was started. Pop-out windows and other linked sessions are not sampled.
- Chrome may ask once to allow multiple downloads.
- Only recordings made after this change have the file.

## Manual check
1. Record a replay session with one pause and resume. Open the `.json`: `events` shows start, pause, resume, stop; `samples` has about one entry per second; `videoDurationMs` is shorter than the wall time by the pause.
2. Record a stepwise session and press Next Bar a few times: the `marketTime` values stay flat, then jump.
3. Record a paper session: `marketTime` is close to the IST time of day.
4. Check the video still saves and plays as before.
