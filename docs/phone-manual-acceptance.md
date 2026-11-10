# Android phone app — manual acceptance (real phone, landscape)

Run on a real phone with the signed debug or release APK. Each sprint adds its section; tick items as they pass. Status of the sprints: `docs/spec-phase24-android-plan.md`.

## A. Install and sign in (S1, S2)
(Filled in when S1 and S2 land.)

## B. Sessions and session detail (S3)
1. Open Sessions: the list shows your trading days, newest first, one row per day and instrument (two sessions on one day are one row marked "2 sessions"). Each row shows the date, symbol, Options or Equity, a mode badge (Replay, Stepwise, Paper, Real, Swing), the net P&L in green or red, and the trade count.
2. Tap a day: the list **hides** and the chart takes the whole width. Tap **Days** (top left of the chart), or the **Sessions** item in the left rail, to show the list again; tap Sessions again to hide it. Android back shows the list before it leaves the screen. Go to Browse and come back: the same day is still open.
3. **Filters** (in the list): choose **90 days** and a **Mode**, Apply; the Filters button shows how many are active. **Custom** without a start date cannot be applied and says why.
4. The chart has **one row at the top**: Days, a view menu (Chart ▾), **Underlying | Option**, then the chart's interval, indicators (fx), fit and maximize. Nothing else sits above the candles. Choose **Option**: the strike menu appears in the same row (a plain label if the day had one contract); open it and pick another strike, and the option chart changes. The menu opens over the chart.
5. The candle details (time, open, high, low, close, EMA values) are hidden; **touch and hold** the chart and they appear. More > Charts changes this to Always or Never.
6. Pinch and drag to zoom and scroll, in the underlying and in the option chart. **Maximize** shows one chart over the whole screen (Underlying / Option and the strike menu stay); Android back or the restore button returns.
7. The view menu: **Trades** shows each execution (time, side, quantity, price, contract, value; a day with two sessions has a Session 1 / Session 2 divider); **Orders** and **Videos** open without errors; a day with a saved video lists it, and Open takes you to the YouTube app. A swing day offers only Trades and Videos.
8. Airplane mode, then tap another day: a clear message with Try again. On a server without the analysis routes: "Sessions is not available on this server".
9. **Snapshots** (view menu > Snapshots, on a day that has them): one strip at the top with ◀ ▶ and the current event (number, time, what happened); ◀ ▶ step through the events and the chart shows the candles and your position and orders as they were at that moment. Tap the event name for the list: search it (`fill*`, `stop*`) and tap one to jump. **Details** shows wallet, open P&L, session P&L, open orders and positions. On an options day the chart row has **Underlying | CE | PE**. A day with no snapshots says so.
10. **Day journey** (view menu) shows the day's cumulative P&L, one dot per completed trade. In **Trades**, tap a row for the execution details (a panel on the right; Back closes it).
11. Volume: in the chart's indicators menu (fx) switch on **Volume**: a volume pane appears for an option or a stock; for the NIFTY underlying it does nothing.

## C. Trade labeling (S4)
(Filled in when S4 lands.)

## D. Stats and Habits (S5)
(Filled in when S5 lands.)

## E. Videos (S6)
(Filled in when S6 lands.)

## F. Browse (S7)
(Filled in when S7 lands.)

## G. Positions (S8)
(Filled in when S8 lands.)

## H. Whole-app checks (S9)
- Server switch between `dev`, `preprod` and the phone branch: features the server lacks show "not available", nothing crashes.
- Airplane mode: offline banner, no crash, recovers when the network returns.
- Android back button steps back one level; at the root a second press exits.
- App lock (if turned on) asks on cold start and after a minute in the background.
- Token refresh still works the day after signing in.
