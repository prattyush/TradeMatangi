

> **Status (2026-11-20): planned, not built yet.** The requirement text below is the owner's original draft, unchanged. The indented notes under each point are the decisions made with the owner on 2026-11-20. Plan, sprints and the drawings fix found the same day: `docs/spec-phase27-implementation-plan.md`. Checks to try by hand: `docs/phase27-manual-acceptance.md`.

## Upgrades
### Deep Dive

#### Results
In the results section, we also need a way to show results, when tags are combined in AND or OR way or Conditional (how many times 2nd happened when 1st happened), like one tag for breakout says it had a 2nd leg, another tag said reversal was exhaustive bar. Now, the group case how many times reversal was with exhaustive bar when we had a 2nd leg in breakout. 
Also, would be case of AND, that is cases when a reversal strategy had liquidity traps and it went on to become a trend, one tag for liquidity trap another for trend.

I can think of only conditional examples now. One way to think that is when AND is true and AND is false. I mean as when AND is true both tags happened, and when it is false 1 tag didn't happen, which also kind of gets the point, example for breakout, the reversal was not exhaustive but breakout had 2nd leg, or breakout had 2nd leg and breakout was not exhaustive bar.

For view of these grouped results, you can show them in live trading as well as another tab named group beside all , buy and sell.

> **Decision (S3).** **Two tags** at a time (no OR view and no N-tag builder). Counted only on days where **both tags are marked**; days where either is not marked yet are listed as "not counted". Shown per pair: both valid (AND true), A valid and B not valid, A not valid and B valid, both not valid, and the conditional P(B valid | A valid) and P(B valid | A not valid), each with n and the "few days" note under 5. A **Group** tab beside All / Buy / Sell in Results, and in the live label popups (an optional per-day list added to `stats/all`; additive, read-only, never delays a save; it stays on `dev` until the owner's real-session try).
>
> **Built (S3).** Results has a **Group** button beside All / Buy / Sell. Pick tag A and tag B (a swap button, the same tag cannot be both) and a side (All / Buy / Sell). Only days where both tags are marked count; the others are listed ("2 not counted", with the missing tag named). It shows the conditional rates ("when A was valid, B was valid 75% (3 of 4)", "when A was not valid, B was valid 50% (1 of 2)", and B to A), then the four cells: both valid (AND true), A valid and B not, A not valid and B valid, neither, each with its count out of the counted days and its percentage. Click a cell to list its days and open one in the in-depth step. The live label popups (replay, paper, real, stepwise, desktop) get a compact **Group** button too, starting on the position's own side (a bought CE is Buy), shown only when the server sends the per-day list and the deep dive has two tags. Percentages round like the other tag percentages; under 5 days gets the same "only n days" note. Live popups: **on `dev` only until your real-session try.** OR is not built.


#### Deep Dive Comparison
In deep dive we will also have a section like marking days in depth, where we can compare strategies, for user to analyze. Only after user has marked the days, can user compare marked days of 2nd different dates, side by side. He can change one date of one strategy and another date for another strategy, like comparing case when reversals end with trend resumption and when reversals end with trend in opposite direction. For now the comparison is only view and may be user finds more thing to look deep dive.

Both the charts of different strategies can be side by side and will have option to switch to CE and PE independently as one chart might be also looking into strategy in BUy side and another strategy in SELL side.

> **Decision (S4).** A new **Compare** tab in the Pattern Library (not a step inside one Deep Dive, so two different strategies can be compared). Each side picks its strategy, one of its marked days (date and side) and Underlying / CE / PE; only strategies with marked days are offered. View only: nothing is saved. Each pane uses the day's saved strikes, draws the day's marks and has its own Maximize. The candle interval gets a per-pane value, because today it is one shared setting.
>
> **Built (S4).** A **Compare** tab in the Pattern Library (desktop tab "Compare"; website and webapp "⚖ Compare"). Two panes, A and B, each with a strategy picker (only strategies that have marked days; a shared deep dive is marked "(shared)"), a day picker (newest first, with side, symbol and the number of marks) and Underlying / CE / PE buttons, so one pane can be a Buy day on its CE and the other a Sell day on its PE. The day's marks are drawn on the chart. The CE and PE use the strikes saved with the day; a day with none gets the same preview pick as Mark days (Max Price at 09:30, premium at most 75), and the note under the chart says which. Each pane has its own **Maximize** (the other pane hides) and its own candle interval, starting at the day's saved one and changed on the chart without touching the other pane or the shared Analysis setting. View only: nothing is saved. Both panes can show the same strategy. Not tried yet on the Windows app (see `docs/phase27-manual-acceptance.md` section D).


### Analyze

#### Analysis Maximize

Analysis tabs namely trades, label trades, walkthrough and what if should have a maximize when that section takes up the entire screen, and then revert back to multi day view upon restore.

> **Decision (S2).** Label Trades, Walkthrough and What If already had their own Maximize (it covered the day list but not the tab bar); Trades had none. They are replaced by **one Maximize on the day card for all four tabs**, covering the whole screen including the tab bar, so tabs can be switched while maximized. Restore, or Esc, returns to the multi-day view with the day list as it was. Website, webapp and Windows app; the phone already shows these views full screen.
>
> **Built (S2).** One **Maximize** button at the right of the day card's tab bar (Trades, Label Trades, Walkthrough, What If). Maximized, the card's detail fills the window (the Windows app keeps its navigation bar), the tab bar stays so tabs switch while maximized, and Restore or Esc returns to the day list with its filters as they were. Label Trades, Walkthrough and What If show the Underlying and strike charts stacked while maximized, as before. The three per-tab buttons are gone; the phone's full-screen overlays have no card and so no button. Website, webapp and Windows app. Not tried yet on the Windows app (see `docs/phase27-manual-acceptance.md` section B).


#### Score of a day
Can you score a day's performance, based on following points. Feel free to add your points as well. Try to make the score non linear and penalizing some acts more and rewarding some acts more.
You can calculate the score after the trades are labelled.

1) If user during the trading, not closed trades but even when the position was on, and the trade went in opposite direction and then trade went in favorable direction, but at some price, the total loss % of the day would have touched the guardrail ban value of capital loss limit %, then that reduces the score, if 50% of limit was touched then penalty, if 100 % limit was touched higher penalty. To do this, you might have to save each days guardrail capital loss limit value as well, so, if it is changed it doesn't effect.
2) If user enters into repeat trade within lets say 2-3 bar or within 6-9 mins of previous trade, in same direction with same strategy expected, results in consequetive losses, then that shows breaking of disicipline, that effects the score negatively.
3) If user adds to losing trades and results in both entries in loss, that effects the score negatively.
4) If for all closed trades, the net P&L % for the day, never went to negative, that should carry high positive score points.
5) If one bad trade, wipes positive P&L % for last 3 trades or more, then that means big size and over confidence, you can penalize that.


Can you include these points, in habits, like system calculated habits and include them in stats as well. Name them as suited.

> **Decisions (S6, S7).**
> - **Score:** 0 to 100 per day, non-linear (penalties grow with repeats; bonuses are larger at the extremes), computed once the day's trades are all labelled, stored per day with the points of each rule. Shown on the day card, as a trend in Stats > Behavior and as a breakdown in the day's Notes tab. Weights live in one config so they can be tuned on real days.
> - **Rule 1 (drawdown against the guardrail limit):** the open-position drawdown is rebuilt from cached candles, with the day's cycles on one time axis, because the system stores no mark-to-market. From now on each session saves its guardrail capital-loss limit at create. **Older sessions use a fixed 12%** (the owner's earlier setup) and are marked "estimated". A day whose candles are missing skips this rule and is marked "partial".
> - **Rules 2 and 3 ("same direction"):** the **same contract** (the same CE or PE strike), within 2 to 3 bars (6 to 9 minutes), with the same expected strategy where it is labelled.
> - **System habits:** rules 2, 3 and 5 become habits named `sys:repeat_entry`, `sys:add_to_loser` and `sys:big_loss_wipes_gains`, shown in the Habits scorecard, trends and compare next to your own habits (they cannot be archived). Rules 1 and 4 are day-level and show as score items.
> - **Real trading:** the guardrail snapshot is written at session create (additive). That is a real-trading path, so it stays on `dev` until the owner's real-session try.


### Improvement Notes
In the label trades section or some where else, can you also have an option to enter notes, what went well, what to improve and any specific points to improve and in general some context about the trading day and high level trading behavior. User can also add TODO, which are carried over and showed in the next days trading notes and user can mark them displayed or improved.

Feel free to be creative in this space, not sure about where to display and where, but I want on a high level, user notes or points to focus on with some TODO type, where user selects ok did that, did that, still working.  And add context, so that when I review older days I can say I am improving or not, behaviouring. Maybe stats might not show or showing. 

> **Decisions (S5).** A **Notes** tab on the day card (the fifth, after What If), on every host. **One note per market date**, covering all of that day's sessions (replay, paper and real): what went well, what to improve, specific points and context. **TODOs** stay open until closed: Open, Working on it, Done / Improved; every change is kept with its date. Open TODOs from earlier days show at the top of the day's notes and as a banner in Label Trades. A review list shows each TODO's history and how many were closed per week, so improvement can be seen over time. Linking a TODO to a habit was not chosen.
>
> **Built (S5).** The **Notes** tab is the fifth tab of the Analysis day card (website, webapp, Windows app), after What If. Top: the day's **TODOs**: those written on earlier days that are still open or working are carried here (marked "from 14 Oct"), with today's own; each has Open / Working on it / Done / Improved buttons, a delete and its history; Done and Improved close it, so it is not carried to later days. Then the day's **note** with four boxes (What went well, What to improve, Specific points to focus on, Context and behaviour), saved by itself a moment after typing stops. Last, a collapsed **Review**: how many TODOs are open, working, done and improved now, a table per week of TODOs written and closed, and every TODO with its history. Reviewing an older day shows each TODO as it stood that day. In **Label Trades**, the TODOs still open on that day show in a banner above the form. Notes are yours only, and are kept when a session is deleted. **The phone has no Notes tab yet** (its views are overlays, not a day card); it is not built in this sprint. The score breakdown joins the Notes tab in S7. Server tables `DayNotes` and `DayTodos` are created on first use (also in `scripts/setup-dynamodb-tables.py`); the Windows app needs a rebuild (new analysis routes).

### Found on 2026-11-20: Lightweight charts and KLine drawings (Phase 26 follow-up)
The owner saw lines drawn in KLine missing on the website Browse in Lightweight mode. Cause: Browse, Day, Swing and live Lightweight charts all use `Chart.tsx`, which keeps drawings only in the browser; Phase 26 shared the database drawings with the Analysis, Patterns and Deep Dive Lightweight charts only (listed there as "Not done"). **Decision (S1):** all Lightweight charts save to and read the same database drawings as KLine (the common tools only), including the Swing scope; old browser-only drawings are copied up once. Details and the first check: `docs/spec-phase27-implementation-plan.md` section A.
