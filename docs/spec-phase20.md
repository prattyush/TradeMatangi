# Phase 20 — Trading performance and chart browsing

## Agreed scope and decisions

Capture analytics for website and desktop executions in Paper, Real, Stepwise,
and Replay wherever those modes already exist. Reports remain in website
Analysis → Stats. Kite broker execution, desktop real-trading enablement, and website continuous browsing are deferred. Desktop Analysis is now included
as a planned follow-up below; desktop real-trading execution remains deferred.

- Use FIFO quantity splitting: entries 40 + 80, exit 60 consumes 40 + 20.
- A trade cycle is one exact contract from flat to flat. Entry positions and
  matched exit portions retain separate results. Handle shorts and reversals.
- Reuse existing labels/tags and expected/actual patterns; no mandatory rationale.
- Capture original entry intent independently of execution type and confirmed
  exit controller, including Half/Full intent and actual selected quantity.
- Capture Capital %, Risk %, fixed quantity, requested percentages/budgets,
  capital baseline, sizing stop, effective exposure and minimum-lot overruns.
- Statistics include unlabeled executions. Associated cycle results overlap
  across methods and must not be added. Missing evidence stays Unknown/null.
- Add expectancy, profit factor, distributions, fee drag, realized drawdown,
  entry-spacing/scaling/re-entry behavior, MFE/MAE, giveback and initial-risk R.
  Excursions are sampled/approximate when appropriate, never executable promises.
- Groups below 30 closed cycles or 20 distinct market dates are exploratory.
  Larger groups use 1,000 date-clustered bootstrap resamples for mean intervals.
- Desktop underlying pagination retains D−13 through D, including holidays,
  in two-calendar-date buckets. Both clients initially show up to 150 candles.
  Restored ranges and subsequent user navigation take precedence.
- Add Underlying Stoploss Half/Full using existing protected exit allocation.
- Preserve Phase 19 exact-contract identity, IST wall-clock timestamp encoding,
  provider/cache policies, broker confirmation and snapshot recovery.

## Sprints and status

| Sprint | Deliverable | Status |
|---|---|---|
| 0 | Agreed specification and baseline | Validated |
| 1 | Execution provenance and sizing capture | Implemented; automated validation passed |
| 2 | FIFO analytics and accounting corrections | Implemented; automated validation passed |
| 3 | Performance APIs and behavior metrics | Implemented; automated validation passed |
| 4 | Excursions and initial-risk analysis | Implemented; automated validation passed |
| 5 | Website Stats dashboard and drill-down | Implemented; automated validation passed |
| 6 | Desktop pagination and 150-candle viewport | Implemented; automated validation passed |
| 7 | Underlying Stoploss Half/Full and integration | Implemented; automated validation passed |

Each sprint records implementation, tests, and remaining acceptance below.
Development stays on dev; delivery PR branches target dev after review. Main
merging and deployment remain manual. Existing user requirements below are retained.

## Restart reconciliation — 2026-10-06

The laptop restart preserved the working tree on dev. All implementation files
are present; no merge/deployment has occurred. Temporary test logs and browser
screenshots were lost. The sprint table has been reconciled against code rather
than treating the older Pending entries as absent implementation.

Pre-restart validation reported 1,668 backend tests passing with two documented
Phase 19 baseline failures (stale options-expiry assertion and tab-restore fixture
missing group_id), 155 desktop/client tests, 29 website Node tests, both TypeScript
checks/production builds, native Rust tests, and dashboard browser acceptance.
Subsequent accounting/label integration changes passed 92 focused backend tests.
These historical results are checkpoints, not final validation of later changes.

Remaining work: API/database and history-page edge-case acceptance, controller and
price-path provenance review, chart navigation/viewport checks, a durable final
regression record, and PR delivery targeting dev. No live broker orders are needed
for automated checks; native Windows and real-broker acceptance remain manual.

## Sprint implementation notes

### Sprint 1 — Execution provenance and sizing

Orders and trades persist versioned analytics snapshots. Market-style LIMITs keep
Market intent; AS and ASL retain their strategy origin. A logical action groups
partial fills and broker split orders. Confirmed exit-controller history includes
strategy, requested Half/Full and actual allocation. Manual price/type edits take
ownership; quantity-only reconciliation and recovery preserve the controller.
Broker conversion provenance is published only after confirmation.

Capture Capital %, Risk %, fixed quantity, requested budget/percentage, captured
capital, sizing reference/stop/source, lot/margin information and effective filled
allocation/risk. Minimum-lot budget overruns are visible. Entry fills aggregate
actual sizing across partial fills without counting extra decisions. Reuse the
already-resolved sizing stop: analytics does not add settings reads to execution.
Session interval/brokerage, trade metadata and same-clock fill ordering survive
restart. Legacy metadata is Unknown rather than inferred from current presets.

### Sprint 2 — FIFO accounting and labels

A shared ledger handles exact-contract partial matching, shorts and reversals.
Entry and exit fees follow matched quantity; remaining entry fees stay with open
inventory. Session summaries no longer classify open purchases as realized losses.
Real summaries use individual executions from a pinned committed projection,
with order/execution membership, quantity/value and revision consistency checks.
Exchange, product, strike and expiry stay separate; real aliases count once.

Label round trips use the same ledger. New labels store stable cycle identities;
legacy labels are attached only when entry/exit memberships and quantities agree.
DynamoDB pagination and ownership checks cover the analysis/label boundaries.
Metadata Decimals are normalized before arithmetic. No historical records are
bulk-rewritten; provenance reconstruction uses stored evidence only.

### Sprint 3 — Performance and behavior APIs

- `GET /api/analysis/performance`: summaries, comparisons, distributions,
  daily results, realized drawdown, behavior groups, coverage and insights.
- `GET /api/analysis/performance/cycles`: paginated cycle drill-down.
- `GET /api/analysis/performance/cycles/{cycle_id}`: owned detail, with optional
  cached-price enrichment and the owning session ID.

Filter dates, mode, client, symbol, instrument, direction, entry/exit methods,
sizing/percentage, existing tags/strategies and data quality. Method/origin/sizing
filters select containing cycles, retaining their other actions for whole-cycle
context. Associated cycle results overlap and are not additive.

Measure expectancy, win/loss/breakeven, profit factor, mean/median P&L, capital
contribution and initial-risk R where available. Behavioral groups cover counts,
strategy-bar spacing, relative addition size, contemporaneous addition P&L,
rapid re-entry, size after losses, daily trade sequence, weekday, half-hour and
holding duration. Partial fills and order splits are not discretionary decisions.
Use bounded fingerprinted result caching, worker execution and date-clustered
intervals. Read failures produce errors, not successful empty statistics.

### Sprint 4 — Price-path quality

Lazy enrichment reads cached exact-contract Breeze/Kite/Kotak data without
broker polling or automatic downloads. Fresh provider caches preserve observed
versus gap-filled rows. Legacy native-minute caches are sampled candles; old
Breeze caches without observation provenance remain unavailable for excursions.
Exclude ambiguous boundary bars and filled gaps. Report provider, resolution,
coverage and sampled/unavailable status for matched portions and the changing
cycle inventory. Preserve the initial sizing stop rather than rewriting risk
from a later trailing stop. Fees remain the application's existing estimates;
this phase does not reconcile broker contract notes or change charge schedules.

### Sprint 5 — Website Stats

Overview, Entries, Exits, Sizing and Behavior share filters, sortable tables,
linked charts, calendar, entry→exit combinations, distributions and a sizing
scatterplot. Rows show position attribution separately from associated-cycle
outcomes. Half/Full, existing labels, coverage and small-sample badges are visible.
Trade details include sizing, fees, FIFO portions, R, optional execution charts
and sampled price paths. CSV exports the filtered cycles. Insights describe
observed associations and never assert random/revenge intent.

### Sprint 6 — Desktop history and viewport

`GET /api/desktop/v1/historical/underlying-pages` scans at most two calendar dates
before its cursor within D−13..D, including holidays. Failures are explicit and
retryable. Desktop uses the existing authenticated request transport and history
workers, KLineCharts' prepend loader, stale-request fencing and separate older
context. Live refreshes retain that context. The history cache is bounded to
32 entries/100,000 aggregate candles with ten-minute expiry and failed-promise
removal. Live anchoring uses the current IST date; Replay/Browse uses its selected
date. Options/futures do not gain continuous paging.

Both clients initially display at most 150 available bars without reducing fetched
data. Saved website ranges take precedence; subsequent navigation is preserved.
Explicit Fit still shows all loaded data. Desktop native initial history now honors
the configured context-day count rather than always requesting five days.

### Sprint 7 — Underlying Stoploss Half/Full

Persist `underlying_stoploss_size`, default Full. Both clients expose Half/Full
and armed size editing through the existing shared controls. Half uses Phase 19's
protected allocation, rounding and recovery rules; even one lot selects one lot.
Remaining protection, manual reductions and retry fencing stay intact. Analytics
records requested size separately from actual quantity and closed fraction.

## Validation artifacts and reproduction

Logs, JSON fixtures and regenerated screenshots are kept on disk in
`.cache/phase20-validation/` (ignored by Git). The specification records durable
results below. All automated browser/provider checks use synthetic or mocked data.

Backend checks use `~/venvs/tradematangi/bin/python -m pytest backend/tests/ -q`
with `USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1`. Both clients run TypeScript
checks and Vite production builds. Desktop tests use Vitest; website accounting
checks use `node --test src/*.test.mjs src/services/*.test.mjs`. Native checks use
`cargo test --offline --manifest-path windowsapp/src-tauri/Cargo.toml`.

Browser checks are reproducible with `scripts/phase20-browser-check.mjs` and
`scripts/phase20-chart-check.mjs`. Install playwright-core outside the project,
then supply its module through `PLAYWRIGHT_MODULE`, the project venv through
`PYTHON_BIN`, and optionally `CHROME_BIN` and `PHASE20_ARTIFACT_DIR`. No runtime
browser-testing dependency was added. The existing chart soak script also runs
with synthetic prices; a short accelerated run is not a long market-hours soak.

## Final automated validation — 2026-10-06

| Check | Result |
|---|---|
| Full backend suite with DynamoDB Local running | **1,685 passed / 2 baseline failures** |
| Final focused accounting/API/order/strategy/desktop regressions | **351 passed** |
| Desktop/client Vitest | **155 passed**, 25 files |
| Website Node accounting/history checks | **29 passed** |
| Website and desktop TypeScript / production builds | Passed |
| Native Rust tests on Linux | **16 passed** |
| Actual desktop chart browser acceptance | Passed: 375 retained bars / 144 visible initially; 100 prepended; one request; overlay and viewport survive a live append; refresh returns to 144 latest visible bars |
| Website Stats browser acceptance | Passed: five views, detail, unavailable excursions, CSV, narrow viewport and close; no page errors |
| Synthetic four-chart accelerated soak | Passed for one simulated minute; no failures; sampled JS heap about 5.15 → 6.10 MB |
| Diff whitespace check | Passed |

The two remaining failures are the existing stale expiry assertion in
`test_options_api.py` and missing `group_id` in `test_tab_restore.py`. Before
DynamoDB Local was restarted, four additional environment-dependent failures
occurred; all six reproduced against unchanged dev commit `80fb0a5`. Starting
DynamoDB resolved those four, leaving the established two-fixture baseline.
The final focused run covers the final sizing-metadata/latency refinements and
prepared-Half allocation size-edit fence after the full-suite checkpoint. Existing bundle-size/dateutil/pytest-marker
warnings and pandas observation-column downcasting warnings remain visible.

`summary.json`, complete logs and all regenerated screenshots are available in
`.cache/phase20-validation/`. Browser scripts regenerate artifacts there by default.
No live orders, broker credential changes, main merges or deployment were performed.

### Remaining manual acceptance and operating limits

- Native Windows packaging/interaction, pop-out/refresh/reconnect, 14-date browsing
  with real cache/provider availability, and persisted drawings across sessions.
- Authorized existing website real-trading acceptance for confirmed conversion,
  partial fills, FIFO refresh and Underlying Stoploss Half remainder protection.
- Excursions require cached observations; missing, legacy gap-filled or ambiguous
  boundary data stays unavailable. Native minute candles are sampled, not ticks.
- Statistical associations do not establish causality or psychological intent.
  Current estimated fees, capital snapshots and historical lot-size limitations
  retain their existing meanings. An underlying stop is not converted into a
  fictional option-risk amount.
- Website continuous browsing, Kite broker execution and desktop real-trading
  enablement remain deferred. Desktop Analysis is now included in the follow-up.

### Delivery

Implementation was completed on dev. Delivery uses a dedicated
`feature/phase20-trading-analytics` branch targeting dev; review precedes merge.
Main merging and deployment remain manual.

Delivery: [PR #599](https://github.com/prattyush/TradeMatangi/pull/599),
`feature/phase20-trading-analytics` → `dev`. Implementation commit `e3c66ed`;
review/merge and the manual acceptance checks above remain pending.

## Baseline and research

Current dev already includes PRs #568, #570, #588, #595 and #597 despite older
Phase 19 delivery paragraphs recording pending merges. FIFO position tests:
10 passed. Existing analysis reports an unclosed purchase as a realized loss;
round-trip grouping also misses the closed half of a reversal. Legacy Stats
reads only saved labels rather than all executions.

Synthetic 5,250 OHLC objects used about 0.7 MB for one Node array and 3.3 MB
for four additional copies, excluding charts/canvas/indicators/React. This is
not a browser memory acceptance test. Website continuous browsing is deferred.

Sources informing the design:
- [TradingView expectancy](https://www.tradingview.com/support/solutions/43000772770-expected-payoff/)
- [TradingView performance measures](https://www.tradingview.com/support/solutions/43000681733-overview-tab/)
- [Fidelity MAE/MFE and drawdown definitions](https://www.fidelity.com/research/backtesting/glossary.html)
- [CME risk management](https://www.cmegroup.com/education/courses/building-a-trade-plan/risk-management-and-your-trade-plan)

## Original requirements

# Upgrades

## Desktop Client Continuous browse
1) In desktop client, when going through charts for any mode (browse, live, replay, stepwise), and only for underlying charts, not for options or futures, if the user goes to the end of the chart on the left side, first candle drawn. The desktop client should automatically fetch the data for previous days, upto 14 Days. This helps in desktop only as, we have more memory compared to website, or if is possible in website as well, please go ahead and do it, but primary requirement is for destkop only, as the lines and drawings are saved which can come in handy. Further, 14 days helps to look into previous weekly high and low which is important. By 14 days I didn't mean 14 trading days, I meant 14 days which can include holidays.

Include this feature for website, if it is simple otherwise leave it. When fetching and drawing on chart, you can fetch in buckets, like fetching 1 day at a time or 2 days at a time, till the user keeps going back and at max 14 days data is fetched. This is because for smaller intervals, user may not go to back 14 days, but for 15 mins, 14 days makes more sense.

2) Separate, requirement, do, handle the case in website, as website draws all the candles on the screen, when refreshed, which may become a lot for 1 min candle, so maybe when refreshed it can only shows x number of candles, 150 candles in the view and rest can be scroolled. This 150 candle apply to desktop as well, if possible, only for first draw or refresh etc. It is max 150 just on view not backend fetch data. Not sure the complication of this requirement.


Don't implement continuous browse for website if it requires significant memory increase. Please discuss it first with some stats.


## Analytics Upgrade

### Order Info For Analytics
For each postion entry and exit we need to store how that particular position was entered or exited. Like for Entry we need to keep the information whether that entry was triggered by Market Order, Limit Order, Target Order, Auto Stop Order (Though Auto Stop results in Target Order, if Auto Stop needs to be stored), Auto Stop Limit Order.

Similarly for Exit Orders, we need to store per order, whether that particular order was Stoploss Order Exit, Limit Order Exit, Aggresive SL Order Exit, Target Profit Strategy Full Order Exit,  Target Profit Strategy Half Order Exit, Underlying Target Strategy Half Order Exit, Underlying Target Full Order Exit and similarly for Underlying SL (full and half exits).


### Analytics On Order Info
Now, a trade is different than a particular position. In one trade I can take 2 positions and exit one in some way and another in other way. While exitting I think, we take FIFO logic, for first exit would be for last entry, I am fine with that if quantities are same, if quuantities don't match, find a position in that trade that matches in quantity, if exit quantity is either low or high and doesn't match then match to last entry with min of (exit, entry) and use it in analytics.

#### Stats On Entries
The stats windows needs to show per position, the breakdown of enter position types (based on previous section (Order Info of Analytics) values) against Profit and Loss % of that position and also the entire trade. What I mean lets say for one trade, we have 2 positions with Auto Stop entry with 100 quantity, the exit was in 2 ways, or total 100 quantity exit was in order, one in profit (40) and one in loss (60), then calculate actual profit and loss combined and calculate % against session capital. Also, in the same example, lets say 2nd entry was market order and the entire trade was in profit, but Auto Stop Order was in Loss Exit, when matched with FIFO logic or quantity match logic. Then, also show stat of Auto Stop entries against its own position profit and loss % and trade level profit and loss %.

You have aggregate across days and may be within a day, so you can show aggregate, sum, mean and median to get an idea of distribution or show histogram etc.

#### Stats On Exits
The stats window also needs to show similar stats for exit trades as well, I mean whether take profit is more profitable or aggresive SL , similar to previous section (Stats On Entries), you can show per position P&L and also trade level P&L.


#### Stats On Entries/Exit Count
Also, need stats on entry and exit counts in one trade and the result of those trades P&L % etc. Can you also give me stats whether I am entering too less gap or entries in same bar, bar interval length is counted from settings, strategy candle interval. If the entries vary in % entries w.r.t to sizes and whether that result in profit or losses, P&L in count of trades and also % in losses or profits.

## Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation.

## Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.


## Analysis In Desktop
First list out all features of Analysis and then support the same website analysis (tab) in desktop as well.
I am not how will analysis will open, will it be a separate screen or in the same screen. But, it should have the stats, date selection and type and other selection parameters then graphs shown with left and right.

The way trades are calculated should be same.

You can be creative in the UI. You can make the split view of left side underlying and right side chart for options, bigger and taking more screen space, in website it is too small.

Another important feature in this would be when the markers (buy and sell) markers appear on the screen, both in full screen and in the split view, when user clicks on those markers it show if entry, then what type of entry (Auto Stop, risk % or capital %, what percentage, time, limit, market, target order), if sell or exit, then show type of exit (limit, stoploss, take profit full/half, aggresive SL or underlying target or underlying SL).

The current stats view is awesome is website, can it be replicated in desktop client as well.


## Always-enabled entry protection follow-up — 2026-10-06

The user observed two website Replay NIFTY option Market entries, submitted through
right-click Use as SL with Risk %, filling without protective stops. Inspection
and reproduction found the non-real website fill watcher consulting
`entry_auto_sl_enabled`, default False; a disabled setting silently skipped the
explicit attached stop. That gate predates Phase 20 (introduced in September;
real-mode exemption in Phase 19), rather than originating in analytics changes.

The final requested scope retires this enable switch from **both website and
desktop settings** and keeps the existing enabled behavior for every user. Entry
SL requests and AutoStop fallback protection are always processed on fills.
Original price selection/AutoStop fallback and configured real-trading delay are
retained. Risk sizing alone still does not become an attached-stop instruction;
this change removes the account opt-out rather than inventing new entry-price rules.

Backend compatibility responses report the legacy field as True. Stored False
values and writes from older clients cannot disable protection; unrelated settings
and the real-trading delay are preserved. No bulk account migration is needed.
The website no longer reads the stale localStorage flag, and the desktop settings
field catalogue no longer includes the enable toggle. Delay remains configurable.

Regression coverage includes the reported September 15 replay path for both CE
and PE: two risk-sized marketable LIMIT fills produce separate same-contract
stoplosses with the exact selected stop prices and quantities; the SSE order events
are present; another strike cannot fill them; a matching price crossing closes the
position. Settings tests cover previously disabled users and older-client writes.
Automated checks use synthetic replay prices and mocked broker/database paths;
no real broker orders are submitted.

Confirmed scope: website left-panel orders may open positions without an SL.
Selecting Use as SL or attaching an explicit SL must always protect that filled
entry. The unchanged AS/ASL fallback is 25% from fill price when those strategies
have no supplied SL; it does not extend to ordinary entries without an SL.

Validation: **1,697 backend tests passed / 2 existing failures** (the stale
options-expiry assertion and missing `group_id` tab-restore fixture). **296 focused
regressions**, **155 desktop/client Vitest checks**, **29 website Node checks**,
both TypeScript checks and both production builds passed. Mocked browser
acceptance verified both Trading settings panels have no enable switch and retain
a saved seven-second real-trading delay, with no browser errors. Logs/screenshots
are retained in `.cache/replay-entry-stoploss-validation/`.

Delivery targets dev through a dedicated `fix/always-enabled-entry-stoploss`
branch. Update the backend and both clients together. Review/merge, main deployment
and authorized native Windows/live-broker acceptance remain separate manual steps.
Delivery: [PR #601](https://github.com/prattyush/TradeMatangi/pull/601),
`fix/always-enabled-entry-stoploss` → `dev`, implementation commit `fc90c87`.
Review/merge and manual main deployment remain pending.


## Kotak protected-entry reconciliation follow-up — 2026-10-08

The 11:51 IST SENSEX 71700 PE incident involved separate 40-unit and 20-unit
entries but only two initial 20-unit SLs. The user supplied the missing 20-unit
SL manually. The watcher subtracted total contract coverage from each entry
group independently, allowing one group's exit to reduce another's protection.
The later 11:55 40-unit SL was intentionally split into 20+20; that operation
must not create additional protection. Raw Kotak events and the browser message
export support this distinction; the copied stdout log lacks application
protection decisions, so the original entry-to-exit attribution is not claimed
as conclusively reconstructed from logs alone.

Implementation:

- Only Kotak real-options execution enables the entry manager. Execution broker
  identity is persisted separately from the market-data provider, defaulting to
  the existing Kotak execution path. Paper/replay, desktop live browsing and
  future Kite execution retain their existing behavior.
- Confirmed executions reconstruct exact-contract FIFO remaining entry lots.
  Entries carrying an attached SL or AutoStop intent are protected; unrelated
  unprotected quantities and closed cycles do not gain unsolicited SLs.
- Existing exits are allocated once: explicit entry links first, then unlinked
  exits to protected groups in opening order. Manual SLs and allocated limit
  exits count. Repair is capped by fresh broker position and exit capacity.
- Optional order allocation/group metadata plus durable journal exclusions
  preserve manual cancellations/reductions across refresh/restart. Split
  siblings retain links. Historical application cancellation intent is honored
  when adopting legacy records. Exclusions are consumed as their FIFO lots exit.
- Fills, cancellations/rejections, reconnect, restart and Trade History Refresh
  trigger coalesced checks. Entry delay defaults to three seconds; cancellation
  delay is 750 ms. Known protected entries do not require a cancellation-origin
  or recent-exit-fill correlation. Unrelated legacy cancellation incidents keep
  their prior policy.
- There is no periodic broker polling. Account reports share an in-flight task;
  background bundles are spaced by at least two seconds, with shared 2/5/10-second
  backoff and longer broker retry delays. Accounting fetches only its needed
  reports; fresh partial bundles can be completed without repeating those reads.
  Repeated refresh clicks join existing work.
- Manual operations take priority over queued background work. Background
  network reads occur before the foreground refresh barrier; stale revisions
  are discarded. Pending splits/conversions and day closure defer repair.
  Automatic placements serialize per account, with immutable conditional
  submission claims, deterministic tags and no blind retries after uncertain
  acknowledgements. Coverage verification occurs outside the manual-edit lock.
- For the user's long idle periods and short action bursts, the manager has no
  idle polling. Normal audits compare fresh broker executions/positions with the
  confirmed in-memory ledger and avoid rewriting the day's trade history.
  Missed-event/restart inconsistencies fall back to the heavier reconciliation,
  reusing the same report bundle. Slow background staging does not set the
  foreground refresh barrier; intervening trading invalidates its staged result.
  Trade History Refresh remains the explicit heavier preparation/reconciliation
  action. Unchanged protection records are not rewritten on every audit.
- Repeated inconsistent reports remain coalesced in the account queue with
  2/5/10-second spacing, rather than creating a job per event. Scope disagreement
  counts reset only after that scope verifies. Retry windows remain bounded.
- Repair prices use the group's protective SL or attached entry trigger and the
  existing fresh-LTP recovery fallback. SL execution provenance is captured
  separately from entry provenance. Per-contract notices and logs describe
  required/covered/missing quantities, coalescing, request counts and failures.
- EC2 stdout appends to `backend-stdout.log`; application decisions remain in
  rotating `backend.log`, avoiding truncation/file-handler collisions on restart.

Earlier changes retained:

- Dev commit `6044885` already supplies the 750 ms recovery delay and open-position
  CE/PE strike restoration within the saved shared expiry on real Stop/Start.
- This delivery includes the subsequent timeout fallback: a report timeout can
  reopen charts using a saved snapshot only when the same account/day projection
  and confirmed executions verify its positions. A visible notice requests
  Trade History Refresh. The fallback cannot authorize live protection repairs.

Compatibility: optional metadata keeps existing orders/sessions readable. The
existing BrokerProtectionRecovery table is reused; no new table or public API
is required. Deploy the backend and updated EC2 startup script together. Main
deployment, review/merge and live broker acceptance remain manual.

Validation covers 40+20 entries, partial fills, freeze chunks, manual protection,
FIFO closures/exclusions, unknown origin, uncertain acknowledgement/restart,
split/conversion barriers, account single-flight/pacing/backoff, broker/client
isolation and the earlier timeout fallback. Automated tests submit no live orders.
Validation: full backend run **1,841 passed**, with the two documented baseline
failures (`test_options_session_started_successfully`, stale expiry assertion;
`test_active_session_returns_attach_metadata`, missing group_id fixture). The
final focused protection/snapshot/split/conversion/restart run passed **176 tests**,
including five entries submitted from one immutable report snapshot and one
shared verification pass, invalidation of stale partial report caches, unchanged
equity protection, lightweight in-memory audits and background staging priority.
`git diff --check` and EC2 startup-script shell syntax validation passed.

Delivery branch: `fix/kotak-entry-protection-coordinator`, targeting `dev` for PR
review. Review/merge, main deployment and manual live acceptance remain pending.

## Analysis in Desktop — agreed specification and implementation plan

### Follow-up Sprint 0 — Specification and baseline

This follow-up supersedes desktop Analysis deferral. Preserve the original user
requirement and earlier validation history. Development stays on dev; delivery PR
branches target dev for review. Main/deployment remain manual. Local history contains
Phase 19 FIFO/conversion and Phase 20 analytics merges plus the attached-stoploss
fix. Native Windows/broker acceptance remains separate from automated validation.

Decisions: dedicated Workspace / Analysis tab in the main window, KLineCharts in
desktop Analysis, clickable executions only in Analysis. Same website calculations
and full feature parity. Separate Analysis windows, desktop real execution, Kite
execution, new drawing persistence and continuous Analysis browsing are deferred.

### Website parity inventory

| Area | Required capabilities |
|---|---|
| Sessions | Symbol/instrument/mode/date filters, refresh/loading/error/empty; aggregates; date/symbol/instrument/mode groups, multiple sessions; capital/net P&L/P&L %/round trips/fees; execution time/side/qty/price/right/strike/commission/value |
| Charts | Prior context plus selected day, underlying/exact option tabs, All/CE/PE markers, EMA9/21, execution-price markers, maximize/restore |
| Labels | FIFO round trips, expected/actual category/strategy, entry/exit tags/custom values, save/reload, round-trip markers, selection/maximize, dirty-edit protection |
| Snapshots | Group-wide chronological events, wildcard search/keyboard navigation, underlying/CE/PE charts, captured orders/positions/wallet/P&L, confirmed delete-all and explicit failures |
| Comparison | Trades versus saved annotations, category/strategy filters, underlying/options, top patterns, label context, maximize |
| Stats | Overview/Entries/Exits/Sizing/Behavior, all existing filters, summaries/curve/drawdown/calendar/distributions/matrix/scatter/comparisons/behavior/insights; sorting/linked drill-down/pagination, fees/FIFO/R/labels, execution charts, explicit cached enrichment; all-page CSV |

### Interfaces and implementation decisions

Share workflows/dashboard/types/formatters/CSV in shared/analysis with injectable
AnalysisApi and AnalysisChartRenderer. Website keeps its transport and Lightweight
renderer; desktop uses bearer/native transport and KLineCharts. No duplicate FIFO
or metrics logic. Extend types for stored analytics/sort times/stable execution,
order/action identities/role quantities/exits/controller history/open/realized data.
No database migration or execution capture changes.

Authenticated /api/desktop/v1/analysis adapters expose sessions/detail/round-trips,
labels/metadata, snapshots/comparison, performance/cycles/detail and historical
candles through existing services. Verify owner for every session/cycle/label/
snapshot operation. Preserve validation/pagination, worker execution, real committed
execution checks and errors. Selected session loads canonical cycle membership once,
not one request per marker. Native command is restricted to analysis endpoints and
uses existing token refresh; browser preview uses the same bearer endpoints. Fence
obsolete account/server/query responses. Viewing never orders/reconciles/subscribes.

Dedicated full-size tab preserves active sessions/streams. Sessions / Stats retain
filters and selection. Collapsible 300px navigator resizes 240–480px, Trades / Labels
plus Snapshots / Compare actions, bounded scrollable tables and large charts.
Underlying left / exact option right, draggable 50/50 split; equity full width.
Below 1100px collapse navigator and switch chart pane. Maximize preserves viewport/
selection. Default last 30 dates through today, all modes/symbols/instruments/both
clients (Replay=sim). Preserve presentation state across switches, clear account data
on logout/server/account change. Lazy-load charts and dispose hidden analysis charts.
Existing popped-out trading windows stay trading windows.

Charts use three-minute candles, prior context plus full selected day, dedup/sort,
EMA9/21 and exact expiry/exchange/product. IST wall-clock and epoch alignment remain;
seconds-to-milliseconds conversion only at renderer boundary. Preserve replay history
provider/cache policies, bounded account/provider/contract/date cache, <=150 initial
visible candles, restored ranges and Fit all. Underlying option markers use recorded
underlying_price or identified approximate candle fallback, never as option fill.
Enrichment is explicit and cached-only, with sampled/unavailable provenance.

Locked non-draggable clickable overlays carry stable session/execution/cycle IDs.
Coincident executions show count and chronology chooser; different prices stay
separate. Linked table rows provide keyboard access. A 380px execution inspector
(drawer on narrow windows) offers Close/Open cycle; Escape closes inspector before
maximize. Selection survives layout, clears on owning group/contract change. Backend
FIFO roles handle SELL short entries, BUY covering exits and reversals with both
roles. Unresolvable snapshot IDs show captured evidence only, without guessed joins.

Inspector includes all captured evidence: side/role/contract/time seconds/qty/lots/
fill/value/fees/session/mode/client/IDs; original Market/Limit/Target/AS/ASL and actual
execution type; Capital%/Risk%/fixed qty/requested %/budget/qty/capital baseline/
reference price/initial sizing stop/source/lot/margin/effective allocation/risk/
overrun; confirmed exit controller and requested Half/Full versus actual allocation/
closed fraction; matched entries/FIFO gross/net/fees/capital%/R/open remainder and
separate cycle results; labels/expected-actual patterns/partial-fill action totals/
controller history; optional MFE/MAE/giveback/provider/resolution/coverage. Unknown
stays Unknown, zero is valid; requested/effective and fill/action values stay distinct.
Pending/refused conversion is not confirmed provenance. No settings/side/color
inference, double percentage conversion or psychological-intent claims.

### Follow-up sprints

| Sprint | Deliverable and acceptance gate | Status |
|---|---|---|
| 0 | Complete specification, inventory, sprint breakdown and acceptance | Complete |
| 1 | Shared contracts/API/native auth/canonical membership; ownership/parity tests | Complete — automated ownership, FIFO, real Decimal and failure checks passed |
| 2 | Shared views/dedicated tab/session filters/navigation/tables; workspace continuity | Complete — lazy tab, resizable navigator and trading continuity verified |
| 3 | KLine exact charts/EMA/split/maximize/history/viewport | Complete — exact-contract KLine charts, EMA, viewport/maximize and cleanup verified |
| 4 | Clickable/grouped markers and full evidence inspector across analysis views | Complete — readable inspector, canonical cycle links, keyboard and physical overlay hit testing verified |
| 5 | Labels/snapshots/comparison parity and cross-client persistence | Complete — save/discard/read-only, snapshot and comparison error/retry acceptance passed |
| 6 | Five shared Stats views/all filters/detail/enrichment/full CSV | Complete — five shared views, detail, cached enrichment and complete CSV traversal verified |
| 7 | Regression/browser/Windows acceptance/docs/reviewed PR to dev | Automated regression and browser acceptance passed; packaged Windows and PR review/merge remain manual |

### Test and delivery gates

Website/desktop identical fixtures must agree for FIFO/fees/reports/labels/CSV.
Cover 40+80 entry/60 exit, multiple/partial exits/open inventory, shorts/reversals,
interleaved/split/duplicate/equal-second fills, different sessions/expiries/products,
marketable LIMIT/AS/ASL, sizing overrun/missing capital/legacy evidence, controller
pending/refused/confirmed/manual changes and real revision conflicts. Verify ownership,
no per-marker fanout/no broker actions and IST alignment. Exercise all marker surfaces
(split/maximize/Labels/comparison/Stats/snapshots), overlaps/keyboard, dirty labels/save
errors, snapshot wildcard/delete failures, comparison filters, Stats paging/coverage/
enrichment and all-page CSV (incomplete export must fail explicitly).

Verify active Paper/Replay/Stepwise continuity, slow/obsolete responses/rapid filters,
reconnect/token expiry/logout/account changes, 150/Fit/restored viewport, repeat tab/
maximize cleanup, bounded caches and large lazy fixtures. Run backend focused/full
suite, desktop Vitest, website Node checks, both TS/builds and Rust tests. Keep
reproducible browser logs/screenshots, record durable results here and list existing
expiry/group_id failures separately. Packaged Windows acceptance covers scaling,
auth refresh/CSV/focus/resize/maximize/workspace return; unperformed checks stay
Pending. Update sprint implementation/validation after each sprint; earlier Phase 20
results do not establish acceptance of this follow-up.


### Desktop Analysis WIP checkpoint — 2026-10-06

Work paused at the user's request for an overnight checkpoint. All current changes,
including the original user-authored Analysis requirement, are saved on
`wip/phase20-desktop-analysis`, based on dev commit `584c3bb` (PR #601 merged).
This is an incomplete implementation, not a release or a completed sprint. No PR,
merge, main deployment or broker orders are part of this checkpoint.

Implemented foundations:
- Sprint 0: agreed specification, full website parity inventory and sprint gates.
- Existing Analysis, Labels, Snapshots, Comparison and Performance presentation
  extracted into `shared/analysis`; website component wrappers provide the existing
  API through an injected environment. Shared types expose stored analytics and
  execution-role evidence. Website TypeScript/build pass after extraction.
- Desktop-authenticated adapters in `backend/app/routers/desktop_analysis.py`
  reuse explicitly allowlisted website endpoints/response validation. Snapshot
  reads/deletes add session ownership checks. Selected-session detail loads existing
  FIFO cycles and canonical execution membership. Backend router import succeeds
  and registers 21 routes; accounting/ownership/parity tests still need to be added.
- Native restricted `desktop_analysis_request`, browser/native request adapter,
  bounded session/cycle memoization and basic stale-generation handling.
- Initial standalone KLine renderer, EMA9/21, history loading, exact option filters,
  grouped execution overlays/click callbacks, snapshot/comparison adapters and
  viewport retention. These modules are **not wired into App.tsx yet**.

Resume in this order:
1. Review/test desktop API signatures, date/history parameters, strict auth/ownership,
   real projection identity/role quantities and Decimal serialization. Preserve the
   dedicated desktop history worker/provider conventions. Test failures as errors,
   not empty reports. Improve request cancellation/account-generation fencing.
2. Add the lazy Workspace / Analysis tab, desktop provider and Sessions / Stats
   shell/navigation in `windowsapp/src/App.tsx`. Keep active trading hooks/streams
   mounted and supervised. Add desktop-scoped styles and responsive split layout.
3. Wire all KLine chart overrides, supply snapshot session/exact-contract identities,
   preserve viewport through maximize without disposal, and verify real marker
   hit testing. Review captured snapshot candle correctness and annotation ordering.
4. Implement the complete execution inspector and cycle links using stored evidence;
   retain stable physical execution IDs, reversals and role quantities, matched
   FIFO results and Unknown legacy handling. Add accessible linked table selection.
5. Finish Labels/Snapshots/Comparison desktop integration, dirty-label protection,
   explicit error/retry handling, then the five shared Stats views and CSV workflow.
6. Add focused ownership/accounting/marker/lifecycle/export tests and synthetic
   browser acceptance, then run the required regression/build/Rust checks. Record
   packaged Windows acceptance separately. Update sprint statuses from evidence.

Checkpoint verification: both website and desktop TypeScript checks pass; both
Vite production builds pass with existing bundle-size warnings; backend app/router
import passes; diff whitespace check passes. Desktop production build currently
validates the existing app, not runtime integration of the unwired analysis modules.
The first website build caught shared-source module resolution; explicit Vite
resolution was added and the rerun passed. No backend analysis unit/integration,
new feature browser or packaged Windows acceptance has been run at this checkpoint.
Existing desktop Vitest/native Rust checks are recorded separately below when done.

Existing desktop/client Vitest regression: **155 passed / 25 files**. These existing
tests do not establish coverage of the new desktop Analysis feature.

Native Rust offline check on Linux: **16 passed**, main target/doc tests passed.
This verifies compilation and existing native tests, not Windows packaging or new
analysis command acceptance. Checkpoint implementation commit: `37fbc51`.
Remote checkpoint: [wip/phase20-desktop-analysis](https://github.com/prattyush/TradeMatangi/tree/wip/phase20-desktop-analysis).
Resume from this branch; finish the pending integration/tests before creating a
reviewable delivery PR targeting dev.

## Website floating messages and error history — 2026-10-07

The user reported distracting chart movement when top-level order/broker/exit
protection/conversion banners appeared and disappeared during real trading.
Website messages now use a fixed floating stack rather than consuming chart layout
space. There is no backdrop, focus steal, sound or slide animation. At most three
flashes appear in the lower-right corner; errors/warnings dismiss after eight
seconds and informational/success messages after five. Users can dismiss them.
Actual guardrail interventions and order confirmation state retain their meaning.

A fixed message-history icon opens a nonmodal panel. Keep the latest 100 messages
per account/backend in this browser for seven days, including actual receipt time
(displayed in IST), severity/source, session/symbol/mode when available, repeated
occurrence counts and unread error/warning badge. Opening history does not stop or
resize charts. Support errors/warnings filtering, mark-read, confirmed clear, and
JSON download. Closing/expiring a flash does not delete its history. Reload restores
history without replaying flashes; logout/account/server changes isolate history.
Storage failures retain in-memory notification functionality.

Website API rejections, trading/local validation errors, recording errors, caught
chart rendering errors and uncaught browser errors/rejections enter the same
journal. Expected missing saved patterns/active-session lookups and aborted requests
are not errors. Duplicate API/panel reporting is suppressed; repeated identical
messages within 30 seconds update history counts without restarting dismissed
flashes. Request errors capture the originating session context and obsolete account
responses cannot populate another account's journal. Storage writes are batched
outside the user-action callback and flushed on page hide/account change.

Recovery needs-attention is a warning; pending/restored states are informational/
success. Broker conversions are informational while awaiting confirmation, warnings
when unknown or replacement is unconfirmed, errors when failed and success when
confirmed. The order row still identifies its pending conversion and keeps the last
broker-confirmed type. The notification change does not assume broker success or
change recovery, order routing or real trading behavior.

Broker recovery/conversion errors already have backend logs, including
`protection_recovery` and `broker_conversion`. Browser-only validation/network/
rendering errors are now retained in browser history; this is not a new server audit
log or cross-device history. No broker credentials or raw event payloads are added.

Validation: 37 website Node tests (including eight new journal tests), website
TypeScript/production build, and 155 existing desktop/client tests passed.
`scripts/website-notification-check.mjs` provides synthetic browser acceptance with
Playwright installed externally through PLAYWRIGHT_MODULE. It verifies three
severities, unchanged real chart geometry and instance on show/dismiss/expiry,
chart interaction, IST/context/history/download, reload without replay, account
isolation, narrow history layout, API error capture, expected 404 suppression and
late-account failure fencing, with no page errors. Artifacts are ignored in
`.cache/website-notification-validation/`. No backend code changes or live orders.
The existing production bundle-size warning remains. Backend/full-suite and live
broker acceptance are not claimed for this UI-only change.

Development on dev; deliver in a dedicated feature branch/PR targeting dev.
Review/merge and manual main deployment remain pending. Desktop Analysis work is
still preserved separately on `wip/phase20-desktop-analysis` and is not included.

Delivery: [PR #603](https://github.com/prattyush/TradeMatangi/pull/603),
`feature/website-floating-error-history` → `dev`, implementation commit `f624e6a`.
Review/merge and manual main deployment remain pending.

## Website emergency exits and manual real-day ban — 2026-10-07

### Agreed behavior

- **Exit all now** closes only the selected session's open contracts/positions,
  including CE/PE, older strikes/expiries, equity and shorts. It is a one-click
  urgent order action, not a fill guarantee. Use LIMIT SELL 3% below a fresh quote
  for longs, LIMIT BUY 3% above for shorts, tick-aligned independently of normal
  Market/Target gap settings. Keep normal quote/provider/contract identity rules.
- **Done for day** appears only in Real mode. After explicit confirmation, block
  new real entries while requesting exits for the user's real sessions for today.
  Cancel entry orders and strategies, preserve existing protection, use the same
  emergency exit path, and mark **done** only after coherent broker confirmation
  of flat positions and no pending orders. Aliases of a broker book exit once.
- The final ban is user-wide for the current IST calendar date. It persists across
  logout/reconnect/session restart/backend restart. There is no UI, settings,
  whitelist/admin action or API endpoint to clear it. A new IST date uses a new
  record. Paper, Replay and Stepwise remain unaffected.
- While closing, risk-reducing exits/protection can finish. After done, no new real
  order execution is allowed, including an old view whose position appears stale.
  The status is monotonic within a day: delayed HTTP responses cannot revert
  closing/done SSE status, and an old-day status cannot replace the new day.

### Implementation and failure behavior

`POST /api/trades/sessions/{session_id}/exit-all` is owned/session-scoped.
`POST /api/trades/sessions/{session_id}/done-for-day` requires an owned real session
and initiates the user-wide day closure. `GET /api/trades/real-day-status` reports
active/closing/done and resumes monitoring an unfinished closure after reattachment.
There is deliberately no unlock route or writeable day-state request parameter.

`emergency_exit` uses existing exact-contract positions and broker-confirmed
conversion workers. Convert/reprice existing closing orders first, retain their
coverage while confirmation is pending, and create only uncovered quantity. Re-read
positions/remaining fills before each additional chunk; respect freeze splitting,
short covers and duplicate-click fencing. Process contracts independently and report
partial failures. Existing uncertain conversions/acknowledgements do not justify
another full-position exit. Do not change realized positions/P&L before actual fills.

Real quotes must be fresh for the exact contract, including older strikes. Missing
quotes, mismatched coverage, unsupported products and broker errors are explicit
needs-attention results. A real submission is persisted before contacting Kotak;
SDK/transport uncertainty reserves its quantity and is excluded from local tick
execution. An explicit rejection is distinct from uncertainty. Tagged submissions
retain evidence for broker investigation; retry cannot blindly duplicate an unknown
exit. Existing MIS placement support is retained. Practice limits fill when their
supported engine next processes a matching price; paused/stepwise charts do not
invent an immediate execution.

The day state is stored separately from resettable session guardrails/settings in
`WalletLedgers`, keyed by user and `real-day-lock:<IST date>`, with conditional
active→closing→done progression. Closing is persisted before exit requests. Existing
entry/forwarding/strategy/start paths enforce the day barrier using server state,
not client booleans. Failures to verify the lock block new entries; protective
closures can continue during storage outage, while known done state rejects orders.
Normal settings edits, session override flags and permission changes do not clear
this record. No per-tick database polling is added for ordinary market data.

Day-completion monitoring does not call an acknowledgement a fill. It uses existing
broker orders/executions/positions reconciliation before committing done. Pending
orders, uncertain submissions, inconsistent reports or failed verification leave
closing/needs-attention, with new entries still blocked. No automatic duplicate
submission is used to force progress. No backend shutdown/revocation of shared
broker credentials is introduced. Broker trading outside this application is not
controlled by this user lock.

Both website actions use floating feedback/history. Labels distinguish requesting
exits, closing for day and done; charts remain in place. The day confirmation is an
explicit user action, and there is no unlock control. The desktop Flatten button and
its existing normal real-market gap behavior are unchanged.

### Validation and delivery

- Full backend: **1,721 passed / 2 documented baseline failures** (stale options
  expiry assertion and tab-restore fixture missing group_id).
- Focused existing execution/conversion/recovery/desktop plus initial new tests:
  **288 passed**. Final day/protection/strategy/emergency regressions: **115 passed**.
- Website accounting/history/journal checks plus four monotonic day-state tests:
  **41 passed**. Website and desktop TypeScript/production builds passed with their
  existing bundle-size warnings.
- Synthetic browser acceptance via `scripts/website-safety-check.mjs`: selected
  session endpoint only, Real-only day action, confirmation before submission,
  closing until completion, disabled done state, Paper/Stepwise unaffected, stable
  chart geometry and floating feedback, with no page errors.
- New backend coverage exercises aggressive long/short prices, partial protection
  plus uncovered remainder, repeated requests, exact old contract enumeration,
  per-contract failure isolation, real timeout versus rejection, ownership, day
  persistence/rollover, mode isolation, no premature completion on report failure,
  user-wide real-only scope, alias deduplication and protection during storage outage.

Artifacts/logs are ignored under `.cache/website-safety-validation/`. All broker
checks use mocks; no live broker orders were placed. Native/live broker acceptance
still requires authorized manual checks of exact-contract/freeze orders, pending
conversion, partial fills, unknown acknowledgements and day closure/restart.
Development is on dev; deliver in a dedicated reviewed PR targeting dev. Main merge
and deployment remain manual. Desktop Analysis WIP remains separate.

Delivery: [PR #605](https://github.com/prattyush/TradeMatangi/pull/605),
`feature/website-emergency-exit-day-ban` → `dev`, implementation commit `dbcfb53`.
Review/merge, authorized live acceptance and manual main deployment remain pending.

### Compact website chart entry ticket follow-up — PR #605

At the user's request, the website right-click Use as SL ticket now shows order
choices on the left and sizing on the right in one window, replacing the type→size
navigation and Back button. Reduce ticket and chart-context-menu text to 10px
(ticket heading 11px, hints 9px). Keep both columns visible while selecting.

Type-first and size-first are supported: submit when the second selection is made,
through the existing Market/Limit/Target/AS/ASL handler. Buy/Sell selection remains
available where configured; sizing choices wait for a direction. Capital/Risk is
local to this ticket, and switching it clears the prior size selection so a changed
preset cannot submit accidentally. Fixed quantity and saved percentage values retain
their existing units. Preserve clicked stop price, exact contract, minimum-lot hint,
Limit/Target price-pick behavior, outside-click/Escape and explicit close. The ticket
is fixed-position, measured/clamped within the viewport, and does not resize charts.

Validation: website TypeScript/build and 41 Node checks passed. Synthetic production
component acceptance in `scripts/website-entry-ticket-check.mjs` exercises left/right
layout/no Back, Market type-first Risk %, ASL size-first Risk %, AS Capital %, clearing
selection on mode switch, Sell fixed-quantity Limit, exact stop/contract preservation,
close and narrow viewport clamping without page errors. Artifacts are ignored under
`.cache/website-safety-validation/`. No broker orders or backend changes in this
follow-up. Included in the existing PR #605, not a separate delivery.

## Real analytics numeric-metadata repair — 2026-10-07

The user supplied a production trace where a successful broker snapshot publication
(193 orders / 148 trades) was followed by round-trip calculation failure in
`execution_analytics.filled`: float arithmetic multiplied a sequence-valued
`margin_rate`. The reproduced path is DynamoDB Decimal analytics loaded into an
Order's untyped analytics dictionary, then serialized with `model_dump(mode="json")`.
Pydantic serializes those Decimals as strings; the old broker snapshot encoder
persisted the strings, while the old metadata normalizer only handled Decimals.

Normalize numeric strings for known arithmetic fields (capital, margin, stop,
budget, percentages, quantities, controller/quote timestamps and related captured
numbers). Preserve numeric-looking IDs, labels, methods and contract text as strings.
Normalize before confirmed-controller history filtering as well as fill calculations,
including decimal-form timestamp strings. Future snapshot encoding restores numeric
analytics fields to DynamoDB numbers rather than persisting JSON numeric strings.
Both paths work with already-stored records, without a historical rewrite/migration.

Blank optional numeric evidence stays null. Invalid/nonfinite numeric strings raise
an explicit field-named data error rather than producing invented zero statistics.
Metadata inputs are copied, not mutated. This repair changes analytics serialization/
reading, not broker order placement, contract matching, fees, wallet quantities or
IST timestamp encoding. The quoted trace identifies the round-trip read failure;
it does not by itself establish a broker execution/protection failure.

Validation: **44 focused analytics/API tests passed**, including a database-backed
real individual-execution projection with stored numeric strings and decimal-form
controller timestamps. That fixture now produces its FIFO round trip, net P&L and
initial-risk R through `compute_round_trips_for_session`, the function in the user's
trace. **172 analytics/broker-snapshot/execution-gap/conversion/recovery regressions
passed**; existing dateutil warnings remain. Full-suite results and delivery follow
below. All broker paths in validation are synthetic/mocked, with ignored logs under
`.cache/analytics-numeric-metadata-validation/`; no live orders or deployment.

Final full backend validation: **1,728 passed / 2 existing baseline failures**
(stale options-expiry assertion and missing group_id in tab-restore fixture).
Development completed on dev; delivery is through a dedicated fix branch targeting
dev. Review/merge and manual backend deployment remain separate steps.

Delivery: [PR #607](https://github.com/prattyush/TradeMatangi/pull/607),
`fix/analytics-numeric-metadata` → `dev`, implementation commit `bcf25a7`.
Review/merge and manual backend deployment remain pending.



### Desktop Analysis resumed implementation — 2026-10-07

Resumed on the explicitly requested local `wip/phase20-desktop-analysis` branch.
Merged current dev `32c76ba` into WIP (merge commit `3f8ca8c`), retaining the shared
Analysis extraction and bringing across the website floating notifications,
emergency-exit/day barrier, and real analytics numeric-metadata repair. Website
shared views report errors through its floating journal; desktop retains explicit
inline errors. This remains an incomplete implementation checkpoint, not delivery.

Implemented and checked in this continuation:
- Analysis endpoints require a verified desktop bearer, without the legacy
  X-User-Id bypass. Adapt both user_id and _user_id signatures and retain source
  route dependencies, including historical request policy. Session-scoped reads
  and snapshot deletes enforce ownership before calling services.
- Data history adapters use the bounded desktop history executor while website
  history retains its existing executor. Legacy synchronous pattern OHLC work
  is offloaded from the event loop. Context/provider policy survives the worker.
- Canonical session detail retains exchange/product and physical execution IDs.
  Tests cover one physical reversal fill with separate entry/exit role quantities,
  and committed real projection detail with Decimal and legacy numeric-string
  sizing/controller evidence, FIFO net P&L and initial-risk R.
- Transport cancellation/generation fencing prevents late native/browser responses
  from succeeding after refresh/disposal/account changes. Failed cached reads retry;
  session search responses are fenced. StrictMode cleanup does not retire the
  immediately remounted transport.
- Lazy main-window Workspace / Analysis tab, shared Sessions and five Stats views,
  detail and CSV. Trading ScreenControllers remain mounted across tab switches;
  analysis chart adapters dispose while their view is hidden. Account/server/token
  changes replace the provider and logout removes account data. Popped-out screens
  remain trading windows. Desktop Sessions defaults to the last 30 IST dates.
- KLine adapters now cover Sessions, Labels, Snapshots, Comparison and Stats.
  Fix the zero-height internal candle pane with a definite containing block.
  Pass the actual snapshot session identity and stop guessing an option expiry
  from the selected snapshot chart. Annotation styles follow their own annotation.
- Initial 380px execution evidence inspector, grouped marker callbacks, accessible
  trade-table selection, Escape close and canonical Open cycle links. Reversals
  expose both FIFO roles; matching cannot cross sessions. The current inspector
  uses structured JSON evidence and still needs the planned readable presentation.

Validation of this checkpoint:
- **94 focused backend tests passed** (desktop adapters, Phase 20 accounting/API,
  and Phase 19 historical policy), including 13 new desktop boundary/worker tests.
- **163 desktop/client Vitest tests passed**, 27 files, including eight new
  transport/marker tests. **41 website Node checks passed**.
- Website and desktop TypeScript checks and production builds passed. Existing
  bundle-size and dateutil warnings remain.
- `scripts/desktop-analysis-check.mjs` exercises the built desktop app with
  synthetic/mock APIs: login, lazy Analysis tab, usable KLine candle pane,
  keyboard execution inspector/cycle link, five Stats views, CSV download,
  chart disposal/restoration, narrow viewport and logout isolation; no page errors
  or Analysis trading writes. It regenerates its fixture with PYTHON_BIN and uses
  externally supplied PLAYWRIGHT_MODULE/CHROME_BIN like the earlier browser checks.
- Logs, fixtures, screenshots and browser summary are ignored under
  `.cache/desktop-analysis-validation/`. Diff whitespace check passed.

Implementation gates outstanding at the initial `e89c20c` checkpoint (completed in the delivery continuation below):
1. Replace the reused modal/group layout with the specified resizable navigator,
   linked session selection, draggable underlying/option split and narrow-pane UX.
2. Present captured execution/sizing/controller/FIFO evidence as readable fields;
   clear selection on owning group/contract changes. Verify real marker hit testing,
   overlap chooser and physical IDs across every surface and snapshot provenance.
3. Preserve chart instance/viewport through maximize, review exact exchange/product
   selection and snapshot boundary candles/positions, and bound candle caching.
4. Finish dirty-label protection, explicit snapshot/comparison error/retry and full
   cross-client save/reload parity; shared legacy error swallowing remains to fix.
5. Validate Stats all-page CSV failures/paging/enrichment and account/query races,
   run active Paper/Replay/Stepwise continuity acceptance, then full backend/native
   regression and packaged Windows acceptance before a delivery PR targeting dev.

No delivery PR, main merge, deployment or live broker orders in this continuation.


### Desktop Analysis completion and real-history sharing — 2026-10-07

The initial WIP checkpoint is superseded by this completed implementation. Work
continued on `wip/phase20-desktop-analysis`; delivery uses a separate feature branch
and reviewed PR to dev. Main merge and deployment remain manual.

Desktop now has the dedicated lazy Workspace / Analysis tab and Sessions / Stats
navigation. Sessions provides mode/symbol/instrument/date filters, the last 30 IST
dates by default, refresh/error/retry/empty states, a collapsible 300px navigator
resizable from 240–480px, bounded execution/order tables and selected-session
content. Preserve filters, selection and label drafts across tab switches. Show
real sessions containing only pending/cancelled orders as well as filled sessions.
Use the existing saved historical-context setting, including zero context days.
Main navigation styles load with the workspace rather than waiting for lazy CSS.

Underlying / exact option charts use KLineCharts, EMA9/21 and separate expiry,
exchange and product identities. The split is draggable and keyboard adjustable;
narrow layouts switch panes. Maximize changes layout without disposing the chart.
Viewport restoration centres the saved timestamp correctly rather than using
KLine's right-edge timestamp anchor. Clear the old price series before loading a
different contract/date so stale candles cannot appear under a new identity. Hidden Analysis views dispose their charts,
while trading controllers, engines and streams stay mounted. Hidden workspace
charts do not consume drawing/refresh keyboard shortcuts. History and viewport
caches are bounded, scoped to the account and cleared on account/server changes;
failed/aborted requests are not memoized. Active authentication expiry returns to
sign-in, and cancelled late native replies cannot change another account's state.

Execution circles are locked and clickable; exact coincident fills and circles
that overlap geometrically on nearby bars offer a chronological chooser. Keep
physical execution IDs and owning sessions, both reversal roles and role quantities.
Accessible table selection opens the 380px inspector; Escape closes it before a
maximized view. Readable fields cover captured entry intent/execution type, sizing,
requested budgets/percentages/quantity, capital/reference/initial stop, effective
allocation/risk/overruns, confirmed exit method and Half/Full allocation, logical
fill/action totals, FIFO gross/net/fees/capital contribution/R/open inventory,
labels and controller history. Missing evidence remains Unknown; zero is retained.
Associated cycle results are shown separately and are not additive. Open cycle
provides the shared detail and explicit cached-only sampled excursion analysis.

Labels retains saved/custom values, expected/actual fields, tags and FIFO context.
Protect dirty edits when leaving a session or label view, prevent navigation while
saving, and retain drafts on failure. Saved labels invalidate cached reads and
refresh Stats. Metadata and round-trip storage failures now raise explicit errors
rather than successful empty reports; label/tag/pattern reads consume every page.
Comparison joins physical or stored execution IDs within the owning session and
retains both label contexts for a reversal; category/strategy filters and top
pattern annotations remain shared. Charts preserve their instances on maximize.

Snapshots retains chronological group events, wildcard search, keyboard navigation,
underlying/CE/PE panes and captured orders/positions/wallet/P&L. Include recordings
from broker-book aliases without counting their executions twice. Pass the actual
snapshot session; resolve captured fills only against unique physical evidence with
matching price and quantity, otherwise show captured-only/Unknown provenance.
Discard cached boundary/future bars and use captured OHLC when available; preserve
unknown observation resolution. New recordings retain exact expiry/broker IDs/fees
and available option observations, without rewriting legacy snapshots. Snapshot
reads paginate; delete-all requires confirmation, retries bounded unprocessed
batches and reports incomplete deletion. Capture/read/delete ownership is enforced.

Stats has Overview / Entries / Exits / Sizing / Behavior, existing filters and
sortable linked tables, summary/curve/drawdown/calendar/distributions/matrix/scatter,
coverage/small-sample badges, comparisons/insights, cycle detail and CSV. Export
traverses every page, validates total/membership/offset consistency and fails
explicitly without downloading partial data. Filter changes cancel stale exports.

#### Additional user requirement: share complete real history by email

Website Settings → sharing and Desktop Settings → History sharing allow an owner
to select up to 20 registered email addresses. Share all past and future real-mode
sessions: application orders plus committed broker report facts (including orders
without fills), individual executions, analytics, saved labels and recorded trading
snapshots. Recipients see these alongside their own practice history, with owner
identity and account/mode comparisons in Stats. Owner and recipient sessions cannot
merge merely because their dates/symbols/modes match.

Sharing grants read access only. Recipients cannot trade, change protection, edit
labels, create snapshots or delete the owner's snapshots. Paper/Replay/Stepwise
history, broker credentials, account settings and private patterns are not newly
shared. Existing Pattern Library sharing remains separate. Saved order evidence
uses an allowlist, keeps application-versus-broker facts distinct and exposes full
recorded fields through lazy expandable tables. No broker polling, reconciliation,
subscription or order request is performed by Analysis.

`GET/PUT /api/users/real-history-sharing` and the bearer-authenticated desktop
settings adapters persist grants on existing Users records, using an atomic
version-checked transaction and reverse source references. No additional table or
historical rewrite is needed. Check the owner's current grant on every server read;
reverse references alone cannot authorize access. Normalize/deduplicate email
addresses, reject unknown/self/ambiguous targets and preserve existing grants after
validation or write failures. Removing an email revokes further reads; already
loaded/downloaded copies cannot be recalled. Failed settings loads cannot submit
an empty replacement list. No emails/notifications are sent to recipients. Website
requests retain the existing website identity transport; desktop adapters require
verified bearer identity. Trading permissions and credentials remain unchanged.

#### Final validation and reproduction

All provider, broker and browser paths in validation use synthetic/mocked data.
DynamoDB Local is running for the existing full backend regression environment.

- Full backend regression: **1,758 passed / 2 documented baseline failures**.
  The failures remain the stale expiry fixture in `test_options_api.py` and the
  missing `group_id` fixture in `test_tab_restore.py`; no new failures.
- Final focused backend boundary/accounting regressions: **74 passed** after the
  final storage/worker refinements.
- Desktop/client Vitest: **171 passed**, 28 files. Website Node checks: **41 passed**.
- Website and desktop TypeScript checks and production builds passed. Existing
  bundle-size/dateutil/pytest-marker/pandas warnings remain.
- Native Rust offline tests on Linux: **16 passed**, main/doc targets passed.
- Built-app browser acceptance verifies login, lazy tab, Sessions/KLine, keyboard
  inspector/cycle links, five Stats views/CSV, chart disposal/restoration, narrow
  layout and logout isolation.
- StrictMode workflow acceptance verifies chart instance/viewport retention,
  actual underlying/option overlay hit testing and overlaps, dirty-label guards,
  save/reload and error/retry, snapshot chronology/wildcards/recorded boundary
  prices/delete failures, comparison failures, shared read-only views, real
  order-only sessions, all-page CSV failure/retry and desktop sharing settings.
- Paper / Replay / Stepwise continuity acceptance verifies that SSE and P&L update
  while Analysis is visible and existing trading chart instances survive return.
- Website settings acceptance verifies normalized emails, validation failures,
  revocation and incoming owner display. Cross-client backend tests verify atomic
  grant/revoke, non-transitive grants, real-only scope, complete sanitized order
  evidence, snapshot alias membership and rejection of unauthorized writes.

Reproduction scripts are `scripts/desktop-analysis-check.mjs`,
`scripts/desktop-analysis-workflows.mjs`, `scripts/desktop-analysis-continuity.mjs`
and `scripts/history-sharing-settings-check.mjs`. As with earlier checks, provide
external PLAYWRIGHT_MODULE and optional CHROME_BIN; fixture-generating scripts also
accept PYTHON_BIN. No runtime browser-test dependency was added. Durable test/build
logs, JSON summaries and screenshots are ignored under
`.cache/desktop-analysis-validation/`.

Packaged Windows acceptance (scale/focus/native auth refresh/download/resize) and
existing authorized live-broker acceptance remain manual and are not claimed by
Linux/browser tests. No live orders, credential changes, main merge or deployment.


Delivery: [draft PR #610](https://github.com/prattyush/TradeMatangi/pull/610),
`feature/desktop-analysis-history-sharing` → `dev`. Implementation commit
`fa1957e`; the local `wip/phase20-desktop-analysis` checkout is retained with the
completed code. PR review/merge, packaged Windows acceptance, authorized existing
live acceptance and manual main deployment remain pending.

### Follow-up in PR #610: website Replay and open-order splitting (2026-10-07)

The delivery branch remains `feature/desktop-analysis-history-sharing`, targeting
`dev` in the same draft PR. It contains the completed desktop Analysis, Stats,
snapshots and real-history sharing work above, plus these follow-up changes.

**Website NIFTY options Replay.** The notification API proxy wrapped the
synchronous `getSSEUrl()` helper in an async function. EventSource therefore
received a Promise instead of the stream URL, which explains the stationary
clock/charts despite active Pause/Stop controls. The facade now preserves the
synchronous URL, including user identity and replay cursor. A separate connection
fix always subscribes to the selected active member when its group refresh is
empty/stale/unavailable; attaching clears a different group's stale state and
late start responses cannot overwrite a newer selection. Dual options replay
loads underlying/CE/PE data, including strike reloads, in worker threads rather
than blocking the application's SSE event loop.

**Split pending orders on website and desktop.** A compact fork icon splits the
remaining quantity as evenly as possible in complete lots, retaining the larger
half on the original order. With a lot size of 20, 60 becomes 40 + 20; one lot
cannot be split. Entries, targets, limit exits and stoploss orders retain their
prices, exact contract, stop attachment, execution provenance and exit allocation.
Equities use whole shares. Existing wallet reservations are redistributed, with
no second debit; cancellation refunds only each sibling's share. Related order
records are committed atomically, including the desktop Paper ownership fence.
Stable operation IDs prevent duplicate submissions on request retries, including
retries after a later split. Both edit panels now use accessible, titled check
and cross icons for Save and Cancel.

For broker-backed intraday orders, the original quantity reduction must be
confirmed in a broker report before the child is submitted. Fills received during
acknowledgement remain authoritative. Durable uncertainty barriers block edits,
conversions and duplicate submission; a complete account refresh can adopt a
child by its persisted unique tag without importing a duplicate order. In-flight
splits and account refreshes cannot replace each other's order state. Failure
messages explicitly identify uncertain or incomplete splits; reconciliation does
not submit another order. Trading streams carry full sibling updates, including
removal of a retained order that filled during confirmation. Website snapshot
recording receives the successful split action.

Validation for this follow-up:

- Full backend: **1,794 passed**, with only the same two documented baseline
  fixture failures (`test_options_api.py`, `test_tab_restore.py`). Final focused
  split/replay/broker-confirmation checks: **58 passed**, including local DynamoDB
  atomic commit/conflict, Paper lease fencing, wallet refunds, partial/full fill
  races, lost acknowledgements, refresh adoption and retry idempotency.
- Desktop/client Vitest: **176 passed**, 29 files; website Node checks: **41 passed**.
  The new facade tests require a synchronous SSE URL while preserving asynchronous
  request behavior and selected-session/group subscription rules.
- Website and desktop TypeScript checks and production builds passed. Native
  Rust offline tests on Linux: **16 passed**.
- `scripts/replay-order-split-check.mjs` passed with actual website replay hooks,
  the real API facade and Lightweight Charts in StrictMode: advancing NIFTY
  underlying/CE/PE prices and candles, Pause/Resume/Stop, empty/stale/wrong/missing
  groups, both real order-panel components, 60 → 40/20, minimum-lot disabling,
  Save/Cancel icons and retained-price/quantity editing. Feeds/broker responses
  are synthetic; no live broker orders were submitted. Screenshot/JSON/build/test
  artifacts remain under `.cache/desktop-analysis-validation/`.

### Desktop clean-build correction: renderer ownership (2026-10-07)

The Windows installer CI failure was caused by compile-time coupling, not a
missing desktop chart feature: shared Analysis components still imported and
contained the website's Lightweight Charts fallback implementations even though
all desktop chart slots already used KLineCharts. The desktop TypeScript/Vite
aliases resolved those imports through `frontend/node_modules`, masking the
problem locally; Windows CI installs only desktop dependencies.

Website implementations now live in `frontend/src/components/analysis/` and are
registered by the website Analysis provider. Shared components contain only
renderer-neutral props and workflows, and require the host's supplied renderer.
Desktop retains its existing KLineCharts implementations for Sessions, Labels,
Stats details, snapshots and comparisons. Pattern marker calculation is shared
without chart-library types; only the website adapts markers to Lightweight
Charts timestamp types. The desktop cross-client aliases are removed. No desktop
package or lockfile dependency was added or changed. Windows build path triggers
now also include shared Analysis and the frontend services consumed by desktop.

Validation:

- An isolated source checkout passed desktop `npm ci` and `npm run build`, with
  neither `frontend/node_modules` nor desktop `lightweight-charts` installed.
  The desktop Analysis bundle excludes the website renderers (about 108 kB rather
  than 297 kB before this correction).
- Both TypeScript checks passed; website production build passed.
- Desktop Vitest: **176 passed**, 29 files; website Node checks: **41 passed**.
- Desktop StrictMode Analysis workflows and Paper/Replay/Stepwise continuity
  browser checks passed without a Lightweight Charts alias.
- Website Stats browser acceptance passed (five views, cycle detail, cached-price
  failure, CSV export, narrow layout and close). Its standalone browser harness
  now supplies the React resolver/automatic JSX used by the production build.
- `scripts/website-analysis-renderers-check.mjs` verifies all seven website chart
  slots in StrictMode: underlying, options, chart panel, both snapshot renderers,
  trade comparison and pattern comparison. All passed without page errors.
- `wip/phase20-desktop-analysis` is an ancestor of the delivery branch; there are
  no WIP commits missing from PR #610. Replay, order splitting, Stats, snapshots
  and real-history sharing remain included.

These are clean desktop frontend and browser checks; the packaged Windows
installer is validated by the existing Windows CI workflow, not by Linux tests.

### Compact desktop view switcher (2026-10-07)

Workspace and Analysis now share a compact, keyboard-accessible dropdown in
their existing toolbar. The separate 36-pixel navigation row is removed, giving
both views that height back. Analysis overlays/maximized charts now align below
its own 42-pixel toolbar. Popped-out screens keep their existing Workspace-only
controls, and active controllers remain mounted when changing views.

Validation: desktop TypeScript and production build passed. Built-app browser
acceptance verifies the toolbar starts at y=0 and the separate row is absent;
Analysis workflow and Paper/Replay/Stepwise continuity checks passed with dropdown
navigation, including chart retention, labels, snapshots, comparison and Stats.
