# Phase 26 — Manual acceptance (Patterns Strategy Deep Dive)

Sections are added as sprints land. Report back with what failed, with the strategy name and date.

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

## Report back
