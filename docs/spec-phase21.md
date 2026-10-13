# Phase 21 — Desktop UI implementation

## Desktop toolbar scrollbar correction — 2026-10-12

The main/preprod integration is merged in [PR #653](https://github.com/prattyush/TradeMatangi/pull/653)
(preprod `0c82a7d`). Its Windows installer build is allowed to finish independently.

The toolbar's invisible absolute tooltip pseudo-elements enlarged its scrollable
width/height even when the controls fit. Remove those pseudo-elements and retain
the buttons' existing native `title` hover labels and accessible names. The top
workspace header clips vertical overflow while retaining horizontal `auto`
scrolling for genuinely narrow windows; controls keep their order and dimensions.

Browser reproduction: at 1,200px width, the old toolbar measured 1,334px scroll
width and 67px scroll height against a 1,200×47px client area. The fixed toolbar
measures 1,200×47px at rest, hover and focus. At 50px width, intentional horizontal
overflow remains reachable. Desktop TypeScript and production build checks passed. The installer build for
PR #653 completed successfully. This CSS-only fix requires no backend or trading
behavior changes.

## Main → preprod integration — 2026-10-12

PR #652 is merged into preprod (`49e92c8`); authenticated acceptance is in
progress, not declared complete. Integration work starts from that revision on
`integration/main-into-preprod` and merges main `d10ab97` (which contains dev
`dfa878d`). Main/dev source contents match; six older script executable-mode
changes exist only in main and remain preserved. Main/dev are not modified.

The integration brings authoritative website live-mode labels, finalized Real
Day charges, event-second snapshot candles, retained snapshot viewport/zoom,
option marker cleanup, sequential header errors, desktop strategy submenu/Take
Profit actions and saved Paper/Real capital restoration. It retains preprod's
Kite/Real execution, four broker/style slots, shared funding, Swing runtime,
linked Replay refresh, toolbar icons/tooltips and compact date/time controls.

Four textual conflicts are resolved by retaining both behaviors: this document,
shared performance broker/account/fee-source fields, the desktop workspace's
Real/companion routing and strategy callbacks, and both CSS additions. Automatic
merges are reviewed for account-scoped ledgers, frozen sizing capital, fractional
option identity and native analysis allowlists.

Finalized-charge corrections are **Day-only** for now, as explicitly selected.
Swing histories keep estimates and are excluded from charge discovery/application;
per-day Swing billing remains deferred. Corrections are owner/date/broker/account
scoped and analytics-only. Legacy Kotak requests/records remain supported; Kite
uses explicit broker scope. Legacy/current correction metadata is deleted together
so reverting cannot revive an older bill. No trading, wallet or funding records
are altered by charge correction.

Integration verification:

- Backend: **2,189 passed**, with the two known local ICICI configuration failures
  in options-start validation (`test_missing_strike_returns_400` and
  `test_invalid_right_returns_400`). No new integration failures. The incoming
  pattern-logger test setup removes the other two former local failures.
- Desktop: **194 tests passed**. Website notification tests: **14 passed**.
  Both TypeScript checks and production builds passed.
- Native Linux Rust: `cargo check --locked --offline` passed; **19 library tests
  passed**. This does not replace building/testing the Windows executable.
- Mocked browser checks passed for Day charges (separate Kite/Kotak scopes),
  strategy submenu/Take Profit controls, snapshot candles/viewport navigation,
  header notifications, running mode labels and Real/linked Replay controls.
  No page errors or live broker orders were produced.
- Python compilation, reviewed new-service lint and diff checks passed.

PR delivery is recorded below. Delivery targets
preprod; deployment and native Windows/authenticated broker acceptance remain
manual. The original testing checkout is not modified by integration work.

## Current Swing review status — 2026-10-11

The ownership/funding/recovery self-review and fixes are on
`feature/phase21-swing-trading`. See the [authoritative current status and review
checkpoint](spec-phase21-swing-trading-plan.md#current-review-status--2026-10-11).
Four broker/style slots supersede the earlier one-Real-session-per-user restriction.
Running books keep their broker/account when the default setting changes.

The review fixed startup child adoption/readiness, interrupted-start persistence,
concurrent funding edits, partial-fill commitments, pending entry checks, unknown
submission timing and empty cash correction. Undated attempts require explicit
owned-order acknowledgement plus verified-flat closure; current-day unknown
attempts remain blocked. History warnings persist. Earlier delivery/checkpoint
sections below describe their original revisions.

Verification: **2,121 backend tests passed** with four known local ICICI
configuration failures; **184 desktop tests passed**. Both client TypeScript
checks/builds and mocked acknowledgement controls passed.

The branch and all PRs target **preprod**. Backend/native live acceptance follows
merge and deployment; main/dev promotion is manual. Linked Swing views, multi-day
Replay, remaining Paper edges and live/native acceptance are not declared complete.

## Current extension — Kite and desktop Real / linked screens

The approved [complete extension specification and sprint plan](spec-phase21-real-trading-plan.md)
records scope, exclusions, decisions, broker/books/session design, desktop UI and
linked-window lifecycle, failure cases and acceptance gates. Sprint 0 writes this
handoff before trading-code changes. All extension work and PRs target **preprod**;
main/dev promotion is manual after acceptance. The original extension used one
active Real session per user; the current Swing ownership revision above supersedes
that limit and allows changing the default broker while books remain pinned. Funds and history stay
broker-account separate. Earlier Kite/desktop Real deferrals and dev-delivery rules
below describe the previous delivery and are superseded for this extension only.


Extension implementation is on `feature/phase21-real-desktop` in ready-for-review
[PR #632](https://github.com/prattyush/TradeMatangi/pull/632), targeting preprod.
See the linked specification for delivered sprints, automated results and remaining
Windows/native and live-broker acceptance gates. No main/dev promotion is included.

## Current delivery status — 2026-10-12

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

Desktop chart-price picking, order editing and popup/Stats improvements in
[PR #630](https://github.com/prattyush/TradeMatangi/pull/630), and the running website
Real-mode label fix in [PR #634](https://github.com/prattyush/TradeMatangi/pull/634),
are merged to dev. The Real Analytics finalized-charges follow-up below is
implemented and validated; [PR #638](https://github.com/prattyush/TradeMatangi/pull/638)
merged to dev (a150002). The Desktop snapshot event-candle follow-up below is
implemented and validated; [PR #640](https://github.com/prattyush/TradeMatangi/pull/640)
merged to dev (89efc32).

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
  history no longer prevents the Wallet popup reset. Reset funds remain available
  on resume, with existing same-date/market-time guards and trading history retained.
  The capital follow-up below preserves the saved session baseline separately.
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

### Desktop price picking, popup closing and Stats layout — 2026-10-09

**Status: all four requested changes implemented and validated; [PR #630](https://github.com/prattyush/TradeMatangi/pull/630) published for review → dev.**
The chart-price controls below supersede the original “no chart click” default for
the compact order window. Backend trading/wallet behavior is unchanged.

| Follow-up | Implemented behavior | Status |
|---|---|---|
| 1 — Order popup | Limit, Target and position SL price fields have a chart picker; clicking the price field also arms picking. Picked values stay editable until explicit Submit. | Validated |
| 2 — Left-panel edit | Price field, chart icon and LTP work for the exact order contract. Picked/LTP prices remain draft values until Save; existing lot and coverage checks remain. | Validated |
| 3 — Desktop close controls | Pressing buttons no longer moves their hit areas; popup close controls have stable 28px minimum targets. Chart activation ignores overlaid order/menu controls. | Validated |
| 4 — Analysis Stats | Shared website/desktop dashboard places the selected Trades Behind panel directly after the row containing Outcome Distribution, before comparison rows. Other Stats views retain their details panel. | Validated |

The price picker reuses the existing desktop chart conversion mechanism. It is
bound to the selected tile, exact contract and session. Wrong-chart clicks leave
the draft unchanged, even when another chart becomes active. Contract/session
changes, field typing, close/cancel and submission clear draft picking. Choosing a
price does not place an order or update an existing order. LTP requires an available
quote for the displayed matching contract; unavailable quotes do not invent a price.
Price spinners use a zero base so chart-picked prices cannot shift their quarter-
rupee grid; keyboard/wheel increments and positive-price submission checks remain.

Validation:

- **182 desktop Vitest tests** and **43 website Node tests** passed.
- Both client TypeScript/production builds passed.
- Extended Phase 21 browser acceptance passed across Replay, Stepwise, Paper,
  five-pane Stepwise and empty stopped Paper. Checks cover Limit/Target/SL picking,
  field/icon entry paths, wrong-chart exclusion, no automatic trading writes,
  edit LTP/picking/manual entry, ₹0.25/lot increments, stable close hitboxes on
  hover and pointer-down, single right-edge closes for order and instrument popups,
  dragging/viewport bounds, existing orders and uncertain submission handling.
- Website Stats browser acceptance and actual desktop Analysis acceptance both
  verify the selected Trades Behind card is the distribution row's immediate
  next sibling. Filtering, detail inspection, all five views, CSV, narrow viewport
  and close behavior pass with no page errors.

Artifacts: `.cache/four-ui-updates/` (desktop Stats screenshots also use
`.cache/desktop-analysis-validation/`). Scripts:
`scripts/phase21-desktop-check.mjs`, `scripts/phase20-browser-check.mjs` and
`scripts/desktop-analysis-check.mjs`, using external PLAYWRIGHT_MODULE and the
project venv PYTHON_BIN where fixtures are generated. No backend changes were
made, so the prior 1,949-backend/303-AI-helper results are historical evidence;
those suites were not rerun for this frontend-only change. Native packaged Windows
acceptance remains manual. Delivery needs a rebuilt desktop client and updated
website assets; main merging/deployment remain manual.

### Website running Real/Paper mode display — 2026-10-10

**Status: implemented and validated; [PR #634](https://github.com/prattyush/TradeMatangi/pull/634) published for review → dev.** Starting a session
changes the SessionControls key, remounting it with the local Paper picker default.
The running display previously used that picker instead of the session's actual
mode, so a Real session could appear as Paper.

App now passes the current session type to SessionControls. Running/paused live
selection and badges use that type, including restored sessions before the Real
access lookup completes. Idle and add-session controls keep the existing picker
behavior and fresh Paper default. Trading execution, permissions and backend
session modes are unchanged.

Validation: website TypeScript/production build and **43 website Node tests**
passed. `scripts/website-real-mode-check.mjs` verifies choosing Real and starting
through a component remount, repeated remount, paused Paper, restored Real before
access lookup, fresh idle Paper default and no page errors. Artifacts:
`.cache/real-session-label/`. Deploy rebuilt website assets to apply the display
fix; main merge/deployment remain manual.

## Real Analytics finalized charges — 2026-10-11

Implemented for the shared website/desktop Stats dashboard. Broker charges can
finalize overnight; until a user supplies the finalized bill, analytics continues
using calculated estimates. In Stats, select **Real → Actual Real charges**, choose
the trading date and owned broker account, enter the finalized total, and save.
**Use estimate** removes the correction. This is a manual correction, with no
scheduled broker polling or statement import.

- The bill covers all loaded Real orders for that account/date, across symbols
  and sessions. Chart/report filters do not narrow the allocation. If the bill
  includes other trades, load their history first or enter only the charges
  attributable to the loaded orders. Legacy trades without an account identity
  remain estimated.
- Store the correction separately in the existing WalletLedgers table under
  `analytics-real-fees:<date>:<account hash>`. Raw broker trades/orders, wallets,
  live P&L, order placement and risk controls remain untouched. No migration or
  new table is required; missing correction storage reads as an estimate.
- Allocate the finalized total across broker orders using estimated charges,
  falling back to turnover. Per-order allocations
  sum to the exact bill in paise. Partial fills share each order allocation;
  FIFO cycle matching allocates it between exits and remaining open inventory.
- Apply corrections before building analytics cycles. Net P&L, outcomes,
  drill-down details, summaries and CSV use corrected charges. Labels distinguish
  estimates, allocated actual charges, mixed sources and changed history.
  Individual allocated fees are approximations, not broker-confirmed order fees.
- Broker refresh cannot overwrite a saved correction. New orders or changed
  quantity/turnover keep their estimates, with a history-changed notice asking
  the owner to save the finalized total again. Account/date/user isolation and
  existing shared-history read-only permissions are preserved.
- Reads and saves run off the backend event loop. Storage failures are logged
  and return an error; the editor keeps the report available and permits retry.

Validation complete: **1,962 backend tests**, **183 desktop Vitest tests**,
**43 website Node tests**, and **17 native Rust unit tests (Linux)** pass. Both
TypeScript/production builds pass. The 13 charge regression cases cover account,
date and owner isolation, shared read-only access, projection aliases, partial
fills and reversals, zero charges, changed history, refresh persistence, storage
failure, outcome/summary/detail changes and reverting to estimates. Browser
acceptance covers editor save/revert/zero/failure/empty date/close and the existing
Stats sections, drill-down, CSV and narrow viewport, with no page errors.
Two older equity OHLC fixtures were repaired to mock broker downloads; the full
suite no longer depends on a live Breeze token for those cases. Test artifacts:
`.cache/real-analytics-fees/`; repeatable editor check:
`scripts/real-charges-browser-check.mjs` (set PLAYWRIGHT_MODULE if needed).

Reviewed account/date scope, allocation, cache refresh, sharing permissions and
trading isolation. No unresolved automated-check failures. Packaged Windows
acceptance remains manual. Deploy the updated backend and website and rebuild the
desktop client to include the native route allowlist. Main merge/deployment remain
manual; this follow-up targets dev.

## Desktop snapshot event candle — 2026-10-11

Implemented the event-candle follow-up for Desktop Analysis snapshots. Selecting
an event displays the three-minute candle containing its recorded market time,
including underlying/CE/PE tabs. The previous implementation removed the boundary
candle unless captured OHLC existed; captured OHLC itself could represent only a
single observation rather than the accumulated three-minute candle.

- Reconstruct from the candle boundary through the event second, inclusively:
  first open, maximum high, minimum low, and close at that second. Use cached,
  genuine observed seconds with complete coverage; never treat synthetic gap
  filling or minute rows as exact second observations.
- If suitable seconds are absent, retain the full historical event candle. No
  precision or fallback labels are added. Exclude candles after the event candle.
  Missing both sources produces the existing chart data-error flow rather than
  substituting the preceding candle.
- Keep captured current-price, order and position lines. Ignore stale captured
  observation boundaries when a valid recorded event timestamp exists. Replay
  uses its recorded market timestamp, not the wall-clock `event_timestamp`.
- Add `GET /api/snapshots/{event_id}/candle?session_id=…&instrument=underlying|CE|PE`
  and the desktop-authenticated equivalent, returning `{candle: OHLC | null}`.
  Resolve date, symbol and strike/expiry from the saved snapshot. Preserve owner
  and shared-history read permissions and exact read-only native allowlists.
- Reconstruction only reads existing Breeze parquet/legacy equity pickle caches;
  it does not download, migrate files or change recording/trading state. File
  reads and aggregation run off the event loop. Unexpected errors are logged;
  desktop falls back to the historical event candle. Event/account changes abort
  or ignore obsolete replies. Reopening a snapshot keeps its event candle visible.

Validation: **133 related backend tests**, **186 desktop Vitest tests**, **18 native
Rust unit tests (Linux)** and **43 website Node tests** pass. Both TypeScript and
production builds pass. `scripts/snapshot-candle-browser-check.mjs` exercises the
actual shared viewer and desktop KLineCharts: exact OHLC/full fallback, stale
capture boundaries, underlying/CE/PE, late responses, reconstruction failure,
keyboard navigation, resize/Fit, price lines, missing event data and close, with
no page errors. Artifacts: `.cache/snapshot-event-candle/`.

No database migration or website behavior change. Rebuild the desktop client and
update the backend to apply the feature; an older backend still permits the full
historical-candle fallback. Packaged Windows acceptance remains manual. Delivery
[PR #640](https://github.com/prattyush/TradeMatangi/pull/640) merged to dev;
main merge/deployment remain manual.

## Desktop option marker text and snapshot navigation — 2026-10-11

CE/PE execution markers now use colored circles without text on desktop trading,
Analysis, comparison and snapshot charts. Underlying labels retain option-side
context and grouped counts. Marker colors, exact fill placement, contract filtering
and Analysis click/chooser behavior are unchanged. Pattern annotations and order
price-line labels remain visible. Website rendering is unchanged.

Snapshot event navigation within the same session/date/contract now keeps the
existing chart and its zoom. Prior candles and price lines remain while the next
event loads, then update together. Stable chart identity is separate from event
identity; the existing loader is reused without resetting the manual price scale.
The original automatic event scrolling is superseded by the fixed-position
follow-up below.
A different date or option contract clears the old series, and missing/invalid
event data still produces a chart error rather than presenting a stale event.
No backend changes or new caching infrastructure are required for this follow-up.

PR #642 validation: **191 desktop Vitest tests**, TypeScript and production build passed.
The snapshot browser check verifies retained chart instance/zoom, no blank frames
during delayed navigation, zoom changes during loading, old price lines while
waiting, distant/earlier events, cancellation, contract tabs, resize/Fit and error
handling. Marker tests cover CE/PE colors, underlying labels, coincident fills,
custom option labels, exact prices and open/history filtering. Artifacts:
`.cache/snapshot-viewport/` and `.cache/option-marker-labels/`.
[PR #642](https://github.com/prattyush/TradeMatangi/pull/642) merged to dev (194e15d).

## Desktop snapshot fixed chart position — 2026-10-11

Selecting snapshot events now preserves the time axis exactly where the user
placed it. If 10:15 is centered and zoomed, another 10:15 event or a later 11:15
event keeps 10:15 at the same screen position. The new event may remain offscreen;
there is no automatic scroll to the latest candle during same-context navigation.

Capture a candle's timestamp, measured horizontal pixel position and current zoom
immediately before replacing data. Restore that position in the same synchronous
update, without approximate re-centering or a delayed callback that could undo a
fresh pan/zoom. Reuse the existing chart/loader; retain pending-data, price-line,
manual price-scale, cancellation and error behavior. New dates/contracts retain
initial positioning; earlier snapshots still exclude future candles and respect
normal chart scrolling limits. No backend or public API changes.

Validation: desktop TypeScript and production build pass. The actual snapshot
viewer/KLineCharts browser check asserts position within **one pixel** for repeated
10:15 events, 10:15 → 11:15 and back, distant events without auto-scroll, and panning
and zooming during delayed loading. Existing exact/full-candle fallback, contract
tabs, keyboard navigation, resize/Fit, price lines, no blank frames and data-error
checks also pass, with no page errors. Artifacts: `.cache/snapshot-fixed-position/`.
[PR #644](https://github.com/prattyush/TradeMatangi/pull/644) merged to dev (7126fe0). Rebuild the desktop client to apply;
main merge/deployment remain manual.

## Website header notifications — 2026-10-12

Implemented the website notification follow-up for all trading modes: Paper,
Replay, Stepwise and Real. Automatic floating cards could cover order controls;
errors now use the reserved header space between Add Session and Day P&L.

- Show one static error headline, clipping long first-line text with ellipsis.
  Keep the header's height stable with or without messages. The history button
  and unread error/warning count are beside the headline; there is no floating
  launcher over the trading workspace. Sign-in retains a compact standalone
  launcher where no trading header exists.
- Queue distinct errors FIFO, with eight seconds starting when each becomes
  active. Dismiss advances the next error. Repeats retain grouping/count behavior
  without restarting the active timer; the queue is bounded by retained history.
- Store all levels in history (latest 100 records, seven days per account/backend).
  Clicking the headline opens the existing nonmodal history and scrolls to that
  message. Full text, filters, mark-read, confirmed clear, download and IST receipt
  times remain. Expiry/dismissal does not delete history, and reload does not replay
  old headlines. Account changes cancel pending messages and timers.
- Remove the separate pattern-alert stack. Pattern details and suggestions enter
  the same history; critical alerts are errors, warnings stay warnings, and other
  alerts are informational. Only errors appear automatically. Actual guardrail
  blocking, confirmations and broker acknowledgement semantics are unchanged.
- No backend/API/storage migration or desktop behavior change. The journal remains
  browser-local and existing chart instances/data are retained.

Validation: **49 website Node tests** (including **14 notification tests**),
TypeScript and production build pass. Updated notification browser acceptance uses
actual header/history components, Lightweight Charts and OrderPanel: one clipped
headline, error FIFO/dismissal/expiry, complete details for every level, targeted
history, download, reload/account isolation, narrow layout, pattern criticality,
API failures and late-account fencing. Real/Paper/Replay/Stepwise Buy/Sell and
order editing/cancellation stay clickable during notifications; chart bounds and
instance remain unchanged. Existing Real safety-action browser acceptance also
passes. No page errors. Artifacts: `.cache/website-header-notifications/`.

[PR #646](https://github.com/prattyush/TradeMatangi/pull/646) merged to dev (22c5f4f). Deploy rebuilt website assets to apply; main merge/deployment remain manual.

## Desktop right-click Strategies submenu — 2026-10-12

Desktop trading charts now group Aggressive SL, Breakeven and Lock Profit here
under **Strategies**. Underlying target/SL strategies also use that submenu on
eligible underlying charts, retaining their Half/Full choices. **Take profit here**
remains a main-menu item with its existing Half/Full submenu. Buy/Sell entry,
SL coverage and order-move actions remain in the main menu.

Take Profit P&L text on the chart is now anchored 8px from the left edge at its
price level, clearing the right-hand price scale. The strategy price line, numeric
price label, P&L calculations and line interactions remain unchanged.

The desktop TP percentage editor now has icon buttons with tooltips/accessible
names: Save (check), Cancel edits (cross), and Delete strategy (trash). Delete
uses the existing strategy-cancel endpoint, retains the position, and removes the
confirmed-cancelled TP line. Disable controls while Save/Delete is pending; failed
deletion keeps the editor/line and an error for retry. Confirmed cancellation is
reflected locally even if the subsequent snapshot refresh fails, with the refresh
failure reported separately. Session changes cannot receive an old cancellation
snapshot. Sidebar cancellation continues to use the same handler/error reporting.

Reuse the existing submenu hover/focus behavior and edge-opening styles. Existing
position/entry/underlying eligibility, action identifiers, clicked price and anchor
are unchanged; no backend or strategy execution changes. Allow enough space for
nested underlying menus when choosing the opening side/vertical placement.

Validation: **191 desktop Vitest tests**, TypeScript and production build pass.
`scripts/desktop-strategy-menu-check.mjs` exercises the actual ChartTile/KLineCharts
menu: grouped visibility and dispatch, Take Profit at root, keyboard focus,
right/bottom-edge opening, underlying strategy size choices, existing flat vs
held-position eligibility and left-aligned TP text clear of the price scale; no
page errors. The editor check activates the registered line-selection callback
then clicks the real Save/Cancel/Delete icons, verifying percentage payload,
non-mutating Cancel, pending controls, deletion failure/retry, and line removal.
Artifacts: `.cache/desktop-strategy-menu/` and `.cache/desktop-tp-editor/`.
[PR #648](https://github.com/prattyush/TradeMatangi/pull/648) targets dev and awaits
review; rebuild the desktop client to apply. Main merge/deployment remain manual.

## Paper/Real resumed session capital — 2026-10-12

Implemented and validated. The shared storage restore path previously took current
wallet cash as session capital, then persisted that reduced baseline. Desktop Paper
resumes, stopped-session previews and website Paper restoration now retain the
saved finite `session_capital`, including zero. Positions, trades, available wallet
cash and P&L continue to use their existing values. For example, a ₹1,00,000 session
with a ₹6,501 open-position debit resumes with ₹1,00,000 capital and ₹93,499 cash.

Real restoration retains an explicitly supplied frozen broker account/day baseline;
without that override it uses the saved session capital. Missing or invalid legacy
capital falls back to the existing explicit-capital/wallet logic and logs
`session_capital_resume_fallback`. No new API, fields, migration, historical scan
or client calculation was introduced. Already overwritten original capital cannot
be reconstructed reliably from current cash; no automatic repair is attempted.

Wallet reset rules are unchanged. Resuming the same Paper session after reset keeps
that session's original capital while exposing the updated available balance. A
new session still starts from the existing wallet rules. Replay/Stepwise start,
pause/resume, stop/checkpoint and position-flattening behavior remain unchanged.

Validation: **162 focused backend tests**, **46 related backend tests**, **49 website
tests**, **191 desktop tests**, and both TypeScript checks pass. Coverage includes
open-position stop/restoration, repeated server-memory loss, persisted capital,
read-only preview, empty-session desktop/website resume after reset, zero and
invalid legacy values, Real frozen daily balances, and unchanged Replay/Stepwise
capital rules. The existing replay completion test now awaits the engine task
with a bounded timeout instead of assuming it finishes in 100ms. Artifacts:
`.cache/resume-session-capital/`. [PR #650](https://github.com/prattyush/TradeMatangi/pull/650)
targets dev and awaits review; main merge/deployment remain manual. Restart the
backend to apply; no client rebuild is needed.

## Original requirements

## Improvements

### Desktop UI
1) An UI option to roll up draw and indicators. A button when clicked will hide the draw and indicator. This is to create space for open orders, orders and others, during a replay or paper trading session. As draw and indicators take up space, so one button to click to that these draw options and indicators don't take space vertically.
2) An order panel like present in website, but only visible as a popup, with same options as well, specifically, stoploss and limit, market and target. The same panel which is present in website in the right. No need for strategies. Further, this popup should be navigable. I mean I am move it, and I can click on chart and see everthing, the popup remains, more like a window. It should not blur out the backgroud. Similar to what we have in Kite Website. Make it innovative UI not the website UI like target and limit. No need to support chart click like website.
3) Also, when starting a session of stepwise, replay and paper, user can choose options in the search window, with a max price option, if selected, then automatically that option strike price is choosen. When any session is started stepwise, replay or paper, all charts would switch to that date and time. If any chart currently on screen doesn't have data on that date ,or is invalid, like options already expired or too many weeks away, those charts would auto close and number of panes reduced. When user opens the search symbol sign, then date is fixed, and when options selected, user can choose strike prices or max price and the system auto finds the respective strike price for CE or PE within that price at that current running time for that date. For equity it will same as today.
4) Remove the word "connected" on the right hand side with just Green (When connected) to Red (Offline), other color during connection, On mouse hover you can display more info.
5) One other requirement in the edit options, which are present in the left panel, where I can change the quantity of already present orders. If you check in website, the similar option respects the option lot sizes, which are currently not respected in the left panel in desktop. That is with respect to scrolling. So if I scroll, the lot prices should change. Just look over into the website, edit options and how they're handled for options, or price change and quantity change, and try to duplicate that during edit options in left panel in desktop.

### Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation. The cancellation optimization present for Kotak Broker need not be applied in Kite Broker. Rest all the mechanism in which orders are placed, target, strategies should be same as currently with website and Kotak.

The Admin can choose whether to use Kotak for real trading or Kite.


### Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.

It should support all features currently supported in website for real trading. Do discuss if you find things need discussion.

### Real Trading or All Trading in Option supporting multiple strike prices.
1) We can have 2 CE Strike Prices, with orders and stoploss and target profit strategy at the same time.
2) The 3 charts (One PE and 2 CE), can be in the 5 pane layout both desktop and website.
3) For Kotak, with 2 strike prices, all optimizations, including auto cancellations handling should be done.
4) For resume an old session which has open orders, during resuming a paper or real trading session, display definitely those open orders' Strike Prices. (one or 2).
5) Support in website a similar seaerch feature as in desktop, to choose a chart with a specific strike price. It can be limited search, only for that underlying symbol. Or a much simpler can be just a dropdown to change strike price, or when search button cilck,  option to change the chart either a underlying or CE or PE with specific strike prices. This is required as currently during session starts
the strike price is auto choosen based on under 50 rupees etc (current price), for 2 strike prices, it has to choosen manually.

### Desktop Split Screen Trading
 Support in Desktop, if split screen, both screens can have same session. So one option where user can clicks the current replay trading, or paper or real trading and ask it to  split screen, the second screen will be the same paper trading or replay trading. It may have different strike prices of CE /PE etc. We can plan to make it simple, such that no wallet shown or orders only in one. I am open to suggestions.


## Nifty 100 and Swing implementation

The approved decisions and sprint implementation record are in
[the Swing Trading specification](spec-phase21-swing-trading-plan.md).
All work and review PRs target preprod.

### Expanding Supported Symbols to Nifty 100
1) Support Nifty 100 symbols.
2) Make sure it is supported for both website and desktop.
3) Make sure it is supported for real trading brokers, Kite and Kotak and ICICI Direct for replay trading, paper trading and stepwise.
4) Support in all forms of trading types, paper, real, step, replay.
5) Generate scripts to whether you can get historical data for all 100 nifty symbols, in Kotak, Kite and ICICI to know that the symbols mapping is present. Just either fetch latest price or smallest historical data, to know that all symbols mapping are correct. For scripts credentials are present in ddb local.
6) Extend the symbol chooser in both website and desktop to handle. Don't add dropdown, as we have 2 sectios now, indices and equity symbols. Further in both the symbol selection fields, make it type and options comes, like I type TATA and all tata symbols will come. For quick selection. Feel free for UI suggestions.
7) Also, support Options if available for these 100 symbols. And you can fix it to NIFTY 100, no need of SENSEX 100. Only nifty is fine.

### Swing Trading Support
This requirement is for supporting positions across days, and also in multiple symbols, for now only equity, maybe options. Support right now is required right now for paper and real, and replay. Replay is secondary, paper and real are more required.

The thought behind is testing swing trading strategies, that is taking a position in long. In Indian Stock Market short position cannot be across days. Or PE Contract Long in that symbol for taking benefit of bear movement in the stock. 

The session can be long lived, and once a capital is captured, honor it for percentages. For real trading scenario, do the same or now. For real do give the option, for uer to change session capital.
When system detects mismatch betwween capital and P&L and orders, specially decrease, incerase is fine, then ask user to update session capital. Required for perccentage postion and % P&L Calculation.

Point to note in multiple day trades, there is no leverage in equity.


### Real broker/style ownership and downtime recovery

The 2026-10-11 revision in [the Swing implementation plan](spec-phase21-swing-trading-plan.md#real-ownership-and-outage-recovery-revision--2026-10-11-sprint-0)
supersedes the earlier one-broker/one-operator assumptions. Real accounts permit
one Day session and one Swing portfolio across users; one user can occupy all
four Kite/Kotak style combinations. Each account has one shared capital pool.
Unclosed books retain ownership through outages, pause and screen detach, and
require reconciliation/verified closure before their slot can be reused. Paper
and Replay restrictions are unchanged. Implementation and testing status remains
in the linked document; Real Swing runtime acceptance is not implied by slot or
funding-helper tests alone.


### Ownership and recovery implementation checkpoint (2026-10-11)

Real Day/Swing broker-style slots, shared account funding and Real Swing runtime
are now connected on the existing feature branch. Website/desktop controls include
broker reconciliation, opening inventory preview/import, selected funding edits,
negative cash-correction preview and verified closure with history warnings.
See the [full implementation checkpoint and exclusions](spec-phase21-swing-trading-plan.md#implementation-checkpoint--ownershiprecovery-revision-2026-10-11).
Broader linked Swing charts, multi-day Replay and preprod/live acceptance remain
explicitly outstanding; main/dev promotion remains manual after acceptance.


### Swing Trading Improvements
When I open swing trading I see a page with just numbers to enter or purchase without charts.
1) Change the swing trading UI to support charts and maybe left panel has positions orders etc, or feel free to suggest great UI. Improve the UI, it literally has almost nothing, compared to day trading whicch is so great.
2) The charts for swing need not be fine, so you can download from kite or kotak or icici breeze 1 minute candles.
3) The charts would be in website and desktop both, in desktop it is KLine.
4) I can take position from ccharts or at least use chart picker to pick entry (limit, target), stoploss etc.
5) Positions should also some P&L.
6) In swing charts, I can cchoose Day as a candle interval as well, at that time one has to download 1 min for 140 days right, depending on how many candles are to be shown. You can also be clever and download day level data for older days and store it or maybe 1 hour granularity and use it to show Day granularity candles. Feel free to optimize.

### Swing improvements implementation plan

The approved [Swing Improvements sprint/design record](spec-phase21-swing-improvements-plan.md)
records portfolio-first 1–4 independent charts, confirmed chart picking, daily
history, position P&L and backend-owned live pricing during 09:15–15:30 IST.
This is a new sprint track; original Phase 21 status/history remains intact.


### Swing Improvements implementation checkpoint — 2026-10-12

Sprints 0–4 are implemented on `feature/swing-chart-workspace` for preprod.
Sprint 5 automated review/build/browser checks are complete; broker and installed
Windows acceptance follows preprod merge/deployment. See the [delivery decisions,
interfaces, test evidence and remaining acceptance scope](spec-phase21-swing-improvements-plan.md#implementation-checkpoint--2026-10-12).
Swing uses 09:15–15:30 IST for active Paper/Real pricing independently of screens;
Paper expiry exits begin at 15:15. Main/dev promotion remains manual.

### Linked Swing windows and analytics — 2026-10-12

The approved [linked-window and Swing analytics plan](spec-phase21-swing-linked-analytics-plan.md)
adds desktop portfolio companions and Swing-aware history, labels, Analysis and
Stats. The previous chart workspace was merged through PR #655. This extension
uses a new branch and targets preprod.


### Linked windows and Swing Stats implementation checkpoint — 2026-10-12

Desktop companions now share one exact portfolio with independent chart workspaces.
Both clients have execution history, stable open/closed trade labels, Swing-aware
Analysis and portfolio/trade/exposure Stats. See the [implementation details,
accounting conventions and test/acceptance record](spec-phase21-swing-linked-analytics-plan.md#implementation-checkpoint--2026-10-12).
Work is on the new `feature/swing-linked-analytics` branch targeting preprod;
installed-Windows and authenticated broker acceptance follows merge/deployment.
Multi-day Replay, website popups, new strategies and finalized Swing charges remain
deferred; earlier linked-chart/history pending notes are superseded.


PR #656 follow-up review corrections are recorded in the
[linked Swing delivery record](spec-phase21-swing-linked-analytics-plan.md#pr-656-review-corrections--2026-10-12):
History initialization, valuation chronology/import attribution, independent drawing
scopes, label navigation, Day/Swing filters and a single native window close owner.
Installed Windows and broker acceptance remain after preprod deployment.


### Day ownership handover and practice wallet isolation — 2026-10-13

Follow-up to merged PR #656, on `fix/real-day-handover-practice-wallet` from
preprod `2b2b14a`; delivery PR targets preprod.

“Done for the day” now waits for broker-confirmed flat positions, no pending or
unresolved orders, durable closure of every live alias, authoritative Day slot
release and funding participant completion before publishing the final day lock.
Closed history cannot replace the active owner during verification. Aliases stop
before releasing the owner, so the next user's session cannot be managed by an old
viewer. A failed release remains pending and retries; a failed final day-lock write
can complete after the runtime has ended, provided no outstanding current-day slot
remains. The original user's IST-day entry barrier is retained.

The daily close intent is persisted. Startup recognizes both closing day locks and
legacy done locks with outstanding ownership, restores the owned session and
resumes existing verified closure instead of creating entries. Status reads and
repeated Done requests resume pending repair. A cross-user start also nudges repair
when the former owner already requested day completion; it still returns 409 until
ownership is actually released. Missing/unverifiable metadata retains ownership;
there is no forced unlock, broad historical scan or new trading lock.

Practice-wallet reset blocking now checks the specific dated ledger used by active
Day practice sessions. Explicit saved wallet identity takes precedence, with a
legacy fallback from session type/date. Real books, Swing portfolios, other dated
wallets and chart-only Live Browse do not block a Day practice wallet. Active or
paused sessions using that wallet still block it; Paper startup leases and wallet
revision guards remain unchanged. Broker funds are never reset by this API.

Desktop polls the daily status while closing, including after the session-end
stream stops, so it can display final completion after ownership release.
Regression coverage includes release failure/retry, live-owner selection over
closed history, aliases, restart with closing/done locks, no-runtime outstanding
ownership, shared Kotak account handover across users, and website/desktop practice
wallet reads/resets while a separate Real book is active. Deployment to preprod
and authorized broker acceptance remain required; no live orders were placed.


Validation for this follow-up: **244 focused backend checks passed**; full backend
**2,245 passed**, with the two existing local ICICI-configuration failures
(`test_missing_strike_returns_400` and `test_invalid_right_returns_400`). Desktop:
**206 tests passed**, TypeScript check/build passed, and portfolio-management
browser acceptance passed. The broker handover fixture uses Moto and mocked broker
reports; authenticated Kotak acceptance is still required after deployment.


### Desktop Kotak authentication dialog — 2026-10-13

Desktop Real toolbar previously only checked broker status, and Settings required
an inline TOTP before its disabled Connect button could be used. Both now open a
Kotak login dialog using the existing authenticated desktop settings login route.
The dialog accepts six digits from the authenticator app, focuses the input,
supports Enter/Cancel/Escape and keyboard focus containment, disables dismissal
and duplicate submission while connecting, and shows retryable backend errors.
Codes stay in component memory and are cleared on failure/success/dismissal;
there is no new credential storage or broker API. The dialog uses a portal so
Settings cannot accidentally submit/save its own form when login is submitted.

Real startup refreshes authentication before preparing a session. If a cached Kotak
connection has expired, it opens login and returns without starting a session.
After login, the user explicitly starts Real trading; no entry/order is retried
or submitted automatically. Toolbar status is refreshed after connection, and
Kite retains its token-based connection flow without a Kotak code prompt.


Validation: desktop TypeScript/production build and **206 tests passed**. The
built-app Kotak browser check covers toolbar and Settings prompts, code validation,
Cancel/Escape, retry and keyboard focus, duplicate/busy submissions, expired cached
authentication, status refresh, no implicit settings save/session start and Kite
isolation. Existing Real/Stepwise/Replay/Paper linked-trading browser checks passed.
Broker responses are synthetic; installed desktop plus real Kotak login acceptance
remains after preprod deployment. No real authentication codes or orders were used.
