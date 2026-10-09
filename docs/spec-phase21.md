# Phase 21 — Desktop UI implementation

## Current delivery status — 2026-10-09

PR #619 merged to dev on 2026-10-08 (merge e1938ce). Main includes that delivery
through PR #620 (d42ca29). Earlier ready-for-review/manual-main-merge statements
below are historical checkpoints. A code merge does not establish the runtime
backend's deployment. The Replay market-fill correction was merged to dev through PR #621 (02f904f)
on 2026-10-09. Paper wallet serialization and reset-message follow-up is tracked
below; main merging/deployment remain manual.

## Agreed scope and defaults

Implement all five Desktop UI requirements below. Kite execution and desktop Real
trading remain deferred from this delivery, pending separate plans. Preserve the
original requirements. Develop on dev; delivery PR targets dev, with review before
merge. Main merge/deployment remain manual.

- Synchronize only the starting screen, including its popped-out owner window.
- Paper uses today IST/live time as on the website. Replay/Stepwise use the effective
  historical clock, including active-session/checkpoint decisions.
- Max Price scans ATM outward (CE higher, PE lower), first premium <= cap, within
  30 candidates. No successful ATM fallback and no future-price selection.
- Keep valid panes waiting for a late first tick. Remove confirmed invalid panes
  after successful initialization. Block with the original screen intact if all
  panes are invalid or preparation encounters transient provider failures.
- Order window: compact contract buttons, fixed selection independent of chart
  clicks, approximately 340px width, 10–11px labels and 12px input values.
- Market/Limit/Target/position Stoploss, Buy/Sell, fixed/Capital %/Risk % sizing,
  optional attached SL, explicit Submit. Strategies and order management stay outside.
- Existing-order parity: pending prices increment by **₹0.25**; only Stoploss
  quantities are editable, by full option lots or shares, bounded by exact-contract
  position/coverage. Direct valid finer prices remain accepted.

## Sprints and status

| Sprint | Deliverable | Status |
|---|---|---|
| 0 | Documentation reconciliation and regression baseline | Validated |
| 1 | Collapsible tools and connection dot (requirements 1/4) | Validated |
| 2 | Lot-aware existing-order editing (requirement 5) | Validated |
| 3 | Session preparation and premium search API | Validated |
| 4 | Picker and synchronized session start (requirement 3) | Validated |
| 5 | Compact movable order window (requirement 2) | Validated |
| 6 | Integrated acceptance, regression and PR delivery | Validated automatically; PR #619 published for review |

Progression: Planned → In progress → Implemented—validation pending → Validated.
Track PR merge, native Windows acceptance and deployment independently.

### Sprint 0 — Baseline and documentation

Reconcile Phase 20 against local merge history, retaining historical results and
distinguishing superseded WIP/delivery notes from outstanding manual gates.
Establish fresh regressions and baseline failures. Preserve Phase 20 controllers,
auth/window ownership, Analysis continuity, history/viewport behavior, contracts,
protection and order splitting. Update these documents with actual results each sprint.

### Sprint 1 — Compact tools/status

One persisted per-screen Draw / Indicators disclosure collapses drawing controls,
indicator selectors and Clear indicators without altering plotted state/charts.
Preserve position/orders/history/labels/strategies and drawing shortcuts. Provide
keyboard access/aria-expanded. Replace connection word with accessible green/amber/
red dot and hover/focus details; distinguish backend from broker-feed health.

### Sprint 2 — Existing order editing

Focused wheel/arrows increment by one lot/share and ₹0.25. Match website SL-only
quantity editing, show unit/lot/max hints, bound protection using the exact contract
and other pending exits. Preserve Save/Cancel and failed drafts; invalidate editing
on terminal orders and fence split/conversion uncertainty. Prevent duplicate native
wheel increments; unfocused wheel still scrolls the panel.

### Sprint 3 — Preparation boundary

Bearer-authenticated desktop preparation accepts mode/date/time and 1–5 panes;
returns normalized contracts, reference time, per-pane availability and reasons.
Creates no sessions/orders. Optional owned-session identity resolves active clocks
on the server. Preserve desktop history workers, policy/cache/cooldowns and observed
prices at/before reference time; exclude incomplete native minute candles. Validate
date-aware expiry, selected-day data (context alone does not count), rights, positive
caps and strikes. Explicit no-match/transient errors; capability advertisement and
backward-compatible optional fields. Replay start/sync support five panes. No new table.

### Sprint 4 — Picker and startup

Manual/Max Price selection shows strike/premium/reference time. Fix session date;
Paper uses live time. Preserve Browse/equity behavior. Persist mode/cap, re-resolve
on new start and never continuously switch strikes. Fence stale responses. Resolve
checkpoint/attach first, prepare screen, initialize trading/contract attachments and
chart streams, then commit dates/contracts/reduced layout. Preserve surviving IDs,
drawings/indicators; repair active/maximized selection and report removals. Retain
Replay partial/Stepwise completed bars. Pass selected seed strikes/expiry. On failure
restore the screen and clean up only owned resources; reconcile uncertain starts
before retrying and report incomplete cleanup. Other screens retain their sessions.

### Sprint 5 — Floating order window

Non-modal drag/clamp window, explicit Close/Escape, no chart shortcut leak. Compact
buttons deduplicate displayed contracts, show full identity and disambiguate expiry.
Non-tradable chart prompts selection. Contract change/disappearance clears sensitive
drafts; other symbols stay view-only under existing session model. Keep draft/position
across view changes; clear on account/server/session termination. Reuse authoritative
chart-order/manual-SL APIs, entry lots→units, Capital fraction/Risk percentage points,
Target limit preview and optional protection. Explicit Submit, duplicate-click fence,
uncertain-ack reconciliation before retry; retain window after success.

### Sprint 6 — Acceptance and delivery

Cover stepping/invalid input/partial fills/coverage/split-conversion barriers; CE/PE
cap equality/no match/future ticks/late observations/provider cooldowns/stale replies;
1–5 panes/all-part-invalid/context-only/holidays/expiry/checkpoint/attach clocks and
failed/uncertain start/cleanup; selection/removal/deduplication/sizing/SL/order retry;
independent screens/pop-out ownership/account isolation/reconnect/Analysis continuity;
dragging/small viewports/keyboard and Windows DPI. Focused then full backend with
DynamoDB Local, desktop Vitest, website Node, both checks/builds and Rust offline.
Clean desktop build without frontend dependencies; rerun Phase 20 history/order split/
Analysis/Paper-Replay-Stepwise continuity. Automated feeds/orders are synthetic.
Record dated results, commands, limitations, commit/PR and deployment status.

## Implementation and validation record

### Completed implementation — 2026-10-08

All five Desktop UI requirements are implemented. Phase 20 delivery notes now
reflect confirmed dev merges while retaining historical validation and unverified
manual/deployment gates. The Phase 21 plan and original requirements are retained.

Sprint 1: the screen save/recovery state persists tools_collapsed; disclosure does
not dispose charts. Status dot exposes backend/feed details through hover/focus.
Sprint 2: one input helper prevents double native wheel changes, steps focused
quantity by authoritative lots/shares, and pending prices by ₹0.25. Fractional
price inputs avoid a browser min/step-base offset; typed finer prices retain their
value when stepped by a quarter rupee. SL-only quantity
editing accounts for exact-contract remaining exits and fills; ordinary pending
entries keep price-only editing. Chart shortcuts ignore inactive panes and form input.
Sprint 3: POST /api/desktop/v1/trading/prepare-session requires a verified bearer,
uses the bounded history pool and date-aware metadata, returns availability/reasons
and captured reference time, and supports five panes. Both Live and Replay models
accept five. Active clocks normalize the engine's string timestamp correctly.
Sprint 4: initialization is staged, fenced by account/server and duplicate-click
state, and keeps the original screen after transient/all-invalid/stream-start failures.
Concurrent starts are serialized per matching session; created_for_request identifies
which request owns cleanup. Shared sessions cannot be stopped by a losing request.
Interrupted starts offer Recover charts or Stop/Detach session. Paper fields display
its actual today/live clock. Surviving IDs/layout state are preserved.
Sprint 5: the compact window stays non-modal, supports header dragging and resize
clamping, retains drafts across close/view changes, deduplicates contracts and clears
sensitive fields when selection changes/disappears. It reuses authoritative order
paths and fences uncertain acknowledgements, including after close/reopen.

Observation handling: premium selection recovers dropped observation masks from
exact provider parquets, rejects gap-filled/future observations and incomplete minute
candles, and blocks no-match/unknown-provenance/stale-provider results without deleting
charts. Legacy caches without observation evidence require manual strike selection.
Known leading option backfill is excluded from desktop history pages, Replay sources and execution
streams/quotes so a late first tick cannot become an early price or fill. Ordinary
legacy manual histories retain their previous semantics. Historical preparation can
download missing contracts, subject to existing provider pacing/cooldowns; search
is deliberately outside the execution path.

### Validation

| Check | Result |
|---|---|
| Full backend with DynamoDB Local | **1,878 passed / 2 documented baseline fixture failures** |
| Final focused preparation/trading/replay/simulation/API/provider checks | **255 passed** |
| Desktop/client Vitest | **182 passed**, 31 files |
| Website Node regressions | **41 passed** |
| Website and desktop TypeScript / Vite builds | Passed |
| Isolated desktop npm ci/build, without frontend/node_modules | Passed |
| Native Rust offline tests on Linux | **16 passed**, main/doc targets passed |
| Built-app Phase 21 browser workflows | Stepwise, Replay, Paper and five-pane Stepwise passed |
| Phase 20 Analysis workflow and mode continuity acceptance | Passed |
| Phase 20 actual chart history/viewport acceptance | Passed |
| Website Replay and both pending-order panel split acceptance | Passed |

The backend failures remain test_options_api.py::TestOptionsSimulationStart::
test_options_session_started_successfully (stale expiry fixture) and
test_tab_restore.py::test_active_session_returns_attach_metadata (missing group_id).
No new failures. Existing bundle-size/dateutil/pytest-marker/pandas warnings remain.
Browser checks use synthetic APIs, source prices and mocked orders. No live orders
or credential changes were performed. Logs/screenshots/JSON are ignored under
.cache/phase21-validation/; previous harnesses also write their existing artifact folders.

Reproduction: USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1 with the project venv's
python -m pytest backend/tests/ -q; npm test / npm run build in windowsapp;
node --test src/*.test.mjs src/services/*.test.mjs and npm run build in frontend;
cargo test --offline --manifest-path windowsapp/src-tauri/Cargo.toml.
Browser scripts use external PLAYWRIGHT_MODULE and CHROME_BIN (and PYTHON_BIN where
fixtures are generated): scripts/phase21-desktop-check.mjs,
scripts/desktop-analysis-workflows.mjs, scripts/desktop-analysis-continuity.mjs,
scripts/phase20-chart-check.mjs and scripts/replay-order-split-check.mjs.
The Phase 21 harness checks provider/all-invalid preservation, failed-start cleanup,
concurrent-start ownership/recovery, chart retention, non-modal contract selection,
order payload units, quarter-price/lot wheel-key edits, premium selection, dragging,
small viewport clamping and uncertainty fencing with zero page errors.

### Remaining acceptance and delivery

Packaged Windows installer CI was triggered by the delivery branch; its status is separate
from manual interaction acceptance. Packaged Windows DPI/focus/native auth refresh/pop-out/drag/wheel acceptance remains
manual; Linux/browser results do not establish native Windows acceptance. Kite execution
and desktop Real execution remain deferred. Delivery: [PR #619](https://github.com/prattyush/TradeMatangi/pull/619),
feature/phase21-desktop-ui → dev, implementation commit 4e60617. PR review/merge
and manual main deployment remain pending. No automatic main merge or deployment is included.

### NIFTY premium preset follow-up — 2026-10-08

At the user's request, the first NIFTY Max Price preset is ₹30 instead of ₹25;
higher presets remain ₹50/75/100/125/150. Shared preset definitions keep website
SessionControls (Paper/Real/Replay/Stepwise), Settings, Fine Structures and desktop
Paper/Replay/Stepwise symbol pickers consistent. Desktop displays small preset
buttons alongside its custom input. Sensex and other-symbol presets are preserved.

Existing saved/custom caps are not silently increased: website dropdowns show a
non-preset value explicitly as saved; desktop retains its numeric input. The saved
₹50 default is unchanged. No account migration, broker order or live test is involved.
Both client TypeScript/production builds and synthetic website four-mode acceptance
passed, including retained saved ₹25 and selecting/saving ₹30 for CE/PE. The desktop
workflow harness checks NIFTY buttons and selection across its three modes and five
panes. The isolated desktop build also includes the new shared helper without website
dependencies. Windows CI now watches all shared source so future preset edits trigger it.

PR #619 is published as ready for review at the user's explicit request. Windows
installer CI passed for head 0b474a2; new preset changes trigger a subsequent run.
Packaged native interaction acceptance, review/merge and main deployment remain manual.

### Desktop Replay Market fill correction — 2026-10-09

Reported: Order popup → Market creates a pending Buy LIMIT line without a fill.
Six synthetic reproductions failed against merged dev: paused Replay/Stepwise CE/PE
Market entries, plus additional-contract entry/Stoploss execution on the replay clock.
The old handler only performed the immediate Market check for Paper. Additional
registered option strikes were also omitted from the options replay fill path.

Market entries now reuse the authoritative exact-contract quote and existing fill,
wallet, trade, protection and SSE pipeline in Replay/Stepwise as well as Paper.
Historical execution uses the current session clock while preserving the quote's
observation timestamp, so paused sessions fill without Next Bar and clocks do not
rewind. Only the submitted order is checked immediately; other pending entries and
exits retain their normal price-trigger behavior. Ended sessions and invalid/future
quotes are rejected before creating an order. Broker-confirmed Real execution is
unchanged and cannot be filled by this local check.

The underlying replay clock now evaluates additional attached contracts from their
own cached ticks, including their limits, targets and protective stops. Primary
contracts are excluded from this auxiliary route so normal streams do not duplicate
fills. Equity-hosted option attachments retain their existing path. A single-contract
replay keeps its original source strike/expiry when another chart changes CE/PE
convenience selection, and evaluates secondary contracts at the same clock time.
Existing cached ticks and leading-observation guards are reused; no provider polling,
new public API or schema migration is introduced.

Regression coverage adds 17 cases: BUY/SELL, CE/PE, paused Replay/Stepwise, exact
position/stop/SSE evidence, unrelated pending-order isolation, older observation
versus execution time, additional-contract entry/exit, primary-stream isolation,
single-contract source identity, invalid/future quotes, ended-session rejection and
request-only fill isolation from the shared group clock.
The initial six failures now pass. Full backend regression: **1,895 passed / two
existing baseline fixture failures**, unchanged stale options expiry and missing
tab-restore group_id assertions. Final focused desktop trading/preparation/replay/
simulation/orders/entry-SL/sizing checks: **264 passed**. Desktop Vitest: **182 passed**.
All provider/execution inputs are mocked/synthetic; no live broker orders were sent.
Artifacts are ignored under .cache/desktop-replay-market-fix/.

Reproduce with USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1 and the project venv's
python -m pytest backend/tests/ -q; focused files are test_desktop_trading.py,
test_desktop_preparation.py, test_desktop_replay_events.py, test_simulation.py,
test_orders_api.py, test_replay_entry_stoploss.py and test_sprint2_funds_ratio_stoploss.py.
Desktop checks use npm test in windowsapp. Delivery branch:
[PR #621](https://github.com/prattyush/TradeMatangi/pull/621),
fix/desktop-replay-market-fill → dev, implementation commit 6976795 plus the shared
clock guard follow-up. Ready for review; merge and backend deployment remain pending.
Main merging/deployment stay manual.

This is backend-only: the existing desktop installer can use the correction after
backend deployment. No live broker orders or main deployment are performed by this fix.

### Paper wallet serialization and reset messages — 2026-10-09

The user reported a desktop Paper Market order failing with HTTP 503: "Paper wallet
storage unavailable; retry without changing the operation identity". Two database-
backed reproductions produced the identical detail, with underlying boto3 TypeError:
"Float types are not supported. Use Decimal types instead." Paper reserve+order
transactions serialized only top-level floats from model JSON; nested Phase 20
analytics/controller numbers remained floats, while existing Decimals became strings.
The failure occurred before submitting the transaction, not because of funds or a
broker rejection.

Paper movements now use the same canonical order database item as ordinary writes.
Transaction/fenced writers apply the existing recursive DynamoDB encoding so nested
numbers remain numbers; strings/IDs, booleans, zero and Unknown/null are preserved.
Atomic order+wallet commits, operation receipts, spending limits and engine/cleanup
ownership fences remain unchanged. Underlying exceptions are logged without dumping
wallet/order payloads; genuine storage failures still fail closed with the existing
503 and require the same operation identity for retry.

The user also clarified website wallet reset happened AFTER starting/stopping Paper,
whereas desktop reset was BEFORE starting Paper. Those timings explain the result:
Paper funds are shared by user/date and remain locked after the first session starts,
even after Stop. The website now preserves the backend error detail instead of
"Wallet reset failed: 409"/"Reset failed", explains the lock rule, disables in-flight
and repeated locked-date resets, and fences late replies when the selected date
changes. No wallet-lock policy or post-start reset bypass is introduced.

Validation: **1,904 backend tests passed / two existing fixture failures** (stale
options expiry and missing tab-restore group_id). **223 focused checks passed**.
Nine new database-backed regressions cover nested analytics/Decimal/list encoding,
atomic reserve retries, ownership fencing, lost acknowledgement with exactly one
debit, and actual desktop Paper CE/PE Market fills with fixed/Capital %/Risk % sizing,
persisted trades/positions/protection and reserve-receipt replay. **182 desktop Vitest**
and **41 website Node checks passed**; both client TypeScript/production builds passed.
Actual website Settings browser acceptance verifies reason display, repeat blocking,
date change, success callback and zero page errors. All orders/providers are synthetic.

Artifacts: .cache/desktop-paper-wallet-fix/. Reproduce backend checks with
USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1 and the project venv's pytest backend/tests/;
focused files: test_phase18_paper_wallet.py, test_desktop_paper_recovery.py,
test_desktop_paper_eod.py, test_desktop_trading.py, test_orders_api.py and
test_replay_entry_stoploss.py. Both clients use their existing checks; browser script
scripts/wallet-settings-check.mjs uses external PLAYWRIGHT_MODULE/CHROME_BIN.

PR #621 was already merged when the user requested adding this correction to it.
Delivery is the linked [PR #623](https://github.com/prattyush/TradeMatangi/pull/623),
fix/paper-wallet-order-serialization → dev, implementation commit 9135f45.
Review/merge remain pending. Deployment requires the updated backend
and website; the desktop Market correction does not require a new desktop installer.
No live broker order, wallet reset on the user's account, main merge or deployment.

## Original requirements

## Improvements

### Desktop UI
1) An UI option to roll up draw and indicators. A button when clicked will hide the draw and indicator. This is to create space for open orders, orders and others, during a replay or paper trading session. As draw and indicators take up space, so one button to click to that these draw options and indicators don't take space vertically.
2) An order panel like present in website, but only visible as a popup, with same options as well, specifically, stoploss and limit, market and target. The same panel which is present in website in the right. No need for strategies. Further, this popup should be navigable. I mean I am move it, and I can click on chart and see everthing, the popup remains, more like a window. It should not blur out the backgroud. Similar to what we have in Kite Website. Make it innovative UI not the website UI like target and limit. No need to support chart click like website.
3) Also, when starting a session of stepwise, replay and paper, user can choose options in the search window, with a max price option, if selected, then automatically that option strike price is choosen. When any session is started stepwise, replay or paper, all charts would switch to that date and time. If any chart currently on screen doesn't have data on that date ,or is invalid, like options already expired or too many weeks away, those charts would auto close and number of panes reduced. When user opens the search symbol sign, then date is fixed, and when options selected, user can choose strike prices or max price and the system auto finds the respective strike price for CE or PE within that price at that current running time for that date. For equity it will same as today.
4) Remove the word "connected" on the right hand side with just Green (When connected) to Red (Offline), other color during connection, On mouse hover you can display more info.
5) One other requirement in the edit options, which are present in the left panel, where I can change the quantity of already present orders. If you check in website, the similar option respects the option lot sizes, which are currently not respected in the left panel in desktop. That is with respect to scrolling. So if I scroll, the lot prices should change. Just look over into the website, edit options and how they're handled for options, or price change and quantity change, and try to duplicate that during edit options in left panel in desktop.

### Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation.

### Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.






