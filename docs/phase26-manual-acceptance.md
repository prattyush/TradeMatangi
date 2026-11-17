# Phase 26 — Manual acceptance (Patterns Strategy Deep Dive)

Sections are added as sprints land. Report back with what failed, with the strategy name and date.

| Section | What | Needs |
|---|---|---|
| A | Desktop: Deep dive tab, marking days | desktop rebuild |
| B | Desktop: in-depth analysis | desktop rebuild |
| C | Desktop: results | desktop rebuild |
| D | Website and webapp: Deep dive | website build |
| E | Percentages in Label Trades (all hosts) | desktop rebuild |
| F | Percentages in live label popups (**real-trading screens**) | try replay or stepwise first, real last |
| G | Fixes after the first tries (symbols, calendar, layout) | |
| H | From your trades | labelled trades in several sessions |
| I | Hardening (S11) | |
| J | Review changes: side-by-side traded charts, Maximize per chart, Deep Dive header in one row | |
| K | Rename a tag | |
| L | Strength (Ideal / Average / Poor) and entry / exit times | |

## A. Desktop: Deep dive tab, marking days (S4)

Needs the desktop app **rebuilt** (`windowsapp`, the Rust allowlist changed in S2) and the backend from `dev` running.

1. Tools > Pattern Library: there is a third tab **Deep dive** next to Annotate and Saved charts.
2. Deep dive tab: "Start a deep dive" with Category, Strategy (each with "+ Add new…"), Symbol (NIFTY) and a Start button that stays disabled until both names are chosen. "Your deep dives" says there are none yet.
3. Pick an existing category and strategy, Start. The calendar opens on the latest trading day's month, with "← All deep dives" above.
4. Click **B** on three different weekdays and **S** on two (one of them a day that also has **B**). Each button turns green (Buy) or red (Sell) at once. Today, later days and weekends have no B or S.
5. "Marked days" lists the days in date order, a day's Buy before its Sell. Click a day name: the chart on the right shows that day (KLine, with the usual interval buttons).
6. Click the day number in the calendar: the same chart, and the line above it says "marked Buy", "marked Sell + Buy" or "not marked".
7. Mark a day that is a market holiday: a red message from the server says it is not a trading day and nothing is added.
8. Click **B** again on a marked day that has nothing else: it is removed without a question.
9. Close the Deep dive tab (another tab or another tool) and come back: the marks are still there. Restart the app: still there.
10. Back to "All deep dives": the dive shows the number of days, "(n buy · n sell)" and "Needs marking" is empty while the dive has no tags.
11. Change the symbol box to BSESEN and mark a day: the calendar shows only that symbol's days; the marked list shows both with their symbols.

(Removing a side that already has tag marks, chart marks or an outcome asks first; that is easiest to check after the in-depth step, S5.)

## B. Desktop: in-depth analysis (S5)

Needs the desktop rebuilt from `dev`. Use the deep dive from section A with at least four marked days, one of them both Buy and Sell.

1. Open the deep dive, tab **2 · In-depth**. The header reads `1 / n · <oldest day> · BUY` and a chip per day sits below it (a day's Buy before its Sell).
2. Each day shows the underlying chart on top and **one** option chart under it: a **CE** chart for a Buy day, a **PE** chart for a Sell day. Below the charts a line says which strikes were picked and by which rule (OTM or Max Price, matching Settings). Check that the strike is what Browse or the Pattern Library would pick for that day.
3. Mark tools: choose **▲ Entry UL** and click a candle: a marker appears and the chart title counts "1 marks"; click the same candle again to remove it. Do the same with **Entry CE** (or PE) on the option chart. "Saved" shows in the header after each change. Undo and Clear marks work.
4. Change the candle interval on a chart (for example 5m), go to the next day and come back: the 5m interval is restored for that day.
5. **Tags**: add "Second leg" and "Double top". The note says how many days they are not marked on, every chip turns amber, "Needs marking" lists every day.
6. On a day, tap **Valid** on a tag, tap it again (it clears), tap **Not valid** on the other. The day's chip turns green when both are marked. **Mark the rest not valid** settles the open tags.
7. **Next unmarked day** jumps to a day with open tags; clicking a day in "Needs marking" jumps there.
8. Add a third tag while on a later day: all earlier days turn amber again (this is the "question added on the 20th" case). Archive a tag (🗄): it leaves the list, the amber days that were only waiting for it turn green, and it appears under "Archived tags" with Restore.
9. Set **Success** or **Failed**, write a note and click elsewhere: "Saved". Reload the app: outcome, notes, tags, marks and strikes are all still there and the option chart is on the same strike.
10. Stop the backend and mark a tag: the header shows "Not saved: …" with **Retry**; start the backend, press Retry: "Saved".
11. Back in step 1, remove a side that has tag marks or chart marks: a question lists what will be lost; Keep leaves it, Remove deletes it.
12. A symbol that has no options (a stock): the day shows only the underlying chart and the mark tools for it.
13. Optional, with a second account that is in your Pattern share list: the shared deep dive opens read-only (no B/S, no tag buttons, no outcome).

## C. Desktop: results (S6)

Needs the desktop rebuilt from `dev`. Use the deep dive from section B, with tags marked on most days, an outcome on some days and chart marks on at least one day.

1. Open the deep dive, tab **3 · Results**. Under the All / Buy / Sell buttons a line explains the sides: **Buy = long / bullish** (long equity or index, CE bought, PE sold) and **Sell = short / bearish** (short equity, PE bought, CE sold). Hovering the buttons says the same.
2. The summary shows the number of days with the buy and sell counts and "Success x of y (z%)". With fewer than 5 days having an outcome it says "Only n days marked".
3. Each active tag has a bar, "70% (n=14)", "10 valid · 4 not valid". Check one by hand: valid days divided by the days where that tag was marked (Valid or Not valid; unmarked days do not count). Fewer than 5 marked days shows "Only n days marked" and a striped bar. The archived tag is not listed.
4. **Sell** shows only the sell days' numbers and rows; **Buy** the buy days'; **All** both. A tag never marked on the chosen days shows "—" with n=0.
5. "Order: Most frequent first" re-sorts the tags, unmarked ones last.
6. Each day row shows its outcome, one dot per active tag (green valid, red not valid, grey unmarked; hover for the name), the number of chart marks and the notes. The date or **Open** opens that day in the in-depth step.
7. A day with chart marks has **Save to Patterns**: "saved as a new pattern chart with n marks". Find it in Saved charts (same symbol, day and marks, with the dive's category and strategy). Press it again after adding a mark in the in-depth step: "added 1 mark to the existing pattern chart" and the chart does not duplicate the old marks.
8. **Save n marked days to Pattern Library** does the same for every day shown; the message counts new and updated charts.
9. A day whose pattern chart already uses other CE or PE strikes is refused with a message that names the strike; nothing is overwritten.
10. A shared deep dive (second account): the results are shown, no save buttons.

## D. Website and webapp: Deep dive (S7)

Needs the website (or webapp) built from `dev` and the backend running. Do it once with Settings > Display > **Analysis & Patterns chart** = Lightweight and once with KLine.

1. Open the **Pattern Library** page. There are three buttons: **Create**, **View**, **🔍 Deep dive**. Create and View behave as before.
2. **Deep dive**: the same screens as the Windows app: list of deep dives, start form, then the steps **1 · Mark days**, **2 · In-depth**, **3 · Results**.
3. Mark days (B and S per day) on the calendar; the chart on the right shows the selected day. In Lightweight it is the Patterns page's style chart; in KLine the Analysis chart with its drawing tools.
4. In-depth: the underlying chart on top and one option chart under it: a **CE** chart for a Buy day, a **PE** chart for a Sell day. The strikes are the ones the Patterns page picks for that day (check the OTM or Max Price rule in Settings).
5. Mark tools: choose **▲ Entry UL**, click a candle: a marker appears and the title counts "1 marks"; in Lightweight the marker shows the strategy name on the candle. Click the same candle again: it is removed. Do the same on the option chart.
6. Change the candle interval on a chart (the select in its header); go to the next day and back: the day's interval is restored. In Lightweight both charts follow the interval.
7. Tags, Valid / Not valid, "Mark the rest not valid", Next unmarked day, "Needs marking", outcome, notes, Retry on a failed save: as section B on the desktop.
8. Results: the percentages, the All / Buy / Sell filter and its hint line, Save to Patterns; the saved chart then shows under **View** with the same marks.
9. Switch the Analysis & Patterns chart setting and reload: the Deep dive uses the other chart, with the same data.
10. Webapp (installed or browser): the same page and the same Deep dive.
11. A second account in your Pattern share list opens your deep dive read-only.

## E. Percentages in Label Trades (S8)

Needs the desktop rebuilt from `dev` (a Rust change), the backend, and a deep dive with several days, tags and outcomes (sections A to C). Try it on the website, the Windows app and, if you use it, the phone.

1. Analysis > a session day > **Label Trades**. Choose an **Expected Pattern** category and strategy that has a deep dive: a panel **Your deep dive** appears under the strategy selectors. A strategy without a deep dive shows nothing.
2. The panel shows All / Buy / Sell with the day counts, each tag as `70% (n=14)` (most frequent first, "Only n days marked" under 5 days) and "Success x of y (z%)". Check one number against the Results step of the deep dive for the same side.
3. It opens on the side the position profits from. Try a long equity or index trade (Buy), a **bought CE** (Buy), a **bought PE** (Sell), a **sold CE** (Sell) and a **sold PE** (Buy). The panel says "this position is Buy-side" or "Sell-side". Tap the other side and All: the numbers change at once.
4. Go to the next trade: the panel follows that trade's own direction.
5. Change the expected strategy or clear it: the panel changes or disappears. The labels save exactly as before and the panel never delays saving.
6. A deep dive shared with you shows "shared with you"; your own deep dive of the same strategy wins.
7. With the backend stopped or an older backend, Label Trades works as before with no panel and no error.
8. Phone: the same panel in the one-trade-at-a-time form.

## F. Percentages in live label popups (S9; real-trading screens)

Needs a deep dive with several days, tags and outcomes. **Try replay or stepwise first, then paper, and real last.** On the Windows app this needs a rebuild; the website and webapp need a build from `dev`. This is on `dev` only and does not go to `preprod` until you have tried it in a real session.

1. In a **replay** or **paper** session, buy something (an index, a CE or a PE). Open the entry label (**Label open trade** on the website, the **Expected** row on the desktop). Choose a category and a strategy that has a deep dive: **Your deep dive** appears under the selectors with All / Buy / Sell, the top tags with `70% (n=14)` and the success rate. A strategy without a deep dive shows nothing.
2. Check the side it opens on, "this position is Buy-side / Sell-side": long equity or index = Buy, CE bought = Buy, PE bought = **Sell**; sell short: equity = Sell, CE sold = Sell, PE sold = **Buy**. Switch to the other side and All.
3. **Save** the label: it saves exactly as before (same fields, same behavior), with or without the panel. Nothing about the popup is slower.
4. The **exit** popup (Actual Pattern) has no panel.
5. **Stepwise** (website): when round trips complete, each one shows the panel under its own Expected Pattern once a strategy is chosen, on the side of how that trade was opened.
6. Stop the backend's Deep Dive tables or use an older backend (or turn the network off for a moment): the popup still opens, shows its category and strategy lists and saves, just without the panel.
7. **Real session** (last): the same as step 1 and 3 on a real trade; the label saves and the order flow is not affected in any way. Report anything that feels slower or different while trading.

## G. Fixes after the first tries (symbols, calendar, chart layout)

1. **Symbols:** in the Deep dive start form and in the marking step, the Symbol is a dropdown with NIFTY 50, SENSEX, Reliance Industries, Tata Motors CV and Tata Power. Start a deep dive on a stock: the in-depth step shows its underlying chart and a **CE** (Buy day) or **PE** (Sell day) chart, picked at OTM from the 09:15 price at the stock's strike gap (5). The desktop Pattern Library's symbol box lists the same five.
2. **Calendar:** check a month you know: each date sits under its own weekday (a Monday under MON, a Friday under FRI), including months that start on a Sunday or a Thursday. Go back a month and check again.
3. **In-depth layout:** on a tall window the two charts (underlying on top, option below) together fill the height down to the bottom of the window, half each, with no empty half-page; both time axes are visible. On a short window each chart keeps a usable height and the page scrolls. Resize the window: the charts follow. Open the "Needs marking" box or add a tag note: the charts adjust.

## H. From your trades (S10)

Needs the desktop rebuilt from `dev` and trades you have labelled (expected and actual strategies) in Analysis or in a live popup, in more than one session.

1. Pattern Library > **From your trades** (website: **🧾 From your trades**). The left list has every strategy you have labelled a trade with, each with "n trades · n expected · n actual · last <day>". A strategy you only ever used as the *actual* one is there too. The filter narrows by category or name.
2. Choose a strategy: a table of the trades behind it, newest first: day, instrument (with strike for options), position (**Buy** or **Sell** badge and bought or sold), time range, P&L, whether it was the **expected** or the **actual** strategy (or both), and the session type. Check the Buy / Sell badge against the rule: long equity or index, CE bought and **PE sold** = Buy; short equity, CE sold and **PE bought** = Sell.
3. The first trade is drawn below the table: the **underlying chart and, for an option trade, the CE or PE contract chart side by side** with that trade's strike, both centred on the entry. A gold **⚑ BUY** marks the entry bar and a gold **⚑ SELL** the exit bar (a short trade shows SELL first and BUY at its exit). The gold marks look different from the green, red, blue marks of a marked pattern. A legend says "gold = your actual orders".
4. Click other trades: the charts follow. The charts and table fill the window height; nothing is hidden below the fold on a normal window.
5. **Save as pattern chart**: a message says it saved a new pattern chart with 2 marks. Find it under **View** (Saved charts): the same symbol and day, with the entry and exit as ordinary marks of that strategy on the traded leg. Do it for another trade of the same day: "Added 2 marks to the day's pattern chart" and the old marks are not duplicated.
6. **Save and edit**: the saved chart opens in **Annotate** (Create on the website) with its marks; move or add a mark and save as usual.
7. A day whose pattern chart already uses other strikes than the trade's: the save is refused with a message that names the strike; nothing is overwritten.
8. A real session's labelled trades appear once (not twice), and with a very long history the screen stays quick (the strategy list does not wait for trades; a strategy with many trades shows the newest 50 and says so).

## I. Hardening (S11)

1. **Paper trading, feed row:** start a paper session. While the feed is connected there is **no** "Feed kite · connected" line above the chart, and the chart has that row's height back. Disconnect the feed or start with the broker down: the line appears ("Feed kite · reconnecting" or "unavailable") and goes away again when it reconnects. If a fallback provider is used, the line shows "(fallback from ...)" even while connected. (The desktop toolbar label follows the same rule.)
2. **Day strip keyboard:** in the in-depth step, Tab to the day strip (one stop), then Left, Right, Home and End walk the days and the focus follows the selected day.
3. **Past days only:** mark a day through another client (or change the system date): the server refuses today and later with "A deep dive day must be before today". Yesterday works at any hour in India.
4. **Older backend or no connection:** point the app at a backend without the Deep Dive (or stop the backend). Deep dive and From your trades say "This server does not have this feature yet" or "Could not reach the server", the category and strategy lists still load, and "Your deep dives" says it could not be loaded instead of "Loading…".
5. **Many days:** a deep dive with a hundred marked days still opens at once; Next, Prev, the day strip and Results stay quick.
6. **Speed of the percentages:** open Label Trades or a live label popup twice in a row: the second time is instant. Add a tag mark in the Deep Dive and open a label form at once: the new percentage is there.

## K. Rename a tag

1. In the in-depth step, click **✎** on a tag. The name becomes an input; type a new name and press Enter (or Save). The row shows the new name and a note says it shows on every day.
2. Go to a day where the tag was marked Valid or Not valid: it has the **same mark** under the **new name**. Results shows the new name with the same percentage and n.
3. Try a name another active tag already has: "An active tag with this name already exists" and nothing changes. Press Escape in the input: it goes back to the name.
4. Open Label Trades and choose this strategy as the Expected Pattern: the Your deep dive panel shows the new name (within about 20 seconds).
5. A deep dive shared with you (read-only) shows no ✎.

## L. Strength and entry / exit times

1. In the in-depth step, under **Outcome**, choose **Ideal**, **Average** or **Poor**: only one stays pressed. Click **Failed**: the grade goes. Click a grade again: it clears. Step to another day and back: the choice is still there.
2. A day you marked Success before this change shows **Success (not graded)** pressed; pick a grade (or click it to clear).
3. Place an Entry mark and an Exit mark on the chart: the line under Outcome reads "Entry hh:mm · Exit hh:mm" (the candle the mark sits on, IST). Undo the Exit: it reads "Exit —".
4. Results: the summary line shows "Ideal n · Average n · Poor n", each day's Outcome says its grade, and the Entry and Exit columns show the times.
5. Label Trades (or a live label popup): choose an Expected Pattern with a deep dive: the success line also shows the grades.
6. Optional, with the backend: `GET /api/deep-dive/timings` (with your token) lists every marked day with `entry_time` and `exit_time`.

## Report back
