
## Phase 18 — Desktop Paper, Equity Practice, Browse Live, and Pop-out Screens

### Requirement

1. Enable Paper Trading in the Desktop App with all features currently present in Desktop Replay/Stepwise Trading.
2. Support equity intraday practice with 5x buying power in Desktop Paper, Replay, and Stepwise.
3. Allow an equity-anchored Paper/Replay/Stepwise session to trade the underlying shares and options on that same underlying in one session.
4. Allow multiple Paper sessions on separate screens, for different symbols, while sharing one Paper wallet for the trading date.
5. Preserve the ability to stream any live symbol in the desktop chart workspace.
   - Convert the current top-level Desktop Live mode into Paper Trading.
   - Move chart-only live streaming into Browse so users can live-monitor symbols without trading controls.
   - Browse mode must remain read-only whether live streaming is enabled or disabled.
6. Allow a saved desktop screen to pop out into a separate native Tauri window for two-monitor workflows.

### Status

Core Phase 18 functionality is implemented on dev, but the phase is not yet
complete or signed off. The 2026-09-26 code comparison identified ownership and
startup concerns, plus outstanding database concurrency and Windows/provider
acceptance validation, detailed below. The latest review fixes are also in
place: Desktop Paper explicit entry stop-loss orders now work without depending
on the global auto-SL setting, watcher-created Paper stop-loss orders preserve
Paper ledger/source metadata for retry-safe recovery, attached website-owned
Paper sessions are protected from the desktop Stop endpoint, and the stale
website/pop-out status notes have been reconciled. Windows/live-provider
acceptance validation remains outstanding.

### Agreed completion plan — desktop equity long and short

The September 2026 review originally identified the desktop equity, Paper safety,
and screen/pop-out gaps below. The implementation addresses the main capabilities
on `dev`; remaining concerns must be resolved or explicitly accepted before
completion. The stage list remains here as the acceptance baseline. Automated checks
alone do not replace Windows/provider acceptance testing.

#### Stage 1 — single-screen equity readiness

- Enable right-click Buy / Long and Sell / Short on the session underlying in
  Paper, Replay and Stepwise. Equity exposes both directions regardless of the
  option `longOnly` preference; Browse remains read-only.
- Support editable whole-share quantity, capital-percentage sizing and
  stop-loss risk-percentage sizing for market-style, limit, target and AutoStop
  entries. Equity uses `right=null`; options retain complete contract identity.
- Capital allocation reserves 20% actual capital and permits 5x notional.
  Risk allocation is `session_capital * risk_fraction / stop_distance`, rounded
  down; reject zero-share results instead of forcing a share beyond the budget.
  Long stops must be below entry and short stops above it.
- Explain capital % as margin allocation and risk % as modeled loss against
  session capital. Existing wallet/P&L displays remain sufficient.
- Resolve sizing and lot validation from each traded instrument, including
  options attached to equity sessions, rather than the anchor instrument.
- Gate live candles by screen mode so live state cannot override Replay or
  Stepwise. Paper historical caching is best-effort; unsuccessful live contract
  subscription must not appear as successful attachment.

#### Stage 2 — margin and Paper safety

- Reserve 20% margin for the opening part of long and short equity orders;
  closes require no fresh margin and reversals reserve only the opening part.
- Preserve/release reservations through update, conversion, cancellation,
  fills, strategies, flatten, stop and recovery. Full price movement determines
  P&L; closing releases entry margin plus realized P&L.
- Make Paper initialization and wallet changes authoritative with conditional
  DynamoDB operations and retry identities. Persistence failure cannot silently
  accept spending. Persist the date's first-start lock, including after stop or
  restart, and enforce it from desktop and website reset paths.
- Select wallets by requested mode and reconstruct historical equity ledgers
  with margin-aware cash flows. Preserve historical-date Replay/Stepwise wallet
  sharing and existing session-capital initialization.
- Enforce one active Paper session per user/date/underlying, including concurrent
  starts and differing anchor types. Attach compatible existing sessions or
  explain conflicts. Independent desktop runs must coexist without inheriting
  an unrelated group's clock/date; website groups retain existing behavior.
- Expose ownership: Stop ends owned sessions; Detach stops consumption of shared
  sessions.

#### Stage 3 — screens and native windows

- Key mode, run/session references, ownership, snapshots, errors, tickets, ticks
  and stream lifecycle by screen. Persist mode and Browse `live_enabled`, and
  rediscover saved session references through authenticated endpoints.
- Share Paper wallets by user/date but isolate session orders, positions, P&L
  and clocks. Propagate wallet changes to other screens using that ledger.
- Scope Browse streams/reconciliation to the screen; closing/reconfiguring one
  screen must not stop others. Extend contracts with instrument lot size,
  ownership and wallet-lock status without breaking older clients.
- Child windows consume `screen_id` and render only that screen. Coordinate
  exclusive editing, focus, bring-back and close handoff; preserve saved screens
  on child close. Persist geometry with best-effort monitor restoration.
- Handle auth expiry, reconnect, stream resets and backend restart without
  routing events to another screen/session. Retain native SSE/recovery snapshots
  and browser polling fallback.

#### Required regression and acceptance coverage

- Exercise long/short × Paper/Replay/Stepwise × quantity/capital %/risk %, including
  right-click visibility, payload identity, invalid stops, zero-share sizing,
  insufficient margin, short reservations, partial closes and reversals.
- At 100,000 capital, 24% allocation permits 120,000 exposure using 24,000 margin;
  4.5% risk must model no more than 4,500 loss, subject to available margin.
- Cover update/convert/cancel, AutoStop, flatten, end-of-day cleanup, mixed
  equity/options lots/quotes/markers/strategies and wallet reconstruction.
- Exercise concurrent reservations and duplicate starts against DynamoDB Local,
  retries/stale caches, durable locks, website attachment, concurrent screens,
  historical-to-live switching and pop-out ownership.
- Finish with Windows/two-monitor/provider testing, auth/network reconnect and
  minimize/restore. Detailed manual regression steps will accompany implementation.

Development is on `dev`; PRs target `dev`, and merging to `main` stays manual.
Additional margin dashboards and richer Paper status UI remain deferred.

### Implementation Progress

Implemented so far:

- Desktop trading backend accepts `desktop_mode=paper` and maps it to `session_type=paper`.
- Desktop Paper uses a date-scoped Paper ledger id (`paper:{date}`) instead of a group-scoped ledger id.
- Order reservations persist the margin rate and ledger identity so update, convert, cancel, fill, and stop cleanup can release funds against the same wallet/ledger that created the reservation.
- Equity BUY orders in desktop simulated trading modes can reserve 20% margin while retaining full-notional P&L behavior.
- Website equity trading now supports broker-style 5x intraday buying power in Replay (`sim`), Stepwise, Paper, and Real sessions without changing existing session-start wallet/session-capital initialization.
- Website funds-ratio sizing treats the selected percentage as actual wallet capital usage. For example, 24% funds usage produces up to 120% notional exposure in equity while reserving only 24% actual wallet capital.
- Website equity fill settlement is margin-aware: entries consume 20% margin, closes return entry margin plus realized P&L, and P&L percentages remain calculated against actual session capital.
- Real website equity orders still send the full share quantity to the broker, while the local wallet display tracks actual capital/margin usage and realized P&L.
- Website wallet responses can include optional equity margin fields (`margin_used`, `available_margin`, `buying_power`, `exposure`, `margin_rate`) while preserving `balance` as the actual wallet value.
- Equity-anchored desktop sessions can attach same-underlying options and preserve option order identity (`right`, `strike`, `expiry`) and full-premium option reservation.
- Desktop Paper options now receive full contract quote identity for options-anchored sessions as well as equity-anchored sessions. Legacy CE/PE Paper ticks without `contract_key` are matched back to the registered desktop contract so market-style chart orders and P&L can use the authoritative contract quote registry.
- Desktop Paper can subscribe newly attached option contracts after the Paper live stream has started. For options-anchored sessions, the base CE/PE stream remains the owner for the active contract and extra subscriptions are only used when an attached/switch contract is outside the active base stream.
- The Windows desktop top-level mode selector now uses `Browse | Paper | Replay | Stepwise`.
- Browse exposes chart-only live controls (`Start Live`, `Stop Live`, refresh) and does not show trading controls.
- Paper exposes a single-screen trading start/stop flow, wallet/P&L/flatten controls, chart-order tools, trade labels, strategies, and snapshot recovery through the existing desktop trading facade.
- Desktop trading now exposes an authenticated SSE endpoint at `/api/desktop/v1/trading/{session_id}/events`. It enforces desktop auth/session ownership, supports `Last-Event-ID`, bounded replay through the session event queue, heartbeat comments, initial snapshot events, and stream-reset snapshot fallback after reconnect gaps.
- The Windows Paper view starts a native authenticated `paper:{session_id}` stream, applies tick/bar events incrementally, and fetches full authoritative snapshots only for initial/reset/recovery, state-changing trading events, and a slower reconciliation pass. Browser/non-native fallback still uses snapshot polling because browser `EventSource` cannot send the required desktop bearer header.
- Desktop pre-session wallet read/reset can target the Paper date ledger (`paper:{date}`) instead of always using the historical simulation ledger (`sim:{date}`).
- Tauri has native child-window commands for screen pop-out primitives: `open_screen_window(screen_id)`, `focus_screen_window(screen_id)`, and `close_screen_window(screen_id)`.
- The desktop shell has a "Pop out screen" action that opens/focuses a child window in native builds.
- Regression coverage exists for equity 20% margin reservation on the session ledger and mixed equity/options order identity inside an equity-anchored desktop session.
- Regression coverage exists for website 5x equity funds-ratio sizing and same-price leveraged equity round-trip wallet restoration.

#### Remaining concerns from code comparison — 2026-09-26

> **Completion callout:** Core trading, wallet, screen, and pop-out functionality
> exists in code. Phase 18 remains open pending the concerns and acceptance checks
> below. Automated tests do not establish Windows or live-provider acceptance.

- **Paper attachment ownership:** `windowsapp/src/App.tsx` determines
  `sharedTradingSession` from candidate attachment. However,
  `backend/app/routers/simulation.py::start_with_paper_claim()` can return an
  existing compatible session from the start request itself. This path can
  treat an attachment as owned and offer Stop instead of Detach. Return an
  explicit created/attached result and use it for client ownership decisions.
  Test a session appearing between candidate lookup and start, including a
  website-owned session. Snapshot `owned`, derived from `desktop_origin`, does
  not prove that the requesting screen owns the session.
- **Paper startup failure recovery:** the renderer creates the backend session
  before starting chart/live/native streams and records local trading state
  afterward. A stream startup failure can leave a running backend session with
  no local run reference. Retain the returned session immediately and support
  retry/reattach, or safely clean up a newly created session. Never stop an
  existing shared session as failure cleanup. Test live-start and native-stream
  failures separately.
- **Database concurrency validation:** `backend/tests/test_phase18_paper_wallet.py`
  uses Moto, with sequential overspending and duplicate-start checks. Required
  simultaneous-worker tests against DynamoDB Local remain outstanding. Exercise
  competing reservations/starts, receipt retries, stale caches, durable reset
  locks, and engine lease takeover; verify balances, persisted orders, and that
  only one engine remains active.
- **Manual acceptance:** execute the long/short × Paper/Replay/Stepwise × sizing
  matrix, mixed equity/options and order lifecycle checks, Windows/two-monitor
  pop-out tests, authentication/network/backend recovery, and live-provider
  checks below. Website capital display and sizing also need running-backend
  checks; Real trading requires broker-session validation.

Remaining native validation and agreed deferred work:

- Run the Windows/live-provider regression checklist below, including multiple monitors and authenticated reconnects. Linux unit tests do not validate WebView focus, native close events, monitor placement, or broker availability.
- Browser fallback continues snapshot polling; adding a header-capable browser SSE transport is deferred.
- Stronger Paper attach/status wording and additional margin dashboards remain deferred as agreed.
- **Callout:** The backend can block Stop for website-owned/shared Paper sessions that have no desktop origin. It does not yet carry a per-screen owner token, so it cannot distinguish two desktop windows attached to the same desktop-owned session purely server-side; that finer ownership guard remains a future API hardening item.

Implemented completion requirements:

- Equity right-click BUY and SELL entries, share quantities, editable capital/risk percentages, direction-aware stop validation, and 20% opening-margin reservation on both sides.
- Independent screen controllers and mode-gated live candles; per-screen persisted live/run state and stream keys.
- Paper date wallet lock, atomic wallet/order reservations and refunds, durable operation receipts, compatible-session claims and engine leases, and fill recovery.
- Assigned-screen pop-outs, focus/bring-back actions, saved geometry, and native close waiting for the latest screen save.
- Paper contract attachment tolerates unavailable historical caching while requiring a successful live subscription.
- Desktop Paper entry stop-loss automation now treats `desktop_paper` as an explicit desktop SL source and carries Paper ledger metadata onto generated stop-loss orders.

### Current Implementation Notes

- Scope clarification: the existing desktop wallet/P&L display is accepted. Additional desktop margin-used, available-margin, buying-power, exposure, and risk-amount displays are not required for Phase 18. Backend margin accounting, sizing, and validation remain required. The website equity wallet now shows one Capital value and hides leverage diagnostics from the UI, while keeping backend leverage and MaxSize validation. Stronger Paper attachment/status wording is a deferred P2 UI improvement.
- Fixed the subsequent snapshot review P1/P2: native Paper tick updates preserve authoritative realised day P&L and commissions, applying only open-position mark changes; position P&L includes backend-equivalent exit charges. Trading snapshots now carry `event_cursor` and SSE events carry `event_id`, so buffered events already included in a recovery snapshot and obsolete recovery snapshots cannot overwrite newer renderer state. Added renderer regression coverage for closed profits, long/short options, equity with options, same-second buffered events, duplicate events, and stale recovery responses. Native Windows/live-provider validation remains outstanding.
- Fixed Desktop Paper P1 review findings: base live option subscriptions retain their original strike/expiry identity; switched contracts receive separate subscriptions, and old base ticks cannot be attributed to the newly selected strike. Paper starts use today's IST market date, with backend rejection of historical dates. Mode changes require stopping/detaching the active run and clear ended-session state. Live tile reconciliation now runs in Paper as well as Browse so instrument changes update chart subscriptions.
- Implemented the authenticated desktop trading event endpoint. It reuses the existing per-session replay queue rather than adding a parallel Paper event bus, so fills, ticks, order events, broker errors, and session-ended events stay in the same ordering as the simulation engine. Initial connections receive a full snapshot, reconnects resume after `Last-Event-ID`, and stale reconnect cursors or active-stream queue gaps receive a `stream_reset` snapshot.
- Wired Desktop Paper in the Windows renderer to start/stop a native `paper:{session_id}` stream. Native Paper now consumes tick/bar events directly for price/time/P&L movement, collapses native batches into at most one recovery snapshot, fetches full snapshots for state-changing trading events, and keeps a slower 30 second reconciliation snapshot for safety. This replaces the frequent Paper full-snapshot path in native builds; browser fallback still polls snapshots because authenticated SSE needs request headers.
- Fixed Paper stream lifecycle/recovery edge cases found during review: failed Stop no longer stops the native stream before the backend session stop succeeds, failed snapshot recovery stays marked for retry, and obsolete/in-flight native recovery is serialized per session effect.
- Added backend regression coverage for historical Paper date rejection and switched-contract subscription/old-tick identity. Native Windows/live-provider validation remains outstanding.
Backend files touched in the current partial implementation:

- `backend/app/routers/desktop_trading.py`
  - `DesktopTradingStartRequest.desktop_mode` now accepts `paper`.
  - `/api/desktop/v1/trading/start` maps `desktop_mode=paper` to `session_type=paper` and `stepwise=false`.
  - `/candidate` and `/active` accept `paper` in their mode filters.
  - `_desktop_source()` returns `desktop_paper` for Paper-mode sessions.
  - Equity-anchored sessions can attach same-underlying option contracts. The old `session.instrument_type == "options"` gate was removed from contract attach.
  - `place_order()` validates option contract identity whenever the request has `right`, even when the session anchor is equity.
  - `place_chart_order()` now accepts both equity chart orders and option chart orders:
    - equity orders use the session's `last_price` as the authoritative quote for market-style chart entries
    - option orders still require an attached contract and use contract quote lookup
  - `/wallet?desktop_mode=paper` reads the Paper date ledger (`paper:{date}`) when there is no active session.
  - `/wallet/reset?desktop_mode=paper` resets the Paper date ledger before an active desktop session starts.
  - `/api/desktop/v1/trading/{session_id}/events` is authenticated with the desktop auth dependency and enforces user ownership before streaming. It emits full `snapshot`/`stream_reset` payloads for initial/gap recovery and raw ordered session events for incremental updates, including reset recovery if an already-connected reader falls behind the bounded queue.
- `backend/app/routers/orders.py`
  - `_desktop_order_source()` recognizes `desktop_paper`.
  - `_wallet_balance_for_session()` reads the owning session ledger when available, so desktop simulated sessions do not accidentally size orders against the legacy date wallet.
  - `_uses_equity_intraday_margin(session, order_right)` applies 20% margin to equity orders in website `sim`, `stepwise`, `paper`, and `real` sessions. It is intentionally order-instrument aware: same-underlying option orders inside an equity-anchored session keep full-premium option reservation.
  - `order_service.place_order()` now receives `wallet_ledger_id` and `wallet_ledger_kind` when a session owns a ledger, so reservation debit/release happens on the correct ledger.
  - Pending order funds-ratio and risk-ratio quantity calculations pass the applicable margin rate. Equity funds-ratio uses 5x buying power; risk-ratio still sizes from actual stop-loss risk and then validates required margin.
  - Real-session broker stop-loss callbacks settle the local wallet through margin-aware fill accounting and release reserved margin if Kotak rejects/fails the order.
- `backend/app/services/order_service.py`
  - `Order` placement persists reservation metadata:
    - `reservation_margin_rate`
    - `wallet_ledger_id`
    - `wallet_ledger_kind`
  - Reservation adjustment helpers centralize ledger-aware debit/credit for cancel, update, conversion, and SELL fill credit.
  - Updating a pending BUY order's price or quantity recomputes reserved amount using the order's original `reservation_margin_rate`, preventing accidental reversion from 20% margin to 100% notional.
  - Converting a BUY order between TARGET and LIMIT also preserves the original margin rate and ledger.
  - `compute_funds_ratio_quantity()` and `compute_risk_ratio_quantity()` accept an optional `margin_rate`. Existing callers default to `1.0`; equity leverage callers pass `0.20`.
  - `check_orders()` accepts `settle_wallet=false` so simulation/real loops can record fills and settle margin-aware wallet cash flow in one place instead of always crediting full SELL notional.
- `backend/app/services/trading.py`
  - Adds `settle_wallet_for_trade()`, the shared wallet settlement helper for fills.
  - For leveraged equity entries, it debits 20% margin unless the order already reserved entry margin.
  - For leveraged equity closes, it credits released entry margin plus realized P&L. A same-price round trip restores the wallet to the pre-trade actual capital.
  - For real broker fills, the broker quantity remains full quantity, but local wallet settlement stays actual-capital based.
  - Non-leveraged instruments keep legacy full-value debit/credit behavior.
- `backend/app/services/simulation.py`
  - Trade recording now tags option orders as `instrument_type="options"` when `order.right` is present, even if the session anchor is equity.
  - This is important for mixed equity/options sessions because downstream position, P&L, and history code must not infer every trade's instrument type from the session anchor.
  - Sim/Paper/Stepwise and Real fill loops call `check_orders(..., settle_wallet=false)` and then use `settle_wallet_for_trade()` before recording the trade.
  - Real broker callbacks for triggered TARGET/LIMIT orders and broker-side STOPLOSS orders also use the shared settlement helper.
  - Paper option ticks with no `contract_key` are enriched from registered desktop contracts before quote registry updates, so options-anchored Paper sessions expose `contract_quotes` in the same shape as mixed equity/options sessions.
  - Dynamic desktop option subscriptions are no longer limited to equity-anchored Paper sessions; options-anchored sessions can subscribe switched/attached contracts while avoiding duplicate subscription for the active base CE/PE stream.
- `backend/app/routers/trading.py`
  - Immediate website buy/sell endpoints now use the same equity margin model as pending orders.
  - Funds-ratio immediate buy/sell passes `margin_rate=0.20` for leveraged equity, so the ratio controls actual capital usage and quantity uses 5x buying power.
  - Direct Real fills use margin-aware local settlement while broker orders still use full quantity.
- `backend/app/services/strategy_service.py`
  - AutoStop funds-ratio/risk-ratio quantity calculations use the session wallet ledger and the equity margin rate when applicable.
  - AutoStop entry orders pass margin rate and ledger metadata to `order_service.place_order()`.
- `backend/app/routers/wallet.py`
  - `/api/wallet?session_id=...` still returns `balance` as actual wallet capital.
  - For leveraged equity sessions, the response can also include margin/buying-power diagnostics: `session_capital`, `margin_used`, `available_margin`, `buying_power`, `exposure`, and `margin_rate`.
- `backend/app/routers/simulation.py`
  - Paper sessions now use `wallet_ledger_id = paper:{date}`.
  - Persistent first-start reset locking and transactional wallet/order movements are implemented in `paper_wallet.py`. Concurrent-worker validation against DynamoDB Local remains outstanding; focused wallet coverage currently uses Moto.
- `backend/app/models/schemas.py`
  - `Order` has reservation metadata fields for margin rate and ledger identity.
  - `WalletResponse` has optional margin/buying-power fields; existing clients can continue reading `balance` only.
- `backend/tests/test_desktop_trading.py`
  - Added regression coverage for 20% equity margin reservation on the session ledger.
  - Added regression coverage for same-underlying option order identity and full-premium option reservation inside an equity-anchored desktop session.
  - Added regression coverage for desktop trading event auth, initial snapshot delivery, and bounded replay gap reset.
- `backend/tests/test_equity_leverage.py`
  - Added coverage that 24% funds-ratio equity sizing at 5x creates 120% notional exposure.
  - Added coverage that a same-price leveraged equity round trip restores the actual wallet.

Frontend files touched in the website leverage implementation:

- `frontend/src/services/api.ts`
  - `WalletResponse` includes optional margin/buying-power diagnostics.
- `frontend/src/components/WalletWidget.tsx`
  - Shows a single `Capital` value for leveraged equity sessions by adding committed equity margin back to the free wallet balance.
  - Hides buying-power, exposure, and margin diagnostics from the UI; those values remain backend-only validation data.
- `frontend/src/components/OrderPanel.tsx`
  - Renames funds-ratio label from "Capital Ratio" to "Capital Used".
  - Adds an equity hint that 5x buying power affects quantity while wallet usage remains the selected percentage.

Desktop files touched in the current partial implementation:

- `windowsapp/src-tauri/src/lib.rs`
  - Adds native commands `open_screen_window`, `focus_screen_window`, and `close_screen_window`.
  - Child windows use stable labels formatted as `screen:{screen_id}`.
  - Child routes use `?screen_id=...`; the renderer consumes the assigned screen id so the child renders only that screen.
  - Native windows persist/restore geometry best-effort and the main window offers focus/bring-back ownership controls.
- `windowsapp/src/App.tsx`
  - Replaces the old top-level `Live` mode with `Paper`.
  - Browse now owns chart-only live stream controls and remains read-only.
  - Paper now starts the desktop trading facade directly, keeps the chart workspace on live candles, attaches option tiles as contracts, consumes native trading events incrementally where available, and exposes the existing wallet/P&L/flatten/order/strategy controls.
  - Adds a "Pop out screen" button beside the existing screen actions.
  - In native builds it calls `open_screen_window`.
  - In browser/dev preview it shows a message that pop-out is native-only.
  - The authenticated Paper trading event stream is implemented for native Windows builds; browser/non-native fallback still uses snapshot polling because authenticated SSE needs request headers.

Complicated points and callouts:

- Website equity leverage is implemented for Replay (`sim`), Stepwise, Paper, and Real order paths. Desktop Windows/live-provider validation remains outstanding; broader desktop margin/buying-power display is not required.
- Remaining validation for the website 5x leverage requirement:
  - Full real-broker reconciliation semantics for leveraged local wallet display. Kotak fund sync remains authoritative and may overwrite local margin-display state after manual/out-of-band broker activity.
  - Broad end-to-end manual validation in live Real trading. The code paths are wired for Kotak callbacks, but this needs careful broker-session validation before treating it as production-proven.
- Existing session-start wallet/session-capital logic is intentionally unchanged. The wallet value used for sizing and P&L remains whatever the session already captures at start/resume today.
- `balance` is actual wallet capital, not leveraged exposure. Leverage affects allowed quantity/notional and required margin only.
- Funds-ratio means actual capital usage. Example: 24% funds usage on equity reserves 24% of the wallet and can create 120% notional exposure.
- Risk-ratio remains actual-capital based. Leverage does not multiply the stop-loss risk amount; it only decides whether the derived quantity can be afforded by 20% margin.
- P&L amount is full share quantity times price movement. P&L percentage remains `P&L / session_capital`, not `P&L / exposure`.
- Same-price leveraged equity round trips must restore actual wallet capital. This is why close settlement credits released entry margin plus realized P&L instead of full SELL notional.
- Mixed equity/options sessions must make margin decisions per order, not per session. A session anchored to equity can still place option orders; those option orders must keep lot sizing, premium funding, and option identity exactly as existing option sessions do.
- Paper shared wallet support uses the date-scoped `paper:{date}` ledger, persistent first-start lock, backend reset rejection after first start, conditional wallet/order movements, durable receipts, and engine leases.
- The desktop Paper backend can start via the facade and the Windows UI now has a usable Paper run mode with authenticated native Paper trading events, persisted per-screen Paper/live stream lifecycle, screen-scoped streams, and shared-wallet lock semantics. Stronger attach/detach status wording remains a deferred UI polish item.
- Browse live is reachable from Browse and persisted/restored as a per-screen `live_enabled` lifecycle.
- Important implementation learning: options-anchored Paper sessions used the legacy CE/PE tick path, which did not populate the desktop `contract_quotes` registry. Chart market orders depend on that registry, so Paper options must enrich every option tick with full contract identity before order placement and P&L use it.
- Pop-out support now opens native child windows that render the assigned screen id only, persists geometry best effort, and lets the main window focus or bring back popped screens.
- `check_orders()` still supports legacy full-notional SELL credit by default, but simulation/real loops now call it with `settle_wallet=false` and then use `trading.settle_wallet_for_trade()` for margin-aware settlement.
- Paper recovery restores orders through `order_service.reload_paper_orders()` using `Order.model_validate(record)`, preserving reservation margin rate and ledger identity and repairing recorded fills. This restore path is implemented; backend-restart acceptance must still verify complete session/order/wallet recovery.
- **Callout:** per-screen backend ownership is still coarse. The backend can reject Stop for website-owned/shared Paper sessions with no desktop origin, but it cannot distinguish two desktop windows attached to the same desktop-owned session without a future per-screen owner token.
- Potential issue: real broker reconciliation resets/syncs wallet from Kotak funds. That remains authoritative for real sessions and can override local margin-display state after out-of-band broker activity.
- Existing focused verification after this partial implementation:
  - `~/venvs/tradematangi/bin/python -m pytest backend/tests/test_equity_leverage.py backend/tests/test_sprint2_funds_ratio_stoploss.py::TestComputeFundsRatioQuantity backend/tests/test_order_service.py::TestSLWalletCredit backend/tests/test_order_service.py::TestCancelAllPendingOrders -q`
  - `~/venvs/tradematangi/bin/python -m pytest backend/tests/test_desktop_trading.py::test_desktop_equity_buy_orders_reserve_intraday_margin_on_session_ledger -q`
  - `~/venvs/tradematangi/bin/python -m py_compile backend/app/services/order_service.py backend/app/routers/orders.py backend/app/services/trading.py backend/app/services/simulation.py backend/app/routers/trading.py backend/app/services/strategy_service.py backend/app/models/schemas.py backend/app/routers/wallet.py`
  - `cd frontend && node node_modules/typescript/bin/tsc --noEmit`
  - `~/venvs/tradematangi/bin/python -m pytest backend/tests/test_order_service.py backend/tests/test_desktop_trading.py -q`
  - `cd windowsapp && node node_modules/typescript/bin/tsc --noEmit`
  - `cd windowsapp/src-tauri && cargo check`
  - `cd windowsapp && node node_modules/typescript/bin/tsc --noEmit`
  - `AWS_MAX_ATTEMPTS=1 ~/venvs/tradematangi/bin/python -m pytest backend/tests/test_equity_leverage.py backend/tests/test_desktop_trading.py -q --tb=short --show-capture=no`
  - `AWS_MAX_ATTEMPTS=1 ~/venvs/tradematangi/bin/python -m py_compile backend/app/services/simulation.py backend/app/routers/desktop_trading.py`
- Latest review-fix validation:
  - `AWS_MAX_ATTEMPTS=1 python /tmp/phase18-run-tests.py backend/tests/test_desktop_trading.py backend/tests/test_equity_leverage.py backend/tests/test_phase18_paper_wallet.py`: **105 passed**
  - `AWS_MAX_ATTEMPTS=1 python /tmp/phase18-run-tests.py backend/tests/test_order_service.py backend/tests/test_desktop_trading.py`: **69 passed**
  - `git diff --check`: passed

### Summary

Phase 18 separates chart-only live monitoring from simulated trading, expands equity day-trading practice across all desktop simulated trading modes, and adds multi-window screen workflows:

- **Paper mode** is a live paper-trading cockpit. It reuses the existing backend paper-trading engine and the Phase 17 desktop trading facade, so the desktop gets the same order, position, strategy, wallet, P&L, trade-history, and chart-order features already available in Desktop Replay/Stepwise trading.
- **Replay and Stepwise** gain the same equity intraday margin model as Paper for historical practice: 20% margin reservation, 5x buying power validation, risk sizing against session capital, and P&L from full notional movement.
- **Website Replay, Stepwise, Paper, and Real** now also use the equity intraday margin model for equity orders. The session wallet value remains the actual wallet/session capital captured by existing session-start logic; leverage changes quantity/buying power and margin reservation only.
- **Browse live** is chart-only live streaming inside Browse. It lets one or more Browse screens stream their configured symbols without creating a trading session or showing any trading controls.
- **Pop-out screens** let users move a saved desktop screen into its own native window, so one screen can run on another monitor without creating an independently editable duplicate.

The intended workflow is: run Paper sessions for different symbols on separate desktop screens, practice equity day trading in live Paper or historical Replay/Stepwise, trade an underlying and its options within the same equity-anchored session, monitor other live symbols through Browse screens or the website, and place selected screens on separate monitors. Paper sessions for one trading date use the shared Paper wallet; Replay and Stepwise use their own session simulation wallet/capital.

Real broker order placement from the desktop remains out of scope for this phase.

### Product Decisions

- Rename the top-level desktop mode from `Live` to `Paper`.
- Remove the old meaning of top-level `Live` as chart-only streaming.
- Replace `Browse | Live | Replay | Stepwise` with `Browse | Paper | Replay | Stepwise`.
- Treat `Paper`, `Replay`, and `Stepwise` as desktop trading modes.
- Add a per-screen Browse live toggle, persisted with each desktop screen.
- Keep Browse live screen-scoped, not app-global. Each enabled screen owns its own stream lifecycle.
- Each Paper session is anchored to one underlying symbol and one trading date. Multiple screens may host Paper sessions for different symbols on that date. Starting the same symbol/date in a second screen is not supported for now; the UI should offer to attach to the existing session or direct the user to its screen.
- An equity-anchored Paper, Replay, or Stepwise session can contain equity trades and option trades for that same underlying. For example, a Reliance session can trade Reliance shares and a RELIANCE CE contract. Options retain their full contract identity, expiry handling, lot size, strategies, markers, and P&L behavior.
- Cross-underlying edits and option contracts are rejected in active simulated trading sessions in both backend and UI.
- A desktop Paper start attaches to an already-running compatible website Paper session for the same user, symbol, and date instead of silently creating a duplicate.
- All Paper sessions for the same user and trading date share one wallet ledger. The wallet may be initialized/reset when the first Paper session for that date starts. Once any Paper session for that date is underway, the wallet cannot be reset or changed; other symbol sessions use the existing balance and reservations.
- Replay and Stepwise equity margin use that session's simulation wallet/capital, not the shared Paper date wallet.
- Equity trades in Paper, Replay, and Stepwise use 5x intraday buying power with 20% margin reservation. Risk percentages always refer to wallet/session capital at risk if the configured stop loss is hit. Leverage changes allowable notional and margin reservation; it does not multiply the stop-loss risk or profit/loss calculation.
- Website Replay, Stepwise, Paper, and Real equity trades follow the same 5x/20% rule. This does not change how wallet/session capital is initialized at session start.
- Funds-ratio sizing means actual capital used, not notional exposure. At 5x, a 24% capital-use order can create up to 120% notional exposure while reserving 24% actual capital.
- P&L % is always measured against actual wallet/session capital. It is never measured against leveraged notional exposure.
- Detaching or closing the desktop Paper view stops desktop event consumption only. Explicit Stop ends the backend paper session.
- Browse live and trading streams must be independent; stopping or reconnecting one must not disturb the other.
- Popping out a screen moves visible ownership of that screen to the child window. It does not create an independently editable duplicate.
- The main window remains the primary login and workspace shell.

### Backend Plan

Generalize the existing authenticated desktop trading facade under `/api/desktop/v1/trading` instead of creating a second desktop paper API.

Required changes:

- Extend `DesktopTradingStartRequest.desktop_mode` from `stepwise | replay` to `stepwise | replay | paper`.
- For `desktop_mode=paper`, start or attach using `session_type=paper`, `stepwise=false`, and the existing paper `SimulationSession` engine.
- Return `desktop_mode="paper"` and `source="desktop_paper"` in desktop trading snapshots.
- Extend `/candidate` and `/active` to find compatible active Paper sessions and existing Paper records.
- Reuse existing desktop trading endpoints for Paper:
  - snapshot
  - attach option contract
  - place, update, cancel, convert, and bulk-convert orders
  - start, update, cancel, and cancel-all strategies
  - wallet read/reset where applicable
  - flatten
  - trade history, positions, P&L, and settings
- Add an authenticated desktop event endpoint, e.g. `GET /api/desktop/v1/trading/{session_id}/events`, backed by the session replay queue.
  - Require desktop identity and user ownership.
  - Support monotonic event IDs, `Last-Event-ID`, bounded replay, heartbeats, reconnect, and snapshot fallback after gaps.
  - Keep `/api/stream/{session_id}` behavior for the website; desktop must not depend on unauthenticated session streams.
- Preserve the existing paper engine for fills, tick handling, wallet accounting, guardrails, strategies, session resume, and provider selection. Do not build a parallel simulator.
- Give all Paper sessions for a user/date the same ledger id (for example, `paper:{date}`), replacing group-scoped Paper ledgers. Session creation, resume, order sizing, reservation, fill, cancellation, and close-out must consistently use this ledger rather than the legacy global wallet helpers.
- Protect shared-wallet balance and reservation updates against concurrent orders from separate Paper sessions so two screens cannot spend the same available balance.
- Permit different-symbol Paper sessions to run concurrently for the same user/date. Enforce uniqueness for an active user/date/underlying Paper session so the same underlying cannot be started independently on two screens.
- Allow wallet reset only before the first Paper session for that user/date has started. Persist a date-level started/locked state so stopping all sessions does not make the wallet resettable again. Reset/change attempts after that point must be rejected by the backend.
- Introduce a shared equity intraday margin model for desktop simulated modes: Paper, Replay, and Stepwise.
  - BUY orders reserve `notional × 0.20`.
  - Available equity buying power is unreserved wallet/session capital multiplied by 5, with any existing broker-style limits applied consistently.
  - Paper uses the shared user/date Paper wallet.
  - Replay and Stepwise use the current session's simulation wallet/capital.
  - SELL/short eligibility follows the existing mode-specific rules and must not be inferred from long buying power.
- Keep risk sizing capital-based: `risk_amount = wallet_or_session_capital × risk_pct`; quantity is derived from `risk_amount / abs(entry_price - stop_loss_price)`, rounded down to whole shares. Validate the resulting position notional against 5x buying power. At a 4.5% risk setting, the modeled stop loss must be no more than 4.5% of wallet/session capital. For example, if a chosen trade allocation equals 22.5% of capital, 5x buying power permits notional up to 112.5% of capital, while the stop-loss risk still remains capped at 4.5% of capital.
- Calculate realized and unrealized equity P&L from full notional and price movement, not from the 20% margin reserved.
- Apply the equity margin model consistently in Paper, Replay, and Stepwise order placement, chart orders, updates, conversion, cancellation, fills, close-out, and flatten.
- Release the corresponding equity margin reservation as orders fill, cancel, convert, flatten, or positions close.
- Persist the applicable margin rate with each equity order/reservation, or derive it reliably from the owning session and instrument, so order update and conversion paths preserve the 20% reservation instead of reverting to full-price reservation.
- Preserve options behavior: lot sizing, premium funding, contract identity, expiry/strike/right scoping, strategies, markers, and P&L remain as today.
- Website equity leverage implementation requirements:
  - Apply the same 20% equity margin rate to website `sim`, `stepwise`, `paper`, and `real` equity orders.
  - Do not change session-start wallet/session-capital initialization.
  - Funds-ratio quantity calculation must divide selected capital usage by the margin rate before dividing by price.
  - Risk-ratio quantity calculation remains stop-loss-risk based and only uses leverage as an affordability/margin validation input.
  - Pending orders, immediate buy/sell, AutoStop entries, real broker callbacks, and simulated fills must settle through the same margin-aware wallet rules.
  - Closing a leveraged equity position credits released entry margin plus realized P&L; it must not credit full SELL notional to the actual wallet.
  - Real broker placement must continue to send full quantity to Kotak while local wallet/margin display remains actual-capital based.
  - Options and same-underlying option orders inside equity-anchored sessions remain full-premium funded and do not inherit equity leverage.
- Keep real-trading endpoints, broker order placement, and broker credentials unavailable to Desktop Paper.
- Keep `/api/desktop/v1/live` as chart-only Browse live infrastructure.
  - It remains read-only and must not import or mutate trading state.
  - It should continue to provide start, snapshot, stop, tile configure/remove, refresh, and events for screen-level tile streams.
  - Multiple streams for the same user must coexist.
  - Provider fan-out should be reused or improved so Browse live and Paper do not create unnecessary duplicate broker connections.

Session and contract rules:

- Paper, Replay, and Stepwise start from the active chart's underlying context. A session may trade that equity and any attached options whose underlying symbol matches it.
- Option/index sessions use the same ATM/expiry resolution rules as existing paper/replay/stepwise trading.
- Attached option contracts use full identity: `underlying symbol + expiry + strike + right`, and each option trade is tagged as an option even when the session anchor is equity.
- Equity and option orders, positions, trade history, and P&L must retain their own instrument type inside the shared session. Do not infer every trade's instrument type from the anchor session type.
- Contract quote subscriptions and lookup for Paper must support multiple attached contracts by full contract identity alongside the underlying equity feed.
- A single active trading session cannot switch to another underlying. The response should tell the user to use another screen/session.
- Same-right strike switching must respect the existing risk rule: do not switch away from a contract that has open position, pending orders, or active strategy risk.

### Desktop Frontend Plan

Update the Windows desktop app around a clear mode model:

- Replace `Browse | Live | Replay | Stepwise` with `Browse | Paper | Replay | Stepwise`.
- Update shared contracts so `RunState.mode` and mode predicates include `paper` and do not treat `live` as a trading mode.
- Treat `Paper`, `Replay`, and `Stepwise` as desktop trading modes for the left rail, chart order lines, strategy controls, wallet/session capital, P&L, flatten, and trade history.
- Treat Browse live as a property of a Browse screen, not as `mode=Live`.
- Enable equity chart order entry in Paper, Replay, and Stepwise when the active session is equity anchored.
- Keep the existing wallet/P&L display in desktop trading modes; additional equity margin/buying-power fields are not required.
- Ensure risk percentage text says the loss is measured against wallet/session capital if stop loss hits.
- Keep Paper multi-session state keyed by screen/session id, with the shared wallet reflected across all Paper sessions for the same date.
- Keep Replay and Stepwise session state scoped to their own session/screen.

Browse live behavior:

- Persist `live_enabled` in each screen's saved state.
- Store live snapshots, tick caches, stream keys, errors, and native stream subscriptions by screen id.
- Starting Browse live starts a stream for the current screen's tiles.
- Editing tiles on an enabled Browse live screen updates only that screen's stream.
- Disabling Browse live or closing a screen stops only that screen's stream.
- Switching to Paper/Replay/Stepwise must not accidentally stop Browse live streams on other screens.
- Historical Browse dates cannot start live streaming. Show a clear message that live data is available only for the current market date.
- Browse live charts use existing historical candles plus live tick aggregation/reconciliation. Trading controls, wallet, P&L, strategies, flatten, order markers, and order actions remain hidden.

Paper behavior:

- Starting Paper calls the desktop trading facade with `desktop_mode=paper`.
- Each Paper screen owns its own session state, keyed by screen/session id. The frontend must support concurrent Paper sessions for different symbols, while refusing duplicate same-symbol/date starts and showing the existing-session attach path.
- The frontend checks for a compatible active/existing Paper session before starting and offers attach/continue or start-another-symbol choices consistent with Stepwise/Replay flows. Starting another session must never reset the shared wallet.
- Paper subscribes to authenticated desktop trading events and keeps an authoritative snapshot polling or recovery path.
- Paper chart candles merge historical baseline data with live paper ticks.
- Paper order/fill markers, order lines, positions, wallet, P&L, strategies, and trade history use the same desktop state model as Replay/Stepwise.
- Active Paper sessions lock the instrument picker date and underlying. Same-underlying option tiles can be attached; cross-underlying edits show guidance before the backend rejects them.
- Show shared wallet balance and session P&L using the existing display. Equity margin accounting and risk sizing remain backend requirements; additional margin/buying-power displays are not required.
- Equity chart order entry is enabled in Paper. Option chart order entry remains available for attached same-underlying option tiles, using contract lot size and existing option controls.
- P2 (deferred UI improvement): enhance the Paper session indicator to distinguish:
  - new desktop-owned session
  - attached/shared website session
  - broker feed reconnect/error
  - auth/session expiry

Native stream handling:

- Use distinct native stream keys for Browse live and trading streams, for example `browse-live:{screen_id}:{stream_id}`, `paper:{session_id}`, `replay:{session_id}`, and `stepwise:{session_id}`.
- Browse live and trading stream keys must remain screen/session scoped across windows.
- Token refresh/auth expiry must not corrupt screen state. On authentication failure, stop affected streams, keep persisted screen configuration, and ask the user to sign in again.
- Backend restart should surface a recoverable error and allow users to reattach/start again without losing persisted screens.

### Multi-window Desktop Plan

Add native Tauri child-window support for saved desktop screens:

- Add a "Pop out screen" action near the existing screen actions.
- Add Tauri commands such as `open_screen_window(screen_id)`, `focus_screen_window(screen_id)`, and `close_screen_window(screen_id)`.
- Open child windows with stable labels like `screen:{screen_id}` and route/query state such as `?screen_id=...`.
- A popped window renders exactly one assigned screen with its chart grid, tools, Browse live toggle, Paper/Replay/Stepwise controls, and trading state.
- One visible window owns a screen at a time.
  - The main window marks popped screens as opened externally.
  - Main-window actions for popped screens offer focus/bring back instead of simultaneous editing.
  - A popped screen cannot be edited simultaneously from two windows.
- Closing a popped window does not delete the screen. It detaches only that window and leaves the persisted screen available.
- Persist child window size, position, maximized state, and restore best effort on the same monitor.
- The main window remains responsible for login/session setup. Child windows should handle auth refresh and expiry using the shared desktop auth state without corrupting the screen.
- Browse live, Paper, Replay, and Stepwise state must remain keyed by screen/session across windows, so moving a screen between windows does not merge streams or sessions.

### Concurrent Workflow Requirements

The implementation must support:

- Paper trading one symbol in Desktop Paper while live-monitoring other symbols in Browse.
- Practicing equity day trading in Replay and Stepwise with 5x buying power and full-notional P&L.
- Running multiple Paper sessions for different symbols on separate screens on the same trading date, with a shared wallet and independent session state.
- Buying/selling an underlying equity and trading its attached same-underlying options in the same equity-anchored simulated session.
- Simultaneous orders from separate Paper sessions cannot reserve or spend more than the shared wallet and its 5x equity buying power allow.
- Multiple Browse screens streaming different symbol sets at the same time.
- One Browse screen being closed, disabled, reconfigured, reconnected, or moved to another window without stopping other Browse screens or trading sessions.
- The website and desktop attaching to the same compatible Paper session for the same user.
- Two screens open on two monitors, with one running Paper and another running Browse live, Replay, or Stepwise.
- Desktop minimize/restore, token refresh, auth expiry, network loss, backend restart, provider reconnect, stream reset, and child-window close/reopen without cross-screen state corruption.

### Acceptance Criteria

- Desktop mode switch shows `Browse`, `Paper`, `Replay`, and `Stepwise`; the old top-level `Live` trading/chart mode is removed.
- Browse screens can enable live data for their configured symbols without exposing trading controls.
- Two Browse screens can stream different symbol sets simultaneously.
- Paper can start from desktop, attach to a compatible website Paper session, and display live chart ticks.
- Multiple Paper sessions for different symbols can run on separate screens for one user/date and see the same wallet balance and reservations.
- A second active session for the same symbol/date is rejected or attaches to the existing session; it cannot create a duplicate independent session.
- The shared Paper wallet can be reset before the first session starts for that date and cannot be reset or changed after any session starts, including after the session is stopped.
- Equity BUY orders in Paper, Replay, and Stepwise use 20% margin reservation and 5x buying power, while stop-loss risk percentage is calculated from wallet/session capital and P&L uses full notional movement.
- Website Replay, Stepwise, Paper, and Real equity BUY orders use 20% actual wallet margin and 5x buying power without changing the existing session-start wallet value.
- A website funds-ratio equity order with 24% capital usage creates up to 120% notional exposure and reserves approximately 24% actual wallet capital.
- Closing a leveraged website equity position at the same price restores actual wallet balance to the pre-trade value, excluding normal charges if those are later applied to wallet settlement.
- Equity risk sizing rounds down to whole shares and rejects orders whose notional exceeds available 5x buying power.
- Updating, converting, cancelling, filling, flattening, and close-out for equity orders preserve and correctly release the margin reservation.
- An equity-anchored Paper/Replay/Stepwise session can trade its underlying shares and attached same-underlying options, with option lot sizing and per-instrument P&L/position reporting.
- Paper exposes the same practical desktop trading feature set as Replay/Stepwise:
  - chart order entry
  - order placement, update, cancellation, conversion, and bulk conversion
  - order and fill markers
  - draggable order and strategy lines
  - positions and average entry
  - wallet, realized/unrealized P&L, and day P&L
  - strategy lifecycle controls
  - flatten
  - trade history
- Cross-underlying edits are rejected for active simulated trading sessions.
- Explicit Stop ends a desktop-owned Paper session. Detach/close only stops desktop consumption for attached/shared sessions.
- Browse live and Paper streams recover independently from reconnect, stream reset, token refresh, and backend restart.
- Pop-out opens the requested screen id and renders only that screen.
- The main window marks popped screens as opened externally and offers focus or bring back.
- Closing a popped screen window detaches the window without deleting the saved screen.
- Child window size, position, and maximized state are restored best effort.
- Real broker order placement is not exposed from Desktop Paper.

### Test Plan

Backend:

- Desktop Paper start maps to `session_type=paper` and uses the existing paper engine.
- Paper start/attach/candidate/active/snapshot/stop enforce desktop auth and user ownership.
- Existing website Paper sessions can be discovered and attached.
- Desktop Paper event stream supports `Last-Event-ID`, bounded replay, heartbeats, gap reset, and snapshot recovery.
- Another user cannot read, stream, or mutate a Paper session.
- Paper order, strategy, wallet, position, P&L, flatten, and contract attach endpoints work through `/api/desktop/v1/trading`.
- Cross-underlying Paper/Replay/Stepwise changes are rejected.
- Equity margin model applies consistently in Paper, Replay, and Stepwise.
- Website equity margin model applies consistently in Replay (`sim`), Stepwise, Paper, and Real for pending orders, immediate buy/sell, AutoStop entries, simulated fills, and real broker callbacks.
- A website funds-ratio equity order at 24% capital usage produces 5x quantity and reserves only 24% actual capital.
- A same-price leveraged website equity round trip restores the actual wallet to the pre-trade value.
- A 4.5% risk setting means max modeled stop-loss loss is 4.5% of wallet/session capital.
- A trade allocation of 22.5% wallet/session capital can produce up to 112.5% notional exposure under 5x buying power.
- Order update, convert, cancel, fill, flatten, and close-out preserve/release the 20% margin reservation.
- Paper shared wallet rejects concurrent over-reservation across multiple sessions.
- Equity and option trades inside one equity-anchored session retain correct instrument identity and P&L.
- Browse live start/stop/configure/refresh/events remain user-scoped and read-only.
- Multiple Browse live streams can coexist for one user with different tiles.
- Browse live and Paper subscriptions do not create uncontrolled duplicate provider connections.

Desktop unit/integration:

- Mode labels and mode predicates handle `Paper` correctly.
- `Browse | Paper | Replay | Stepwise` mode handling supports equity order entry where allowed.
- Per-screen `live_enabled` state persists and restores.
- Browse live stream state is keyed by screen id, not a single global `live` snapshot.
- Browse live does not render trading controls or mutate trading state.
- Browse live tile edits affect only that screen's stream.
- Paper snapshots/events update candles, orders, fills, positions, wallet, P&L, strategies, and trade history.
- Existing wallet/P&L display updates after equity orders and fills; additional margin/buying-power display is out of scope.
- Paper state, stream subscriptions, and order events are isolated per screen/session while wallet changes are reflected across all sessions for that date.
- Replay and Stepwise trading state stays scoped to the active session/screen.
- One-underlying validation prevents invalid simulated trading screen edits.
- P2 (deferred): verify enhanced Paper attach/shared-session status and explicit stop/detach wording when implemented.
- Pop-out opens the requested screen id and renders only that screen.
- A popped screen cannot be edited simultaneously from two windows.
- Browse live and trading stream keys remain screen/session scoped across windows.
- Reconnect, stream reset, token expiry, and snapshot reconciliation preserve state.
- TypeScript build and desktop unit tests pass.

Manual Windows validation:

- Enable Browse live on two screens with different symbols.
- Open two screens on two monitors.
- Run Paper on one window and Browse live on another.
- Run two different Paper equity sessions in two windows and verify shared wallet/margin updates.
- Practice equity day trading in Replay and Stepwise with 5x buying power.
- In one equity session, trade underlying shares and a same-underlying option contract.
- Verify equity risk sizing against wallet/session capital, 5x buying power, 20% margin reservation, and full-notional P&L.
- Confirm all Paper sessions share the same wallet and that reset is blocked after the first session starts.
- Place/update/cancel/convert Paper orders from chart controls.
- Start/cancel Paper strategies and verify strategy lines/events.
- Attach the desktop to a Paper session started in the website.
- Close and reopen a popped screen window without deleting the screen.
- Minimize and restore windows.
- Disconnect/reconnect network.
- Restart backend and reattach/recover.
- Refresh authentication and confirm recovery is window scoped.
- Close one Browse screen and confirm other Browse streams and trading sessions continue.

### Scope and Effort

- Browse live screen-scoping and UI migration: approximately 3-5 engineering days.
- Desktop Paper trading with authenticated events, shared-wallet concurrency, equity margin, mixed equity/options sessions, and Replay/Stepwise feature parity: approximately 10-15 engineering days.
- Multi-window screen support: approximately 3-4 engineering days.
- Full Phase 18 with Windows/provider validation: approximately 16-24 engineering days.
- Real broker trading from the desktop is a later phase.

## Completion regression checklist

Use a development account and known equity data. Run historical checks on a date with complete 3-minute bars; run Paper checks during market hours with the live provider connected. Record symbol, date, entry/exit prices, wallet balances, and any errors. Native checks require the Windows desktop build.

1. **Browse baseline:** open equity and option tiles, change intervals/layouts, add drawings and indicators, and reload. Confirm saved configuration returns, drawings still work, and Browse offers no trading entry controls. Enable live for today's IST date; historical dates must reject live start.
2. **Equity entries in every trading mode:** repeat in Paper, Replay, and Stepwise. Right-click the equity chart and confirm both BUY and SELL entries appear regardless of the options short preference. Place a long, close it, then place a short and cover it. Check share quantities, signed position, trade markers, commissions, realised P&L, and wallet restoration. Stepwise must advance only on Next bar; Replay pause/resume/speed must retain their existing behavior.
3. **Capital sizing:** set a known wallet (for example ₹100,000 before starting) and L/M/H to 10/20/30%. At a ₹200 reference entry, 10% capital with 20% margin allows 250 shares (₹10,000 margin, ₹50,000 notional). Check BUY and SELL using the actual order price and rounding. Repeat with an explicit share quantity and confirm it is not multiplied by an option lot size.
4. **Risk sizing:** with ₹100,000 capital, 1% risk and a ₹4 stop distance allow 250 shares before buying-power limits. Test long stop below entry and short stop above entry; reject reversed/equal stops. Repeat with insufficient funds and sub-share budgets; equity must reject rather than force one share. Inspect the resulting stop order after entry fills.
5. **Order lifecycle:** for both sides, place pending orders, drag price, change quantity, convert LIMIT/TARGET/STOPLOSS, cancel, partially close, reverse, and flatten. Check opening margin changes exactly once; closing shares require no new opening margin and reversal reserves only the excess. Failed increases must preserve the existing order and balance. Check target-profit, lock-profit, and AutoStop on an equity position.
6. **Existing options behavior:** use an options-anchored session and a same-underlying option tile in an equity session. Confirm CE/PE contract identity, expiry/strike switching, lot presets, full-premium reservation, configured option short visibility, stop/target strategies, trade labels, and round trips. Explicit option quantities must be whole lots. A historical-cache failure alone must not prevent Paper attachment; a live-subscription failure must leave the prior contract intact.
7. **Wallet isolation and locks:** reset Paper before the first session and confirm success. Start Paper and try reset from desktop and website; both must reject. Stop all sessions and restart the backend; reset must remain blocked for that user/date. Replay/Stepwise must retain their existing shared historical-date wallet behavior and must not spend the Paper ledger.
8. **Concurrent screens:** run different Paper underlyings on two screens with the shared date wallet. Submit orders whose combined margin exceeds the balance; only affordable reservations succeed. Cancel and verify one refund and consistent balances on both screens. Start the same underlying in a second screen and verify compatible attachment without another engine. Attach a website-owned Paper session and detach desktop; the website session must keep running.
9. **Pop-out handoff:** run Paper, Replay, Stepwise, and Browse on separate screens; switching tabs must leave other screens running. Pop out a screen; only it appears in the child and main offers Focus/Bring back. Change layout/indicators then immediately close the child; reopen/bring back and verify the latest settings and run survive. Close the child without deleting its screen or stopping its backend run. Move/resize/maximize across monitors and reopen; disconnect a monitor and verify accessible placement. Close one screen and confirm the others continue.
10. **Recovery and mode isolation:** disconnect/reconnect network, expire/re-authenticate the token, and restart the backend. Confirm no duplicated fills/refunds, pending orders and completed trades recover, and stale snapshots do not overwrite newer state. After a lease expires, a former engine must not continue trading. Switch from live Browse to historical Replay/Stepwise after stopping/detaching as required; candles must remain historical. Restart the desktop and confirm per-screen live settings and runs recover or show an actionable restart/reattach error.

Automated implementation validation (2026-09-26):

- Backend full suite: **839 passed, 12 failed**. These 12 failures were also reproduced against the unmodified dev application: registration, three historical-data endpoints, duplicate live-tile routing, deleted-drawing reload, three options start validations, two pattern OHLC tests, and active-session tab restore. The baseline had two additional options quantity failures now corrected to use valid lot quantities.
- Focused backend equity/order/Paper wallet/session-resume/desktop-trading suite: **133 tests passed**, including atomic order reservations/refunds, expired engine leases, and settlement retries.
- Desktop: **33 tests passed**, TypeScript checks and Vite production build passed. Vite reports the existing large-bundle advisory.
- Native Rust: **8 tests passed** using the offline build.
- The backend API tests needed a temporary runner that caps selector waits at 20 ms because this sandbox blocks the event-loop wakeup socket. This changes only the test runner, not application code.

Windows/live-provider steps remain manual until executed on the target environment.

### Website equity leverage / MaxSize follow-up

Capital percentage is a margin allocation: with ₹100,000 session capital, 15% allocates ₹15,000 opening margin and supports a ₹75,000 equity position at 5× leverage. Apply leverage once when computing shares. Risk percentage uses unleveraged session capital divided by stop distance; P&L continues to use the full share quantity and price movement.

The website MaxSize check previously compared full equity notional with an unleveraged capital limit, wrongly treating this example as 75% capital usage. MaxSize now counts 20% opening margin for both long and short equity, using the same margin rule as sizing and settlement. Options continue to count full premium. Percentage and rupee limits use this same capital-usage measure. Pure exits remain permitted when usage already exceeds a lowered limit; reversals must satisfy the new limit. Only the targeted contract's capital is released in the estimate, preserving other option contracts and equity positions.

Website regression steps:

1. Start an equity session with ₹100,000 capital, MaxSize enabled at 20%, and capital sizing set to 15%. At a ₹100 order price, SELL from flat must create 750 shares and reserve ₹15,000, leaving ₹85,000 available. Repeat BUY from flat in a fresh session. With market-style LIMIT orders, use the submitted limit price when verifying shares and reserved margin.
2. Repeat with MaxSize set to an exact ₹20,000. The 15% order must succeed; a 25% allocation must fail with MAXSIZE, leaving the order list and wallet unchanged.
3. Fill the entry and cover/close at the same price. Margin must return once, and the position must flatten. Repeat with profitable and losing exits; P&L must use all 750 shares, with existing commissions reported as before.
4. Set 1% risk and a ₹4 stop distance on a ₹100 entry. Expect 250 shares and ₹5,000 margin, rather than multiplying the risk-sized shares by five. Repeat long and short with the stop on the correct side.
5. Add to an existing position and confirm MaxSize counts existing margin plus the proposed addition. Lower MaxSize below current usage and verify partial/full exits are allowed; a reversal opening a position above the limit is rejected.
6. Repeat in website Replay/Stepwise and Paper; test existing CE/PE options positions and an equity session containing options. Closing one contract must retain all other contracts' capital usage, and options must retain full-premium accounting.

Automated coverage includes website order and direct-trade routes, both equity directions, percentage/value limits, risk sizing, pure exits/reversals, mixed contracts, and invalid/sub-share allocations.

Follow-up validation: **120 focused backend tests passed**; the full backend run completed with **868 passed and the same 12 existing failures** documented above. The website TypeScript/Vite production build passed. Manual website/provider checks above remain to be executed against a running backend.

### Website capital display preference

The website equity wallet displays one **Capital** figure, adding committed equity funds back to the free wallet balance. Placing or filling an equity entry must not appear to reduce capital merely because funds were reserved; closing trades changes capital according to the existing wallet settlement. Hide the 5× buying-power and exposure display, and do not add available/used-margin figures. Keep leverage, margin reservation, sizing, and MaxSize calculations in the backend. Non-equity wallet display retains its existing balance behavior.

Manual check: with ₹100,000 capital, place and fill a 15% equity long or short. The website must still display Capital ₹100,000 and no buying-power/exposure figures. Cancel a pending entry and verify capital remains ₹100,000. Close a 750-share position with a ₹10 favourable move; capital must show the resulting ₹107,500 wallet settlement. Repeat an adverse move and verify the loss reduces capital. P&L/commissions retain their existing separate reporting.
