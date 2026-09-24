## Phase 17 — Desktop Chart Trading Support

### Summary

Phase 17 turns the Windows desktop chart workspace into a chart-first trading cockpit for Stepwise trading. The desktop UI should be optimized for fast chart reactions, while backend trading logic remains shared with the website: simulation sessions, orders, strategies, wallet, guardrails, sizing, and P&L calculations stay backend-authoritative.

Primary scope:

- Stepwise trading only.
- One desktop screen maps to one trading session anchored to one underlying symbol/date.
- A Stepwise session can start from the underlying chart only; option contracts can be attached later.
- Website parity is not a UI constraint, but backend behavior should stay compatible with the website.
- Replay/Live/Real desktop trading are future work unless naturally enabled by the same abstractions.

### Implementation Status

**Status: complete.**

The original Phase 17 implementation was merged in PR #480 and has since received
desktop-trading follow-ups, including contract-scoped quotes, order-entry fixes,
option-switch lifecycle fixes, and the completion work below. The user manually
verified the complete Stepwise workflow after the earlier audit.

Implemented:

- Desktop Stepwise trading API facade, including session start, snapshots, next-bar, contracts, orders, strategies, wallet, bulk conversion, and flatten.
- Underlying-only Stepwise start for option/index sessions, with backend expiry/ATM resolution and default CE/PE stream registration.
- Same-symbol option attachment after session start, including new strikes and full contract identity (`symbol + expiry + strike + right`).
- Locked-underlying enforcement with user-facing guidance to use another desktop screen for another symbol.
- Contract-aware order matching, fills, positions, chart filtering, and source metadata (`desktop_stepwise`).
- Chart order overlays, drag-to-update, two-step selected-line conversion, clicked-price placement, and chart context-menu bulk conversion.
- Shared desktop settings, wallet/P&L/flatten controls, and desktop capability advertisement.
- Shared-session discovery before a desktop Stepwise start, explicit attach
  confirmation, and a visible shared-session status. Detaching the desktop
  screen does not stop an attached website/shared session.
- Strategy chart lines for price-based strategies, drag-to-update behavior, and
  compact running-strategy cancel/edit controls in the left panel.
- Contract-correct Flatten pricing: every target now resolves its exact
  `right + strike + expiry` quote.
- Authoritative desktop `next-bar`: it waits for the simulator to finish the
  next bar before returning its snapshot.
- Stepwise trade-strategy labels in the left panel below Trade History. Expected
  category/strategy is saved while a round trip is open; actual
  category/strategy is saved after exit. Label round trips use the full option
  contract identity so same-right strikes do not collide.
- Desktop fills are available through the existing website Analysis Trades/Trade History surface for the same user.
- Stop-loss quantity controls are shared between website and desktop: the website SL form can be cleared or set to zero to skip placing an SL, while pending SL quantities can be edited. Desktop selected SL lines expose the same quantity edit behavior.
- Stop-loss quantity changes use a step of `1` for equity and the contract lot size for options. New or edited quantities cannot exceed the uncovered position after other pending closing SL/LIMIT orders are accounted for.
- Desktop stop-loss labels include the order quantity with projected P&L, and selected-line actions use compact `L`, `SL`, and delete (`×`) controls.
- Real-session stop-loss edits update the broker-side Kotak order before local state is changed; broker rejection leaves the local order unchanged.
- No separate Order Book tab or Analysis UI was added; “order book” in the implementation means the existing trade/order history data path and is not a new user-facing Analysis surface.
- This specification was updated alongside the implementation, including the assumptions and known streaming limitation below.

Verification status:

- Windows desktop tests passed: 18 tests in 5 files (`npm test`).
- Windows desktop TypeScript check and production build passed (`npm run build`).
- Backend tests exist for explicit desktop identity/capabilities, contract attachment and scoping, clicked-price conversion, quote selection, fills, wallet reset, and selected user-isolation cases. A focused contract-aware Stepwise label-state test was added.
- Python syntax compilation passed for backend code and tests. The full backend pytest suite was not run because FastAPI/pytest are absent from this environment.
- The desktop test suite still does not simulate every chart gesture; manual acceptance testing covers the completed Stepwise workflow.

### Lessons Learned

- A `right` (`CE`/`PE`) is not a sufficient trading identity once a session can attach more than one strike. Every quote lookup, position, order filter, bulk action, and flatten operation must carry `symbol + expiry + strike + right`.
- The coordinated replay `next-bar` endpoint waits for the simulator to finish its bar before returning a combined replay/trading snapshot. Desktop actions should use that coordination point rather than assume that merely signalling a Stepwise event means state has advanced.
- A backend route is not a finished desktop capability until the desktop invokes it, presents its state, and has a tested recovery/error path. `/active` and the strategy endpoints are concrete examples.
- Live-renderer work reinforced the same principle for chart state: hot updates must be incremental, while full snapshots belong at start, reset, refresh, and recovery boundaries—not on every event.

### Backend Plan

Add a desktop trading facade under `/api/desktop/v1/trading`:

- `POST /start`: starts a backend Stepwise `SimulationSession` from the underlying symbol/date and returns a desktop trading snapshot. For option-only/index symbols, the backend internally resolves expiry/ATM CE/PE so the replay loop can produce option fills even when the desktop did not ask the user for a strike first.
- `POST /{session_id}/contracts`: attaches a same-underlying option contract (`symbol + expiry + strike + right`) to the Stepwise session and updates the active CE/PE stream for that right.
- `GET /active`: finds an active compatible Stepwise session for the user so the desktop can warn and attach.
- `GET /{session_id}/snapshot`: returns session state, positions, trades, open orders, strategies, wallet, P&L, and desktop trading settings.
- `POST /{session_id}/next-bar`: advances the backend Stepwise session.
- Order endpoints wrap existing order services for place, update, cancel, convert, and bulk convert.
- Strategy endpoints wrap existing strategy services for start, cancel, cancel-all, and price update.
- Wallet endpoints expose get/reset for the session date.
- `POST /{session_id}/flatten`: exits all open positions immediately by converting usable closing orders to emergency LIMIT exits or creating new emergency LIMIT exits.

Contract rules:

- The session is locked to its underlying symbol. Same-symbol option strikes can be attached and traded.
- If the user tries to attach or trade another underlying inside the same Stepwise screen, the backend returns a clear error. The desktop should tell the user to open another screen for that symbol.
- Desktop option orders, trades, positions, and chart lines use the full contract key: `symbol + expiry + strike + right`. Do not filter only by CE/PE because multiple CE or PE strikes may be used over one session.
- The current implementation keeps one active CE stream and one active PE stream in the simulation loop. Attaching a new strike for the same right switches that right’s active stream and avoids order/position collisions by full contract key.
- Because only one CE and one PE stream are active, switching a right to another strike is blocked while the old same-right contract has pending orders or an open position.

Assumptions and deliberate trade-offs:

- “Underlying chart” means the chart’s underlying symbol is the session anchor. An option-only tile may be used to start the request only when its underlying can be resolved; the desktop start flow itself sends the underlying context and does not require the user to preselect a strike.
- Adding a same-symbol strike is supported during the session, but the current replay engine has one active CE stream and one active PE stream. A new strike can therefore replace the active stream for that right only when the previous same-right contract has no pending orders and no open position. This protects fills from being attributed to the wrong stream.
- Simultaneous open positions or pending orders on multiple strikes of the same right will require a future multi-contract simulation-stream refactor. The API and UI already use full contract keys so that extension does not require a data-model redesign.
- The expiry is part of the contract identity. A session is expected to trade one expiry; attaching another expiry is rejected once the session has a locked expiry.
- The session is scoped to the authenticated user and the desktop identity. A user may use another screen for another symbol, but a single screen/session cannot silently switch its underlying.
- Analysis parity is data-level, not a new navigation surface. The existing Analysis Trades table remains authoritative and desktop fills are represented as ordinary trades with optional source metadata.
- The source field is intentionally optional so historical website trades and imported/legacy records remain valid.
- Desktop responsiveness is prioritized by optimistic chart drag/selection state and one request on commit. Backend state remains authoritative after the next snapshot poll.
- Bulk actions are intentionally limited to closing orders for the active full chart contract. This prevents a right-click on one strike’s chart from changing another strike’s risk orders.

Desktop settings should live in shared user settings:

- `desktop_hide_chart_labels`
- `desktop_order_size_mode`: `quantity | funds_ratio | risk_ratio`
- `desktop_pnl_display_mode`: `currency | percent`
- `desktop_confirm_flatten`

### Desktop UI Plan

Use a chart-first cockpit layout:

- Top bar shows session status, wallet, day P&L, P&L mode, and `Flatten`.
- Left rail keeps drawing/indicator tools and adds compact Orders, Strategies, Trade History, and Settings sections.
- Chart panes render order and strategy lines directly as KLine overlays.
- In Stepwise mode, editing a tile to another underlying in the active trading screen is blocked. Same-underlying option tiles are allowed and are attached to the trading session.

Order lines:

- Pending LIMIT/TARGET/STOPLOSS orders appear as horizontal chart lines.
- Labels show side/type plus quantity or projected P&L, e.g. `BL 13K`, `SL 65 -1.2%`, `T +2.4%`.
- Stop-loss labels always include the active order quantity alongside projected P&L.
- Dragging a line previews locally and sends exactly one backend update on drag end.
- Delete/Backspace cancels the selected line.

Selected stop-loss line controls:

- The quantity field can be edited directly and changed with the mouse wheel.
- Equity quantities change in steps of `1`; option quantities change in steps of the contract lot size.
- The maximum quantity is the open position quantity minus other pending closing-side SL/LIMIT quantities for the same contract. The existing selected stop-loss is excluded from this calculation so it can be resized upward when uncovered quantity is available.
- `L` converts the selected order to a limit order, `SL` converts it to a stop-loss, and `×` deletes it. Each control has an accessible tooltip/label.

Website stop-loss controls:

- The new SL quantity field preserves blank and zero while editing. Zero skips order placement; a positive quantity is required to submit an SL.
- Pending stop-loss orders expose editable quantity in the order editor. Deleting an existing pending SL remains a separate cancel action.
- Website and desktop use the shared quantity update endpoint and the same uncovered-position and lot-size validation.

Two-step selected-line conversion:

1. Select an order line.
2. Choose `Convert to Limit`, `Convert to Stoploss`, or `Convert to Target`.
3. Cursor enters price-pick mode.
4. Click the target price on the chart.
5. Backend converts the selected order with that clicked price.

Escape cancels price-pick mode.

Chart right-click actions:

- Place Buy Limit or Sell Limit at clicked price.
- Place Target or Stoploss at clicked price.
- `Move all SL here`: update/convert relevant closing stoploss orders to the clicked price.
- `All Stoploss here`: convert all matching closing orders for the active chart/right to STOPLOSS at clicked price.
- `All Limit here`: convert all matching closing orders for the active chart/right to LIMIT at clicked price.

Bulk conversion applies only to closing orders for the active chart contract, matching the website’s bulk Stoploss update behavior.

### Website Analysis

Desktop Stepwise fills should appear in the existing website Analysis trade history for the same user.

- Do not add a separate Analysis tab or separate order-book UI.
- The existing Trades table remains the visible history surface.
- Desktop-originated trades may carry `source = desktop_stepwise` in the API/data model for filtering or future diagnostics.
- Session and trade access must remain user-scoped; another user must not see desktop trades.

### Flatten

`Flatten` exits all open positions for the session.

- If closing SL/target/limit orders exist, convert them to LIMIT exits at an emergency price.
- If no closing order exists, create a LIMIT exit order.
- Long positions use SELL LIMIT below current price.
- Short positions use BUY LIMIT above current price.
- Default emergency offset: 3%.
- If `desktop_confirm_flatten` is enabled, the desktop asks for confirmation.

### Session Sharing

If the same user already has a compatible Stepwise session running from the website:

- Desktop should detect it and warn before attaching.
- Attached shared sessions show a visible shared/session status.
- Backend snapshots/events remain authoritative so website and desktop reconcile to the same orders, positions, wallet, and P&L.

### Test Plan

Backend:

- Desktop routes require explicit desktop identity.
- Capabilities advertise Stepwise trading.
- Snapshot includes orders, strategies, wallet, positions, settings, and P&L.
- Stepwise can start from an underlying-only request for option/index symbols.
- Same-symbol contract attach succeeds.
- Different-symbol contract attach is rejected with a locked-underlying error.
- Option order placement is rejected unless the contract is attached.
- Order placement stores full contract key and desktop source.
- Selected-order convert uses the clicked price.
- Bulk chart conversion uses the clicked price and filters by active contract.
- Flatten handles long/short, CE/PE, existing SL, no SL, and no-position cases.
- User isolation rejects another user’s desktop trading request.
- Website Analysis shows desktop Stepwise fills in the existing Trades history without adding a new tab.

Desktop:

- TypeScript build passes.
- Order label formatting handles quantity and percent P&L mode.
- Selected-line conversion enters price-pick mode and sends the clicked price.
- Escape cancels conversion mode.
- Dragging LIMIT/TARGET/STOPLOSS maps to correct backend update fields.
- Chart right-click bulk actions call the correct conversion endpoint.

Manual:

- Start Stepwise options session.
- Place orders from chart right-click.
- Drag SL/TARGET/LIMIT lines and confirm backend state changes.
- Convert selected SL to LIMIT by selecting `L` then clicking chart price.
- Select a stop-loss line, edit its quantity directly or by scrolling, and verify equity step size, option lot-size step, and uncovered-position limits.
- Verify the selected stop-loss line shows quantity plus projected P&L in currency and percent modes.
- Bulk convert all closing orders to SL/LIMIT from chart right-click.
- Run Flatten with and without existing stoploss orders.
- Verify chart reaction remains fast during repeated Next Bar presses.

## Phase 18 — Desktop Live Paper Trading and Browse Live Streaming

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
