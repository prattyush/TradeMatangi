
## Phase 18 — Desktop Live Paper Trading and Browse Live Streaming


Requirement
1. Enable support of Paper Trading in Desktop App with all features as present in Replay Trading in Desktop App.
2. Live Symbols, Suggestion to approach:-
   a) Convert Live into Paper Trading Session.
   b) The Live ability to stream any symbol is a required feature, thus shift it to browse. So, user can either go live on per symbol/chart or he can switch the entire browse mode into a current Live Mode functionality. Use whichever seems better, free to choose. Browse Mode won't have trading options, whether live or not live.

### Status

Planned.

### Summary

Phase 18 adds two related desktop capabilities:

1. Browse screens can display live market data for their configured symbols without becoming trading sessions.
2. Desktop Live mode becomes a one-underlying live paper-trading session with orders, fills, positions, strategies, wallet, P&L, and trade history.

The intended workflow is to paper trade one symbol in Desktop Live mode while monitoring other symbols through live-enabled Browse screens or the existing website.

Real broker order placement from the desktop remains out of scope for this phase.

### Browse Live Streaming

Each persisted Browse screen must support an independent `live_enabled` setting.

When enabled:

- The screen streams all currently configured equity and option tiles.
- Historical candles remain visible and incoming ticks are merged using the existing interval aggregation and reconciliation rules.
- Browse remains read-only; it must not expose or modify orders, positions, strategies, wallet, or P&L.
- Multiple Browse screens may stream different symbol sets at the same time.
- The live switch is available only for the current trading date. Historical dates show a clear explanation that live data is for the current market date.
- The stream supports reconnect, bounded event replay, stream reset, provider errors, backend restart, and authoritative snapshot recovery.
- Stopping one Browse stream does not stop any other screen or paper session.

### Desktop Live Paper Trading

Desktop Live mode must create or attach to a live paper-trading session.

Session rules:

- A paper session is anchored to exactly one underlying symbol and trading date.
- Same-underlying option tiles, including CE and PE contracts, may be attached.
- Changing an active paper screen to another underlying is rejected with guidance to use another screen or session.
- A desktop start request for an already-running compatible website paper session attaches to that session rather than silently creating a duplicate.
- Detaching the desktop view stops desktop event consumption only; it does not stop the backend paper session.
- Ending the paper session is an explicit stop action.

The Desktop Live UI must expose:

- Live chart ticks and candle aggregation.
- Paper order placement, update, cancellation, and conversion.
- Order/fill markers and order-line updates.
- Positions, average entry, quantity, wallet, realized/unrealized P&L, and trade history.
- Paper strategies and strategy lifecycle controls supported by the existing backend.
- Connection, session, broker-feed, and reconciliation errors.

### Backend Requirements

Extend the authenticated desktop API with paper-session operations for:

- Start or attach to a paper session.
- Find a compatible active session.
- Fetch an authoritative paper snapshot.
- Stop a paper session.
- Place, update, cancel, and convert orders.
- Start, update, and cancel supported strategies.
- Read wallet, positions, trades, and P&L.
- Subscribe to authenticated paper-session events.

Implementation requirements:

- Reuse the existing backend paper-trading engine for fills, order state, wallet accounting, strategies, guardrails, and P&L. Do not create a second paper simulator.
- Add authenticated desktop event streaming with monotonic event IDs, `Last-Event-ID` resume, bounded replay, and snapshot fallback.
- Enforce authenticated user ownership on every desktop paper endpoint and event stream.
- Enforce the one-underlying rule at the backend boundary, not only in the UI.
- Keep real-trading endpoints and broker credentials unavailable to this feature.
- Reuse or introduce provider-level fan-out so Browse-live and paper sessions do not create unnecessary duplicate broker connections.
- Preserve backend authority when the desktop is minimized, disconnected, restarted, or reattached.

### Frontend Requirements

- Keep Browse-live state separate from Desktop Live paper-session state.
- Persist screen-level `live_enabled` state without introducing a global active-screen write that lets concurrent windows overwrite one another.
- Display separate connection/session indicators for Browse-live and Paper mode.
- Preserve independent stream lifecycles when switching screens or modes.
- Show the one-underlying restriction before starting a paper session and when editing its tiles.
- Do not show trading controls in Browse-live mode.
- Normalize paper-session snapshots and events into the desktop chart/order/position state model.

### Concurrent Workflow

The implementation must support:

- Paper trading one symbol in Desktop Live mode while live-monitoring other symbols in Browse.
- Using the existing website concurrently with the desktop and attaching to the same compatible paper session.
- Running multiple Browse-live screens with different symbol sets.
- Closing or disconnecting one Browse screen while the paper session and other screens continue.
- Token refresh, authentication expiry, network loss, backend restart, and provider reconnect without cross-screen state corruption.

### Acceptance Criteria

- A Browse screen can enable live data for its configured symbols without exposing trading controls.
- Two Browse screens can stream different symbol sets simultaneously.
- Desktop Live can run a one-symbol paper session and display order, fill, position, strategy, wallet, P&L, and trade-history updates.
- Desktop can attach to a compatible paper session started by the website.
- Cross-underlying edits are rejected for an active paper session.
- Browse-live and paper streams remain independent and do not lose or duplicate events during reconnect.
- Explicitly stopping a paper session ends it; detaching a desktop view does not.
- Windows testing covers two monitors, minimize/restore, network loss, backend restart, token refresh, and closing one screen.

### Test Plan

Backend:

- Browse live start/stop is user-scoped and read-only.
- Multiple live streams can coexist for one user with different tiles.
- Paper start, attach, snapshot, stop, order, strategy, wallet, and event endpoints enforce desktop identity.
- Existing website paper sessions can be discovered and attached.
- Cross-symbol paper changes are rejected.
- Paper event replay and snapshot recovery restore the authoritative state.
- Browse-live and paper subscriptions do not create uncontrolled duplicate provider connections.
- Another user cannot read or mutate a Browse stream or paper session.

Desktop:

- `live_enabled` screen state persists and restores correctly.
- Browse-live does not render trading controls.
- Browse-live and Paper mode transitions start and stop only their own streams.
- Paper snapshots update charts, orders, positions, wallet, P&L, and strategies.
- One-underlying validation prevents invalid paper screen edits.
- Reconnect, stream reset, token expiry, and snapshot reconciliation preserve state.
- TypeScript build and desktop unit tests pass.

Manual Windows validation:

- Enable Browse-live for two screens with different symbols.
- Paper trade one symbol in Desktop Live while monitoring the other screens.
- Attach the desktop to a paper session started in the website.
- Minimize and restore windows, disconnect/reconnect the network, restart the backend, and refresh authentication.
- Close one Browse screen and confirm other streams and the paper session continue.

### Scope and Effort

- Browse-live streaming only: approximately 3–5 engineering days.
- Full Phase 18 implementation: approximately 10–15 engineering days, including Windows and provider testing.
- Real broker trading from the desktop is a later phase.
