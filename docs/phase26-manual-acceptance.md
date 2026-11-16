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

## Report back
