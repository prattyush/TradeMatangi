
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

In progress.

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

Remaining work:

- P2 review finding: live chart subscriptions can override Replay candles after switching modes. Gate live chart rendering by mode, including the shared live snapshot fallback, so historical runs always display historical candles.
- P2 review finding: Paper option attachment currently requires a successful historical data fetch. Make historical caching best-effort for Paper so a historical-provider failure does not prevent a valid live contract subscription.
- Persist Browse live as a per-screen `live_enabled` state, with live snapshots, tick caches, stream keys, errors, and native subscriptions keyed by screen id. The current implementation is usable from Browse but still uses one active workspace live stream rather than a restored per-screen live lifecycle.
- Fully remove Paper snapshot polling in browser/non-native fallback if a header-capable browser SSE transport is added. Native Windows now uses the authenticated desktop trading event endpoint; browser fallback remains snapshot polling by design.
- P2: Add stronger Paper session status indicators and explicit attach/detach wording. The current UI can attach to an active compatible Paper session and stops only owned sessions, but owner/shared semantics are still minimal. This UI improvement is deferred; correct ownership and stop/detach behavior remain required.
- Replace the current minimal pop-out action with full screen ownership semantics:
  - render only the assigned screen in the child window
  - mark popped screens as opened externally in the main window
  - offer focus/bring-back actions
  - prevent simultaneous editing from two visible windows
  - detach on child-window close without deleting the saved screen
- Persist and restore child-window size, position, maximized state, and best-effort monitor placement.
- Add backend date-level Paper wallet lock semantics so reset/change is allowed only before the first Paper session for that user/date starts, and remains blocked even after sessions stop.
- Harden shared Paper wallet concurrency with atomic reservation/update protection across multiple active Paper sessions.
- Enforce the complete Paper uniqueness/attach policy for active user/date/underlying sessions and compatible website sessions.
- Finish desktop-specific equity buying-power validation across chart orders, updates, conversion, flatten, and close-out.
- Update risk-sizing helper text so it clearly states that stop-loss loss is measured against wallet/session capital.
- Add broader backend, desktop integration, and Windows manual validation for Paper options, multi-session Paper, Browse live, and pop-out workflows.

### Current Implementation Notes

- Scope clarification: the existing desktop wallet/P&L display is accepted. Additional desktop margin-used, available-margin, buying-power, exposure, and risk-amount displays are not required for Phase 18. Backend margin accounting, sizing, and validation remain required, and existing website displays are unchanged. Stronger Paper attachment/status wording is a deferred P2 UI improvement.
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
  - This is only the ledger-id foundation for a shared Paper wallet. Date-level reset locking and atomic cross-session reservation protection are still outstanding.
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
  - Continues to show actual wallet balance as the primary value.
  - Shows compact `5x BP` and `Exposure` values when the backend provides leveraged equity fields.
- `frontend/src/components/OrderPanel.tsx`
  - Renames funds-ratio label from "Capital Ratio" to "Capital Used".
  - Adds an equity hint that 5x buying power affects quantity while wallet usage remains the selected percentage.

Desktop files touched in the current partial implementation:

- `windowsapp/src-tauri/src/lib.rs`
  - Adds native commands `open_screen_window`, `focus_screen_window`, and `close_screen_window`.
  - Child windows use stable labels formatted as `screen:{screen_id}`.
  - The current child route is `?screen_id=...`; full renderer-side child-window isolation is not implemented yet.
  - Current behavior opens or focuses a native window, but does not yet persist/restore window geometry or enforce one visible owner for a screen.
- `windowsapp/src/App.tsx`
  - Replaces the old top-level `Live` mode with `Paper`.
  - Browse now owns chart-only live stream controls and remains read-only.
  - Paper now starts the desktop trading facade directly, keeps the chart workspace on live candles, attaches option tiles as contracts, consumes native trading events incrementally where available, and exposes the existing wallet/P&L/flatten/order/strategy controls.
  - Adds a "Pop out screen" button beside the existing screen actions.
  - In native builds it calls `open_screen_window`.
  - In browser/dev preview it shows a message that pop-out is native-only.
  - The authenticated Paper trading event stream is implemented for native Windows builds; browser/non-native fallback still uses snapshot polling because authenticated SSE needs request headers.

Complicated points and callouts:

- Website equity leverage is implemented for Replay (`sim`), Stepwise, Paper, and Real order paths. Desktop Windows validation remains outstanding; broader desktop margin/buying-power display is not required.
- Not implemented yet for this website 5x leverage requirement:
  - Atomic shared-wallet reservation protection across multiple active Paper sessions. Current ledger writes can still race under true simultaneous order placement.
  - DynamoDB restore/hydration audit for pending leveraged orders. The model writes margin metadata, but resumed pending orders must be checked to ensure `reservation_margin_rate`, `wallet_ledger_id`, and `wallet_ledger_kind` are restored before relying on long-lived pending leveraged orders after backend restart.
  - Full real-broker reconciliation semantics for leveraged local wallet display. Kotak fund sync remains authoritative and may overwrite local margin-display state after manual/out-of-band broker activity.
  - Broad end-to-end manual validation in live Real trading. The code paths are wired for Kotak callbacks, but this needs careful broker-session validation before treating it as production-proven.
  - Full-suite test run completion. Focused leverage/order/frontend checks passed, but the broader `test_order_service/test_trading` runs were interrupted because they were very slow in this environment.
- Existing session-start wallet/session-capital logic is intentionally unchanged. The wallet value used for sizing and P&L remains whatever the session already captures at start/resume today.
- `balance` is actual wallet capital, not leveraged exposure. Leverage affects allowed quantity/notional and required margin only.
- Funds-ratio means actual capital usage. Example: 24% funds usage on equity reserves 24% of the wallet and can create 120% notional exposure.
- Risk-ratio remains actual-capital based. Leverage does not multiply the stop-loss risk amount; it only decides whether the derived quantity can be afforded by 20% margin.
- P&L amount is full share quantity times price movement. P&L percentage remains `P&L / session_capital`, not `P&L / exposure`.
- Same-price leveraged equity round trips must restore actual wallet capital. This is why close settlement credits released entry margin plus realized P&L instead of full SELL notional.
- Mixed equity/options sessions must make margin decisions per order, not per session. A session anchored to equity can still place option orders; those option orders must keep lot sizing, premium funding, and option identity exactly as existing option sessions do.
- Paper shared wallet support currently has the correct date-scoped ledger id, but does not yet have:
  - a date-level "started/locked" marker
  - backend reset rejection after first start
  - atomic reservation protection for simultaneous orders from multiple Paper sessions
- The desktop Paper backend can start via the facade and the Windows UI now has a usable single-screen Paper run mode for options. It now has authenticated native Paper trading events, but still lacks persisted per-screen Paper/live stream lifecycle ownership, stronger attach/detach status, and full shared-wallet lock semantics.
- Browse live is now reachable from Browse instead of top-level Live, but it is not yet persisted/restored as a per-screen `live_enabled` lifecycle.
- Important implementation learning: options-anchored Paper sessions used the legacy CE/PE tick path, which did not populate the desktop `contract_quotes` registry. Chart market orders depend on that registry, so Paper options must enrich every option tick with full contract identity before order placement and P&L use it.
- Pop-out support is currently a native window primitive plus a button. It is not yet a completed multi-window workspace because the child window does not yet render only one assigned screen or coordinate edit ownership with the main window.
- `check_orders()` still supports legacy full-notional SELL credit by default, but simulation/real loops now call it with `settle_wallet=false` and then use `trading.settle_wallet_for_trade()` for margin-aware settlement.
- Any future persistence/resume work must ensure reservation metadata is loaded back into `Order` objects from DynamoDB. The model can hold it, and writes include it, but restore paths should be checked before relying on resumed pending orders with non-1.0 margin rates.
- Potential issue: if pending orders are restored from DynamoDB without `reservation_margin_rate` and ledger identity, resumed leveraged BUY orders may settle as full-notional orders. Restore/hydration paths should be audited before relying on long-lived pending leveraged orders across backend restarts.
- Potential issue: shared Paper wallet updates are still in-memory/ordinary ledger writes; true atomic cross-session over-reservation protection remains outstanding for multiple active Paper sessions.
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
