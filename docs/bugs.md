
# Bugs
This document has the bugs which are found while testing. They are divided at Phase wise.
Look at each of the bugs, fix them and then mark them resolved as well if approved manually. Do get manual approval against each bug to resolve it.

## Phase-VII PaperTrading

### Open Bugs

**[RESOLVED — Phase VIII Sprint 1]** Open order price lines not filtered by strike (BUG-VII-1).
- `getOrdersForPane` in App.tsx filtered by `right` only. A SELL order on CE 23450 showed its dashed price line on a CE 23500 pane.
- Fix: added `strike: int | None = None` to backend `Order` model + `PlaceOrderRequest`; router resolves strike from `session.strike_ce`/`strike_pe` by `order_right`; `_write_order_to_db` persists it; frontend `Order` interface has `strike?: number | null`; `getOrdersForPane` filters `o.strike == null || o.strike === pane.strike`. Trade marker fix (116c4f3) also applied: `getTradesForPane` + internal `paneTrades` filter both check `t.strike === pane.strike`.

### UI Bugs

**[RESOLVED]** PE (or CE) options chart in Simulated Trading loses its completed candles after clicking the ↻ refresh button.
- **Symptom**: At 09:23 with 3-min candles, clicking ↻ on the PE chart leaves only the growing 09:21 candle. The completed 09:15 and 09:18 candles vanish.
- **Root cause**: The cutoff filter in the options historical `.then()` callback used `latestTickRef.current?.time`. When the PE pane's `latestTick` prop is null (due to a strike mismatch, or options data gap), this is undefined/null → falls back to `startWindowTs` (09:15 boundary). `priorCandles.filter(c => c.time < 09:15_ts)` excludes all current-session candles (09:15, 09:18, …), leaving `series.setData([])`. Only the live tick restores 09:21.
- **Fix**: Added `currentSimTime` prop (equity master-clock time from `sim.latestEquityTick?.time`) and a `currentSimTimeRef` in Chart.tsx. The cutoff now uses `latestTickRef.current?.time ?? currentSimTimeRef.current ?? undefined`, so the equity clock serves as a reliable fallback when the options pane's own tick is null. App.tsx passes `currentSimTime={sim.latestEquityTick?.time ?? null}` to all Chart instances.

**[RESOLVED]** ↻ refresh misses the most recently completed candle window for all chart types (CE, PE, Equity, Index).
- **Symptom**: Refreshing at 09:24:30 with 3-min candles shows 09:15 and 09:18 correctly but 09:21 (the last fully completed window before the current growing 09:24 candle) is absent. Affects all pane types.
- **Root cause (options panes)**: `liveTsNow` was `latestTickRef.current?.time` (the pane's own latest tick). For options data with gaps, the PE/CE tick can be stuck in the 09:21 window (e.g. 09:21:47) while the equity clock is already at 09:24:30. `Math.floor(09:21:47 / 180) * 180 = 09:21:00_ts` → `priorCandles.filter(c.time < 09:21:00_ts)` excludes the 09:21 candle. **Root cause (equity panes)**: `getPreSession(startTime)` with `startTime = "09:15:00"` returns `[]` (start_ts == market_open_ts), so equity panes never load today's completed candles from the backend on refresh — they rebuild one tick at a time.
- **Fix**: Two changes in Chart.tsx. (1) Options cutoff: flip priority to `currentSimTimeRef.current ?? latestTickRef.current?.time` so the equity master-clock (always current) drives the cutoff instead of the potentially-stale options tick. (2) Equity pre-session: when `currentSimTimeRef.current` is non-null and matches `tradingDate`, call `getPreSession(tradingDate, currentSimTimeHHMMSS)` instead of `getPreSession(startTime)`, returning all completed candles up to the current window boundary.

### Data Bugs

### Missed Feature Implementations

**[RESOLVED]** Trade History does not show trades from previous sessions on the same date for the same symbol + instrument type.
- **Use case**: User trades NIFTY options 09:15–10:00, stops, restarts at 10:15 (sim or paper). The new session's Trade History starts empty — previous trades are invisible.
- **Scope**: `user + symbol + date + instrument_type + session_type` combination. For options, ALL strikes/expiries on that date are included (strikes change mid-day, user wants full picture).
- **Fix**:
  - **Backend**: Added `GET /api/trades/by-context` endpoint in `routers/trading.py`. Params: `symbol`, `date`, `instrument_type`, `session_type` (+ `X-User-Id` header). Reuses `analysis_service.get_sessions_for_user` + `get_trades_for_session`. Returns `{trades, session_ids}` sorted by timestamp.
  - **Frontend `api.ts`**: Added `getTradesByContext(symbol, date, instrumentType, sessionType)` returning `{trades, sessionIds}`.
  - **Frontend `useSimulation.ts`**: Added `historicalTrades: Trade[]` to `SimulationState`. After `startSession`, fires a background `getTradesByContext` call and filters to exclude the current session_id. Added `prevDayPnl` computed value (realized P&L from historicalTrades net of commissions). Cleared on `stopSession`.
  - **Frontend `TradeHistory.tsx`**: Accepts `historicalTrades?: Trade[]` prop. Current session trades listed first (most-recent-first), then `── Previous sessions ──` separator, then historical trades at 55% opacity.
  - **Frontend `App.tsx`**: Passes `historicalTrades={sim.historicalTrades}` to `<TradeHistory>`. Day P&L header shows `totalDayPnl = netDayPnl + sim.prevDayPnl` with a grayed `(prev ±X)` annotation when previous-session P&L is non-zero. Session P&L (right TradePanel) remains current-session-only.
- **Key constraint**: Only previous sessions (not current) are loaded from DynamoDB; current session trades arrive via SSE `order_filled` events and `sim.trades` as before.

## Post-Phase-IX UI Fixes

### Streaming Bugs

**[RESOLVED]** Kite live streaming never starts after server runs 48+ hours without a token, then token is added and a PaperTrading/RealTrading session is started (PR #90, 2026-05-27).
- **Symptom**: Chart historical data loads (Phase 1) but no live ticks arrive (Phase 2). Restarting the backend fixes it.
- **Root cause**: `KiteBroadcaster._start()` set `self._connected = True` on the main thread immediately after `ticker.connect(threaded=True)`. If the WebSocket handshake failed quickly (403 — typically because previous ghost KiteTicker threads from a long-running server were still occupying Kite's 3-concurrent-connection limit), kiteconnect's background thread fired `_on_close → _connected = False` before or concurrently with the main thread writing `True`, leaving `_connected = True` on a dead ticker. Subsequent `register()` calls then invoked `_subscribe_more()` on the dead ticker (silent no-op) instead of launching a fresh connection. The 5-second 403-restart timer would eventually reconnect, but only if the user waited long enough, and only if the new connection also succeeded (which it wouldn't if ghost connections persisted).
- **Secondary root cause**: `_on_connect` never set `_connected = True`, so after kiteconnect's internal auto-reconnect fired `_on_connect`, `_connected` stayed `False`, causing the next `register()` to spawn a duplicate KiteTicker and burn another connection slot.
- **Fix**:
  - Moved `self._connected = True` from `_start()` to `_on_connect()` (the only authoritative place).
  - Added `ws is not self._ticker` guard in `_on_connect()` to ignore stale callbacks from replaced tickers.
  - `_start()` now saves and closes the old `_ticker` under lock before creating a new one, eliminating ghost connections.
  - New `_ticker` is stored under lock *before* `connect()` so concurrent `register()` calls see a non-None ticker and skip `_start()`.
  - `register()` gate changed: `_ticker is None` → `_start`; `_connected` → `_subscribe_more`; else (handshake in flight) → no-op (`_on_connect` will subscribe all `_token_sessions` tokens when it fires).
- **Applies to**: PaperTrading and RealTrading sessions on the Kite streaming path.
- **Files**: `backend/app/services/kite_service.py`.

**[RESOLVED]** Kotak Neo market-data and order-feed WebSockets silently die after a connection drop on a long-running server; streaming stops without prompting re-authentication (PR #90, 2026-05-27).
- **Symptom**: After the server runs for an extended period, Kotak Neo streaming stops delivering ticks. `_authenticated` stays `True` so `is_ready()` returns `True` and no TOTP prompt appears, but no market data arrives.
- **Root cause**: `KotakNeoService._on_close()` only logged a warning. If `neo_api_client`'s `NeoWebSocket` did not auto-reconnect, `_on_open` (and hence `_reconnect_callback` → `KotakBroadcaster._on_reconnect` → `_subscribe_all`) never fired, leaving all subscriptions dead.
- **Fix**: `_on_close()` schedules a 5-second `_attempt_reconnect_order_feed` timer that calls `_start_order_feed()` if still authenticated — no TOTP required. `_on_open()` cancels the timer if `neo_api_client` auto-reconnects first, preventing a duplicate `subscribe_to_orderfeed()` call.
- **Files**: `backend/app/services/kotak_service.py`.

### Real Trading Bugs

**[RESOLVED]** TP exit sell trade missing from history; stale SL showing in open orders after TP fires (PR #151, 2026-06-02).
- **Symptom 1**: After TakeProfit strategy fired and exited the position on the broker, the sell trade did not appear in Trade History after page refresh.
- **Symptom 2**: The SL Sell order remained visible in Open Orders even though the broker had already cancelled it.
- **Root cause 1 (trade missing)**: `check_orders()` speculatively marks the replacement LIMIT order (placed after SL cancel) as `FILLED` before Kotak confirms. Reconcile's guard `o.status != PENDING` then skipped it. If the WebSocket fill callback also missed (e.g. transitional "cancelled" event on the SL's kotak_order_id removed the fill callback), the trade was permanently lost with no recovery path.
- **Root cause 2 (stale SL)**: When `modify_sl_to_limit_order()` causes Kotak to send a transitional "cancelled" WebSocket event for the SL's order ID, the local SL order stays `PENDING` indefinitely — `check_orders()` skips it (kotak_order_id guard) and the old reconcile had no mechanism to sync cancelled broker orders to local state.
- **Fix**:
  - Added `kotak_fill_confirmed: bool = False` to `Order` model. Set to `True` in both the SL `on_fill` callback (`orders.py`) and the LIMIT/TARGET fill callback `_make_fill_cb` (`simulation.py`).
  - `_make_fill_cb` now also updates `o.status`, `o.filled_at`, `o.filled_price`, and calls `_write_order_to_db()` (all were missing).
  - Reconcile Pass 1 guard changed from `o.status != PENDING` to `o.status == CANCELLED or o.kotak_fill_confirmed` — FILLED-locally orders where the callback missed are now processed.
  - New **Reconcile Pass 3**: iterates broker-cancelled/rejected orders in `kotak_order_map`, cancels the corresponding local PENDING order, and emits `order_cancelled` SSE.
- **Files**: `backend/app/models/schemas.py`, `backend/app/services/simulation.py`, `backend/app/routers/orders.py`, `backend/app/routers/kotak.py`.
- **Note**: Double wallet credit for SELL LIMIT orders in the cancel+replace path (`check_orders()` credits at local-fill time, `_make_fill_cb` credits again on Kotak confirmation) is a known out-of-scope issue — fix in a follow-up PR.

**[RESOLVED]** Kotak Neo rejects equity orders with "symbol is wrong" for TATMOT (and potentially TATPOW/RELIND).
- **Symptom**: Placing a BUY/SELL order in real trading for TATMOT fails — Kotak API returns an error indicating the trading symbol is invalid.
- **Root cause**: Kotak Neo `nse_cm` (NSE cash market) requires the `-EQ` suffix for equity trading symbols (e.g. `TMCV-EQ`, not `TMCV`). The `_SYMBOL_MAP` in `kotak_service.py` was missing this suffix for all three equity symbols: `TATPOWER`, `TMCV`, `RELIANCE`.
- **Fix**: Updated `_SYMBOL_MAP` to `TATPOWER-EQ`, `TMCV-EQ`, `RELIANCE-EQ` for the `nse_cm` entries. Index/options symbols (`NIFTY` on `nse_fo`, `SENSEX` on `bse_fo`) do not use this suffix.
- **File**: `backend/app/services/kotak_service.py` — `_SYMBOL_MAP`.

**[RESOLVED]** Kotak-rejected orders silently dropped — no UI feedback, no log, wallet permanently deducted (PR #56, 2026-05-22).
- **Symptom**: Orders rejected by Kotak (visible in Kotak UI) were invisible in TradeMatangi — no error banner, no log line, no order removal. For BUY LIMIT/TARGET orders the upfront wallet reservation was never credited back.
- **Root cause**: `KotakNeoService._on_message` only handled `"complete"`/`"filled"` statuses. `"rejected"` and `"cancelled"` WebSocket messages returned early without any action.
- **Fix**:
  - Added `_reject_callbacks` dict to `KotakNeoService` with `register_reject_callback` / `deregister_reject_callback` methods.
  - `_on_message` now dispatches reject callbacks + logs `WARNING` on `"rejected"`/`"cancelled"` status; cleans up both fill and reject maps on either event; all other statuses get a `DEBUG` log.
  - `simulation.py`: reject callback for triggered LIMIT/TARGET orders reverts status to `CANCELLED`, credits back `reserved_amount` for BUY orders, emits `order_cancelled` + `broker_error` SSE.
  - `orders.py`: same for SL orders placed directly on Kotak at placement time.
  - `trading.py`: reject callback for direct TradePanel buy/sell emits `broker_error` SSE (no wallet credit needed — direct orders only debit on fill).
- **Files**: `kotak_service.py`, `simulation.py`, `orders.py`, `trading.py`.

**[RESOLVED]** TradeHistory 🔄 and ⛶ buttons pushed to far right instead of beside title (PR #56, 2026-05-22).
- **Symptom**: Both buttons were wrapped in a `marginLeft: auto` flex container, pushing them to the far right of the Trade History header.
- **Fix**: Removed the wrapper div; buttons now sit directly in the header flex row after the "Trade History (n)" span. Refresh (🔄) is real-trading-only; Maximize (⛶) shows only when trades exist.
- **File**: `frontend/src/components/TradeHistory.tsx`.

**[RESOLVED]** Kotak order-feed WebSocket never connected; refresh didn't pick up Kotak fills (PR #60, 2026-05-22).
- **Symptom**: Orders filled on Kotak (visible in Kotak UI) never appeared in TradeMatangi Trade History. Clicking 🔄 also had no effect.
- **Root cause 1**: `_start_order_feed` set `on_message`/`on_error`/`on_open`/`on_close` as attributes on the client but never called `client.subscribe_to_orderfeed()`. That method (from `neo_api_client` source) is what creates `NeoWebSocket` and starts `get_order_feed()` in a background thread. Without it the WebSocket simply never connected.
- **Root cause 2**: `onRefresh` in `App.tsx` only called `api.getTrades(sessionId)` which reads local DynamoDB. Fills that arrived while the WebSocket was down were never recorded locally, so refreshing showed no new trades.
- **Fix 1**: Added `self._client.subscribe_to_orderfeed()` call at the end of `_start_order_feed`, after setting callback attributes (required by `check_callbacks()` inside `subscribe_to_orderfeed`). File: `kotak_service.py`.
- **Fix 2**: New `POST /api/kotak/reconcile?session_id=...` endpoint. Fetches `order_report()` from Kotak, inverts `session.kotak_order_map` to map kotak_order_id → local order_id, and for each filled order still PENDING locally: records the trade, updates wallet, marks FILLED, emits `order_filled` SSE. `onRefresh` now calls reconcile first, then re-fetches trades and refreshes wallet. Files: `kotak.py`, `api.ts`, `App.tsx`.
- **Key**: `order_report()` response — `stat == 'Ok'` means success; orders in `data` list. Fill fields: `nOrdNo`, `ordSt` ("complete"/"filled"), `avgPrc`/`flPrc`, `flQty`/`qty`.

**[RESOLVED]** Kotak order-feed `_on_message` silently drops all fills/rejects — `data` is a list, not a dict (PR #62, 2026-05-22).
- **Symptom**: Even after PR #60 connected the WebSocket, fills/rejects never triggered callbacks. The reconcile button was the only way to pick up fills.
- **Root cause**: The inner message structure is `{"type":"order","data":[{...}]}` — `data` is a list. The `isinstance(order_data, dict)` guard returned silently for every real message.
- **Fix**: Normalize payload to a list, iterate all items. `if isinstance(raw_orders, dict): raw_orders = [raw_orders]`. Processes all order updates per message, not just the first. File: `kotak_service.py`.

**[RESOLVED]** Reconcile endpoint missed fills when `stat` reaches "complete" before `ordSt`; wrong filled-qty field (PR #62, 2026-05-22).
- **Root cause 1**: Checked only `ordSt`. Kotak `order_report` has two parallel status fields — either can arrive first.
- **Root cause 2**: Used `flQty`; actual field is `fldQty`.
- **Fix**: Check both `ordSt` and `stat`; probe qty as `fldQty → flQty → qty`. File: `kotak.py`.
- **Also**: Added `KotakNeoService._normalize_order()` which converts all raw Kotak field names (`nOrdNo`, `ordSt`, `trnsTp`, `fldQty`, `avgPrc`, …) to stable UI-friendly keys (`kotak_order_id`, `status`, `side`, `filled_quantity`, `filled_price`, …). `get_order_history()` now returns normalized dicts; reconcile endpoint uses normalized names throughout.

**[RESOLVED]** Kotak order-feed WebSocket callbacks crash — wrong arity (PR #64, 2026-05-22).
- **Symptom**: Log showed `"Kotak Neo order feed WebSocket subscribed"` immediately followed by `ERROR: KotakNeoService._on_open() takes 1 positional argument but 2 were given`. WebSocket opened but no messages were ever processed.
- **Root cause**: Kotak's `NeoWebSocket` calls `on_open`, `on_close`, and `on_error` with the ws object as an extra positional argument. All three were defined as `(self)` only.
- **Fix**: Changed to `(self, *args)`. `_on_error` extracts `args[0]` for the log line. File: `kotak_service.py`.

**[RESOLVED]** Kotak Neo rejects orders with non-tick-aligned prices (PR #58, 2026-05-22).
- **Symptom**: Orders placed at prices like ₹456.23 (not a multiple of ₹0.05) were rejected by the exchange. `round(price, 2)` allows 1-paise precision but NSE/BSE minimum tick is 5 paise.
- **Fix**: Added `_round_to_tick(price)` helper in `kotak_service.py` using `round(round(price / 0.05) * 0.05, 2)`. Applied to all three price fields sent to Kotak: limit price, SL trigger price, SL limit price. Callers unchanged — rounding happens centrally at the API boundary.
- **File**: `backend/app/services/kotak_service.py`.

### UI Bugs

**[RESOLVED]** Trade marker colors — BUY/SELL distinction unclear on dark background (PR #50, 2026-05-22).
- **Symptom**: Old colors were directional (long Nifty = white, short Nifty = red `#FF4D4D`). Red blends with red down-candles; the PE-inversion logic meant PE-Buy showed red (confusing instrument-level traders).
- **New spec**: Marker color follows raw instrument side — BUY = white `#FFFFFF`, SELL = bright yellow `#FFE600`. Applied to all panes (equity, CE, PE). Analysis/underlying chart keeps directional mapping (CE Buy→white, CE Sell→yellow, PE Buy→yellow, PE Sell→white) via `effectiveSideForChart`.
- **Files**: `Chart.tsx` (removed `isLongDirection`; color = `t.side === 'BUY' ? '#FFFFFF' : '#FFE600'`), `TradeAnalysis.tsx` (same yellow), `CLAUDE.md` (updated invariant).

**[RESOLVED]** Maximizing any chart resets the current in-progress candle bar (PR #50, 2026-05-22).
- **Symptom**: While a 3-min candle has been accumulating for ~2 minutes, clicking ⤢ to maximize the chart causes it to restart from the current streaming value — losing the bar's high/low/open. Reproduced on equity, CE, PE panes in both sim and paper sessions.
- **Root cause**: The old `renderLayout()` had a standalone `if (maximizedPaneId !== null)` branch that returned only the maximized pane as a direct child of the chart column div. Multi-pane layouts (2/3/4) wrap pane wrappers in intermediate flex containers. Switching branches changed each pane wrapper's DOM parent — React treats a DOM-parent change as unmount+remount regardless of `key`, resetting all Chart refs including `liveWindowRef.current`. The next tick then restarted the bar from scratch.
- **Why a partial fix failed for paper trading**: A first fix attempted to restore `liveWindowRef.current` from the last candle in the re-fetched historical data. This worked for simulation (past-date parquet is complete) but not paper trading — the options parquet for today is cached with a 10-minute TTL and may not yet contain the current partial candle, so `candles.find(c => c.time === cutoffTs)` returned `undefined`.
- **Final fix (App.tsx)**: Removed the standalone maximize branch. Each layout preset now handles maximize inline while preserving its flex container structure. Non-maximized panes get `{ display: 'none' }` — still mounted, `liveWindowRef` intact. For layouts 3/4, row containers holding no maximized pane get `display: none` (avoids layout gaps) while pane wrappers inside remain in the React tree.
- **Fix (Chart.tsx ResizeObserver)**: Added `if (w > 0)` guard so `chart.applyOptions({ width: 0 })` is never called when a pane transitions to `display: none`.
- **Fix (Chart.tsx partial-candle restore)**: Kept as safety net for hard-refresh during a running session. After `series.setData()` in both equity and options historical effects, restores `liveWindowRef.current` from the last fetched candle if its timestamp matches the current bar slot.
- **Key lesson**: React component identity is tied to position within the **same DOM parent**, not just the `key` prop. Use CSS `display: none` for layout-driven show/hide — never conditional rendering.

---

## Phase-IV BetaMinorUpdates

### UI Bugs



### Data Bugs


### Missed Feature Implementations

## Phase-XI AI Helper

### AI Helper Bugs

**[RESOLVED]** Duplicate AI exit fires — same exit command evaluated and dispatched multiple times (PR #158, 2026-06-03).
- **Symptom**: On bar-close, `exit_position` dispatched to the backend 2–3× in rapid succession. Position exited correctly but backend received redundant market-sell calls; trade history showed extra entries.
- **Root cause**: Multiple concurrent `_evaluate_exit()` calls (one per bar-close fire) all passed the guardrail and dispatched to the backend before any of them could mark the command as executed in DynamoDB.
- **Fix**: Added `claim_command_execution()` to `commands_store.py` — an atomic conditional write that transitions `active → executing`. Evaluators call this after the guardrail passes and before backend dispatch. Concurrent evaluators that lose the race receive `skipped_duplicate` and return without calling the backend. `unclaim_command_execution()` reverts to `active` on backend failure, allowing the command to retry on the next bar.
- **Files**: `aihelper/db/commands_store.py`, `aihelper/services/command_evaluator.py`.

**[RESOLVED]** Open SL order not cancelled after AI `exit_position`; double margin on Kotak (PR #158, 2026-06-03).
- **Symptom**: After the AI helper fired `exit_position` and the position was market-sold, the SL sell order remained open on the broker and in the UI. On Kotak (options), a pending SL sell + new market sell active simultaneously doubled the margin requirement.
- **Root cause**: `_evaluate_exit()` called `exit_position_market()` directly without first cancelling the open SL.
- **Fix**: Added `cancel_open_stoploss(right)` to `backend_client.py` — fetches open orders and DELETEs any `is_stoploss` orders matching the instrument right. Called in `_evaluate_exit` for `exit_position` only (SL/TP commands keep the position open). The cancel fires **before** `exit_position_market()` to guarantee no overlap window on Kotak.
- **Files**: `aihelper/services/backend_client.py`, `aihelper/services/command_evaluator.py`.

