### Patterns Strategy Deep Dive

> **Status (2026-11-17): built and merged to `dev` (PRs #865 to #878).** What is left is the owner's acceptance, sections A to I of `docs/phase26-manual-acceptance.md` (the Windows app needs a rebuild), and the real-session try of the live label popups (Usage 3 below, sprint S9), which stays on `dev` and does not go to `preprod` before that try.
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
| Screens and shared code | `docs/architecture-frontend.md`, `shared/deepdive/`, `shared/traded/` |
| Tables and routes | `docs/architecture-backend.md` (`DeepDiveSetups`, `DeepDiveTags`, `/api/deep-dive`, `/api/pattern/traded`) |
| Backlog and later ideas | `docs/todo.md` (items 10 and 11) |
| Tests at the end of the phase | backend 3570, `windowsapp` vitest 1762, website Playwright 64 specs, plus the browser checks under `scripts/` |



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