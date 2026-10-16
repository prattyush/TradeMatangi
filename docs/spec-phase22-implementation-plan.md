# Phase 22 implementation plan

Implementation began on preprod. The reviewed implementation is on `feat/phase22-website-kline`, with a PR targeting **dev** at the user's latest request. Branch merges, deployment and promotion remain manual.

## Decisions and boundaries

- Website Day KLine supports Replay, Stepwise, Paper and Real; Swing follows Day.
- Per-user renderer preference defaults to Lightweight. Only chart presentation remounts; no logout/server/session restart.
- Existing website order/strategy APIs and broker execution, sizing, authentication, validation, reconciliation and guardrails remain authoritative. No new broker execution engine.
- Drag movement is local; only release sends a modification. Existing editable types/restrictions remain.
- For broker-owned Real orders retain confirmed solid price plus requested dashed price until existing broker snapshots confirm. Timeouts never automatically resubmit. Apply the same presentation to desktop.
- Share authenticated KLine drawings by exact canonical instrument and user, across clients, sessions and intervals. Reopen/explicit refresh loads storage; no new polling. Existing legacy aliases and revision checks remain.
- Lightweight drawings/indicators stay independent; a chart-local memento retains completed Day drawings and indicator choices while switching renderers, with no new timer or DynamoDB migration. Analysis/Patterns remain Lightweight. KLine uses the existing desktop catalogue and pinned 10.0.0 library.
- New editing work focuses Day; preserve existing Swing capabilities without new strategy types.

## Sprints and acceptance

| Sprint | Work | Acceptance | Status |
|---|---|---|---|
| 0 | Record scope, architecture, decisions, exclusions, checks | Every requirement has a verification scenario | Implemented |
| 1 | Portable shared KLine renderer and native desktop wrapper | Desktop regression checks pass | Implemented |
| 2 | User renderer setting, stable chart host, larger Settings/help tooltips | Switching never mutates session or broker settings | Implemented |
| 3 | Day history/live/replay/stepwise adapter and complete KLine tools | Contract/time/candle parity and existing interactions | Implemented |
| 4 | Shared persisted drawings and explicit refresh | Cross-client create/move/delete, conflict and identity checks | Implemented |
| 5 | Existing Day order/strategy bindings and pending Real presentation | One write per release; broker confirmation, rejection and ambiguity tests | Implemented |
| 6 | Swing KLine integration | Existing portfolios/actions/markers preserved | Implemented |
| 7 | Review, regression suites, builds, final docs | Focused/browser checks pass; broad-suite baseline comparison recorded | Automated review fixes complete; manual acceptance pending |

## Architecture and interface changes

A shared portable KLine component accepts candles, storage requests and interaction callbacks. Desktop injects native drawing events/diagnostics; website uses existing website APIs and stream data. Renderer switching occurs beneath the session owner. The settings API adds optional `website_chart_renderer` (`lightweight` or `kline`), defaulting to Lightweight. Website strategy responses populate their existing optional price/contract fields using the same read-only projection as desktop. The existing desktop broker-refresh response adds optional normalized broker orders, snapshot revision and generation/version evidence from the refresh it already performs. No drawing table/schema migration, broker endpoint changes or broker execution logic changes are introduced. Options history accepts an optional `as_of_time` and echoes it only when requested, filtering source timestamps before resampling. Existing callers without this parameter keep their response shape and full-day behavior; new KLine requires an acknowledged cutoff before using an option partial candle.

## Verification matrix

- Modes/contracts: Replay, Stepwise, Paper, Real; equity/index, CE/PE, Futures; existing Day/Swing.
- Candles: IST-labelled epoch and aligned boundaries, incomplete bars, history paging, replay seek, reconnect/out-of-order events, async instrument switches.
- Controls: price pick in empty space, context menus, markers, P&L levels, resize/maximize/swaps, recording/snapshots; renderer fallback.
- Modifications: unchanged release, cancel gesture, one write, valid ticks, overlapping requests, reject/timeout/late response, partial fill, fill/cancel during edit, stale snapshot/manual refresh; both brokers mocked.
- Drawings: client reopen/refresh, exact contract and user isolation, legacy aliases, revision conflicts, failed saves and late responses.
- Regression: Lightweight, linked windows/pop-outs, order entry/exit/conversion/split/quantity/target sizing, wallets/guardrails, session ownership, labels/stats/Analysis/Patterns.

## Baseline and release checks

Baseline: 254 focused backend tests, 227 desktop tests, both TypeScript checks passed before changes. Automated checks never submit live broker orders. Real acceptance requires explicitly authorized manual preprod checks. Windows native interactions and visual checks must be reported separately from automated checks.

## Excluded/deferred

Library upgrades, Lightweight drawing conversion, continuously synchronized cross-client drawings, new Swing strategy capabilities, new broker order logic, and main/dev promotion.


## Implemented design and edge-case decisions

### Session and renderer boundary

- Only the chart child remounts. `App` / `useSimulation`, Swing portfolio controllers and subscriptions retain ownership of trading state. Renderer selection never starts/stops a session, changes wallet/capital, connects a broker or sends an order.
- KLine is lazy-loaded; each chart can fall back to Lightweight locally if loading/rendering fails. Settings persists the normal renderer selection per authenticated user. A backend/server-qualified browser cache supports reopening; responses from a previous account are ignored, and an older settings read cannot replace a more recent saved choice.
- Completed Lightweight drawings and its EMA/P&L/ratio selections survive a switch away and back through chart-host memory; the existing Swing local save behavior remains. Incomplete drawing gestures are not converted between renderers.
- Settings switching waits for active KLine gestures, drawing saves and modification requests. An unconfirmed broker result remains a presentation record outside the renderer, so it does not permanently prevent recovery through Lightweight. Lightweight also displays that pending proposal.
- Settings expands to at most 960px, constrained to the viewport. Ten static explanations become hover/focus/touch help; validation, funding restrictions and important trading notices remain inline.

### Market data, markers and tools

- Website KLine uses existing website historical/pre-session/options APIs and the existing session ticks/completed-bar props, not desktop feed/session creation APIs. Swing uses its existing external candles and history paging callback.
- Preserve UTC-labelled IST wall-clock seconds and epoch-aligned Day candle buckets. KLine explicitly renders in UTC to avoid applying the IST offset twice. Swing retains its existing candle/marker anchor.
- Keep a chart-local candle handoff across renderer changes, current-bar OHLC extremes, stale-tick rejection and Stepwise completed-bar correction. Replay options history is fenced at the current cursor; future candles are excluded. Its optional cursor cutoff filters raw history before aggregation, restoring a cold/resumed partial candle without exposing a later high/low/close. Late responses merge the bounded partial with buffered extremes instead of reverting a newly completed bar. Rewinds clear the incompatible tail.
- The desktop catalogue is shared: 14 drawing tools and 14 indicator entries, including Position P&L levels. Website tools occupy a collapsible left strip; KLine indicator choices are stored separately from Lightweight choices, qualified by user/server/contract.
- Website Day open-position marker cycles use the existing website cycle calculation; closed-marker toggling remains available. Exact underlying/expiry matching prevents fills leaking between contracts. Swing keeps the existing selected-date marker filtering supplied by its workspace.
- Option/Futures captions display the exact contract. Historical Swing charts and daily bars do not display a misleading live countdown. Volume-dependent indicators remain dependent on source volume; this phase does not fabricate volume or introduce extra data subscriptions.
- HTML order/P&L labels follow chart movement and resizing, and reject non-finite coordinates before first paint.

### Drawing identity and save behavior

- Existing authenticated drawing endpoints and revision checks are reused. New writes use the canonical exact instrument; equity/index kind, exchange, option right/strike/expiry and Futures expiry remain distinct. Date, interval and session are not added to the shared key.
- Day/Swing option drawing identities map NFO→NSE and BFO→BSE while leaving feed venues intact. Both clients can read earlier unscoped feed-venue records. Legacy private window scopes are read only through their existing scope alias; private historical records are not scanned/moved into a shared namespace.
- Load on open/reopen and explicit chart refresh. Existing native/local notifications remain; website adds no focus polling or cross-client transport. Explicit refresh is also available in Swing.
- Persist completed drawings, completed moves and lock/hide changes. A drawing is temporarily locked while its own save is outstanding; another edit/delete waits rather than losing an update or leaving a just-created ghost drawing. Other drawings remain usable, and no server locks are added. Failed moves/creations remain visible locally; a refresh asks before discarding a failed local edit. Failed deletes retain the drawing. Revision conflicts never silently overwrite another revision. Late responses from a different instrument are ignored.
- An ambiguous failed creation is not automatically retried, since the existing create API does not guarantee idempotency. Refresh/reopen first to inspect persisted state. Failed unsaved drawings remain local to that mounted chart; they are not a new offline drawing store.

### Real order and strategy edits

- Price movement is local until release. Unchanged releases send no request. Price picking locks trading overlays against accidental dragging. The existing backend still validates identity, tick prices, recovery state, funds, guardrails and modifications.
- Website Day calls the same `useSimulation.updateOrder` / strategy update APIs as existing website controls. Desktop retains its current trading request facade. Backend broker submit/modify/cancel/convert/replacement implementations are unchanged.
- For broker-owned Day orders, retain the confirmed solid line and display a requested dashed line. HTTP acknowledgment alone does not confirm the line; use existing normalized broker snapshots and one existing refresh after acknowledgment. Do not add periodic polling or automatic resubmission.
- A triggered TARGET is already a broker LIMIT: compare its returned computed limit price, rather than its local trigger price, against broker evidence. Respect replacement IDs already returned by the existing modification path.
- Definitive website HTTP refusals clear the proposal. Uncertain network/server outcomes remain unconfirmed. Terminal fills/cancellations supersede a proposal; partial fills retain existing remaining-order semantics. Reject stale/retired-generation snapshots. Presentation is scoped to the user/backend and exact session/order.
- When a refresh verifies a different broker price, keep the discrepancy visible. The chart's **Use verified broker price** arrow can dismiss that proposal only after such evidence exists; this reconciles the display and sends no order.
- Backend-only target/strategy configuration changes use existing backend acknowledgment, not broker confirmation lines. Dragging a percentage TargetProfit uses the existing price update semantics and makes it an absolute price, matching desktop. Existing strategy controls remain available.
- New website inline editing is price dragging and existing context-menu/price-pick actions. Quantity, conversion and other order management remain in the existing website order panel rather than exposing nonfunctional desktop-only controls.
- New editing work focuses Day. Swing reuses its existing selection, drag/confirmation and order-action callbacks; this phase does not add Swing strategy types or change its Real confirmation rules.

## Requirement mapping

| Spec requirement | Implementation |
|---|---|
| 1: Website Day/Swing KLine | Stable renderer host, Day data adapter and Swing external-candle adapter |
| 2: Submit drag on release | Shared KLine release handler, no-change guard and existing order APIs |
| 3: Switch renderers | Per-user setting, local fallback and chart-only remount |
| 4: Settings layout/help | Responsive larger modal and accessible explanation tooltips |
| 5: DynamoDB drawings | Existing authenticated persistence API and revisions |
| 6–7: Desktop tools, collapsible UI | Shared catalogue and collapsible website tool strip |
| 8: Real edits | Existing website/backend handlers and broker-evidence presentation; desktop parity |
| 9: Other screens | Analysis/Patterns retain their existing Lightweight charts |
| 10–11: Shared drawings | Exact canonical identities, legacy aliases, open/reopen/manual refresh |

## Verification results and reproduction

Automated tests use mocked brokers; none submit live orders.

- Before changes: 254 focused backend tests; 227 desktop/shared tests; both TypeScript checks passed.
- Final broad backend run: **2,580 passed, five failed**. A complete clean `HEAD` archive of preprod, run against the same isolated in-memory DynamoDB setup, produced **2,556 passed and the exact same five failures**. The 24 additional passes are six settings cases, eleven presentation cases and seven cursor-cutoff cases. Earlier in a run concurrent with client builds, the untouched threaded broker chunk-count assertion also failed once; it passes independently in both baseline and changed code and passed in the final serial run.
- The baseline failures are `test_market_data_repairs::test_tail_reuses_completed_chunks_and_provider_wins`, `test_phase19_historical_policy::test_concurrent_breeze_history_initialization_authenticates_once`, `test_real_day_reconnect::test_failed_execution_recovers_immediately_without_waiting_for_heartbeat`, and the two `test_real_simple_lifecycle::test_stop_bypasses_conditional_lock_failure_and_preserves_state` cases. The latter three pass in isolated module runs and fail in the broad baseline run; the first two also reproduce individually. These untouched broker/history behaviors were not changed to force a green run.
- Focused backend regression rerun: **260 passed**; additional chart-presentation tests: **11 passed**, including existing selected-broker refresh reuse for both Kotak and Kite.
- Final desktop/shared unit suite: **259 passed across 41 files**. Final browser suite: **nine tests passed**, including physical mouse interactions, cold partial-candle restoration, pending creation/delete protection and Lightweight state preservation. Both clients pass TypeScript checks and production JavaScript builds; Vite reports its existing large-chunk advisory.
- Browser regressions exercise physical mouse release timing, broker evidence, renderer switching during an outstanding request, explicit rejection, drawing failures/deletion, open/closed markers, replay fencing, Stepwise correction, Swing/Futures identity and resizing. The harness intercepts every API request with fictional data and cannot place real broker orders. The backend tests used an isolated `-inMemory -sharedDb` DynamoDB Local container on port 18000 with the existing table definitions, not the regular database.

Commands (run client commands in the corresponding client directory):

```bash
# Backend: use an isolated DynamoDB Local instance with the existing table schemas.
DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:18000 python -m pytest tests/ -q --disable-warnings

# Either client: explicit node entrypoints work with --no-bin-links installations.
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build

# Desktop/shared unit tests, from windowsapp/
node node_modules/vitest/vitest.mjs run

# Website browser regressions, from frontend/
npm run test:charts
```

Browser tests use installed Google Chrome on Linux when available, otherwise Playwright Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use another installed Chromium executable, or install Playwright Chromium for the test environment. No browser is required by the production application.

## Review outcome

All eleven Phase 22 requirements have implementation and regression coverage. Sprints 0–6 are implemented. Sprint 7 was reopened after the independent review below; all four corrections and the additional drawing lifecycle fix now pass the current automated checks. Earlier full-suite results remain historical evidence. Manual deployed-client/Real-broker acceptance remains outstanding. The reviewed changes are prepared on `feat/phase22-website-kline` for a PR targeting dev. Deployment and branch merges remain manual.

Review fixes included exact marker contract matching, restoring open-cycle marker flags for website data, non-finite first-paint labels, confirmed/proposed price separation, triggered TARGET limit confirmation, old-account/settings response fences, failed drawing retention, pending-create/delete races, cursor-safe cold option candles and Lightweight state preservation.

## Manual preprod acceptance still required

1. After deploying the backend and website, opt one test account into KLine; verify Replay, Stepwise and Paper before Real.
2. In both Kite and Kotak Real Day sessions, use deliberately chosen small test orders to check modify acknowledgment, broker confirmation, rejection and Trade History Refresh. These are manual, explicitly chosen broker actions, not automated tests.
3. In the Windows app, verify native linked/pop-out windows, drawing notifications and Real pending-line presentation against the deployed backend. JavaScript production builds do not constitute an `.exe` acceptance test.
4. Create/move/delete a drawing in desktop, reopen/refresh the same exact contract in website and vice versa; check CE/PE, expiries, Futures and separate users.
5. Check recording/event snapshots, existing order panel operations, Swing portfolio switching, Analysis, Patterns, labels/stats and a narrow/resized layout in the deployed clients.
6. Keep main/dev promotion manual after preprod testing. No live-broker validation, deployment, promotion or PR merge is performed by this implementation.


## Follow-up review and corrective sprints

Review reproduced four issues despite the earlier green automated checks: website KLine ignored unavailable/authoritative P&L; strategy releases could overlap; Lightweight buy/sell drawings lost their markers and correct removal references after a renderer round trip; inactive-pane tool controls failed to activate their owning pane.

| Sprint | Correction | Status |
|---|---|---|
| Review 0 | Record findings, decisions, verification boundaries and reopen Sprint 7 | Complete |
| Review 1 | Respect website P&L availability/value; prevent overlapping strategy updates and stale session responses | Complete |
| Review 2 | Activate pane tools; preserve typed Lightweight drawing data, markers, styles and removal references | Complete |
| Review 3 | Add focused browser regressions, rerun client/backend checks and record actual results | Complete |

Decisions: website Day supplies its existing authoritative P&L and availability flag; desktop/Swing keep their existing calculation when no override is supplied. Strategy edits use local in-flight checks, with no queue, automatic retry or backend locks. The website session owner guards the same strategy across panes and existing panel edits, and ignores a response after switching sessions. Lightweight handoff records retain series options and markers; old Swing records remain readable with defaults. Drawing storage namespaces and broker execution APIs remain unchanged.

Current review uses fictional browser data and mocked broker services only. Earlier full-backend counts above were not rerun as part of the independent review. Deployed broker/Windows acceptance remains outstanding. The user requested a new branch and a PR targeting **dev** after the corrections; this changes the PR destination only, not the manual acceptance requirements.

### Follow-up verification outcome

- **19 browser tests passed**, including authoritative/unavailable P&L, inactive-pane drawing activation, repeated strategy releases while a request is pending, rejection recovery, renderer switching during strategy updates, and all seven Lightweight drawing types surviving a renderer round trip and Clear. Existing order, drawing persistence, replay, Stepwise, Swing/Futures and marker scenarios also pass.
- **259 desktop/shared unit tests passed** across 41 files; **18 focused backend presentation/cutoff tests passed**. Both client TypeScript checks and production JavaScript builds pass. Builds retain the existing large-chunk advisory.
- The new Clear assertions also exposed disposed drawing references surviving React Strict Mode canvas recreation. Chart initialization now resets those references before restoring drawings; this prevents duplicate counts and attempts to remove disposed series.
- Session response fencing and the session-owner in-flight guard were checked in the actual website callback: stale responses cannot update the new session, and concurrent same-strategy calls from different panes or the order panel are refused locally. Browser overlap tests exercise the shared renderer with delayed/rejected callbacks; they do not constitute full-app session-switch or native Windows acceptance.
- No broker submit/modify/cancel implementation changed during the review corrections, no automatic retry/queue was added, and no live broker was contacted. The broad backend suite was not repeated for these frontend corrections; its earlier five baseline failures remain recorded above. Manual deployed/native/broker checks remain open.
