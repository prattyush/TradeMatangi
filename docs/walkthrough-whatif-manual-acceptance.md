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
Website (Lightweight and KLine), desktop, webapp: the **What If** tab next to Walkthrough. Phone: **view menu > What If** (not offered for swing portfolios).
1. Charts on the left (centred on the trade); on the right: the **Day** (actual, what-if, difference) and **This trade** (the same), peak capital (actual and what-if), the entries and exits of the trade, one row per fill: time, side, **price** and **quantity** boxes, the capital % it uses (with the change when you edit), and for KLine charts a **⌖ Pick** button.
2. Change an exit price: the trade and the day move, charges recalculated (paper, replay and stepwise: the platform's formula; real: the broker's charges scaled by value, an estimate). A changed fill is highlighted; ↺ puts it back; **Reset this trade** puts the whole trade back.
3. Change a quantity so entries and exits differ: a warning says the P&L is uneven. Quantity 0 removes a fill ("what if I had only one entry", "what if I stopped averaging").
4. **⌖ Pick** (KLine only): the chart says "Click the chart to set the … price" (tap on the phone); tapping a price sets it; Escape (Back on the phone) cancels. The edited fill is drawn as a hollow ring (amber buy, violet sell; a dashed ring and ✕ for a removed fill), on the underlying chart for equity and on the matching CE/PE chart for options. On the website with the Lightweight renderer there is no pick; a note says to switch the Analysis chart to KLine in Settings.
5. Edits stay when you move between trades. The day total adds up every edited trade.
6. **Save** needs a name and at least one edit. Several what-ifs can be saved per day ("Exit at close", "No averaging"); saving the same name replaces it. After a **refresh** or reopening the tab, the most recently saved what-if is shown again; the dropdown loads another. **Revert day** shows the real day (the saved one stays); **Delete** removes the saved one. Leaving the tab with unsaved changes asks first.
7. **Compare days**: pick a date range; saved what-ifs are grouped by name with actual, what-if and difference per day and the total (for example "Exit at close" across 20 days).
8. Shared (read-only) history: you can edit as a playground; Save, Delete and the name are disabled.
9. A server without saved what-ifs: the tab still works (a note says saving is not available). A server that did not send fills for a trade: that trade says it cannot be edited.
10. No order, trade, label or session changes, ever: only the what-if routes are written.
Option-chart markers: in **Walkthrough** and **What If** (KLine charts, on the website, desktop and webapp; the Lightweight renderer is unchanged) the CE/PE chart's markers carry no text (the colour says buy or sell, and one trade is shown). Label Trades keeps its round-trip numbers there. On the **phone** the option chart's markers have no text in Label trades, Walkthrough and What If.
Phone What If: **ENTRIES** and **EXITS** each have a solid coloured title band (green, orange), every fill row has a thick bar of that colour on its left, and a thick grey line separates the two blocks.
Phone: the saved-what-ifs bar is one line (**What-if: name ▾**) that opens; the fills are two-line rows (label and capital, then price and quantity); Back cancels a pick, then asks before dropping unsaved changes, then closes.

Check on a real, a paper, a replay and a stepwise day; a day with two sessions saves each session's own edits.

## C. Regression: Label Trades
After the shared refactor (W1) Label Trades must behave exactly as before on every host: Prev / Next, chips, auto-save, behavior questions, the one-chart switcher, maximize, the phone layout.
