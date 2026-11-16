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

## L. Brain games, Word (B5): Windows build and the website
Same setup as section H. Three more games are playable: **Anagram Dash, Letter Grid, Word Ladder**. The Brain tab now has twenty-one Play buttons, none "Coming soon" (the word games need their word lists, loaded on demand).
1. A short "Loading the word list" screen shows before each word game (the first time a few hundred KB are fetched). **Website:** with a paper or replay session running, check the trading chart keeps updating during it. **Windows build:** check the Games window loads the word list at all (if it never does, tell me: the game then builds its puzzles on the calling thread and still starts).
2. **Anagram Dash:** scrambled tiles; type a word that uses all the letters and press Enter. Any real word that fits is accepted (try a word with several anagrams, such as "stop", "pots", "tops"). A wrong word is rejected with a message and you can keep trying. Shuffle re-arranges the tiles, Hint shows the first letter (a few per block), Tab skips. Check that none of the words offered is offensive.
3. **Letter Grid:** a 4 by 4 grid (5 by 5 from level 15). Click letters in order, drag across them, or type the word, then Enter. A word the grid does not hold, a repeat, or a too-short word is rejected with a message. A typed word lights its path. "Finish now" ends the game; otherwise it ends at 2 minutes. The score compares your value with a share of the common words in the grid; rare words (dashed) still count.
4. **Word Ladder:** change one letter at a time to reach the goal; par is shown. Enter takes a step, Backspace on an empty box undoes, Reset starts again, Hint shows the next word of a shortest route (20% off that puzzle; none at the top levels). Check the messages for a word one letter off, a word not in the list and a repeated word.
5. Each result screen shows its stats and a Trial review; Progress saves, Practice never changes your level; Esc asks to quit and records nothing; focus loss discards the puzzle in progress and away over 10 s cancels the session.
6. **Licence and content check:** open `shared/games/brain/assets/words/NOTICE` and confirm you are happy with the credits and the exclusion method; tell me about any word that should be excluded (add it to `scripts/build-word-lists.py` and rebuild).
7. Tell me which levels feel too easy or too hard (targets, time limits, par); they are provisional until you have played them.

## M. Brain integration (B6): Windows build and the website
Same setup as section H. Play at least one session of two or three games first so there is something to see.
1. **Dashboard:** the All / Brain / Market buttons filter the games table (market games read "coming soon"). Category ratings, a level badge, sessions, best and a small score line appear for the games you played. The warm-up streak line shows today's steps. Brain trends show a number and a line for Colour Clash (interference), Flanker Flock, Rule Switch, Flip Map, Grid Recall, Sequence Echo, N-Back and Card Sorter after you have played them in **Progress** mode (the trends live on this device only).
2. **Warm-up:** the tab shows five steps (Quick Match first) and a note that market games are not available yet. Start the warm-up, finish a step: it shows "done", and after closing and reopening the Games window the plan is the same and the step is still done. Skip a step; "Play now" brings it back. Finish four steps and check the streak reads 1 day on the Dashboard (the day also shows "today is done"). Try the pool setting in Settings: every choice uses brain games for now.
3. **Review:** the last sessions are listed with score and level; opening one shows every trial (what was shown, your answer, the right one, your time). "Play these puzzles again" replays the same puzzles in Practice mode and saves nothing. Check Track the Dots shows the same dots and a matrix game the same puzzles. Sessions older than the newest 20 keep their stats but no trial list.
4. **Settings:** **Colours: Higher contrast** brightens the game colours (Colour Clash, Green Light, Pattern Matrix still carry names or patterns); **Reduce motion** stops animations and makes Track the Dots and Equation Drop slower (the instructions say scoring is unchanged); **Size** scales the text; **Sound** gives a tick on each countdown number, a higher tone at the start and a tone at the result (off by default). Press **Save settings**, close and reopen: they are kept (they sync through your profile).
5. **Keyboard and screen reader basics:** Tab reaches every button, a focus ring is visible, Esc still asks to quit inside a game and does not reach the trading window. (Screen-reader use of the timed games themselves is not claimed.)
6. **Website:** with a paper or replay session running, repeat 1 to 4 once in the overlay and check the trading chart keeps updating.
7. Tell me anything confusing in the Dashboard wording, and whether eight to ten minutes is the warm-up length you want (the games run at normal length; a shorter routine needs a per-game short mode).

## N. Games market data (G1): backend only
No game uses these routes yet; this checks the data side with `curl`. Run it where the backend serves your real data cache.
1. `python scripts/build-games-index.py` prints the folder it scanned, how many files it read, and for NIFTY and BSESEN the number of days (about 236 and 149 on the owner's cache) and contracts, then writes `data/games-index.json`. Run it again: it reads 0 files and finishes faster.
2. `curl -H "X-User-Id: <you>" http://localhost:8700/api/desktop/v1/games/availability` lists `NIFTY` and `BSESEN` with `lot_size` 65 and 20, `strike_step`, `dates` and `options`. Before step 1 it answers `"index_missing": true` and no symbols.
3. `curl -H "X-User-Id: <you>" "http://localhost:8700/api/desktop/v1/games/window?symbol=NIFTY&date=2026-11-09&start_sec=34200&duration_sec=300"` returns 300 values in `t` (from 34200 = 09:30 IST) and prices as whole numbers of paise (NIFTY near 2,500,000). Add `&interval_seconds=60&start_sec=0&duration_sec=86400` for the whole day in minutes (about 375 candles). `&expiry=...&strike=...&right=CE` (taken from `availability`) gives the option.
4. A date that is not cached (`date=2030-01-01`) answers 404 `{"reason":"not_cached"}`, and the backend log shows no Breeze, Kite or Kotak call for it; `interval_seconds=5` answers 422.
5. Trading is unaffected: a live or paper chart keeps updating while you repeat step 3 a few times.

## O. Tick Reader (G3b): Windows build and the website
Needs the backend with the Games index built (section N) and a desktop or website build that includes this sprint. No Rust change, so an existing G3a desktop build only needs the new frontend.
1. **Market tab:** Tick Reader has a **Play** button (the other nine say "Coming soon"). Instructions list five lines. **Progress (level 1)** starts: "Loading market data" then Round 1 of 15 with a chart (price from 0, no symbol, date or clock) and a 10 second bar.
2. **Play a round with the keys:** ← long (CE), → short (PE), ↓ skip, or the three buttons. After the choice the next seconds replay faster, with an "entry" line and a marker; then a sentence says what happened (points after costs, whether a tradable move existed) and **the symbol, day and time are named**. Space (or waiting 3 seconds) goes on. Letting the 10 seconds run out counts as a skip and says so.
3. **Finish a session:** the result shows Score, rounds, trades, hit rate, expectancy, skip precision, timeouts and mean decision time. **Progress** saves (the level can change after two good sessions; 70 or more is hard on purpose, see spec 5.1 C30); **Practice** at level 20 is much faster (2 seconds to decide).
4. **Settings → Market game costs:** the numbers are placeholders; change the slippage and the cost per lot to your broker's, save, play again: the costs in the result sentences change.
5. **Dashboard:** with **Market** or **All** selected, a "Tick Reader expectancy" trend appears after a few Progress sessions.
6. **No repeats:** play two sessions; you should not see the same day and time twice (the symbol and day are named after each round).
7. **Failures:** stop the backend and press Play: a message says the server could not be reached and nothing is recorded. On a backend without the index file, a message says the index has not been built.
8. **Trading is unaffected:** with a paper or replay session running on the website, the trading chart keeps updating while a Tick Reader round plays. In the Windows app, Task Manager memory of the Games window stays well under 600 MB.
9. Tell me whether the pace feels right at level 1, whether three requests per round slows the start of a round, and whether the chart is readable.

## P. Risk Calculator and Hotkey Drill (G4a): Windows build and the website
No backend or Rust change; a frontend rebuild only. Both are in the Market tab (three games are playable now).
1. **Risk Calculator:** Play, Progress (level 1). Each question is a line of arithmetic (for example "Stop 10 points, 2 lots of 65. Rupee risk?"). Type the number, press Enter: it says Correct, Close (half credit) or Not quite and shows the working. Enter again goes on. The bar is the time for the question; letting it run out is a miss. Rounding to two decimals is accepted; 1,605 means 1605. Check at least one question of each type at higher levels (Practice at level 15 or more unlocks all eight, with up to three steps).
2. **Hotkey Drill:** Play. A prompt such as "BUY CE 2 lots" appears: press **2**, **C**, **Enter** (or click). Wrong lots, wrong side or an unknown key shows a red message and counts as an error; the prompt stays until you fix it. **Exit all** is X, **Stop to cost** is S. At level 10 and up there are two- or three-step chains and "IGNORE: do nothing" cues: pressing a key during one is an error. Three one-minute blocks with a short rest between.
3. **Settings → Hotkey Drill keys:** change Buy CE to another letter, save, play: the panel shows your letters and the old one is now a wrong key. Two equal letters are repaired when you save.
4. **Result:** Risk Calculator shows the score and accuracy by question type; Hotkey Drill shows the median reaction time and error counts. Progress mode saves; the Dashboard trend lines for these two appear after a few Progress sessions.
5. **Warm-up** can now include them (with the pool set to Brain and market): check the step opens and finishes.
6. Tell me whether the time limits and the number ugliness feel right, whether three one-minute blocks is too long, and whether any key on your keyboard layout does not work.

## Q. Entry Sniper and Exit Discipline (G4b): Windows build and the website
Needs the backend with the Games index built (section N). Both are in the Market tab (five games are playable now). No Rust or backend change.
1. **Entry Sniper:** Play, Progress. A line says LONG or SHORT with a stop and a target in points, and the chart forms second by second (a 45 second window plays in about 15 real seconds at level 1). Press **Enter** to take the entry at the current price, or **P** to pass; letting the window run out is a pass. After an entry the trade runs fast to the stop, the target or the time limit. The result lines say your R, the best entry in the window (marked on the chart), whether you were chasing (an entry in the first two seconds) and whether the round was a trap. The market, day and time are named. **Space** goes on.
2. **Exit Discipline:** Play. A trade is on in the direction shown. Level 1 to 5 fill in a suggested stop and target; from level 6 they are blank and you type them (the stop must be half to one and a half times the suggested one, the target half to six times your stop: a wrong value is refused with a sentence). Enter or the button starts the replay. **E** exits, **T** moves the stop to your entry (only while in profit), **L** locks half of the open profit; the stop and the target are enforced for you. The result panel gives your R, the plan's R, the best the window offered, and whether overriding made it worse.
3. **Scoring:** Entry Sniper out of 100 with 50 as break-even (passing traps scores half); Exit Discipline is the share of the best available result you captured, and it levels at 50 up and 20 down, not the usual 70 and 40.
4. **Dashboard:** trend lines for entry efficiency and exit capture appear after a few Progress sessions.
5. **Failures:** stop the backend and press Play: a message says the server could not be reached and nothing is recorded.
6. Tell me whether the window length, the stop sizes and the replay speeds feel right, whether three trap rounds in ten is what you want, and how the Exit Discipline plan limits feel.

## R. Level Recall, Strike Picker and Regime Switch (G5): Windows build and the website
Needs the backend with the Games index built (section N). Eight market games are playable now. No Rust or backend change.
1. **Level Recall:** Play. A chart of yesterday and today so far shows labelled levels: yellow lines are the ones you will place, grey ones are shown but never asked (from level 2). Enter (or the button) when you are ready, or wait for the bar. The chart goes and a blank price ladder appears with a dashed "now" line: a prompt names a level; click where it is, for each prompt; Backspace undoes the last; Enter submits. The result shows each level's error in points and in "units" (how much the market moves in five minutes) and the ladder with the true levels in blue. The market and day are named. At **level 10 and up** every third round is a **swing sequence**: six numbered swing points, then five "higher or lower" questions (H and L).
2. **Strike Picker:** Play. A card gives a call or put, the index level, days to expiry, volatility, an expected move in minutes and an objective. Pick one of seven strikes (ITM3 to OTM3) with the arrows, the keys 1 to 7 or the mouse. The table then shows every strike's premium before and after, delta, gamma, theta per day, the spread, rupees per lot and return, with the best strike and yours marked, and a sentence on what drove the result. Later levels include moves that do not come and volatility changes.
3. **Regime Switch:** Play. A stretch of price from an unnamed market and a line saying whether the last 30 seconds went up or down. Press F (follow), D (fade) or S (stand aside). The hold replays and the result names the regime (trend up or down, range, spike), the three playbooks' results after costs, and which was best. Repeating the old playbook after a regime change costs a quarter. Levels 1 to 8 show the previous regime.
4. **Dashboard:** trend lines for level error, best strike picked and regime perseveration appear after a few Progress sessions.
5. **Failures:** stop the backend and press Play on Level Recall or Regime Switch: a message says the server could not be reached and nothing is recorded. Strike Picker still plays offline.
6. Tell me whether the level counts and study times feel right in Level Recall, whether the strike answers make sense to you as a trader (the model is Black-Scholes with a simple spread), and whether regimes change often enough in Regime Switch.

## S. Spot the Trap and No-Trade Day (G6): Windows build and the website
Needs the backend with the Games index built (section N). All ten market games are playable now. No Rust or backend change.
1. **Spot the Trap, breakout:** Play. The chart stops at a bar that closed beyond the yellow level (the highest high or lowest low of the last 24 bars). Press R (real) or F (fake) before the bar runs out. The reveal adds the next minute and two dashed lines ("real if it gets here first", "fake if it falls back here"), and says what happened in points. A late call scores nothing.
2. **Spot the Trap, hunt (level 6 and up, every second round):** a 60 bar chart and a named pattern with its rule. Click each bar that is an occurrence (click again to remove, Backspace undoes, Enter finishes). The reveal marks your clicks "you", the true ones "yes" and almost-qualifying bars "near"; the score is how many you found against how many of your clicks were right.
3. **No-Trade Day:** Play. Choose rules (a checkbox and a limit each); from level 5 you must choose at least 1, from 10 at least 2, from 15 at least 3. Start. The segment plays faster than real time as 5 second candles. L or S enters long or short, E exits, 1 to 3 sets the lots. Every trade has a stop of 1 R (the dashed line). Break a rule on purpose: the game lets you, shows a warning (up to level 10) and counts it. Enter again soon after a loss with as many lots: a revenge trade.
4. **No-Trade Day result:** the segment's net R against the best in hindsight with your trade limit, rule breaks, revenge trades, each trade, and the scores. In a quiet segment, stand aside (no trades or one) and the performance part is credited. Three segments make a session. From level 10 a forced loss of 1 R appears early in each segment.
5. **Dashboard:** trend lines for fake-out accuracy, real-breakout hesitation, rule adherence and revenge trades appear after a few Progress sessions.
6. Tell me whether the real and fake calls feel fair (are the answers what you would say as a trader), whether the pattern hunt finds what you would call those patterns, whether 1 R and the speed of the replay in No-Trade Day feel right, and whether the rules screen is clear.

## T. Review of market sessions, budget and the whole feature (G7): Windows build and the website
1. **Review:** play any market game (Progress), open Review: the session is listed with its score. Open it: one row per round with the market, day and clock time first, what you did, the right answer or the best result, and the time. There is no "Play these puzzles again" button for market sessions, only a note. A brain session still has it.
2. **Result screen:** the market game's result screen now also offers the round table ("Trial review").
3. **Warm-up:** with the Warm-up pool set to Both or Market, the plan includes market games and each step starts the right game; with Brain only it does not.
4. **Low memory mode:** turn it on in Settings, play a market game: nothing changes you can see; the cache holds up to 150 MB instead of 300 MB.
5. **Memory:** with the Games window open for a long session (several market games at level 15 to 20, No-Trade Day included), look at the window's memory in Task Manager (the WebView2 process of the Games window). Tell me the peak. The budget is 600 MB.
6. **Network:** watch the backend log during a No-Trade Day session: a segment fetches two to four windows of about 9 KB each, and the next segment is fetched while you play.
7. **Whole feature:** every game plays at level 1 and at a high level on the Windows build and in Chrome on the website; the Dashboard, Warm-up, Review and Settings tabs work with both pools; Practice sessions leave your level alone.
8. Tell me what you want changed from play: which games feel too easy or too hard, thresholds that feel unfair, anything confusing.

## Report back
Note any step that fails, the symbol and day, and the interval. 
