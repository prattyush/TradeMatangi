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
Status: not built yet.

## C. Group tab (S3)
Status: not built yet.

## D. Compare tab (S4)
Status: not built yet.

## E. Notes and TODOs (S5)
Status: not built yet.

## F. Day score and system habits (S6, S7)
Status: not built yet.
