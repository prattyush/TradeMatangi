## Support of KLine Charts in Website.
1. Support KLine charts in website, just on the main trading, both swing and day trading.
2. As in KLine the lines can be dragged, so add similar order features as present in desktop, line drag changes limit price. However, make such that only when user has done placing the line at the new price, then call backend for stoploss value change, or limit value change.
3. User can switch between KLine and Lightweight charts, add a Admin setting, or may be per Usser, which ever is convenient, basically, if one is not working, I am switch to the other (lightweight charts) which is tried and tested.
4. Increase settings window size also, took many texts are present explaining setting meaning in the setting UI, can you shift them to tooltip.
5. Any Line drawn on KLine should be saved to DDB as is being done with Desktop for day trading and swing trading.
6. Show the same indicator and drawings are present in Day & Swing Trading in website, No need to add the current light weight charts indicators in KLine, use the same indicators and drawings as present in desktop.
7. The indicator and drawing should be collapsable whereever you want to place, for day trading at least you can place in the left side with minimal place, or where ever you think is best.
8. The orders modificcation or Strategy modifications through lines in KLine should also work for real trading.
9. In website, the Analysis and pattern and other can still use lightweight.
10. Drawings and lines drawn in desktop should be visible in website for KLine and vice versa.
11. Check in desktop and website a line drawn should be visible in all places where Kline is used for that particular syymbol.
12. Website KLine drawings and indicators use one collapsible left panel for all charts in the workspace, operating on the active chart rather than repeating controls per chart.


## Implementation

See [Phase 22 implementation plan](spec-phase22-implementation-plan.md) for sprints, decisions, design, exclusions, verification commands and current status.

PR #675 was merged into **preprod**. The current follow-up is on `fix/website-chart-tools-and-resize`, with PR #676 targeting **preprod**. Website Settings → General → Trading chart selects **Lightweight** (default) or **KLine** for Day and Swing. Swing also has a chart display settings gear. Switching does not restart the session or backend. Analysis/Patterns stay Lightweight.

Day KLine covers Replay, Stepwise, Paper and Real, using existing website trading APIs. Existing Swing actions remain available. Shared KLine drawings load when opening/reopening or explicitly refreshing charts; no new continuous synchronization is added.

Automated regression and browser interaction checks are implemented: 259 desktop/shared unit tests and 19 browser scenarios pass; both TypeScript checks and JavaScript production builds pass. The earlier broad backend run has 2,580 passes and the same five failures reproduced on unchanged preprod; see the linked document for exact results. Live broker and native Windows acceptance remain manual; merging and deployment remain manual.


The follow-up review fixes unavailable/authoritative website P&L, overlapping strategy edits, inactive-pane drawing controls, and Lightweight drawing appearance/removal after switching renderers. It also fixes disposed drawing references during Strict Mode canvas recreation. See the linked implementation document for corrective sprint completion, current verification and remaining manual acceptance.


### Shared website tools and resize follow-up

Website Day and Swing now have one collapsible **✎** panel on the far left. Expand it for drawings and indicators, then click a chart to make it active; its instrument caption and controls appear in the panel. Indicator selections remain independent for each chart. Per-chart tool buttons are removed in the website workspace. The panel hides when using Lightweight. Desktop controls keep their existing layout.

Website Day/Swing size observers and Lightweight chart/ratio widths now coalesce layout changes into animation frames, ignore unchanged dimensions, and cancel pending work on unmount. Browser regression coverage now totals **21 passing scenarios**, with **259 shared/desktop unit tests**, both TypeScript checks and the website production build passing. No global ResizeObserver error suppression is added; the reported warning still needs confirmation in the user's original deployed scenario.


### Order pipeline, recovery and replay layout follow-up

PR #676 also preserves the exact session, pane, option right, strike and expiry through chart menus, entry tickets, price picks and strategies. In options sessions, the underlying menu directs entries to CE/PE charts and retains underlying-specific strategies. Premium order changes target only the clicked contract. Renderer selection is exclusively in Settings; chart errors offer Retry and diagnostic details. Three-chart KLine replay layouts now use the space previously reserved for Lightweight toolbars, removing the unused bottom gap.

Current verification: **27 browser scenarios, 278 desktop/shared unit tests and 18 focused backend tests pass**. See the linked implementation plan for sprint details, assumptions and manual acceptance limits.
