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

**Status: substantially implemented; follow-up work remains before Phase 17 can be marked complete.**

The original Phase 17 implementation was merged in PR #480 and has since received
desktop-trading follow-ups, including contract-scoped quotes, order-entry fixes,
and option-switch lifecycle fixes. This review was performed against `dev` at
`45aa0df` on 2026-09-21; it is a code-and-test audit, not a manual trading
acceptance test.

Implemented:

- Desktop Stepwise trading API facade, including session start, snapshots, next-bar, contracts, orders, strategies, wallet, bulk conversion, and flatten.
- Underlying-only Stepwise start for option/index sessions, with backend expiry/ATM resolution and default CE/PE stream registration.
- Same-symbol option attachment after session start, including new strikes and full contract identity (`symbol + expiry + strike + right`).
- Locked-underlying enforcement with user-facing guidance to use another desktop screen for another symbol.
- Contract-aware order matching, fills, positions, chart filtering, and source metadata (`desktop_stepwise`).
- Chart order overlays, drag-to-update, two-step selected-line conversion, clicked-price placement, and chart context-menu bulk conversion.
- Shared desktop settings, wallet/P&L/flatten controls, and desktop capability advertisement.
- Desktop fills are available through the existing website Analysis Trades/Trade History surface for the same user.
- No separate Order Book tab or Analysis UI was added; “order book” in the implementation means the existing trade/order history data path and is not a new user-facing Analysis surface.
- This specification was updated alongside the implementation, including the assumptions and known streaming limitation below.

Verification status:

- Windows desktop tests passed: 18 tests in 5 files (`npm test`).
- Windows desktop TypeScript check and production build passed (`npm run build`).
- Backend tests exist for explicit desktop identity/capabilities, contract attachment and scoping, clicked-price conversion, quote selection, fills, wallet reset, and selected user-isolation cases.
- Backend tests were **not** run in this audit because no Python interpreter is available in the current environment. Their current pass/fail status must therefore not be inferred from the desktop build.
- The desktop test suite currently covers chart/live/drawing state only; it does not exercise Phase 17 order, strategy, flatten, shared-session, or chart-interaction workflows.
- The Phase 17 manual acceptance checklist below has not been evidenced by this audit.

### Remaining Implementation Work

The completed backend facade should not be confused with every planned desktop
workflow being complete. The following items remain:

1. **Shared Stepwise-session attachment and visible status — required.** `GET /active` is implemented, but the desktop start flow never calls it; it always starts a new session. There is also no visible shared/attached session indicator. Implement the pre-start compatible-session lookup, a user decision to attach or start separately, and a persistent status badge. Add backend and desktop tests for same-user sharing and user isolation.
2. **Strategy controls and strategy chart lines — required.** The backend has start/cancel/cancel-all/update-price endpoints, but the desktop only starts strategies from the chart menu. It does not render strategy lines, list running strategies, cancel them, or drag/update a price. Add contract-aware strategy overlays and a compact management section; ensure every mutation refreshes the authoritative snapshot.
3. **Flatten must use the exact contract quote — correctness fix.** The flatten loop identifies each attached contract correctly, but currently obtains its price using only `right`; for a non-primary attached strike that can select the active CE/PE quote instead of the target contract's quote. Pass `right + strike + expiry` to quote resolution, then add long/short, CE/PE, primary/non-primary, existing-closing-order, no-closing-order, and no-position tests.
4. **Make the standalone desktop `next-bar` endpoint authoritative, or retire it.** The desktop uses the coordinated replay endpoint, which waits for bar completion. In contrast, `/trading/{session_id}/next-bar` only signals the simulator and immediately returns a snapshot, which may still describe the previous bar. Align its contract with the documented “advances” behavior, or remove it from the public facade and document the coordinated endpoint as the sole supported path.
5. **Finish the planned desktop controls — scope decision required.** The compact left rail currently has Trade History and generic chart settings, while Orders are chart overlays and Strategies have no management UI. The documented compact Orders, Strategies, and trading Settings sections are therefore incomplete. Decide whether to implement these panels or explicitly narrow the Phase 17 UI scope and revise this spec.
6. **Close verification gaps.** Add focused desktop interaction tests for label formatting, selected-line conversion/cancel, drag mapping, right-click bulk actions, strategy management, and flatten confirmation. Run the backend desktop suite in a configured Python environment. Then execute and record the manual checklist before changing the phase status to complete.

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
- Labels show side/type plus quantity or projected P&L, e.g. `BL 13K`, `SL -1.2%`, `T +2.4%`.
- Dragging a line previews locally and sends exactly one backend update on drag end.
- Delete/Backspace cancels the selected line.

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
- Convert selected SL to LIMIT by selecting action then clicking chart price.
- Bulk convert all closing orders to SL/LIMIT from chart right-click.
- Run Flatten with and without existing stoploss orders.
- Verify chart reaction remains fast during repeated Next Bar presses.
