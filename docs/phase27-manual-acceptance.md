# Phase 27: Manual acceptance (owner)

Tick each item when tried. The sections follow the sprints of `docs/spec-phase27-implementation-plan.md`; a section is added when its sprint merges. Website and webapp come from `dev` after a redeploy; the Windows app needs a rebuild when a sprint changes a Rust allowlist.

## A. Lightweight drawings shared with KLine (S1, real-trading chart: dev only)
Status: built (S1), waiting for your try.
1. Browse, KLine: draw a Horizontal line, a Trend line and a Text. Switch Settings > Trading Chart to Lightweight: the same three are on the Browse chart.
2. Browse, Lightweight: draw a Fib Retracement and a Rectangle. Switch back to KLine: they are there.
3. Delete one drawing in Lightweight: it is gone in KLine (and the other way round).
4. Change the candle interval in Browse: the drawings stay (they no longer belong to an interval).
5. A drawing that was kept only in this browser before (made in Lightweight Browse, Day or Swing) is copied up once and then shows in KLine.
6. Day chart in a replay, then paper session (Lightweight): draw, reload, the drawing is still there. Check the chart still updates on every tick. Swing chart: a line drawn on a swing contract in KLine shows in Lightweight and the other way round; it is the same drawing the Day chart shows for that contract.
7. Only after 1 to 6 on replay and paper: one try in a real session.

## B. Analysis Maximize (S2)
Status: built (S2), waiting for your try. Website, webapp and Windows app (a Windows rebuild picks up shared code).
1. Analysis, open a day: there is one Maximize button at the right of the tab bar (Trades, Label Trades, Walkthrough, What If), and none inside the tabs.
2. Maximize on Trades: the day fills the window (the Windows app keeps its top bar); the trade list, the journey chart and the chart panel are all reachable.
3. While maximized, switch to Label Trades, Walkthrough and What If: it stays maximized; Underlying and strike charts are stacked, with Prev / Next working.
4. Restore, or Esc: back to the day list with the same filters and the same day open. Esc inside a maximized chart only returns that chart first.
5. A chart's own Maximize (KLine) still works inside the maximized card.
6. Phone: Label trades, Walkthrough and What If look as before (no Maximize button).

## C. Group tab (S3; the live popups are real-trading screens: dev only)
Status: built (S3), waiting for your try. Website, webapp and Windows app (a Windows rebuild picks up shared code).
1. Pattern Library > Deep dive > a strategy with at least two tags, marked on several days > Results: a **Group** button beside All / Buy / Sell.
2. Group: pick tag A and tag B. Check the numbers on a few days by hand: only days where both tags are marked count; "n not counted" lists the others and says which tag is missing.
3. "When A was valid, B was valid x% (n of m)" matches a count of the days where A is Valid. Swap A and B and the conditional lines swap.
4. Click a cell (for example "both valid"): its days are listed; click a day and it opens in the in-depth step.
5. The Group side buttons (All / Buy / Sell) change the counts. A strategy with fewer than two tags says "Group needs two tags".
6. Label a trade in Label Trades (Analysis): pick the expected category and strategy of that deep dive; the panel has a **Group** button, on the position's own side. Same on the live popup in a **replay** session first, then paper, then one real session (the popup is the real-trading screen).
7. Saving a label with the Group view open changes nothing in what is saved.

## D. Compare tab (S4)
Status: built (S4), waiting for your try. Website, webapp and Windows app (needs a Windows rebuild for the shared code).
1. Pattern Library: a **Compare** tab beside Deep dive. With no marked days anywhere it says "Nothing to compare yet".
2. Two panes. Pick a different strategy in each, and a marked day in each (newest first). The day's chart shows with its marks.
3. Switch pane A to CE and pane B to PE (for example a Buy day on CE and a Sell day on PE): each uses the strike saved with that day. A day with no saved strike shows a preview strike and the note says so.
4. Change the candle interval on one chart: the other pane keeps its own, and the chart in Analysis or in Deep dive is not changed.
5. Maximize one pane: the other hides; Restore brings both back. Try it on both chart renderers (Settings, Analysis and Patterns chart).
6. Nothing is saved: open the same strategy in Deep dive afterwards, its days are unchanged.
7. A strategy shared with you can be compared too (it is marked "(shared)").

## E. Notes and TODOs (S5)
Status: built (S5), waiting for your try. Website, webapp and Windows app (needs a Windows rebuild: new analysis routes). The phone has no Notes tab yet.
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
Status: not built yet.
