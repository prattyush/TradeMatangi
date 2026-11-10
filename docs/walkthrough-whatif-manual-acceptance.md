# Trade Walkthrough and What If — manual acceptance

Filled in as the sprints land (W3 and W4 for Walkthrough, F3 and F4 for What If). Plan: `docs/spec-phase24-walkthrough-whatif-plan.md`.

## Hosts to check
Website (Analysis chart set to Lightweight, then to KLine in Settings), desktop app, webapp, phone app (landscape).

## Session types to check on each host
A **real**, a **paper**, a **replay (sim)** and a **stepwise** session, each with at least one options round trip (CE or PE) and one with a partial exit.

## A. Walkthrough (W3, W4)
Website, desktop and webapp (the Walkthrough tab next to Trades and Label Trades, in a day's card; not shown for swing portfolios):
1. Open a day, tap **Walkthrough**: charts on the left (centred on the trade, markers only for that trade, "All markers" shows the rest), one round trip on the right, ◀ Prev / Next ▶ and the numbered chips.
2. **Order:** Next goes to the trade opened next (first entry time), also when trades overlap; it is not ordered by when they closed.
3. The three figures at the top: **Day before** (the day's realised P&L before this trade closed), **This trade**, **Day after**; money and % of capital (the order follows the P&L display setting). Next trade's "Day before" equals this trade's "Day after".
4. **Peak capital**, how long it was **held**, the contract and **charges** (with "estimated" or "actual" on real sessions).
5. **Entries**: time, size (B/S), price, capital %, risk %, and a coloured code for how the order was placed (MKT, BL, SL, BT, AS, ASL). **Exits**: time, size, price, capital % and the code for how the exit happened: **SS** sell stoploss (BS for a short), **SL**/**BL** limit, **ST**/**BT** target, **TP** take-profit strategy, **AGS**, **USL**, **BE**, **LP**, **MKT**, **SC** session close, **EOD**. Hover a code for its name. The ▸ before a time opens more (sizing, initial stop, budget, R multiple, where it was placed from).
6. Nothing can be changed or saved here; there is no save status.
7. Against a server that does not send cycle details: legs still listed with times, sizes and prices, and a note says what is missing.
8. Label Trades and Trades behave exactly as before (regression after the shared layout was extracted).
Phone (landscape): the day's **view menu > Walkthrough** opens it full screen (not offered for swing). Same content in a compact column: the three figures and the facts come first, then the entries and exits with colour-coded codes and the ▸ time button for more. Back or ← closes.

Check on each of: a real, a paper, a replay (sim) and a stepwise session, with at least one options (CE or PE) trade, one stopped out, one closed by a take-profit strategy, one partial exit.

## B. What If (F3, F4)
(Filled in when F3 lands.)

## C. Regression: Label Trades
After the shared refactor (W1) Label Trades must behave exactly as before on every host: Prev / Next, chips, auto-save, behavior questions, the one-chart switcher, maximize, the phone layout.
