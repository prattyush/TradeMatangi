#### Phase-VII PaperTrading
This phase will support PaperTrading and realtime streaming of data.

##### PAPERTRADING
1. To support papertrading, only extra that needs to be supported is to fetch current streaming data from a broker. The data will be directly streamed to the UI. Backend can decide to store it if suitable.
2. Option to choose whether the current session would be papertrading session or simulated trading session. Or based on date automatically paper trading will be launched, if the date is todays date based on IST Timezone. We will also need to introduce realtrading going forward so plan accordingly.
3. Use the same wallet for both simulated and paper trading. And the wallet should reflect the P&L. Easier to implement. If user wants they can always reset it.
4. While persisting trades, include an option to specify that these trades where taken in paper trading case. When doing analysis of trades, simulated and paper trading can be analyzed separately and both are very different situations and require different mental states.
5. Papertrading needs to be suppoorted for both options and symbol trading.
6. In PaperTrading pause button doesn't make much sense, I will leave it to you to whether have it or disable it. If present, then just stop the showing of streaming of data and when resumed, it would be users responsibility to click on refresh against a symbol and fetch the latest data. Refresh is explained in the UI-Upgrade Feature.

##### UI-Upgrade
1. One of the problems in UI with papertrading is that, when we start the session which lets say can be at 9:50am. Now, first historical data would needed to be fetched for that day. So, ideally data should come till 09:49am. However, due to a number of issues or data not get present in server, we might only get it till 09:48am. So, to solve this, the UI should have a refresh option present beside the Trend and H-Line option to refresh data. When refresh data would be clicked it would fetch the historical data for that symbol till the previous bar. That is lets say the chart is showing data at 5 minutes interval and current time is 10:13am. Then the historical data should be fetched till 10:10 or 10:05 whichever is more suitable and UI updated. This will make sure that if any data is missing user can refresh it later and get the accurate bar chart. Though I think the refresh is already implemented as part of Phase 5, just check and validate.
2. UI Settings should have an option of how many days old data needs to fetched whenever either the simulated trading is running or papertrading. I think currently it is hard coded to 2 or 3 days. Now that should be configurable through UI Settings and default to 2 days (previous days). These settings are user based so needs to be persisted accordingly.


##### Broker Integration
1. For fetching live data, suggestion is to use Kite Broker Client or Zerodha Broker Client. As that is a paid subscription and more reliable. Going forward when using live streaming data always fetch it from Kite Broker.
2. The library link is https://github.com/zerodha/pykiteconnect and the documentation is at https://kite.trade/docs/pykiteconnect/v4/
3. The code snippet to connect to kite is:-
```
import configparser
from kiteconnect import KiteConnect

credentials_config_parser = configparser.ConfigParser()
credentials_config_parser.read('data/accesskeys.ini')
kite = KiteConnect(api_key=credentials_config_parser['kite']['api_key'], access_token=credentials_config_parser['kite']['access_token'])

```
4. The credentials for kite are present in the data/accesskeys.ini.
5. Don't use Kite to fetch historical data as it only gives at minute granularity which is of no use. You can use Kite to fetch older data for today's date based on IST and then extrapolate the seconds data from the 1 minute granularity. I will leave the choice to you, but, don't use Kite to fetch historical data for simulated trading, or fetching data for yesterday or day before yesterday or any previous days. You can also use ICICIDirect to fetch todays data as well, use as suited.
6. If the access token has expired show an error in UI and mention shifting to ICICIDirect for Streaming Data and revert to ICICIDirect broker. If ICICIDirect is also failing, show an error to UI and stop.
7. Sometimes the live streaming stops sending data and hangs for both kite and breeze (icicidirect). Please don't timeout and wait. A possible wait would be 5-10 minutes before raising any errors, or maybe wait indefinitely and wait for the user to stop the session.
8. For using Kite API, if you need to fetch the instrument token against the trading symbol, feel to fetch them and store in data/
9. Kite symbol name for NIFTY is "NIFTY 50", for SENSEX is "SENSEX".
---

## Phase VII Implementation Status

### 🚧 In Progress — branch: feature/phase-vii-paper-trading (350 tests passing)

#### What is shipped

**Core paper trading engine** (`backend/app/services/simulation.py`):
- `_run_paper_session`: 3-phase async loop — Phase 1 fast pre-replay, Phase 2 Kite stream registration, Phase 3 live tick consumption
- `SimulationSession.session_type`: `"sim"` | `"paper"`, stored on session and passed through to trade records
- `SimulationSession.paper_tick_queue`: asyncio.Queue(maxsize=3000) separate from SSE queue; Kite broadcaster puts 1-sec OHLC dicts here
- Dual-stream Phase 1 options pre-replay: loads CE/PE Breeze data into dicts, equity tick as master clock
- Kite 1-min gap-fill after each Phase 1 branch: `_kite_1min_gap_ticks` + `_kite_1min_gap_options_ticks`

**Kite live streaming** (`backend/app/services/kite_service.py`):
- `KiteBroadcaster` singleton: one KiteTicker WebSocket per API key; fans out 1-second OHLC candles to per-session queues via `loop.call_soon_threadsafe`
- `_OHLCAccumulator`: aggregates raw LTP ticks into 1-second OHLC; emits completed candle on second boundary
- IST offset fix: `ts_second = int(exchange_timestamp.timestamp()) + 19800` — Kite WebSocket timestamps are naive UTC; +19800s converts to IST-as-UTC to match the Breeze data convention
- `BreezeStreamManager`: fallback when Kite token is invalid; uses `breeze.subscribe_feeds()` + `ws_connect()`
- Equity instrument tokens: hardcoded for NIFTY/BSESEN; NSE CSV cache for stocks
- Options instrument tokens: NFO/BFO CSV cache; lookup by name + expiry + strike + right
- **NEW**: `fetch_kite_1min(symbol, date)` and `fetch_kite_1min_options(symbol, date, strike, expiry, right)` — 1-min Kite REST historical data for paper-session gap-filling; cached as `{SYMBOL}-{DD-MM-YYYY}-kite1m.parquet` / `{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY}-{DD-MM-YYYY}-kite1m.parquet` (distinct from Breeze 1-second files so sim mode never uses them)

**Broker service** (`backend/app/services/broker_service.py`):
- 10-minute TTL for today's partial parquet: re-fetches from Breeze when stale; `partial_pq` fallback when Breeze unavailable
- `validate_and_fill_gaps(df, date, partial=True)`: skips trailing gap check for today's incomplete data; reindexes only to last available row

**Router** (`backend/app/routers/simulation.py`):
- `_soft_ensure()`: non-fatal pre-cache for paper sessions (Breeze data missing = warning, not 500)
- `session_type` propagated from request → `create_session()` → `SimulationSession`

**Frontend** (`frontend/src/components/SessionControls.tsx`):
- `isPaperMode = currentDate === todayIST()`
- Paper mode: always sends `startTime = '09:15:00'`, hides Start Time input, shows ● LIVE badge
- Pause button disabled in paper mode (live data can't be paused)

**Frontend** (`frontend/src/components/Chart.tsx`):
- `latestTickRef` syncs current tick without adding to effect deps
- Options historical cutoff: `latestTickRef.current?.time` used as `cutoffTs` when ticks are flowing (refresh during paper session loads all of today's candles up to "now" instead of resetting to 09:15 boundary)
- `currentSimTimeRef`: ref updated every render from `currentSimTime` prop (equity master-clock unix ts); used as primary cutoff for options refresh so stale CE/PE tick does not drive the wrong candle boundary
- Options refresh cutoff priority: `currentSimTimeRef.current ?? latestTickRef.current?.time` — equity clock is always current regardless of CE/PE data gaps
- Equity refresh extended to current sim time: on refresh during a running session, computes current sim HH:MM:SS from `currentSimTimeRef.current` and calls `getPreSession(symbol, date, currentSimHHMMSS)` (guarded by `simDate === tradingDate`) so completed session candles (e.g. 09:15, 09:18, 09:21) are restored immediately instead of rebuilt tick-by-tick

**Router** (`backend/app/routers/simulation.py`):
- `update_pane_strike` now calls `kite_service.get_broadcaster().update_session_right()` for paper sessions after updating `session.strike_ce/pe`; wrapped in try/except so Kite lookup failure degrades gracefully

**Kite service** (`backend/app/services/kite_service.py`):
- `KiteBroadcaster.update_session_right(session_id, right, new_token, queue, loop)`: atomically swaps the old token for the new one in `_token_sessions` / `_session_tokens`, unsubscribes orphaned tokens, subscribes to the new token — enables mid-session strike changes without restarting the session

**Trade History cross-session** (backend + frontend):
- **Backend** `GET /api/trades/by-context`: new endpoint in `routers/trading.py`; params `symbol`, `date`, `instrument_type`, `session_type` + `X-User-Id` header; calls `analysis_service.get_sessions_for_user` + `get_trades_for_session`; returns `{trades, session_ids}` sorted by timestamp
- **Frontend `api.ts`**: `getTradesByContext(symbol, date, instrumentType, sessionType)` → `{trades, sessionIds}`
- **Frontend `useSimulation.ts`**: `historicalTrades: Trade[]` in state; fire-and-forget fetch after `startSession` filters out current session_id; `prevDayPnl` computed (realized P&L from historicalTrades net of commissions); cleared on `stopSession`
- **Frontend `TradeHistory.tsx`**: `historicalTrades?: Trade[]` prop; ⛶ button moved to immediately after count label (was flush right requiring horizontal scroll); current-session trades listed first, then `── Previous sessions ──` separator, then historical at 55% opacity — both compact and expanded views
- **Frontend `App.tsx`**: `totalDayPnl = netDayPnl + sim.prevDayPnl` drives Day P&L header; grayed `(prev ±X)` annotation shown when previous-session P&L is non-zero; `historicalTrades` prop passed to `<TradeHistory>`

#### Bugs Fixed This Phase

- **Live ticks silently dropped**: `payload.pop("type", "tick")` in Phase 3 loop stripped the `"type"` field before building `tick_for_emit`; SSE event had no `type: "tick"` so frontend's `handleSSEMessage` check `event.type === 'tick'` was always false. Fix: changed to `payload.get("type", "tick")`.
- **Gap validation error (114m)**: `validate_and_fill_gaps` computed trailing gap from last row to `MARKET_CLOSE`. For today's partial data this always exceeded 15 min. Fix: `partial=True` mode skips trailing gap and reindexes only to last available row.
- **Infinite Breeze re-fetch loop**: Today's parquet always had < 20,000 rows (day not complete), triggering re-fetch on every API call. Fix: 10-minute TTL — only re-fetch if parquet is stale.
- **Kite ticks 5.5h off**: `exchange_timestamp` from WebSocket is naive UTC; adding IST offset (+19800s) was missing. Ticks landed 5.5 hours in the past → "Cannot update oldest data" silently dropped. Fix: `ts_second = int(ex_ts.timestamp()) + 19800`.
- **`asyncio.get_event_loop()` deprecated**: Changed to `asyncio.get_running_loop()` in async context.
- **Refresh clears today's CE/PE bars**: Options historical `cutoffTs = startWindowTs` (09:15) on refresh because `liveFromTs` is unset for initial panes. Phase 1 replay already done; Kite streaming only fills from "now". Fix: use `latestTickRef.current?.time` as cutoff so all completed candles up to current position are reloaded.
- **Chart gap on session restart**: Breeze parquet cached at 14:00; restarting at 14:17 replayed only to 14:00. Kite streaming then started from 14:17 leaving a 17-minute gap. Fix: after Breeze replay, fetch Kite 1-min REST data for the gap period and emit those ticks before Phase 2 starts.
- **Delete+re-add pane (paper mode) streams old strike's ticks**: `update_pane_strike` updated `session.strike_pe` and frontend `sessionStrikePE` but `KiteBroadcaster` remained subscribed to the old PE token → Phase 3 forwarded old-strike ticks. Fix: added `update_session_right()` to broadcaster; router calls it after updating `session.strike_ce/pe` for paper sessions.
- **↻ refresh wipes last completed candle on all pane types**: At 09:24:30 with 3-min candles, the 09:21 candle (most recent completed window) was absent after refresh. Root cause (options): `latestTickRef.current?.time` for CE/PE can be stale (09:21:47) while equity is at 09:24:30 — `floor(09:21:47 / 180) * 180 = 09:21:00`, so filter `c.time < 09:21:00` excluded the 09:21 candle. Root cause (equity): `getPreSession("09:15:00")` returns `[]` so refresh lost all in-session candles. Fix: (1) Flip options cutoff priority to `currentSimTimeRef.current ?? latestTickRef.current?.time` — equity master clock is always current. (2) Equity refresh calls `getPreSession(currentSimHHMMSS)` when `currentSimTimeRef.current` matches the trading date, recovering all completed candles immediately.
- **↻ refresh drops completed candles on CE/PE pane when options tick is null**: At 09:23 with 3-min candles, clicking ↻ on the PE chart left only the growing 09:21 candle; 09:15 and 09:18 vanished. Root cause: `latestTickRef.current?.time` was null for PE when the pane's own tick had never arrived (strike mismatch / gap) → cutoff fell back to `startWindowTs` (09:15) → `priorCandles.filter(c.time < 09:15_ts)` excluded all session candles. Fix (prior to the master-clock flip): added `currentSimTime` prop (equity master-clock) as reliable fallback when the options tick is null.
- **Trade History empty on session restart for same day**: Restarting a session for the same symbol+date+instrument_type+session_type showed an empty Trade History even though DynamoDB had trades from earlier sessions. Fix: `GET /api/trades/by-context` endpoint + client-side fetch in `startSession` populates `historicalTrades`; Day P&L includes `prevDayPnl` from those trades.

#### Lessons Learned

- **IST-as-UTC convention applies everywhere**: Kite WebSocket `exchange_timestamp` is naive UTC; Kite REST historical data returns IST naive. Both need different handling to produce the same IST-as-UTC Unix timestamp used by the chart. Always verify timestamp offsets when adding a new data source.
- **Separate cache files for different data granularities**: Breeze 1-second and Kite 1-minute data serve different purposes. Using the same filename would cause sim mode to accidentally use the lower-resolution Kite data. Suffix `-kite1m` on Kite parquet files prevents cross-contamination.
- **Today's parquet needs TTL, not row-count gate**: The `_MIN_DAY_ROWS = 20000` check is correct for historical days but wrong for today (day is incomplete). A time-based TTL (10 min) is the right gate for partial data.
- **Phase 1 + Kite gap-fill = continuous chart**: Paper trading chart continuity requires two layers: (1) Breeze 1-second for 09:15 to last cached second, (2) Kite 1-min REST for the gap to "now". Without the second layer, each session restart leaves a gap.
- **`payload.pop` vs `payload.get` in tick loops**: When routing fields out of a shared dict for multiple consumers, use `.get()` not `.pop()` if the field needs to be in the dict for subsequent use (e.g., as part of the SSE payload).
- **Refresh cutoff needs current live time, not session start**: For paper mode (always starts at 09:15), `startWindowTs` as cutoff filters out ALL of today's candles. The correct cutoff is the latest tick's time, which the `latestTickRef` pattern reads without adding to effect deps.
- **Singleton WebSocket with per-session queues**: Kite allows one WebSocket per API key. Fan-out via per-session queues lets multiple paper sessions share one connection. `loop.call_soon_threadsafe(queue.put_nowait, payload)` bridges the WebSocket thread to each session's asyncio event loop.
- **KiteBroadcaster token map must be kept in sync with strike changes**: The broadcaster is token-keyed, not strike-keyed. Updating `session.strike_pe` without updating the token subscription causes Phase 3 to forward ticks for the wrong contract. Any mid-session strike change must go through `update_session_right()` to atomically swap the old token for the new one.
- **`update_session_right` is a no-op before Phase 2**: If the user changes the pane during Phase 1 (pre-replay), the broadcaster has no record of the session yet. Safe — Phase 2 reads the already-updated `session.strike_pe` when it registers, so it picks up the correct token automatically.
- **Equity master clock is more reliable than per-pane tick for chart cutoffs**: CE/PE ticks lag equity ticks when options data has gaps. Using `latestPETick.time` as the refresh cutoff produces a stale boundary (e.g. 09:21 when sim is at 09:24) that excludes the most recently completed candle. The equity master-clock (`currentSimTimeRef`) is always current and should be the primary cutoff source for all pane types.
- **`getPreSession(startTime)` returns empty when start == market open**: Calling `getPreSession("09:15:00")` returns `[]` because there is nothing "before" the first window. On refresh during a running session, the equity pane needs to call `getPreSession(currentSimHHMMSS)` (with a date guard) to recover completed in-session candles.
- **Cross-session trade history requires endpoint, not just client state**: Trades from earlier sessions are in DynamoDB only — they never arrive via SSE. A dedicated `GET /api/trades/by-context` endpoint that queries all matching sessions is the cleanest pattern. Client-side fires it once on session start (fire-and-forget) and filters out the current session_id to avoid duplication once SSE trades arrive.
- **`prevDayPnl` must net commissions like `netDayPnl` does**: Historical trade records in DynamoDB carry per-trade `commission`. Summing raw `SELL - BUY` value without subtracting commission overstates P&L. Apply `t.commission ?? 0` the same way as the current-session `netDayPnl` computation.
