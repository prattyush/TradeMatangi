
## Phase 18 — Desktop Paper Trading and Browse Live Streaming

### Requirement

1. Enable Paper Trading in the Desktop App with all features currently present in Desktop Replay/Stepwise Trading.
2. Preserve the ability to stream any live symbol in the desktop chart workspace.
   - Convert the current top-level Desktop Live mode into Paper Trading.
   - Move chart-only live streaming into Browse so users can live-monitor symbols without trading controls.
   - Browse mode must remain read-only whether live streaming is enabled or disabled.

### Status

Planned.

### Summary

Phase 18 separates two concepts that are currently mixed together in the desktop app:

- **Paper mode** is a live paper-trading cockpit. It reuses the existing backend paper-trading engine and the Phase 17 desktop trading facade, so the desktop gets the same order, position, strategy, wallet, P&L, trade-history, and chart-order features already available in Desktop Replay/Stepwise trading.
- **Browse live** is chart-only live streaming inside Browse. It lets one or more Browse screens stream their configured symbols without creating a trading session or showing any trading controls.

The intended workflow is: paper trade one underlying in Desktop Paper mode while monitoring other live symbols through Browse screens or the website.

Real broker order placement from the desktop remains out of scope for this phase.

### Product Decisions

- Rename the top-level desktop mode from `Live` to `Paper`.
- Remove the old meaning of top-level `Live` as chart-only streaming.
- Add a per-screen Browse live toggle, persisted with each desktop screen.
- Keep Browse live screen-scoped, not app-global. Each enabled screen owns its own stream lifecycle.
- Paper sessions are anchored to exactly one underlying symbol and one trading date.
- Same-underlying option tiles may be attached to the Paper session.
- Cross-underlying edits in an active Paper session are rejected in both backend and UI.
- A desktop Paper start attaches to an already-running compatible website paper session for the same user instead of silently creating a duplicate.
- Detaching or closing the desktop Paper view stops desktop event consumption only. Explicit Stop ends the backend paper session.
- Browse live and Paper trading streams must be independent; stopping or reconnecting one must not disturb the other.

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
- Keep real-trading endpoints, broker order placement, and broker credentials unavailable to Desktop Paper.
- Keep `/api/desktop/v1/live` as chart-only Browse live infrastructure.
  - It remains read-only and must not import or mutate trading state.
  - It should continue to provide start, snapshot, stop, tile configure/remove, refresh, and events for screen-level tile streams.
  - Multiple streams for the same user must coexist.
  - Provider fan-out should be reused or improved so Browse live and Paper do not create unnecessary duplicate broker connections.

Session and contract rules:

- Paper starts from the active chart's underlying context.
- Option/index sessions use the same ATM/expiry resolution rules as existing paper trading.
- Attached option contracts use full identity: `symbol + expiry + strike + right`.
- A single active Paper session cannot switch to another underlying. The response should tell the user to use another screen/session.
- Same-right strike switching must respect the existing risk rule: do not switch away from a contract that has open position, pending orders, or active strategy risk.

### Desktop Frontend Plan

Update the Windows desktop app around a clear mode model:

- Replace `Browse | Live | Replay | Stepwise` with `Browse | Paper | Replay | Stepwise`.
- Update shared contracts so `RunState.mode` and mode predicates include `paper` and do not treat `live` as a trading mode.
- Treat `Paper`, `Replay`, and `Stepwise` as desktop trading modes for the left rail, chart order lines, strategy controls, wallet, P&L, flatten, and trade history.
- Treat Browse live as a property of a Browse screen, not as `mode=Live`.

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
- The frontend checks for a compatible active/existing Paper session before starting and offers attach/continue/start-clean choices consistent with Stepwise/Replay flows.
- Paper subscribes to authenticated desktop trading events and keeps an authoritative snapshot polling or recovery path.
- Paper chart candles merge historical baseline data with live paper ticks.
- Paper order/fill markers, order lines, positions, wallet, P&L, strategies, and trade history use the same desktop state model as Replay/Stepwise.
- Active Paper sessions lock the instrument picker date and underlying. Same-underlying option tiles can be attached; cross-underlying edits show guidance before the backend rejects them.
- The Paper session indicator must distinguish:
  - new desktop-owned session
  - attached/shared website session
  - broker feed reconnect/error
  - auth/session expiry

Native stream handling:

- Use distinct native stream keys for Browse live and Paper trading, for example `browse-live:{screen_id}:{stream_id}` and `paper:{session_id}`.
- Token refresh/auth expiry must not corrupt screen state. On authentication failure, stop affected streams, keep persisted screen configuration, and ask the user to sign in again.
- Backend restart should surface a recoverable error and allow users to reattach/start again without losing persisted screens.

### Concurrent Workflow Requirements

The implementation must support:

- Paper trading one symbol in Desktop Paper while live-monitoring other symbols in Browse.
- Multiple Browse screens streaming different symbol sets at the same time.
- One Browse screen being closed, disabled, reconfigured, or reconnected without stopping other Browse screens or the Paper session.
- The website and desktop attaching to the same compatible Paper session for the same user.
- Desktop minimize/restore, token refresh, auth expiry, network loss, backend restart, provider reconnect, and stream reset without cross-screen state corruption.

### Acceptance Criteria

- Desktop mode switch shows `Browse`, `Paper`, `Replay`, and `Stepwise`; the old top-level `Live` trading/chart mode is removed.
- Browse screens can enable live data for their configured symbols without exposing trading controls.
- Two Browse screens can stream different symbol sets simultaneously.
- Paper can start from desktop, attach to a compatible website Paper session, and display live chart ticks.
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
- Cross-underlying edits are rejected for an active Paper session.
- Explicit Stop ends a desktop-owned Paper session. Detach/close only stops desktop consumption for attached/shared sessions.
- Browse live and Paper streams recover independently from reconnect, stream reset, token refresh, and backend restart.
- Real broker order placement is not exposed from Desktop Paper.

### Test Plan

Backend:

- Desktop Paper start maps to `session_type=paper` and uses the existing paper engine.
- Paper start/attach/candidate/active/snapshot/stop enforce desktop auth and user ownership.
- Existing website Paper sessions can be discovered and attached.
- Desktop Paper event stream supports `Last-Event-ID`, bounded replay, heartbeats, gap reset, and snapshot recovery.
- Another user cannot read, stream, or mutate a Paper session.
- Paper order, strategy, wallet, position, P&L, flatten, and contract attach endpoints work through `/api/desktop/v1/trading`.
- Cross-underlying Paper changes are rejected.
- Browse live start/stop/configure/refresh/events remain user-scoped and read-only.
- Multiple Browse live streams can coexist for one user with different tiles.
- Browse live and Paper subscriptions do not create uncontrolled duplicate provider connections.

Desktop unit/integration:

- Mode labels and mode predicates handle `Paper` correctly.
- Per-screen `live_enabled` state persists and restores.
- Browse live stream state is keyed by screen id, not a single global `live` snapshot.
- Browse live does not render trading controls or mutate trading state.
- Browse live tile edits affect only that screen's stream.
- Paper snapshots/events update candles, orders, fills, positions, wallet, P&L, strategies, and trade history.
- One-underlying validation prevents invalid Paper screen edits.
- Paper attach/shared-session status is visible.
- Reconnect, stream reset, token expiry, and snapshot reconciliation preserve state.
- TypeScript build and desktop unit tests pass.

Manual Windows validation:

- Enable Browse live on two screens with different symbols.
- Start Desktop Paper for one symbol while both Browse screens continue streaming.
- Place/update/cancel/convert Paper orders from chart controls.
- Start/cancel Paper strategies and verify strategy lines/events.
- Attach the desktop to a Paper session started in the website.
- Minimize and restore windows.
- Disconnect/reconnect network.
- Restart backend and reattach/recover.
- Refresh authentication.
- Close one Browse screen and confirm other Browse streams and the Paper session continue.

### Scope and Effort

- Browse live screen-scoping and UI migration: approximately 3-5 engineering days.
- Desktop Paper trading with authenticated events and Replay/Stepwise feature parity: approximately 7-10 engineering days.
- Full Phase 18 with Windows/provider validation: approximately 10-15 engineering days.
- Real broker trading from the desktop is a later phase.
