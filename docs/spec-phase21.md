# Phase 21 — Desktop UI implementation

## Current delivery status — 2026-10-09

PR #619 merged to dev on 2026-10-08 (merge e1938ce). Main includes that delivery
through PR #620 (d42ca29). Earlier ready-for-review/manual-main-merge statements
below are historical checkpoints. A code merge does not establish the runtime
backend's deployment. The Replay market-fill correction was merged to dev through PR #621 (02f904f)
on 2026-10-09. Paper wallet serialization and reset-message follow-up merged to dev through
PR #623 (0595055) on 2026-10-09. The dated-wallet and empty stopped Paper resume
follow-up below is implemented and validated; [PR #625](https://github.com/prattyush/TradeMatangi/pull/625)
merged to dev (a227b87). The website request-blocking fix
[PR #627](https://github.com/prattyush/TradeMatangi/pull/627) merged to dev (a1f2765);
main includes it through PR #628 (d52c863). Full checks and the comprehensive
review below are complete. The reviewed cache correction and test/documentation delivery target main;
main merging and deployment remain manual.

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
| 6 | Integrated acceptance, regression and PR delivery | Validated; PR #619 merged to dev |

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

Historical policy at PR #623 (superseded by the dated-wallet follow-up below):
the user clarified website wallet reset happened AFTER starting/stopping Paper,
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
PR #623 merged to dev on 2026-10-09 (0595055). Deployment requires the updated backend
and website; the desktop Market correction does not require a new desktop installer.
No live broker order, wallet reset on the user's account, main merge or deployment.

### Dated practice wallets, Paper resume and popup stoploss — 2026-10-09

**Status: implemented and validated; [PR #625](https://github.com/prattyush/TradeMatangi/pull/625) published for review → dev.** This
follow-up replaces the permanent first-start Paper lock described above. The five
original Phase 21 sprints remain complete.

Agreed behavior:

- Paper uses `paper:<date>`; Replay and Stepwise share `sim:<date>`, both scoped
  by user. Real remains separate. Website and desktop use the same respective
  dated records in the existing `WalletLedgers` table.
- Existing dated balance wins. A missing date carries forward only the previous
  balance of the same wallet kind, otherwise ₹1,50,000. Generic `Wallet` and Real
  values do not seed practice funds. Carry-forward uses actual cash flows; realized
  P&L is not added twice.
- A positive explicit reset persists for that date and becomes the starting
  balance of subsequent starts **and resumes**. Saved trades/positions and their
  history remain. This is the latest agreed resume rule.
- Reset is allowed after Stop completes. Matching active/starting sessions,
  pending refunds and Paper cleanup/settlement block it across clients/workers.
  Reset/start races fail with a retryable conflict rather than using old funds.
- Website idle today IST displays Paper from DB; selecting a historical date
  displays Replay/Stepwise from DB. An active session displays its own wallet,
  including the separate broker-backed Real snapshot. Settings displays the
  selected date/kind and rechecks eligibility on reopen or session-state change.
  Desktop Wallet also rechecks status and allows resets while a completed stopped
  session remains visible; it no longer presents the permanent first-start lock.
- An empty stopped desktop Paper run resumes its saved identity directly, without
  an erase/resume confirmation. Preparation accepts the owned persisted record
  after Stop removed it from memory. Runs with history retain the explicit resume
  decision. Same-day/before-15:09 IST and completed-cleanup limits still apply.

| Follow-up sprint | Deliverable | Status |
|---|---|---|
| W1 | Isolated dated storage, same-kind carry-forward, reset eligibility and startup conflict checks | Validated |
| W2 | Website DB balance/date selection, client reset/status, desktop Paper preparation/resume and popup stoploss | Validated |
| W3 | Corner cases, regressions, documentation and delivery PR | Validated; PR #625 published for review |

The reported empty Paper restart failure is specific to desktop preparation.
Website browser checks verify both existing-session Yes/No choices start successfully
with no trades, and DB-backed website start checks preserve the saved Paper identity
and use the updated dated balance with either override choice. No website restart
code change was needed.

The user also reported desktop Replay popup Stoploss returning 422 after a CE Market
buy. Its shared `PlaceOrderRequest` requires `session_id` in the JSON body even
though the desktop path contains it. Popup Stoploss now sends the bound session ID;
the backend still takes authority from the owned path session. A real HTTP regression
places a pending 65-quantity CE Stoploss after a filled Replay Market buy; browser
checks reject missing-body session IDs and verify the exact sell/contract payload
across Replay, Stepwise and Paper.

Corner cases covered: first date without a wallet, existing dates versus later
changes to prior dates, same-kind carry-forward through paginated operation receipts,
Paper cash-flow P&L, cross-client active/starting runs, paused Stepwise, pending
refunds, incomplete Stop, expiry of startup tokens, concurrent reset/start, storage
failure without a confirmed update, cache refresh, dated isolation from Real/legacy,
empty stopped Paper with no orders/trades and owner-only preparation/resume.
Replay erase/restart recalculation uses its dated reset baseline and includes only
runs created after that reset; older evidence stays intact and is not recharged.
Legacy Replay roots without baseline metadata use same-kind prior/default funds
for erase/recalculation, never generic/Real balances. No new table or wallet version
history is introduced.

Validation:

- Full backend regression: **1,920 passed / two established fixture failures**:
  `test_options_session_started_successfully` (stale expiry) and
  `test_active_session_returns_attach_metadata` (missing group_id).
- **267 focused backend checks passed**, including all **16 new dated-wallet
  cases**, website zero-trade restart for both override choices and the Replay
  Market-buy → Stoploss HTTP regression. The final erase/recalculation versus
  reset conflict guard and regression were verified by this focused run after
  the full-suite run.
- **182 desktop Vitest / 41 website Node checks passed**. Both clients' TypeScript
  and production builds passed.
- Website browser acceptance passed: active-reset 409 detail/repeat guard, completed
  Stop unlock on the same date, saved balance refresh, historical selection and
  isolated resets. Desktop browser acceptance passed across Stepwise, Replay,
  Paper, five-pane Stepwise and empty stopped Paper, with no page errors. The
  empty-run scenario verifies preparation with saved session ID, actual resume
  request, no confirmation and no replacement start request. Desktop acceptance
  also verifies a wallet reset with a stopped session visible before resuming.
  Website empty Paper restart acceptance passed for both Yes/No choices.

Artifacts: `.cache/dated-wallets-validation/`. Reproduce with the project venv's
pytest (full suite uses `USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1`), desktop
`npm run test`, both clients' `npm run build`, website `node --test
frontend/src/*.test.mjs frontend/src/services/*.test.mjs`, and browser scripts
`scripts/wallet-settings-check.mjs`, `scripts/phase21-desktop-check.mjs` and
`scripts/website-paper-restart-check.mjs` with
external `PLAYWRIGHT_MODULE` and optional `CHROME_BIN`.

Delivery: [PR #625](https://github.com/prattyush/TradeMatangi/pull/625),
`fix/dated-practice-wallets-and-desktop-restart` → `dev`, implementation commit
`74e097a`. Review/dev merge remain pending.

Delivery requires the updated backend, website and a rebuilt desktop client.
Native packaged Windows acceptance remains manual. Main merge/deployment remain
manual after review. Tests use local/synthetic records and providers.

### Website wallet stalls and simple reset rule — 2026-10-09

**Status: implemented and merged to dev through [PR #627](https://github.com/prattyush/TradeMatangi/pull/627)
(a1f2765), included in main through PR #628. The earlier deferred-testing checkpoint
is superseded by the full verification below.**
PR #625 merged to dev (a227b87). Its synchronous wallet storage/eligibility work
inside async request handlers could block the backend worker, delaying candles,
Settings and sign-in. Settings disables its form while settings requests load,
which explained why all inputs appeared uneditable. Two reproductions failed
before the change with slow wallet read/status work blocking unrelated requests.
The user's restart/retry and eventual success after minutes support a slow request;
the exact deployed database delay was not measured.

Latest user rule supersedes the previous pending-refund/history eligibility policy:

- An on session uses its own wallet. When none is on, show the dated DB balance.
- Any on session for the user blocks reset. Otherwise reset is allowed. Paused
  sessions count as on; stopped session history does not add a reset restriction.
- No historical Sessions/Orders table scans for balance or reset eligibility.
  Eligibility uses current runtime session state. Existing atomic Paper ownership
  and startup conflict fences remain; expired/stopped claim history and cleanup
  metadata do not permanently lock resets.
- Wallet DB reads/status/reset work runs in background threads. Normal balance
  loading does not request reset eligibility; Settings requests it explicitly.
  Google verification also runs off the main request loop.

Always-on request diagnostics now record method/path/request ID at request start,
slow pending requests, response status/duration, cancellation and exceptions.
Background wallet work carries the request ID and logs table operation timings.
These records use the existing `backend.log` handler. Browser network errors now
identify method and endpoint instead of only “Failed to fetch”; requests that never
reach the backend necessarily have only browser/network evidence. Credentials,
query values and request bodies are not recorded.

`AGENTS.md` now explicitly says to keep simple changes simple, prefer existing
state/direct checks, avoid unnecessary historical scans/infrastructure/restrictions,
and defer broad testing when the user requests immediate testing.

Validation: **45 focused backend checks passed** for the final simple-rule change;
**79 broader focused checks passed** before that final simplification, covering
Google sign-in during wallet delay, auth, dated funds, request logging and Real
wallet separation. **43 website Node tests**, both final client builds and **14 final
request/concurrency/logging checks** passed.
Full website acceptance uses the actual App/chart components: candles render and
Settings custom amount is editable while the wallet request is pending, reset
submits the entered amount, and candles return after page refresh. Wallet Settings
and website Paper restart acceptance also passed. An earlier full regression
(before the final simple-rule change) had **1,934 passes and the same two baseline
fixture failures**; it is not a full-suite validation of the final simplification.
Artifacts: `.cache/wallet-chart-startup-fix/`.

Deploy/restart the updated backend and publish the rebuilt website to apply this
fix. Deployment remains manual; full automated verification is now recorded below.
Packaged Windows acceptance remains manual.

### Full verification and comprehensive review after PR #627 — 2026-10-09

**Status: final full automated checks passed; comprehensive review complete.
Delivery: [PR #629](https://github.com/prattyush/TradeMatangi/pull/629), dev → main;
review/main merge remain pending.** Runtime code was reviewed at dev merge a1f2765. The review found and
fixed one stale-read cache race; this follow-up also adds regression tests and
corrects stale fixtures.

| Check | Final result |
|---|---|
| Full backend suite with DynamoDB Local | **1,949 passed**, no failures (19 existing warnings) |
| Full AI helper suite | **303 passed**, no failures |
| Desktop Vitest | **182 passed** across 31 files |
| Website Node tests | **43 passed**, no failures |
| Website and desktop TypeScript/production builds | Passed |
| Full website startup/candle/Settings browser acceptance | Passed |
| Website dated-wallet Settings browser acceptance | Passed |
| Website empty Paper restart browser acceptance | Passed for both existing-session choices |
| Desktop Phase 21 browser acceptance | Passed: Replay, Stepwise, Paper, five-pane layout and empty stopped Paper |

The initial backend run had 1,935 passes and the two previously recorded fixture
failures. The options-start fixture now requests the correct NIFTY weekly expiry
for its historical date instead of asserting a stale later expiry. The tab-restore
fixture now includes the session group/alias/ledger metadata used by the response.
No assertions were removed and no tests were skipped. AI helper's initial three
failures were stale string-based mock targets after other suites reloaded modules;
patching the dependencies actually bound to its test routers makes the complete
suite deterministic. Funds-ratio reads in that test harness are explicitly mocked.

Added **12 wallet cases** beyond the previous suite: running/paused checks across
Paper, Replay, Stepwise and Real, another user's active session not blocking this
user's reset, and active Paper/Replay/Stepwise wallet/date/ownership overriding an
idle picker date, plus a delayed balance read interleaved with a Replay order debit.
The focused fixture/wallet run passed **50 checks** before the initial full backend
run. The final cache-race/dated/Paper/Real wallet checks passed **87 tests**; the full
backend rerun including that correction passed **1,949 tests**. The preceding full
run before the cache correction had 1,948 passes.

Comprehensive review outcome:

- Paper and Replay/Stepwise retain separate per-user dated records; Real accounting
  remains separate. Missing-date carry-forward stays within its kind; existing
  dates and explicit resets win. Receipts are excluded from carry-forward, and
  realized P&L is not added twice.
- Active session requests use the owned session's date/wallet; foreign-user access
  returns 404. Runtime running/paused sessions block reset, regardless of mode/date.
  Stopped historical records and pending historical orders add no reset restriction.
  Eligibility does not scan Sessions/Orders history. The configured backend uses
  one worker (`scripts/start-backend-ec2.sh --workers 1`), matching the runtime
  session-state check. Existing Paper ownership/startup conflict fences remain.
- A concrete delayed-read regression initially failed: after a ₹6,500 order debit
  reduced ₹1,50,000 to ₹1,43,500, a prior viewer read restored the live Replay cache
  to ₹1,50,000. Balance reads now leave trading caches unchanged. Explicit startup,
  resets and trading cash flows retain their existing cache updates. This is one
  removed side effect, with no new infrastructure or eligibility restrictions.
- Wallet reads/checks/resets and Google verification run off the main request loop.
  Balance displays skip reset eligibility. Slow-storage concurrency tests prove
  other requests and Google sign-in complete while wallet work waits. The actual
  full website renders candle pixels, accepts a custom Settings amount and restores
  candles on page refresh while wallet responses are pending.
- Desktop empty stopped Paper resumes the saved identity without a redundant
  confirmation; preparation accepts the owned persisted session. Completed stopped
  history no longer prevents the Wallet popup reset. Reset funds are used on resume,
  with existing same-date/market-time guards and trading history retained.
- Desktop Replay Market execution and exact-contract quote routing, CE/PE option
  lot sizing, pending-order edit increments and protective Stoploss submission are
  covered by backend and browser checks. Popup Stoploss includes the required
  session ID; the owned path session remains authoritative. No duplicate replacement
  session is started for empty Paper recovery.
- Request diagnostics record start/pending/status/duration/failure and correlate
  background wallet work with a request ID. Browser network errors identify method
  and endpoint. Abort identity, HTTP response handling and streaming behavior stay
  compatible; credentials, query values and request bodies are not logged.

The stale-read cache write above was the only additional runtime correction from
this review. Automated checks use local/synthetic providers and records. The user's live website/account testing,
packaged Windows installer acceptance and production deployment remain separate;
these results do not claim real broker execution or installer validation.

Artifacts: `.cache/post627-validation/` (full backend/AI helper/client logs and
browser summaries; browser scripts also write screenshots to their configured
artifact directories). Reproduce with the project venv pytest for `backend/tests`
(`USE_DYNAMODB_LOCAL=true AWS_MAX_ATTEMPTS=1`) and `aihelper/tests`, desktop
`npm run test`, both client `npm run build` commands, website Node tests and the
four browser scripts recorded above. Main merging/deployment remain manual.

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






