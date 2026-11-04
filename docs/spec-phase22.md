## Support of KLine Charts in Website.
1. Support KLine charts in website, just on the main trading, both swing and day trading.
2. As in KLine the lines can be dragged, so add similar order features as present in desktop, line drag changes limit price. However, make such that only when user has done placing the line at the new price, then call backend for stoploss value change, or limit value change.
3. User can switch between KLine and Lightweight charts, add a Admin setting, or may be per Usser, which ever is convenient, basically, if one is not working, I am switch to the other (lightweight charts) which is tried and tested.
4. Increase settings window size also, took many texts are present explaining setting meaning in the setting UI, can you shift them to tooltip.
5. Any Line drawn on KLine should be saved to DDB as is being done with Desktop for day trading and swing trading.
6. Show the same indicator and drawings are present in Day & Swing Trading in website, No need to add the current light weight charts indicators in KLine, use the same indicators and drawings as present in desktop.
7. The indicator and drawing should be collapsable whereever you want to place, for day trading at least you can place in the left side with minimal place, or where ever you think is best.
8. The orders modificcation or Strategy modifications through lines in KLine should also work for real trading.
9. In website, the Analysis and pattern and other can still use lightweight. *(Superseded by the Analysis & Patterns follow-up below: Analysis and Patterns now have their own renderer setting; Lightweight remains the default.)*
10. Drawings and lines drawn in desktop should be visible in website for KLine and vice versa.
11. Check in desktop and website a line drawn should be visible in all places where Kline is used for that particular syymbol.
12. Website KLine drawings and indicators use one collapsible left panel for all charts in the workspace, operating on the active chart rather than repeating controls per chart.


## Implementation

See [Phase 22 implementation plan](spec-phase22-implementation-plan.md) for sprints, decisions, design, exclusions, verification commands and current status.

PR #675 was merged into **preprod**. The current follow-up is on `fix/website-chart-tools-and-resize`, with PR #676 targeting **preprod**. Website Settings → General → Trading chart selects **Lightweight** (default) or **KLine** for Day and Swing. Swing also has a chart display settings gear. Switching does not restart the session or backend. Analysis/Patterns default to Lightweight and now have their own renderer setting (see "Analysis & Patterns drawing tools and indicators" below).

Day KLine covers Replay, Stepwise, Paper and Real, using existing website trading APIs. Existing Swing actions remain available. Shared KLine drawings load when opening/reopening or explicitly refreshing charts; no new continuous synchronization is added.

Automated regression and browser interaction checks are implemented: 259 desktop/shared unit tests and 19 browser scenarios pass; both TypeScript checks and JavaScript production builds pass. The earlier broad backend run has 2,580 passes and the same five failures reproduced on unchanged preprod; see the linked document for exact results. Live broker and native Windows acceptance remain manual; merging and deployment remain manual.


The follow-up review fixes unavailable/authoritative website P&L, overlapping strategy edits, inactive-pane drawing controls, and Lightweight drawing appearance/removal after switching renderers. It also fixes disposed drawing references during Strict Mode canvas recreation. See the linked implementation document for corrective sprint completion, current verification and remaining manual acceptance.


### Shared website tools and resize follow-up

Website Day and Swing now have one collapsible **✎** panel on the far left. Expand it for drawings and indicators, then click a chart to make it active; its instrument caption and controls appear in the panel. Indicator selections remain independent for each chart. Per-chart tool buttons are removed in the website workspace. The panel hides when using Lightweight. Desktop controls keep their existing layout.

Website Day/Swing size observers and Lightweight chart/ratio widths now coalesce layout changes into animation frames, ignore unchanged dimensions, and cancel pending work on unmount. Browser regression coverage now totals **21 passing scenarios**, with **259 shared/desktop unit tests**, both TypeScript checks and the website production build passing. No global ResizeObserver error suppression is added; the reported warning still needs confirmation in the user's original deployed scenario.


### Order pipeline, recovery and replay layout follow-up

PR #676 also preserves the exact session, pane, option right, strike and expiry through chart menus, entry tickets, price picks and strategies. In options sessions, the underlying menu directs entries to CE/PE charts and retains underlying-specific strategies. Premium order changes target only the clicked contract. Renderer selection is exclusively in Settings; chart errors offer Retry and diagnostic details. Three-chart KLine replay layouts now use the space previously reserved for Lightweight toolbars, removing the unused bottom gap.

Current verification: **27 browser scenarios, 278 desktop/shared unit tests and 18 focused backend tests pass**. See the linked implementation plan for sprint details, assumptions and manual acceptance limits.

### Website KLine display parity

Settings → General → **KLine chart appearance** now exposes a website moving-average toggle, MA/EMA type, comma-separated periods (default `9,21`, drawing two lines), and **Show symbol and OHLC values**. Swing exposes the same controls under its chart display gear. Saving updates all mounted website KLine charts; saved values reload on reopening. MA type/periods and OHLC visibility reuse the existing per-user desktop chart-settings record. Website symbol visibility follows this toggle; desktop's separate label setting is unchanged.

Each intraday website KLine chart shows its bar-close countdown on the right. Live charts tick every second; Replay/Stepwise use the session market clock and therefore remain still when replay is paused. Daily/historical Swing charts have no live countdown. Lightweight display behavior is unchanged.

Website KLine indicator controls (including Clear indicators) use wrapping tiles in a responsive grid: two columns in the narrow tools rail and three on wider displays. The expanded rail grows from 178px to at most 248px; the collapsed rail remains 34px. Indicator selection and desktop controls are unchanged.


## Analysis & Patterns: drawing tools and indicators

### Feature request
1. In desktop **Analysis**, a (maximized) chart should offer the drawing tools and indicators normally present while trading, in a left side panel, so the user can analyse entries and exits, design strategies and find faults in how they entered or exited.
2. Drawings must persist, as already done for KLine charts.
3. A cleaner UI for the tools and indicators is welcome, in Analysis generally or only when maximized; hideable/floating panel is the implementer's choice.
4. The website should likewise offer the normal drawings and indicators on its Lightweight charts, and the KLine equivalents for KLine; the webapp follows.
5. All KLine charts, in website or desktop, save their drawings.

Decisions confirmed with the user:
- **Do not mix tool sets.** KLine charts show the KLine set (the desktop's 14 drawing tools and indicators). Lightweight charts show exactly what the Lightweight trading chart has.
- Add **KLine to website/webapp Analysis and Patterns** behind a **separate setting**, so a user can trade on Lightweight and analyse on KLine.
- Tools are visible on Analysis and Patterns charts **at all times**, not only when maximized. KLine uses a hideable left panel; Lightweight uses the on-chart Draw/Indicators dropdowns like the trading chart.
- **KLine drawings are saved to the backend and shared** with the trading charts for the same instrument. **Lightweight drawings stay in localStorage** (as the Lightweight trading chart does today).

### Implementation
- **KLine (desktop always; website/webapp when selected).** Each Analysis KLine chart has a slim left tool rail: the 14 drawing tools, Once/Repeat, and lock/hide/delete for the selected drawing. The header has a **✎** toggle to hide or show the rail (remembered, applies to every Analysis chart) and an **ƒx** popover with 13 indicators (`PositionPnL` is trading-only; EMA 9/21 is on by default, as before). Indicator choice is stored locally per account and pane type (underlying vs option). Escape, Delete/Backspace and Ctrl/Cmd+Z act on the chart under the pointer. The same chart type is used by Underlying/Option panes, Trade labelling, snapshots and the Trade-vs-Pattern comparison, and the maximize layout is unchanged (the rail simply stays beside the larger chart).
- **Persistence and sharing.** Drawings use `/api/desktop/v1/drawings` and the existing `{tool, points:[{timestamp,price}], style}` record, so no backend change was needed. The instrument key is built by `analysisDrawingInstrument` + `drawingIdentity(..., shareDayDrawings=true)` and matches the Day/Swing KLine charts (index/equity: catalogue kind + symbol + exchange; option: underlying, expiry, strike, right). A level drawn on the exact option contract in Analysis therefore also appears on that contract's trading chart and vice versa. If the instrument catalogue cannot be loaded the tools are disabled rather than saving under a guessed key. A click that does not move a drawing does not save it. klinecharts needs three clicks for two-point tools (start, second point, confirm).
- **Lightweight (website/webapp).** Underlying, Option, Trades and Pattern charts get the same **Indicators ▾** (EMA 9/21 toggle, on by default) and **Draw ▾** dropdowns as `Chart.tsx`: horizontal line, trend line, Fib retracement, **rectangle** (two-click shaded box; fill colour/opacity from Settings → Display, shared with the trading chart; it replaced the parallel channel), buy/sell marker, Risk:Reward, plus **Clear** (removes the last drawing). Drawings are stored in `analysis-lw-drawings:<account>:<symbol>:<right>:<strike>:<expiry>` and are restored whenever the chart is recreated (maximize, reload, switching contract tab). `Chart.tsx` is not modified; the tools are re-implemented in `lightweightDrawings.ts`. Snapshot charts keep their previous behavior.
- **Renderer setting.** New per-user `website_analysis_chart_renderer` (`lightweight` default | `kline`) in `UserSettingsResponse`/`UserSettingsUpdateRequest`; shown in **Settings → Display → Analysis & Patterns chart**, independent of the trading chart setting. The frontend caches it per account and the server value wins; a backend that does not confirm the field is reported instead of silently ignored. KLine Analysis code is lazy-loaded so Lightweight-only users never download it.
- **Shared code.** The desktop Analysis KLine chart moved to `shared/analysis/kline/` (old `windowsapp/src/*` paths re-export it). The drawing layer is `shared/charts/{useKLineDrawings,useKLineIndicators,KLineToolsPanel,klineDrawingModel}`. `KLineChart.tsx` (the trading chart) was deliberately not refactored, to keep the real-trading path untouched. `AnalysisEnvironment` gained `drawingRequest`, `resolveSymbolInstrument` and `accountKey`; the website supplies them in `frontend/src/services/analysisEnvironment.tsx`, the desktop in `DesktopAnalysis.tsx`. Website KLine Analysis styles are scoped in `klineAnalysisSite.css`.
- **Fix found while testing.** On the website a maximized KLine Analysis chart could not be restored with Escape (the website environment has no `active` flag); `AnalysisPanels` now ignores Escape only when the environment is explicitly inactive.
- **Webapp.** No separate code: it mounts the website, so it inherits the setting and both tool sets.

### Out of scope
`Chart.tsx`/trading charts, Swing charts, the Pattern Library / Fine Structures / Chart Structures pages (their own Lightweight drawing code is unchanged), syncing Lightweight drawings to the backend, and merging the KLine and Lightweight tool sets.

### Verification
- Browser: `frontend/tests/phase22/analysis-tools.spec.ts` (4 scenarios: KLine draw/save/restore/delete under the shared instrument key, indicators and rail visibility, option-contract key with maximize and Escape, Lightweight tools/local persistence/maximize/EMA toggle). The existing `frontend` (43) and `webapp` (21) Playwright suites still pass.
- Unit: `windowsapp/src/analysisDrawing.test.ts` (instrument key parity with the Day tiles, overlay point round trip); desktop vitest 294 pass. `tsc --noEmit` clean for `frontend`, `webapp` and `windowsapp`; website, webapp and desktop builds pass.
- Backend: `backend/tests/test_user_settings.py` covers the new setting (default, update, invalid values). Full backend suite with DynamoDB Local: 2,777 pass and 1 failed before the test fix below; that test now passes (`test_swing_paper_recovery.py` 10/10). The failure was a pre-existing, clock-dependent test, also failing on unchanged `dev`: `amend_attempt` starts the new attempt at `max(real clock, session clock)+1`, but the test hard-coded 2026-11-02, so it only passed when run during weekday market hours (09:15-15:30 IST) or before that date. The test now pins `current_market_timestamp`; production code is unchanged. Verified with the real clock after hours and with faked weekday-market-hours, weekend and pre-2026-11-02 clocks. The same test exists on `main` and `preprod` and will fail there until this lands.
- Manual acceptance still required: the real Tauri desktop Analysis tab (draw on an underlying and an option chart, maximize/restore, restart, confirm the drawing also shows on the Day chart) and the website/webapp Patterns view with KLine selected. The `scripts/desktop-analysis-workflows.mjs` check could not be used: it fails to resolve `klinecharts` on unchanged `dev` too.
- Design notes for later work are in [Frontend technical constraints](frontend-technical-constraints.md#analysis--patterns-charts).


## Web App For TradeMatangi.
Can you create a web app for trademantagi, with all features as that present in website.

Implementation: see [Installable webapp](spec-phase22-webapp.md) for the shared-code design, chart gestures, hosting, verification and manual acceptance.

The website login screen and trading header now offer **Install app**. The normal frontend startup scripts serve both the website at `/` and the webapp at `/webapp/` on port 5173 for preprod testing. Installation leaves the website tab unchanged; the installed app launches `/webapp/`. See the linked webapp document for startup and acceptance details.

The webapp no longer reserves a separate app-title/install/fullscreen row. Fullscreen uses a compact icon in existing headers and a top-edge floating exit on desktop (or the header restore icon on touch). Installation controls remain on the website only. See the webapp implementation document for behavior and verification.


## Target P&L lines, candle-close sound alert, MAX SIZE alert

Three requirements for desktop, website and webapp (the webapp mounts the website, so it inherits them). Decisions confirmed with the user are marked **(confirmed)**.

### 1. Target P&L levels indicator
1. A new trading-chart indicator, **Target P&L levels**, with its setting in **Settings → Display**. The setting is a comma-separated list of doubles, for example `0,3,6,10,15,18`.
2. If P&L display is **%**, the values are percentages of session capital. If it is **₹**, they are exact rupee amounts.
3. One horizontal line is drawn per value. A line at X is the price where exiting the *entire* position makes the day's **net capital P&L** equal X. **(confirmed)** "Net" means the whole-day total, which is already-booked P&L (including earlier sessions that day) plus this position, after exit charges. With the day at +6.9% and a position open, the 0, 3 and 6 lines sit below the average entry and the rest above.
4. Lines appear only while a position is active. In options sessions they appear only on the held contract's chart, in premium terms, and not on the underlying. **(confirmed)**
5. The lines must never expand the chart viewport.
6. Available in desktop, website and webapp, on Lightweight and KLine renderers. Day trading only; Swing and Analysis charts do not get it.

### 2. Candle-close sound alert
1. **Settings → Trading** gets an on/off toggle, a candle interval (1/3/5/10/15/30 min) and "seconds before candle end". The settings are per-user and synced through the backend. **(confirmed)**
2. The alert is a short sound played that many seconds before each candle of the chosen interval ends. With 3 min and 15 s, it plays at 09:26:45.
3. It works in replay, paper and real sessions on desktop, website and webapp. Stepwise is excluded.
4. Replay uses the session's market clock, so the alert fires at the same market time at any speed and stops while paused.
5. It fires at most once per candle, and not when a session starts or resumes already inside the window.
6. The sound is synthesized in the browser (Web Audio), with no audio asset. A **Test sound** button unlocks audio.

### 3. MAX SIZE "Alert at 50%"
1. A new checkbox under the Guardrail MAX SIZE settings.
2. When capital in use reaches 50% of the MAX SIZE limit (the same figure and limit MAX SIZE already enforces), the chart top bar turns orange.
3. Priority: red states win. **(confirmed)** If the BAN "Alert at 50%" red bar is showing, or a BAN is active, the bar is not changed to orange.
4. Day trading only; Swing has no MAX SIZE guardrail.
