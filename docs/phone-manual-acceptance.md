# Android phone app — manual acceptance (real phone, landscape)

Run on a real phone with the signed debug or release APK. Each sprint adds its section; tick items as they pass. Status of the sprints: `docs/spec-phase24-android-plan.md`.

## A. Install and sign in (S1, S2)
(Filled in when S1 and S2 land.)

## B. Sessions and session detail (S3)
1. Open Sessions: the list shows your trading days, newest first, one row per day and instrument (two sessions on one day are one row marked "2 sessions"). Each row shows the date, symbol, Options or Equity, a mode badge (Replay, Stepwise, Paper, Real, Swing), the net P&L in green or red, and the trade count.
2. The note under the title says "Last 30 days"; tap **Filters**, choose **90 days** and a **Mode**, Apply: the list changes, the Filters button shows how many are active. Choose **Custom** without a start date: Apply stays disabled and says why.
3. Tap a day: the **Chart** tab shows the underlying with your buys and sells marked; **Underlying / Option** switches to the option contract. Pinch and drag to zoom and scroll; the interval selector in the chart header changes the candle size. The chart should use almost the whole right side with no page scrolling.
4. **Trades** shows each execution (time, side, quantity, price, contract, value); a day with two sessions has a "Session 1 / Session 2" divider. **Orders** and **Videos** open without errors; a day with a saved video lists it, and Open takes you to the YouTube app.
5. A swing day shows only Trades and Videos.
6. Press the Android back button with the Filters panel open: it closes the panel and does not leave Sessions.
7. Turn on airplane mode and tap another day: you get a clear message with Try again, not a blank screen.
8. On a server that does not have the analysis routes the screen says "Sessions is not available on this server".
9. Volume (from the Volume work): open an option day's chart, open the indicators menu (fx), switch on **Volume**: a volume pane appears. On a NIFTY underlying chart Volume does nothing.

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
