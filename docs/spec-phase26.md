### Patterns Strategy Deep Dive

> **Status (2026-11-20): built and merged to `dev` (PRs #865 to #878, then Strategy Practice #882 to #894 and the chart work #896 to #904, the last being the phone's read-only drawings).** What is left is the owner's acceptance, sections A to M and items 18 to 36 of `docs/phase26-manual-acceptance.md` (the Windows app needs a rebuild, the phone a new APK, the website a redeploy), and the real-session try of the live label popups (Usage 3 below, sprint S9), which stays on `dev` and does not go to `preprod` before that try.
>
> The requirement text below is the owner's original draft, unchanged. The indented **Built** notes under each point say what was built and what differs from the draft. Plan, sprint notes and decisions: `docs/spec-phase26-implementation-plan.md`. Screens and shared code: `docs/architecture-frontend.md` ("Patterns Deep Dive", "Pattern Library: From your trades", "Phase 26 hardening"). Tables and routes: `docs/architecture-backend.md`.

We have patterns section, where we can add strategy with category and mark them on the chart.

This section is for deep dive into a specific strategy and analyzing and listing it.

What are the steps for this feature:-
1) A deep dive section in patterns, where user lists the category and strategy (one and starts deep dive).

> **Built.** A third tab, **Deep dive**, in the Pattern Library on the Windows app and on the website and webapp. The start form takes a category and a strategy (the Pattern Library's own names, with "+ Add new") and a symbol from a dropdown of the Pattern Library's symbols (NIFTY 50, SENSEX, Reliance Industries, Tata Motors CV, Tata Power). The list of deep dives shows days (buy and sell), tags and how many days still need marking. A deep dive shared with you by someone in your Pattern share list opens read-only.

2) First step of deep dive, it show a particular underlying or original chart, and a set of calendar dates, where user marks the dates 
where this strategy of setup occurred.  Along with calendar dates, user also chooses for that day whether the setup came as sell or buy setup in underlying chart or equity. A day can be both as well.

> **Built (step 1, "Mark days").** A calendar where every weekday has its own **B** (Buy setup) and **S** (Sell setup) button, so a day can be Buy, Sell or both and one click can never swap a side. The chart of the selected day sits beside the calendar. Every click saves. Weekends, today and later days cannot be marked, and the server refuses non-trading days (holidays) and any day that is not before today in India. Removing a side that already has tag marks, chart marks, an outcome or notes asks first.

3) Once the dates are entered, then per day the in depth analysis starts:


In Depth Analysis Steps:-
1) User can scroll with next and prev across selected dates, left panel has 2 charts for options. If same day has both sell and buy setups, then it shows the buy setup first and sell setup. If it was buy in underlying then the second chart is CE Chart. CE/PE chart strike price is choosen witih max price or OTM at 09:30.  

> **Built (step 2, "In-depth").** Prev and Next, a chip per day (arrow keys walk them), days in date order with a day's Buy before its Sell. The underlying chart is on top and the option chart below it (a Buy setup on its **CE**, a Sell setup on its **PE**); the two are stacked and share the window height, and each has a **Maximize** button (the choice stays while walking the days). The deep dive's own controls (back, name, steps, the day walk) sit in the Pattern Library's header row to leave the height to the charts. The strikes follow the account's strike setting like the Pattern Library: **Max Price** (checked at 09:30; indices only) or **OTM** (from the 09:15 price, as the Pattern Library does; stocks always use OTM). They are saved with the day, so the option chart never moves, and "Pick strikes again" re-picks. All five Pattern symbols get an option chart. The candle interval is saved per day. Works on KLine (desktop, and the website's KLine mode) and on Lightweight (website).

2) User cannot or can mark the setup with markers similar to pattern.

> **Built.** The same entry and exit mark tools as the Pattern Library (underlying, CE, PE), with the strategy fixed to the deep dive's; clicking the same candle again removes a mark; Undo and Clear. Marks are optional and autosave.

3) Then user can list a set of questions, and answer whether that question occurs on that day or not. Yes or no has to be answered.

> **Built, with a change of name and one extra state.** The owner chose **tags** instead of questions (2026-11-16): "does every opening breakout reversal have a double top" describes the setup, so it is a tag. Tags belong to a category and strategy and are shared by its Buy and Sell days. On each day a tag is **Valid** (the yes), **Not valid** (the no) or **not marked yet**; a second tap on the same state clears it. The third state exists so a tag added later is not silently counted as "no" on the days that never looked at it. **Mark the rest not valid** settles every open tag of the day in one click. Tags can be added, renamed, archived (their marks stay) and restored.

What are these questions ?
These questions are more for calculating frequency of occurence within a setup, Like does breakout have second leg ?, is breakout reversed with exhaustive bar or double top or micro double top ?.

These questions are used to further define the setup more clearly. User can also to list whether this days setup is failed or success case. 

> **Built.** Each day also has an **Outcome** and free **Notes**. The outcome is **Ideal, Average, Poor** (three grades of a success, owner's request 2026-11-17) or **Failed**: one choice per day, kept with the day; an older Success shows as not graded. The entry and exit times of a day are read from its Entry and Exit chart marks (`GET /api/deep-dive/timings` lists them for every deep dive) and shown beside the outcome and in Results. The percentages count, per tag, the days where it was Valid over the days where it was marked (Valid or Not valid), with the number of days shown ("70% (n=14)") and a "Only n days marked" note under 5 days.

user can add more questions as user passes through days. However, the system should show which days have unanswered questions, ideally, next or prev is not allowed untill all questions are answered. Hoewver, let say user add question on 11th, then went to 20th and added 1 more new question, this new question is un-answered for 11th, so that should be pointed out, when deep dive is not or some other way.

> **Built as a soft block** (the owner's choice): Next and Prev always work, and the gaps are shown instead. Day chips are green when every tag is marked and amber when not; a banner says how many tags the current day has open; a **Needs marking** list names every open day with the count (click to jump); **Next unmarked day** jumps ahead. A tag added on the 20th makes the 11th amber again. Adding a tag tells you how many days it leaves unmarked.


Usage:-
1) In Pattern view user can choose another option of deep dive, in which user is shown these deep dive days and questions answers etc.

> **Built (step 3, "Results").** An **All / Buy / Sell** filter, the success rate, a bar per tag with its percentage and n (ordered by tag order or most frequent first), and a row per day (date, setup, outcome, a dot per tag, marks, notes). A day opens in the in-depth step. Buy and Sell mean the direction the position profits from: **Buy** = long or bullish (long equity or index, CE bought, PE sold); **Sell** = short or bearish (short equity, PE bought, CE sold).

2) In View in patterns, user should able to see the actual pattern and expected pattern listed during trade labelling as well.

> **Built as "From your trades"** (from the owner's clarification of 2026-11-16: the strategies keep growing from what is labelled in Label Trades, expected or actual, and should be usable in the Pattern view). A fourth Pattern Library tab lists every strategy you have labelled a trade with (counts of trades, expected and actual, last day), the trades behind one (day, instrument and strike, position, time, P&L, whether the strategy was the expected or the actual one), and draws a chosen trade on its underlying and CE or PE charts, side by side, each with a **Maximize** button, with **gold ⚑ BUY / ⚑ SELL marks** on the 3-minute bars, so it reads as the actual orders and not an ideal pattern. **Save as pattern chart** copies the entry and exit into the day's pattern chart as ordinary marks; **Save and edit** also opens it in Annotate (Create on the website).

3) These questions and answered would create a frequency % occurence, when user duirng a trade chooses an exxpected strategy, they should be able to see the answers with percentages, like breakout normally have 70% 2nd leg etc.

> **Built.** Choosing an Expected Pattern that has a deep dive shows a **Your deep dive** panel (top tags with percentage and n, the success rate, and an All / Buy / Sell switch that opens on the side the position profits from) in: Label Trades on every host (website, webapp, Windows app, phone) and the **live label popups** of replay, stepwise, paper and real sessions. It is read-only and additive: loading it never delays or changes a label save, and an older server or a strategy without a deep dive simply shows no panel. **The live popups are real-trading screens: they stay on `dev` until the owner has tried them in a real session** (acceptance section F).


Extensions:-
1) If possible, can these deep dive patterns marked, will also be saved as annotations, to be seen with pattern view.

> **Built.** In Results, **Save to Patterns** per day and **Save n marked days to Pattern Library** copy a day's chart marks into the normal pattern chart for that symbol and day (merged by mark id into the day's own chart, or a new one; a chart on other strikes is refused), so they show in the Pattern Library's View.

### Other minor features
1. Increase the search window for Max Price from 30 strikes to 50 strikes.

> **Done** (#865) everywhere the search runs: the minute search behind Patterns, Browse, the phone and session start, and the older second-level search.

2. 

> **Still open: nothing was specified here, so nothing was built.** Tell me what item 2 should be and it becomes a small change on `dev`.

### Also done during the phase (from using the screens)
- The calendar put every date one column late (Monday under Tuesday); fixed, with a check that every day sits under its weekday.
- Only NIFTY and BSESEN could be chosen; the symbol dropdown now has all the Pattern Library's symbols, and each gets an option chart.
- The in-depth charts now fill the window height (stacked), and no longer leave half the page empty.
- After the owner's review: the traded charts are side by side; every chart has a Maximize button; the Deep Dive header is in the Pattern Library's own row.
- In paper trading the website showed "Feed kite · connected" as a row that took chart height; the line now shows only while the feed is connecting, reconnecting, unavailable or on a fallback provider (the desktop toolbar label follows the same rule).
- Hardening: the percentages every label form fetches are cached for 20 seconds and dropped by every write; an older backend or a dropped connection is explained in plain words and no longer leaves the start screen empty.

### Where things are
| What | Where |
|---|---|
| Plan, sprint-by-sprint notes, decisions | `docs/spec-phase26-implementation-plan.md` |
| What to try by hand (sections A to I) | `docs/phase26-manual-acceptance.md` |
| Screens and shared code | `docs/architecture-frontend.md`, `shared/deepdive/`, `shared/traded/`, `shared/practice/` |
| Chart drawings (KLine and Lightweight, shared records) | `shared/charts/` (`klineDrawingModel.ts`, `klineRiskReward.ts`, `klineMarker.ts`, `klineText.ts`, `klineFibSegment.ts`, `useKLineDrawings.ts`), `frontend/src/components/analysis/` (`lightweightDrawings.ts`, `lightweightPersist.ts`, `lightweightHit.ts`), `mobile/src/env/drawingReader.ts` |
| Tables and routes | `docs/architecture-backend.md` (`DeepDiveSetups`, `DeepDiveTags`, `/api/deep-dive`, `/api/pattern/traded`) |
| Backlog and later ideas | `docs/todo.md` (items 10 and 11) |
| Tests at the end of the phase | backend 3570 (+ `test_desktop_persistence.py` with the Text drawing case), `windowsapp` vitest 1824, website Playwright 96 tests, `node --test` 31 (Lightweight hit-testing and persistence mapping), phone vitest 121 and phone UI 233, plus the browser checks under `scripts/` |



### Strategy Practice
This section lists a feature which the deep dive strategy and calendar days marked by user is used for replay trading for practicing strategy. In the deep dive section, user marks the entry and exit points, success, fail and also strength.


The steps of the feature:-
1) User selects a strategy which needs to be practiced.
2) User chooses the symbol, (optional)
3) User also chooses the replay speed.
4) The system from its deep dive automatically chooses a date and for time when to start the replay, Time can be found from the first entry and going back few bars. Keep it some random number of bars, so user doesn't start guessing, the system can start from any minute, even if the strategy is recorded with 3 min bars lets say. 
5) User practices the strategy, and does trading similar to replay trading, with all features similar to replay trading.
6) User ccan evaluate entry and exit against reccorded or marked entries.
7) System can also evaluate profit from entry and exits as marked, and taking start of bar as entry and may be close of bar, as exit. If 2 exits or entries are present, choose the pair most profitable. System can use this to evaluate what user performed.


Not sure where this feature will land up, feel free to choose. Make sure the traing UI is similar or exactly as replay trading, just to create better habits. 

Some way to post analyze as well.

Do discuss anything as required.

> **Built (2026-11-17), sprints S12 to S18** (PRs #882 to #891 and this one): see "Strategy Practice" in `docs/spec-phase26-implementation-plan.md` and section M of `docs/phase26-manual-acceptance.md`. This stays inside Phase 26. Plan and sprints: `docs/spec-phase26-implementation-plan.md` ("Strategy Practice"). The owner's decisions:
> - **Where:** a **Practice** tab in the Pattern Library next to Deep dive and From your trades, on the **website, webapp and Windows app**. The phone can only review a practice run (it cannot trade).
> - **Session:** a normal **Replay** session, so the trading screen is exactly the replay one. **Stepwise** (one bar per Next Bar press) is a second mode per run on the website and the Windows app (S19 to S21; the start is snapped to a bar boundary of your own Stepwise bar, never before 09:15). Underneath it is an ordinary replay session with a practice marker, so orders, Analysis, Label Trades, Walkthrough and What If work unchanged.
> - **Days offered:** the user's own Deep Dive days that have an **Entry mark** (any outcome; Ideal / Average / Poor / Failed can be ticked at start); optional symbol; days already practised are not repeated until all are used.
> - **Start time:** a random whole number of minutes, **5 to 25, before the first Entry** (never before 09:15), so it need not match the chart's 3 minute bars.
> - **Hidden until Stop:** the setup's Buy or Sell side and its marks stay hidden while practising; the review is refused while the session runs.
> - **Review:** your entries and exits against the recorded ones (minutes early or late), and your P&L against the **theoretical P&L** of the marks (entry at the open of the marked bar, exit at the close of the marked bar; with several entries or exits the most profitable pair), as points, % and capture %.
> - **Performance:** practice runs are **excluded from the Performance totals** and stay in Analysis session lists marked Practice.
> - **Negative tests (owner, 2026-11-17):** a day where the strategy was **absent** is also a valid practice day, like a day labelled Failed: the right call is not to trade. The unmarked days **between the oldest and the newest marked day** (per symbol) are taken as reviewed and absent; days outside that range are never offered (they may never have been looked at). A Start option includes them, about one pick in four; the review says "No setup was recorded" and treats any trade as one you should not have taken.
> - Days already marked in the Deep Dive are used as they are; nothing needs re-marking (an Exit mark is only needed for the theoretical P&L).
> - **Hardening (S18):** a day whose data could not be loaded when the replay starts is skipped and not offered again (until another strategy is chosen); a run still marked running 12 hours after it started (a crash) can be reviewed; the real and paper session paths are unchanged (the marker is optional, written only when set, and refused on other session types).

> **Views and chart tools (2026-11-18 to 11-20, owner requests, PRs #896 to #900; details in `docs/architecture-frontend.md`).**
> - **In-depth layout:** the two charts of a day can be **stacked** (default) or **side by side**, a switch in the Mark row, remembered per browser or app.
> - **Mark days: Underlying / CE / PE:** tabs above the day's chart; CE and PE show the option chart at the strike of the **09:30 Max Price pick with a premium cap of 75** (the owner chose 75 over 50; one constant, `PREVIEW_STRIKE_CAP`), whatever the account's strike setting is. Preview only: nothing is saved and a marked day's own strikes are untouched. Max Price applies to the indices (NIFTY, SENSEX); the stocks get an ATM strike.
> - **No marker selected to begin with:** in Deep Dive in-depth and in the Pattern Library's create mode (website and Windows app) a click on a chart marks nothing until a marker is chosen; clicking the chosen marker again puts it down.
> - **KLine pattern marks** are an arrow just outside the candle with plain text and no background box, like the Lightweight markers, on every KLine pattern screen.
> - **KLine Fib Retracement** draws line segments between and a little past the two clicks, not across the whole chart, on every KLine chart (trading and Analysis).
> - **Text drawing:** a **Text** tool on KLine charts (saved to the database as a one-point drawing with a `text` field, shared across screens of the instrument; double click changes the text; drag, lock, hide and delete as for any drawing) and on the Lightweight Analysis / Patterns / Deep Dive charts (saved to the database like KLine's since the shared-drawings change; a drawing can be picked with a click and deleted on its own, and a Text's text changed by a double click; not moved). The Lightweight live-trading chart is not changed.
> - **Layout fixes:** the Mark days chart and its time axis end inside the window, and the Pattern Library page fits its frame, on the website.

### Shared chart drawings (KLine and Lightweight), 2026-11-18 to 11-20

Owner requests made while using the Deep Dive and Patterns charts (PRs #897, #900, #901, #902, #903, #904). They are chart-wide (the Analysis, Patterns and Deep Dive charts, and, for KLine, the trading charts), not specific to one screen. Design notes: `docs/architecture-frontend.md` ("Text drawing", "Lightweight drawings: pick, delete, change a Text", "KLine Risk : Reward and Buy / Sell marker drawings", "Lightweight drawings are saved and shared with KLine"), `docs/architecture-phone.md`; plan: `docs/spec-phase26-implementation-plan.md`; checks: items 20 to 36 of `docs/phase26-manual-acceptance.md`.

> **The owner's decisions.**
> - Drawings are **saved to the database and shared between the KLine and Lightweight charts** for the tools both have; **a line deleted in one chart type stays deleted in the other** (a soft delete of the one shared record).
> - KLine gets the Lightweight-only tools so every saved drawing shows on both: **Risk : Reward** (modelled on the Long Position tool, but placed **stop first, then entry**, as a trade is entered with its stop) and **Buy / Sell markers**.
> - The Windows app shows the KLine changes after a rebuild (same components). The Android phone shows saved drawings **read-only** (no drawing tools on the phone).
> - Drawings kept in the browser before (Lightweight only) are **copied to the database once**.
> - Lightweight drawings cannot be moved; they can be picked, deleted one at a time and a Text's text changed.

> **The common tools.** One saved record per drawing (`{tool, points, text?, style?, visible, locked}`, the KLine shape), under the instrument's identity (option, or `{kind, exchange, symbol}` from the catalogue; no date, no scope), so the Day, Swing, Analysis, Patterns and Deep Dive charts of one instrument share them. Only the points, the text and a Text's colour are shared: each chart draws them in its own style.
>
> | Tool | Saved as | Points | Notes |
> |---|---|---|---|
> | Horizontal line | `Horizontal` | 1 | a Lightweight line keeps the time of the click |
> | Trend line | `Trend` | 2 | |
> | Fib Retracement | `Fib Retracement` | 2 | KLine draws 7 levels as segments between and a little past the two clicks (not across the chart); Lightweight draws 5 levels |
> | Rectangle | `rect` | 2 | |
> | Text | `Text` | 1 + `text` | up to 80 characters; asked for in a small box beside the click (Enter keeps it, Escape, Cancel or empty drops it) |
> | Buy marker, Sell marker | `Buy Marker`, `Sell Marker` | 1 + `text` | blue up arrow below, orange down arrow above the point; text `Buy UL` / `Sell UL`, no background box |
> | Risk : Reward | `Risk Reward` | 2: **stop, then entry** | levels at the stop, the entry and the entry plus 1, 1.5 and 2 times the stop-to-entry distance (upward when the stop is below the entry, a buy; downward otherwise), each with its price |
>
> KLine-only tools (ray, arrow, brush, Fibonacci extension and fan, parallel channel, measure, Gann box, Long and Short position) are not drawn in Lightweight and are never touched by it. A record hidden in KLine is not drawn in Lightweight; one locked in KLine is drawn but cannot be picked there.

> **How it behaves.**
> - **Making and deleting.** KLine: the tool rail, double click on a Text to change it, select and Delete (or Ctrl+Z for the last). Lightweight: **Draw ▾**; with no tool on, a click within 7 pixels of a drawing **picks** it (thicker lines, an outline on a rectangle or text, a small bar with **Delete** and, for a Text, **Edit text**); the Delete key deletes it, Escape or a click on empty chart drops the pick, a double click on a Text opens its text box, **Clear** removes the last one. In Deep Dive in-depth, with a marker selected, a click on a drawing picks the drawing and is not also an Entry / Exit mark.
> - **Sync.** On one page the two chart types update each other at once; a second browser tab, another device or a change of the chart setting picks changes up when the chart next opens. A failed save or delete shows a notice and the chart is refreshed from the database.
> - **Deep Dive.** Drawings belong to the instrument, not to a day (as on KLine); the time of a drawing places it on its day.
> - **Old drawings.** The first time a Lightweight chart opens an instrument its browser-only drawings (also the Deep Dive per-day ones) are copied up, skipping any the database already has; the local copy is left in place.
> - **Phone.** The phone's charts draw the saved drawings locked, with no tools rail, no selection and no shortcuts; its drawings service can only read (one instrument's drawing list, the chart colours, the catalogue).
> - **Backend.** No change: a drawing is stored as given; the only checks are a non-empty tool and integer-timestamp points; delete is a soft delete.

> **Not done, and limits.**
> - The Lightweight **live-trading chart** (`Chart.tsx`, real trading) keeps its own local drawing tools, unchanged; Text, picking and saving were not added there.
> - Lightweight drawings cannot be moved; there are no drawing tools on the phone.
> - Live sync is same page only (no cross-tab push); two browsers that both copy up the same old drawings before either finishes could duplicate them.
> - The backend lists a user's drawings and filters by instrument in Python, so each chart open reads all of the user's drawings; fine at today's size, an index would be the fix if they grow.
> - A drawing made on one Deep Dive day shows on a neighbouring day when that day's chart history reaches back to it.
> - The `analysis-tools` KLine "restores after reload" website test fails intermittently in the full suite (also on unmodified `dev`); the phone and desktop CI builds can fail on a temporary Gradle or network download error, which a re-run clears.
