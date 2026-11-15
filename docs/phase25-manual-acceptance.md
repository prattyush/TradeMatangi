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

## I. Brain games, Memory and Attention (B2): Windows build and the website
Same setup as section H. Six more games are playable: **Grid Recall, Sequence Echo, N-Back Stream** (Memory) and **Flanker Flock, Needle Finder, Track the Dots** (Attention).
1. Brain tab: nine games have a Play button (the three Speed games from section H plus these six); twelve say "Coming soon".
2. **Grid Recall:** tiles light one by one; tap them in the same order. Level 1 uses a 3x3 grid and spans 3, 5, 7. A mistake is a strike (three end the game); the header shows span, round and strikes. From level 8 the tiles light together and order does not matter; from level 12 you tap in REVERSE; from level 18 the grid turns or flips before you answer (tap where the lit tiles went).
3. **Sequence Echo:** pads (digits from level 10, letters from level 18) flash; repeat the sequence by clicking or pressing the key (Backspace undoes). From level 8 repeat it BACKWARDS; from level 15 grey dashed flashes appear that you must ignore.
4. **N-Back Stream:** letters appear at a steady pace; press **M** when a letter equals the one n back (n=1 at level 1; the first n are just for remembering). From level 10 near misses appear; from level 16 the letter also moves on a grid: **A** for the same place, **L** for the same letter. Pressing nothing or always scores 0.
5. **Flanker Flock:** press ← or → for the MIDDLE arrow only. From level 14 two rows appear after a short cue naming the row to judge.
6. **Needle Finder:** click the red upright bar, or press **N** when it is not there (20 screens, a time limit each). From level 7 other bars are red or upright too. Clicking at random or always pressing N scores 0.
7. **Track the Dots:** orange dots are marked for 2 s, then all dots look alike and move; when they stop, click the dots you followed (eight rounds). From level 12 the dots pass behind a screen; from level 16 other dots blink.
8. Each result screen shows its stats and a Trial review; a Progress block saves, a Practice block never changes your level; Esc asks to quit and records nothing.
9. **Focus loss:** during a round switch away for a few seconds: that round is discarded and replaced (it does not use up one of the 20 screens or 8 rounds, and costs no strike); away for over 10 s cancels the session.
10. Timing sanity as in section H step 7 for Flanker and Needle Finder (search times of 1 to 3 s at level 1).
11. With a paper or replay session running, play any of these on the website: the trading screen is unaffected (section H step 12).

## J. Brain games, Flexibility and Math (B3): Windows build and the website
Same setup as section H. Six more games are playable: **Rule Switch, Card Sorter, Flip Map** (Flexibility) and **Number Sprint, Equation Drop, Make Target** (Math). The Brain tab now has fifteen Play buttons and six "Coming soon".
1. **Rule Switch:** a card shows a digit and a letter; the tag on the card names the rule (NUMBER: F odd, J even; LETTER: F vowel, J consonant). Levels 1-5 alternate in pairs with a 1 s cue before the card; from level 6 the rule switches at random; from level 13 the cue comes with the card; from level 16 a SIZE rule (F over 5, J under 5) joins. The result shows switch cost (switch minus repeat RT).
2. **Card Sorter:** four reference cards on top, one new card below; press 1 to 4 or click. Only "Match" or "No match" appears. After a run of correct cards (10 at level 1, 5 at level 20) the rule changes silently. From level 8 the number of symbols is a possible rule too; from level 15 the feedback comes about 0.6 s late. 64 cards, no time pressure. The result shows categories completed and perseverative errors.
3. **Flip Map:** press the arrow key the current rule asks for (SAME, OPPOSITE; TURN from 16). Levels 1-6 keep the rule on screen; 7-12 show it for 1.5 s after a change; 13+ show nothing and flash red after a mistake.
4. **Number Sprint:** type the answer and press Enter (Tab skips). A wrong answer shows the right one for a second and costs half a point. Level 5 adds times and divide, 10 adds two-step sums, 12 negatives, 16 decimals. Typing into the box works with the mouse pointer away; Esc still asks to quit.
5. **Equation Drop:** equations fall; type an answer and Enter clears every equation with that value (combo). A landed equation costs a life (three lives, 90 s). A wrong answer freezes typing for a moment. From level 12 some are reversed ("? + 9 = 23": type the missing number). Check that a drop falls smoothly and that a stalled frame (switch tabs briefly) does not make drops jump.
6. **Make Target:** a short "Preparing the puzzles" screen, then eight puzzles: click a number, an operator, another number; the result replaces them. Backspace undoes, R resets, keys 1-9 and + - * / work. Reaching the target moves on; at levels 1-6 "Submit closest" gives half credit within 2. A bad move (division that is not exact, subtraction to zero) says why. **On the website, confirm the puzzles are built off the main thread:** start a paper or replay session, open Make Target at level 15 or higher, and check the trading chart keeps updating while "Preparing the puzzles" shows.
7. Each result screen shows its stats and a Trial review (Make Target's review shows a shortest solution); Progress saves, Practice never changes your level; Esc asks to quit and records nothing; focus loss discards the trial in progress and away over 10 s cancels the session.
8. Tell me which levels feel too easy or too hard: `itemsTarget` (Number Sprint), `target` (Equation Drop), `categoryTarget` (Card Sorter) and the RT anchors are provisional until you have played them.
9. Windows only: the Games window loads Make Target's worker (if puzzles never appear, tell me; the game falls back to the calling thread and still starts).

## K. Brain games, Reasoning (B4): Windows build and the website
Same setup as section H. Three more games are playable: **Pattern Matrix, Number Series, Code Breaker**. The Brain tab now has eighteen Play buttons and three "Coming soon".
1. A short "Preparing the puzzles" screen shows before each of these games. **On the website, with a paper or replay session running, check the trading chart keeps updating during it** (the puzzles are built in a Web Worker).
2. **Pattern Matrix:** a 3 by 3 grid of figures with the last cell empty and 6 to 8 options (press 1 to 8 or click). Figures change in shape, number, size, colour, turn (a small white tick shows it) and shading. Check that every figure is clearly drawn, that colours also differ by pattern, and that the right option really is the only one that fits the rules (try to work out two puzzles by hand). From level 14 a small 2 by 2 dot pattern in the corner follows XOR or AND of the first two cells in a row.
3. **Number Series:** a series with the next term missing; pick from 5 options (keys 1 to 5), or from level 15 type the answer and press Enter. Check that no puzzle seems to have two reasonable answers (tell me if one does: the solver should have rejected it).
4. **Code Breaker:** place symbols with 1 to 8 (or click), Backspace undoes, Enter makes the guess; each guess shows "n exact, m misplaced". Level 1 is 3 positions from 5 symbols, no repeats; from level 10 symbols can repeat; from level 16 one number per code shows "?". The header shows par; after a code the result line says whether you solved it and gives the code if not.
5. Each result screen shows its stats and a Trial review; Progress saves, Practice never changes your level; Esc asks to quit and records nothing; focus loss discards the code or puzzle in progress and away over 10 s cancels the session.
6. Tell me which levels feel too easy or too hard (time limits, options, par); they are provisional until you have played them.

## Report back
Note any step that fails, the symbol and day, and the interval. Track G (games) starts after this.
