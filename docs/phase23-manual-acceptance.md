# Phase 23 — manual acceptance checklist

Automated suites cover the logic and the browser flows against fixtures. These items need a live broker, a real linked day or the native Windows build, so they are done by hand before Phase 23 is promoted from `dev` to `preprod`. Design and results: [spec-phase23.md](spec-phase23.md) §11.

Tick each item; note the session type, client and anything odd.

## A. Live labeling on the website (start with replay)

- [ ] Replay: open a CE trade, close it. The exit popup shows the exit-type questions, and answering "yes" then Save shows the mark later in Analysis → Label Trades for that trade.
- [ ] Replay: **pause and resume mid-session** between two trades. Label both trades; the second must not overwrite the first (this was the pre-existing bug fixed in Sprint 8).
- [ ] Replay: open **CE and PE together**, close the PE first, then the CE. Each exit label lands on its own trade (check in Analysis).
- [ ] Reload the page mid-session with a trade open, then close it: the label lands on the right trade.
- [ ] Paper session: entry popup, exit popup, Skip, and Retry after stopping the backend briefly.
- [ ] Stepwise session: the stepwise popup asks the same questions and saves.
- [ ] Settings → Analytics: switch Label Trades between One at a time and All together; Prev/Next, auto-save on leaving a trade, and the markers on the Underlying and strike charts behave in both renderers.

## B. Real trading (use a small, safe trade)

- [ ] Website real session: entry and exit popups save marks; trading is never blocked by the popup (manual override rule).
- [ ] Desktop real session, including a **linked real day**: label slots match the website's numbering for the same day (compare in Analysis on both clients).
- [ ] After a real day ends and the broker book re-syncs, Habits shows unmatched marks as a count, not an error.

## C. Windows desktop build

- [ ] Rebuild the desktop app (the Rust allowlist gained `behavior/*` and `behavior/habit-ledger` routes).
- [ ] Settings → Behavior questions: add, edit, archive, unarchive an Entry and an Exit question.
- [ ] Analysis → Habits loads and the ledger request is not rejected by the proxy.

## D. Habits against real data

- [ ] Read the Glossary (spec §10.11) against your own trades: profit/loss %, capital % (sum of entry allocations), bars held, ≤1-bar share.
- [ ] Habits totals equal the Stats overview (Net P&L, trades) for the same filters.
- [ ] The verdict chip (Costly / Rewarding / Mixed / Low sample) agrees with your own reading of at least two habits.
- [ ] Trends and Compare show the trend you expect over the last 5–10 days; clicking a point opens the right trade.
- [ ] Time to load Habits on your full history is acceptable (benchmark: about the same as opening Stats).

## E. Phone / webapp

- [ ] Label Trades one-at-a-time layout: fixed Prev/Next bar, stacked charts, touch targets.
- [ ] Habits scorecard scrolls horizontally with the habit column visible; charts are readable.
