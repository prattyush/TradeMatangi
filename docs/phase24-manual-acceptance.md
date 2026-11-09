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

## E. Recording stops with the session, and YouTube (added 2026-11-09)
Recording auto-stop (needs the build with #790):
1. Start a recording, start a replay or paper session, then press Stop on the session. About 10 seconds later the recording stops by itself, `video.webm` and `video.rec.json` download, and a notice says why.
2. Start recording with no session running and wait over 10 seconds: it keeps recording.
3. Stop a session and start another one within 10 seconds: the recording keeps going.

YouTube (each step becomes available as its PR is merged):
4. **Connect (built):** Tools > Trading Video Maker > YouTube > Connect YouTube; sign in, tick the upload permission; the card says connected, and still does after restarting the app. Disconnect returns to Connect.
5. **Upload (Y2, built):** make a short video (a few minutes), then in the YouTube card click Upload to YouTube..., confirm. The progress bar moves, the result shows the link; Open on YouTube opens it and the video is in YouTube Studio with the chapter description. Also try Cancel part-way, and unplugging the network for ~20 s during an upload (it should resume). If YouTube forces Private, the app says so. Upload a longer video (a few hundred MB) once to see the speed.
6. **Saved links (Y3, built):** right after the upload the YouTube card says "Link saved with N sessions" and the "Saved videos" card at the bottom lists it (title, visibility, date). Restart the app, open the same recording: it is still listed. Log in as the same user on another computer: also listed. A different Trade Matangi user cannot see it. Analysis: open Analysis (website and desktop), expand that day's session: a "Videos (1)" row appears above the trades; Open on YouTube works. For a Private video it says so. Change the video to Unlisted in YouTube Studio, then Play here shows the player on the website; on the desktop it should too, but YouTube can refuse embeds in the desktop window (error 153): report it if you see it, Open on YouTube still works. A session without a link, and a real session shared with you by someone else, show no Videos row. Remove link asks first and removes only the saved link (the video stays on YouTube). To test the failure path, stop the backend before an upload finishes: the card says the link could not be saved and offers Save link; start the backend and click it.
7. **Player (Y4):** the finished mp4 plays in the app, the seek bar works, and clicking a chapter time jumps to it.

