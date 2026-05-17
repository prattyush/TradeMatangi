
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

---

## Phase-IV BetaMinorUpdates

### UI Bugs



### Data Bugs


### Missed Feature Implementations

