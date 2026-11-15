# Phase 25 — Track P (Patterns, Chart Structures, Fine Structures on the desktop): manual acceptance

Needs a Windows desktop build from `dev` that includes #833 (the Rust command `desktop_patterns_request`; an older build shows an unknown-command error in these tools) and a backend from `dev` (route mounts under `/api/desktop/v1/patterns`). Sign in to the desktop app with the account that has saved pattern charts on the website, so you can compare. Track G (the games) is not covered here yet.

Unless a step says otherwise, use NIFTY and a recent trading day.

## A. Tools menu
1. Tools lists Trading Video Maker, **Pattern Library** and **Chart Structures**.
2. Switch to Workspace and back: the tool you had open is still open and keeps its loaded day.
3. Not offered in pop-out screen windows.
4. The website (Patterns, Structures pages) works exactly as before. Nothing changed there.

## B. Pattern Library
1. **Load:** load a day as Underlying only; then as Underlying + CE/PE. The CE and PE strikes follow Settings: OTM offset, or Max Price (caps and the 09:30 pick) for indices. Check them against the website page for the same day.
2. **Mark:** choose Entry UL, then click a candle: a marker lands on that candle at 1, 3, 5 and 15 minute intervals. Click the same candle again with the same tool, strategy and category: the mark is removed. Repeat for CE and PE.
3. **Save and reload:** save with notes, close the tool, reopen it, open the chart from Saved charts: marks, notes, strikes and the candle interval are restored. Saving again updates the same chart (one per symbol, day and type).
4. **Top Patterns:** set Top 1, Top 2 and Bottom 1 from the pairs among your marks; the ranked markers show the badge, and the choice survives save and reload.
5. **R:R:** enter `R:R 1:` for a pattern: markers of that pattern show `(1:x)`; blank removes it. Survives save and reload.
6. **Extra strike panes:** add a CE and a PE pane at another strike, maximize one, remove one. After save and reload the first CE and first PE strikes are the saved ones (`strike` and `strike_pe`, also visible on the website).
7. **Drawings:** draw a horizontal line, a trendline, a rectangle and a fib on the underlying and on an option pane; leave and come back: they are still there (they persist per instrument, as on the trading charts). Marking works again after deselecting the drawing tool.
8. **Saved charts:** the strategy, category and top-pattern filters narrow the table; Delete removes one; select several (and select all) and bulk delete with the confirm. Charts shared with you cannot be selected or deleted.
9. A chart saved on the website opens on the desktop with its marks, and the other way round.

## C. Chart Structures (Broad)
1. The gallery lists days with their Opening, Midday and Closing badges. Each multi-select filter narrows the gallery; clearing them restores it.
2. Sparklines fill in as cards scroll into view (not all at once).
3. Open a card: the day shows on KLine with earlier days of context. Previous / next day move through the **filtered** list.
4. **Edit classification:** on a system (predefined) or shared structure, change a class and save: you get your own copy and the original is unchanged. On your own structure, save updates it. Check on the website.
5. Drawing tools work on the day view.

## D. Chart Structures (Fine)
1. The **Broad | Fine** switch works; going Fine and back keeps both states.
2. **Definitions:** add a structure with sub-types, edit it, delete it. System definitions cannot be edited or deleted.
3. **Builder, underlying:** load a day as Underlying only. Add three steps (structure, optional type, Bull or Bear), reorder and remove one. Select a step, click a candle: its transition bar is set and a numbered arrow appears (Bull up, Bear down). Clear the last transition.
4. **Builder, CE/PE:** load Underlying + CE/PE and build a flow on each pane. Save. Switch to Search and Definitions and back: the half-built flow is still there. Reload the day: all three flows are restored with their transitions and chart interval. Flows saved for equity are not shown on an options day and the other way round.
5. **Drawing tools** are usable in the builder after deselecting the step.
6. **Search:** build the sequence of your three steps, search: the flow you saved is listed. Open it: transition bars and the matched steps are highlighted. Replace the middle step with **Any**: it still matches. Filter equity / options.
7. An options result shows the CE or PE contract of that day (ATM from the 09:15 price). Compare with the website, which may show a different strike (it uses the first loaded candle); this difference is expected.
8. Transition labels on the chart are short and numbered; the step list beside the chart has the full names.

## E. Data and trading path
1. Open the tools while a replay or paper session runs in the Workspace: the session, orders and charts are unaffected, and the tools do not slow the trading chart.
2. With the network inspector or the backend log, every call from these tools is under `/api/desktop/v1/patterns/...`, `desktop_drawing_request` drawing calls, or the existing Settings read. No order, session, wallet, broker or stream call comes from them.
3. A desktop token that has expired shows the sign-in prompt instead of an empty list.

## F. Games backend (G2)
1. Run `python scripts/setup-dynamodb-tables.py` (or just start the backend and call the route): `GameProfiles` is created (or skipped if it exists) and the script prints the TTL line.
2. `curl -H "X-User-Id: <you>" http://localhost:8700/api/desktop/v1/games/state` returns `{"version":1,"profile":null,"games":{},"days":{},"months":{}}` for a new user.
3. A `PUT` with a `game` (`revision` 0) returns 200 and `applied: true`; repeating the same body returns `applied: false`; a second `PUT` with the old `revision` returns 409 and the current record.
4. `GET /api/desktop/v1/capabilities` (same header) lists `"games"` in `features`.
5. Nothing in the trading screens changes; no trading route shows in the backend log for these calls.

## G. Games shell (G3a): Windows build and website
Needs the backend from `dev` (G2) and a **rebuilt** desktop app.
1. Desktop: the toolbar shows a **Games** button after sign-in. With an older backend (no `games` feature) it is not shown.
2. Click it: a separate window opens with tabs Brain, Market, Dashboard, Warm-up, Settings; every game is listed as "Coming soon". Click again: the same window is focused, not duplicated.
3. Close the main window: the Games window closes with it. Close only the Games window: the trading window is unaffected.
4. Settings: turn Sound on, set size to 120 %, Warm-up games to Brain only, Save ("Saved."). Close and reopen Games: the values are back. On the website (same account) the same values appear.
5. Website and webapp: the header has a controller icon (tooltip "Games"). It opens an overlay under the header; the icon toggles it closed. Opening Browse closes Games and the reverse; opening Trade Analysis closes Games.
6. With a **paper or replay session running**, open Games: the session keeps running underneath (charts keep updating, notifications still appear above Games). Close Games: the trading screen is exactly as before. With a **real** session, a banner says so.
7. Stop the backend, reopen Games: a message says the server is not reachable (no crash). Start it again and reload: the hub loads.
8. Network log: Games only calls `/api/desktop/v1/games/state` (website) or the Rust command (desktop). Nothing else, no order, session, wallet or broker route.
9. Dashboard shows empty category bars and "Play a game in Progress mode..."; the footer says these are practice tools.

## H. Brain games, Speed (B1): Windows build (Games window) and the website
Needs the backend from `dev` and, on Windows, a desktop build that includes the Games window. Use a real keyboard and mouse, in Chrome and in the Windows app.
1. Brain tab: **Quick Match, Colour Clash and Green Light** have a Play button; the other 18 say "Coming soon".
2. Each game: Play shows the instructions (at most 6 lines), your level, **Progress** and a **Practice at level N** box. Practice never changes your level.
3. Press Progress: a 3-2-1 countdown, then a time bar runs down over the block (60 s, Green Light 75 s). The block cannot be paused.
4. **Quick Match:** press **S** for same and **D** for different (or click the buttons). Level 1 shows both items until you answer; at higher levels they vanish, and from level 13 they are rotated and a mirror image counts as different. A wrong answer scores nothing; answering at random scores about 0.
5. **Colour Clash:** answer the colour the word is **printed in** (keys 1 to 4, or click). The buttons show a pattern and a number as well as the colour. From level 16 the buttons change places every trial.
6. **Green Light:** a banner states the rule, then press **Space** (or GO) for a GO symbol and do nothing for the others. Level 1: green circle is GO, red square is NO-GO. From level 13 the rule changes during the block and a banner announces it.
7. **Timing sanity:** at the fastest you can, your reported median reaction time is plausible (about 250 to 450 ms in Green Light, 400 to 700 ms in Quick Match). Compare Chrome and the Windows app; do not expect identical numbers.
8. **Too early:** hold the key down or mash it before the symbol appears in Green Light: those presses are counted as errors ("anticipations" in the stats), not as fast reactions.
9. **Focus loss:** during a block switch to another window for a few seconds and come back: the block resumes (the trial you missed is discarded). Stay away for over 10 seconds: "This session was cancelled" and nothing is saved.
10. **Quit:** press Esc during a block: "Quit this session?". Keep playing resumes; Quit returns to the hub and records nothing.
11. **Result screen:** score, a few stats (accuracy, median reaction time, and so on), and a collapsed "Trial review" with what was shown, your answer, the right answer and your time for every trial. After a Progress block "Saved to your progress" appears; on the Dashboard the Speed bar moves.
12. **No trading interference:** with a paper or replay session running, open Games on the website and play a block: the trading screen keeps updating underneath and nothing in it is delayed or changed. Network log: only `GET`/`PUT .../games/state` (once at the start, once at the end).
13. Keyboard safety: keys you press in a game (S, D, Space, digits, Esc) do nothing in the trading screen behind it.

## Report back
Note any step that fails, the symbol and day, and the interval. Track G (games) starts after this.
