# Phase 27: Manual acceptance (owner)

**Status (2026-11-21): every sprint is merged to `dev` (S1 #905 to S7 #911); nothing below has been tried by the owner yet.** Tick each item when tried. The sections follow the sprints of `docs/spec-phase27-implementation-plan.md`; a section is added when its sprint merges. Website and webapp come from `dev` after a redeploy; the Windows app needs a rebuild when a sprint changes a Rust allowlist.

## A. Lightweight drawings shared with KLine (S1, real-trading chart: dev only)
Status: merged #905 (S1), waiting for your try.
1. Browse, KLine: draw a Horizontal line, a Trend line and a Text. Switch Settings > Trading Chart to Lightweight: the same three are on the Browse chart.
2. Browse, Lightweight: draw a Fib Retracement and a Rectangle. Switch back to KLine: they are there.
3. Delete one drawing in Lightweight: it is gone in KLine (and the other way round).
4. Change the candle interval in Browse: the drawings stay (they no longer belong to an interval).
5. A drawing that was kept only in this browser before (made in Lightweight Browse, Day or Swing) is copied up once and then shows in KLine.
6. Day chart in a replay, then paper session (Lightweight): draw, reload, the drawing is still there. Check the chart still updates on every tick. Swing chart: a line drawn on a swing contract in KLine shows in Lightweight and the other way round; it is the same drawing the Day chart shows for that contract.
7. Only after 1 to 6 on replay and paper: one try in a real session.

## B. Analysis Maximize (S2)
Status: merged #906 (S2), waiting for your try. Website, webapp and Windows app (a Windows rebuild picks up shared code).
1. Analysis, open a day: there is one Maximize button at the right of the tab bar (Trades, Label Trades, Walkthrough, What If), and none inside the tabs.
2. Maximize on Trades: the day fills the window (the Windows app keeps its top bar); the trade list, the journey chart and the chart panel are all reachable.
3. While maximized, switch to Label Trades, Walkthrough and What If: it stays maximized; Underlying and strike charts are stacked, with Prev / Next working.
4. Restore, or Esc: back to the day list with the same filters and the same day open. Esc inside a maximized chart only returns that chart first.
5. A chart's own Maximize (KLine) still works inside the maximized card.
6. Phone: Label trades, Walkthrough and What If look as before (no Maximize button).

## C. Group tab (S3; the live popups are real-trading screens: dev only)
Status: merged #907 (S3), waiting for your try. Website, webapp and Windows app (a Windows rebuild picks up shared code).
1. Pattern Library > Deep dive > a strategy with at least two tags, marked on several days > Results: a **Group** button beside All / Buy / Sell.
2. Group: pick tag A and tag B. Check the numbers on a few days by hand: only days where both tags are marked count; "n not counted" lists the others and says which tag is missing.
3. "When A was valid, B was valid x% (n of m)" matches a count of the days where A is Valid. Swap A and B and the conditional lines swap.
4. Click a cell (for example "both valid"): its days are listed; click a day and it opens in the in-depth step.
5. The Group side buttons (All / Buy / Sell) change the counts. A strategy with fewer than two tags says "Group needs two tags".
6. Label a trade in Label Trades (Analysis): pick the expected category and strategy of that deep dive; the panel has a **Group** button, on the position's own side. Same on the live popup in a **replay** session first, then paper, then one real session (the popup is the real-trading screen).
7. Saving a label with the Group view open changes nothing in what is saved.

## D. Compare tab (S4)
Status: merged #908 (S4), waiting for your try. Website, webapp and Windows app (needs a Windows rebuild for the shared code).
1. Pattern Library: a **Compare** tab beside Deep dive. With no marked days anywhere it says "Nothing to compare yet".
2. Two panes. Pick a different strategy in each, and a marked day in each (newest first). The day's chart shows with its marks.
3. Switch pane A to CE and pane B to PE (for example a Buy day on CE and a Sell day on PE): each uses the strike saved with that day. A day with no saved strike shows a preview strike and the note says so.
4. Change the candle interval on one chart: the other pane keeps its own, and the chart in Analysis or in Deep dive is not changed.
5. Maximize one pane: the other hides; Restore brings both back. Try it on both chart renderers (Settings, Analysis and Patterns chart).
6. Nothing is saved: open the same strategy in Deep dive afterwards, its days are unchanged.
7. A strategy shared with you can be compared too (it is marked "(shared)").

## E. Notes and TODOs (S5)
Status: merged #909 (S5), waiting for your try. Website, webapp and Windows app (needs a Windows rebuild: new analysis routes). The phone has no Notes tab yet.
1. Analysis, open a day: a fifth tab **Notes** after What If.
2. Write in the four boxes and wait a second: "Saved" appears. Reload Analysis and open the same day: the note is there. Clear all four boxes: the note is removed.
3. Type in a box and switch to Trades at once: come back, the text was kept.
4. Add a TODO. Open **the next trading day** (or any later one): the TODO is there, marked "from <date>", at the top.
5. Mark it **Working on it** on the next day, then **Improved** on a later one. On days after that it is gone; on the day it was closed it still shows as Improved; on the day it was Working it still shows as Working (reviewing an old day shows it as it stood then).
6. **Review**: the totals match, the week table counts written and closed per week, and each TODO's history reads "14 Oct: Open → 16 Oct: Working on it → ...".
7. Label Trades on a day that has open TODOs: a banner above the form lists them (read only). Change a status in Notes and the banner follows when you reopen the tab.
8. Delete a TODO: it asks, then it is gone from the day and the review.
9. Delete a session from Sessions: the day's note and TODOs stay (they belong to the date, not the session).
10. A day shared with you does not show the Notes tab.

## F. Day score and system habits (S6, S7)
Status: merged (S6 #910, the backend and the session-create snapshot, real-trading path: dev only; S7 #911, the screens). Needs a Windows rebuild (new analysis routes). The phone shows the System habits but no chip or breakdown.
S7, the screens (website, webapp, Windows app):
- Analysis, a day whose trades are all labelled: a chip **Score nn** next to the "n/n labelled" badge (green 75+, amber 50 to 74, red below), on the card and, once any card has scored the day, in the list.
- Open the day, Notes tab: **Day score** first: the score, "A plain day 60", each rule with its points and what was found, the lowest point of the day against the limit, and a yellow note if the limit is estimated or candles were missing.
- A day with a trade not yet labelled: no chip; the Notes tab says how many trades still need a label. Label them in Label Trades, go back: the score is there.
- Habits (Stats): a **System** filter beside Entry and Exit with the three calculated habits, each with the usual Costly / Rewarding verdict, deep dive and compare. They cannot be archived (Manage questions does not list them).
- Stats > Behavior > Day P&L path: the metric **Day score (0 to 100)** plots your scored days over the range; it may take a moment the first time (it scores up to 31 new days per round, then say "more days still to score"; choose the metric again to continue).
- Tell me if a day's score or one of the three system habits does not match what you remember: the weights are a first guess and are all in `CONFIG` in `day_score_service.py`.

S6, the backend and the guardrail snapshot (use the website's address bar while signed in, or the browser's Network tab):
1. Start a **replay** session (Day, any date), trade a little, Stop. In DynamoDB the session's `Sessions` row has `guardrail_limit_snapshot` with your Guardrail BAN % and whether the ban was on. Then paper, then one real session: the same.
2. Change the BAN % in Settings, then resume a paper or real session from before: the row still has the old value (the limit does not follow settings).
3. A session from before this change has no such field; the score uses a fixed 12 % and says `limit_source: estimated`.
4. `GET /api/analysis/day-score?date=YYYY-MM-DD` for a day whose trades are all labelled: `status: scored` with a score and five items; with one trade unlabelled: `status: pending_labels` with `labelled` and `closed`; a day with no trades: `no_trades`.
5. For a day you remember: check each rule against your trades (a repeat loss within 9 minutes on the same contract, an add to a loser, a day whose closed P&L stayed above zero, one loss after three wins) and the drawdown against what the day really touched. Tell me which numbers feel too harsh or too soft: they are all in `CONFIG` in `day_score_service.py`.
6. Label or change a trade and read the score again: it follows. Delete a label: the day goes back to `pending_labels`.

## G. Notes chart and score rules (S8, S9)
Status: S8 merged #914 (the scoped drawings, shared with the trading chart's controller: dev only), S9 in PR; waiting for your try. Website, webapp and Windows app (a rebuild picks up shared code). Not the phone.
1. Analysis, open a day, **Notes**: a header with the full date and the day's score, then the day's charts. On a date with two symbols there is a tab per symbol (both sessions' trades, replay, paper and real, together); with options the Underlying and the CE / PE chart show, with the buy and sell markers. Try on both chart renderers (Settings, Analysis and Patterns chart).
2. Draw a Horizontal line, a Trend line and a **Text** on the Notes chart; reload and reopen the day: they are there.
3. Open the same contract in the **Trades** tab, in Browse and on a live chart: the lines and the text you drew in Notes are **not** there.
4. A line you had drawn earlier on another chart (for example a support line from Browse) is on the Notes chart the first time you open that day. Delete it in Notes: it is still on the other charts. Reopen Notes: it does not come back.
5. A line drawn on the other chart **after** you opened that day in Notes is not added to it (the one limit of this design).
6. The note beside the Day score and the TODOs (two columns on a wide window, one on a narrow one); Maximize: the chart keeps a good height and everything still scrolls.
7. Day score: click a rule, for example "Drawdown against the guardrail limit": why it counts, how its points are set (the numbers match the score you see) and, for repeat entries, adding to a loser and one loss wiping the wins, the times it was found. Click again: it closes.
8. A day with no trades (or only a shared day) shows no chart and a plain message.

## H. Summary data (S10; the screens come with S11)
Status: S10 in PR. Backend only, so the try is a request in the browser. Needs the backend from this branch (and a Windows rebuild for the desktop route).
1. Signed in on the website, open `/api/analysis/day-summary?start_date=<a month ago>&end_date=<today>` in the same browser (or ask for it from the Windows app later in S11). You get `days`, newest first, one per market date you traded, each with `symbols`, `totals`, `strategies`, `labels`, `best`, `worst`, `journeys`, `score` and `note`.
2. Pick one day and compare with Stats for the same single date and the same Mode / Type / Symbol: the trade count, win % and net P&L match; the Day P&L Journey end point equals the net P&L.
3. A day where every trade is labelled shows the strategy rows by name; a day with unlabelled trades has an "Unlabelled" row last. "plan_followed" counts only trades that have both an expected and an actual strategy.
4. A Strategy Practice run and a swing portfolio are not in the list.
5. `note` is `null` on a day you wrote nothing for; once you write a Context line in the Notes tab it appears here. `score` is `null` for a day whose score was never stored (open its Notes tab once), and the number after.
6. A range of more than 62 trading days returns the newest 62 with `truncated: true`.
