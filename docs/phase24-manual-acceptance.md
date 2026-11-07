# Phase 24 — Trading Video Maker: manual acceptance

Needs a Windows desktop build that includes Sprints 1-4 (the CI job `Desktop Windows installer` builds it). Record the videos in the app or website versions that save the `.rec.json` (Sprint 1, on `dev` and `preprod`).

## A. Record (Sprint 1)
1. Replay: start a replay session, record about 10 minutes, take two trades, pause the recording once for about 30 s, stop. You should get `.webm` and `.rec.json` with the same base name.
2. Stepwise: record, press Next Bar a few times, take a trade, stop.
3. Paper: record a live paper session with one trade.
4. Real (on `preprod`): record part of a real-trading session with at least one trade.
5. Open a `.rec.json`: `events` has start/pause/resume/stop, `samples` has about one entry per second, and `videoDurationMs` is the recording time minus the pause.

## B. Tools menu
1. The view selector (top left) lists Workspace, Analysis, Swing and **Tools**.
2. Tools shows "Trading Video Maker". Switching to Workspace and back keeps what you chose.
3. The Tools view is not offered in pop-out screen windows.

## C. Cut to trades
1. Choose the replay `.webm`. The `.rec.json` beside it is found; the session, trades and the "In this video" count appear. The trade table matches Trade Analysis for that session (numbers, contract, entry/exit time, P&L %).
2. The blue bar shows the kept parts. Check one cut against your example: with 3-minute candles, a trade 09:30-09:38 starts at 09:27 and ends at 09:42.
3. Make the video and play the mp4: it seeks with the bar; each trade starts one candle before the entry and ends one candle after the exit; two close trades are one continuous part; the paused 30 s is not a problem.
4. The description lists `0:00 Introduction` and one line per trade with its P&L %. Click a time in the YouTube player after uploading, or compare with the mp4: each chapter lands a few seconds before its entry.
5. A `_description.txt` is saved beside the mp4.
6. Repeat for the stepwise, paper and real recordings.
7. If the video is slightly out of step with the trades, set "Shift video" (for example -3) and check the plan changes.

## D. Other paths
1. "Convert the whole recording to mp4" gives a seekable mp4 of the full length.
2. A recording with several sessions: choose All, then one session; the table, numbering and chapters follow the selection.
3. A video that has no `.rec.json`: the tool asks for it; "Convert" still works.
4. Connected to a server that does not hold the session: a clear message is shown instead of an empty table.
5. Cancel in the middle of a long cut: the job stops, no mp4 or `.trade-matangi-work-*` folder is left behind.
6. Saving to a full or read-only folder shows an error.
7. Time check: note how long a 1-hour recording takes (progress should move steadily) and the CPU use. If the machine has an NVIDIA, Intel or AMD GPU, note which encoder the result reports (it should say so after "Finished").
