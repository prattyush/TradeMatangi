# Android phone app — manual acceptance (real phone, landscape)

Run on a real phone with the signed debug or release APK. Each sprint adds its section; tick items as they pass. Status of the sprints: `docs/spec-phase24-android-plan.md`.

## A. Install and sign in (S1, S2)
Setup first: `docs/phone-google-signin-setup.md` (Android OAuth client for `in.co.tradematangi.phone` and the SHA-1 of the fixed debug key, test user).
1. Uninstall any older TradeMatangi (once: older builds were signed with another key), install the APK. Open it: sign-in screen, landscape.
2. Email and password sign-in works; **Sign out…** in More returns to the sign-in screen.
3. **Continue with Google** opens Google's account chooser. Pick your account: you land in the app, More → Account shows your Google email.
4. Close the app completely and open it again: still signed in (no new sign-in).
5. Close the chooser with Back: no error is shown, you stay on the sign-in screen.
6. (Optional, only if the server does not know a second Google account) Continue with Google with that account: the "has no TradeMatangi account yet" step asks for a name; Back returns to the form; Create account signs in.
7. More → **App lock** → turn on: the phone asks for fingerprint / screen lock. Press Home, wait 40 seconds, open the app: the lock screen shows and the prompt appears; cancel it and **Unlock** asks again. A quick Home and back (under 30 seconds) does not lock.
8. On the lock screen **Sign out** returns to the sign-in screen and the lock is off after signing in again.
9. Install a newer APK over this one (from CI or `scripts/build-android-phone.sh`): it installs without uninstalling, and you stay signed in.

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
12. **Compare** (view menu > Compare, intraday days): full screen, the day's trades on the left (Underlying and each traded contract) and the saved pattern annotations for the same day on the right (Underlying, CE, PE); the two dropdowns filter the annotations by category and strategy. A day with no saved pattern chart still opens (the right side is just the plain chart). Close or Back returns to the session.
11. Volume: in the chart's indicators menu (fx) switch on **Volume**: a volume pane appears for an option or a stock; for the NIFTY underlying it does nothing.

## C. Trade labeling (S4)
0. In Label trades, the CE and PE chart markers carry no BUY/SELL text (white is a buy, blue is a sell); they keep the trade number (`#3`, `#2/#3`). The Underlying chart and every other chart keep their text. Same on the desktop and webapp; the website is unchanged for now.
1. Open a day, then the view menu > **Label trades** (the count of labeled trades is shown beside it). Labeling opens full screen: the chart on the left (centred on the trade, with only that trade's buy and sell marked), the form on the right.
2. At the top of the form: **◀ Prev**, "Trade 1 of N", **Next ▶**. They stay in place while you scroll the form. The trade (contract, P&L) and a row of numbered trade chips (a green dot once a pattern is chosen) scroll with the form. Tap a chip to jump.
3. Choose an Expected category and strategy from the lists (type a new name to add one). Type an Entry tag and an Exit tag (suggestions appear). Switch the entry and exit behavior questions Yes or No.
4. The bar at the bottom says **Saving…** then **Saved ✓** by itself; there is no Save button. Tap Next: your changes are saved before the next trade opens. Go back to the first trade: your answers are still there.
5. In the chart's top row: ← closes, **Underlying | Option** and the strike menu switch the chart; the interval and indicators work.
6. Tap a text field: the keyboard opens and the chart steps aside so the form fills the screen; close the keyboard and the chart returns.
7. Press the Android back button (or ←) right after typing: it waits for the save, then closes. Turn on airplane mode and change something: the bar shows the error with **Retry save**; leaving offers to discard.
8. After closing, the view menu shows the new count, for example 3/5. Open the same day on the website or the desktop and check the labels are there.
9. A shared (read-only) day shows the labels but cannot change them.

## D. Stats and Habits (S5)
1. Open **Stats**. Overview shows the KPI tiles first (scroll the row sideways), then the cumulative curve; the numbers match the website's Stats for the same last 30 days.
2. Switch Entries, Exits, Sizing, Behavior: each section scrolls on its own; wide tables scroll sideways inside their card.
3. **Filters** (bottom of the left strip) opens a panel: dates, Run on, Mode, Origin, Symbol, Instrument, Direction and the Method / labels group. Changing one reloads the numbers. Back (or Hide filters) closes the panel.
4. Overview, scroll to "Trace the individual trades", tap **Details →**: the trade's story opens over the pane. Back closes it.
5. **Habits**: the scorecard lists your habits with verdicts; Trends, Compare and Deep dive switch; tap a habit row to deep-dive it. "Manage questions" is not offered on the phone.
6. In Sessions, tap a trade, then **Open cycle** in the execution details: Stats opens with that trade's story. Leaving and returning does not reopen it.
7. Switch Filters > Trading style to **Swing**: Swing performance shows its own header; "Close statistics" returns to Sessions.
8. No Export CSV and no "Actual Real charges" editor appear (the phone writes only labels and behavior marks).
9. Point the app at a server without Stats or Habits (older branch): the screen says "This feature is not available on this server." with Retry; nothing crashes.

## E. Videos (S6)
1. Open **Videos**: every video saved with your sessions (the desktop Video Maker, or "Add a link" in a session) appears once, newest first, under its upload day, with a privacy badge.
2. Tap an **Unlisted** or **Public** video: the player area shows a Play button and nothing has been sent to YouTube yet. Tap **Play**: the video plays inline in the landscape pane (the largest 16:9 the height allows); the screen stays on while it plays.
3. Tap a **chapter**: the video restarts at that time and keeps playing (it reloads the player, so allow a second).
4. Try the player's own fullscreen button: it should fill the screen in landscape and come back. (Not verified on a phone yet; if it fails, use "YouTube".)
5. A **Private** video shows why it cannot play here; "Open on YouTube" opens the YouTube app. **YouTube** and **Copy** in the side column do the same for any video.
6. **← Videos**, the Android back button, or tapping Videos again returns to the list; leaving the tab and coming back finds the same video.
7. The side column shows the session(s) the video belongs to ("NIFTY · 09 Nov").
8. Adding or removing a link stays in Sessions > Videos (the Videos tab only reads).
9. Against a server without saved videos the tab says "Videos is not available on this server".

## F. Browse (S7)
1. Open **Browse**: the NIFTY chart of the last completed trading day (never today) with the previous days before it. One control row at the top: **symbol**, **‹ day ›**, **Spot | CE | PE**, then the chart's own interval, indicators (VOL, EMA...) and fit.
2. **Symbol** opens a search: type part of a name or symbol; recent symbols are listed first. Choose one: the chart reloads. Symbols without options have CE and PE greyed out.
3. **‹ ›** step to the previous or next weekday (the next button is off on the latest day). Tap the day to open the date picker; a weekend is refused. Exchange holidays show the server's "no data" message: step to another day.
4. **CE** or **PE**: the option for that day's expiry at the strike nearest the underlying; the strike button lists 43 strikes and opens at the current one. Changing day keeps the strike when it is still listed. **CE and PE each keep their own strike**: change the CE strike, tap PE (it starts nearest the money, or at its own earlier choice), tap CE again and the CE strike is still the one you chose.
   - **Max price:** open the strike menu and tap **Max price…** (pinned at the top). Choose a premium cap (presets for the symbol, or type one) and **Use**. The server picks the strike closest to the money whose premium at 9:30 is at or below the cap (the desktop picker's search); the strike button then reads `≤₹cap · strike`. Each of CE and PE has its own cap, and the strike is searched again for every day you step to. Choosing a strike from the menu goes back to manual. If nothing fits the cap the screen says why with **Try again** and **Manual strike**; an older server says Max price is not available. (The first search of a day can take a while if the server has to download option histories.)
5. A day with no listed options explains why instead of drawing an empty chart; Spot still works.
6. Pan and pinch the chart; press and hold for the candle details (time, OHLC, volume when the instrument has it). Turn on the **VOL** indicator for volume bars.
7. Leave Browse and come back: the same symbol, day and side are shown.
8. **Live (today only):** step the day to today (›). A **Live** button appears in the control row. Turn it on: the dot is amber while it connects, then green and the chart keeps updating with the live ticks (spot, or the CE/PE you chose). Change the strike, the symbol, CE/PE or Spot and the stream follows. Changing the candle interval reloads the candles at that interval and keeps the ticks. Turn Live off (or leave Browse, or put the app in the background): the stream is stopped on the server; coming back to the app starts it again. On a server without live data it says so with Try again. (Needs the server's live feed, the same one the desktop uses.)
9. There are no order, buy/sell or drawing controls (read-only). Older days beyond the loaded context are not fetched while panning in this version; step the day instead.

## G. Positions (S8)
(Filled in when S8 lands.)

## H. Whole-app checks (S9)
- Server switch between `dev`, `preprod` and the phone branch: features the server lacks show "not available", nothing crashes.
- Airplane mode: offline banner, no crash, recovers when the network returns.
- Android back button steps back one level; at the root a second press exits.
- *(Phase 2)* App lock (if turned on) asks on cold start and after a minute in the background.
- Token refresh still works the day after signing in.
