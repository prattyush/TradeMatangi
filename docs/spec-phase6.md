#### Phase-VI Strategies
This phase is what will differentiate this platform from others. This phase we will implement strategies. Strategies would be 3 types.
1. Entry Strategies - These strategies will run in a separate thread or parallely and when the trigger condition is fulfilled it will execute a trade, Like wait for the 3 minute candle to close and when it closes, then place a target buy option at the high or limit order at the low of the candle. Every entry strategy would have a trigger condition, quantity (can be capital % if funds ratio selected in settings), symbol for which to run for.
2. Exit Strategy - These strategies will run similar to the entry strategies, and will have trigger condition and symbol and quantity. However, in this case the quantity would be the current open position or part of the position when it is triggered. Bascially when triggered it would exit the position. This strategy can only be started when a position is already open. Only example of exit strategy would be break-even, lets say the trade is running at a loss, in that case, breakeven strategy would exit the trade as soon as the price reaches break even or >=0 profit.
3. TradeManagement Strategy - These strategies can be started only when a position is already open. These strategies would be responsible for shifting the stoploss based on conditions, like trailing stoploss to the low of the candles.

##### Setup
1. All strategies would be working on a defined time interval which would be preset in the settings menu. Default would be 3 min interval. Currently, the strategies will only work based on 3 min interval candles.
2. The backend server can be deployed in multiple cores so multiple processes running, so, all strategies needs to persist somewhere that is running and then cancel all strategies is triggered the backend should cancel or delete that entry from table or any other suitable mechanism. So, when the strategies are not triggered. The strategies can either poll or only check when trigger condition is met and then if missing, cancel itself.
3. All strategies should persist and have a unique id for that particular instance. Lets say a strategy is triggered to exit at break even and then cancelled and then maybe again triggered after 15 minutes with no change in position. Then the 2nd time it is triggered it should work fine.

##### StrategyUI
1. The UI should show a list of strategies upon any button click and trade management strategies would be disabled if no position is open.
2. The user can choose any strategy to run, all strategy are pre-defined and won't have any input when running except the quantity or funds ratio for entry strategies and % of position for exit strategies.
3. The UI should also have option to cancel all running strategies, no need of an option of cancel any 1 strategy.
4. Upon some button, the user can be able to see current running strategies and the symbol on which they are running, like for Options Trading, we can have a entry strategy running for both Call and Put option.
5. Some strategies can be specific configurable settings which would be present in the settings menu.


##### AutoStop Strategy
1. This is a entry strategy, it would take the symbol and the funds ratio or quantity (as specified by funds ratio choice in settings which is already present) and direction. Direction (Buy or Sell) is only relevant for equity trades, for options only buy would suffice for now.
2. It would always be a target order or stop limit order be it buy or sell.
3. It would also have a configuration information present in settings, which is the trigger price is either low of bar for sell, high for buy or % gap from close (For sell it would close price - %deviation, for buy it would be close price + % deviation) The deviation would be % of the closing price. The deviation here refers to the trigger price of the stop limit order or target order.
4. The strategy would support the interval minutes which is set at global for all strategies like 3 min candle or 5 min candle.
5. When cancel all strategies is called, it should not trigger and should close itself, either on receipt of the call or sometime later.

##### AggresiveStoploss Strategy
1. This strategy is a trade management strategy and can only be selected if a position is open.
2. This strategy would wait for the bar close and then change the stoploss to 1% below or above the closing price, depending upon whether it is a buy or sell order.
3. If a stoploss order is already open it would use that and only change the price. 
4. If no stoploss order is present, it can create one with same open position quantity or ignore it, do as suited.

---

## Phase-VI Status

### Phase VI — Strategies ✅ COMPLETE (311 tests passing) — PR on feature/phase-vi-strategies

All three strategy types shipped with full backend engine, REST API, DynamoDB persistence, frontend Strat tab, and settings UI:

1. **AutoStop** (Entry) — waits for a configured-interval bar to close, then places a TARGET order at bar high (BUY) or bar low (SELL); alternatively triggers at `close ± deviation%`. Options sessions always BUY. Sized by FundsRatio (L/M/H) or explicit quantity.
2. **BreakEven** (Exit) — ticks every price update; exits 100% of position as a LIMIT order the moment `price >= avg_entry` (LONG) or `price <= avg_entry` (SHORT). Only startable when position is open.
3. **AggressiveStoploss** (TradeManagement) — waits for bar close; moves stoploss to `close × 0.99` (LONG) or `close × 1.01` (SHORT); creates SL order if none exists. Only startable when position is open.

**Backend:**
- `backend/app/services/strategy_service.py` — in-memory `_registry` per session; bar-close detection via epoch-aligned slot formula; DynamoDB Strategies table with `SessionIdIndex` GSI for cross-process cancellation
- `backend/app/routers/strategies.py` — `POST /api/strategies/start`, `POST /api/strategies/cancel-all`, `GET /api/strategies`
- `backend/tests/test_strategy_service.py` — 12 new tests covering all three strategy types + cancel-all

**Frontend:**
- `OrderPanel.tsx` — new **Strat** tab (alongside Mkt/Tgt/Lmt/SL); Entry / Exit / TradeManagement sections; Running Strategies list; Cancel All button; CE/PE selector for options; direction selector for equity AutoStop; no side-panel width change
- `SettingsModal.tsx` — new **STRATEGY SETTINGS** section: Strategy Candle Interval (3 min / 5 min toggle), AutoStop Trigger type (Bar High/Low vs % from Close radio), Deviation % input (conditional)
- `App.tsx` — `runningStrategies` state; `handleStartStrategy` / `handleCancelAllStrategies` callbacks; `strategy_interval_secs` passed to `POST /api/simulation/start`
- `api.ts` — `startStrategy()`, `cancelAllStrategies()`, `listStrategies()`

**Next: Phase VII PaperTrading** (see `docs/spec-phase7.md`)

### Phase VI Lessons Learned

- **`OrderTypeFull` union + early guard**: Adding `'STRAT'` to the tab union (`OrderTypeFull`) breaks TypeScript narrowing in `handlePlace` — branches that call `onPlaceOrder` still see `'STRAT'` as a possible value. Fix: add `if (orderType === 'STRAT') return` at the top of `handlePlace` to narrow before the order-type branches. Always add early-return guards when extending a discriminated union that drives a large handler.
- **Strategy settings travel with the session, not the strategy**: `autostop_trigger_type` and `autostop_deviation_pct` are passed in `POST /api/strategies/start` (not in `POST /api/simulation/start`). This allows different AutoStop instances on the same session to have different settings. The App reads from state (updated by SettingsModal) and forwards on each `startStrategy` call — no re-read from localStorage needed.
- **In-memory registry + DynamoDB for cross-process cancel**: Strategy evaluation checks the in-memory `_registry` — O(1) per session. DynamoDB is written on start, cancel, and complete. On bar close, each strategy only re-reads DynamoDB if its in-memory status is already CANCELLED (self-cancel path). This avoids a DB read on every bar for the common case.
- **BreakEven guaranteed fill via LIMIT slippage**: SELL LIMIT at `price × 0.99` fills immediately because SELL LIMIT fills when `current_price >= limit_price`. BUY LIMIT at `price × 1.01` fills immediately for the symmetric reason. The same 1% trick used for Mkt tab orders works here without a new order type.
- **Test isolation for strategy + trading state**: `strategy_service` and `trading` each have their own in-memory stores. If a test creates trades via `record_trade` and the next test checks for a flat position, the `clean_registry` fixture must clear both `svc._registry` and `trading.clear_session(SESSION)`. Missing either leaks state across tests.
- **Bar-close detection is per-strategy-instance, not global**: Each `StrategyInstance` carries its own `_last_bar_slot` and OHLC accumulators. This allows multiple concurrent strategies (AutoStop BUY CE + AutoStop SELL PE) to independently track their own bar state without shared mutable state.
- **`strategy_interval_secs` on `SimulationSession`, not per-request**: The interval is snapshotted at session start (from `POST /api/simulation/start`) and stored on `SimulationSession`. Individual strategy start requests don't re-specify it — this keeps all strategies on the same bar cadence per session. To change interval, start a new session.
- **Frontend `runningStrategies` is optimistic**: The list is updated client-side (`setRunningStrategies` appends on start, clears on cancel-all). There is no live polling against `GET /api/strategies`. This is safe because strategies self-complete or are cancelled by the same client. If a strategy completes server-side (BreakEven exits, AggressiveStoploss not applicable), the stale entry stays in the running list until the user cancels or resets. A future improvement could poll `GET /api/strategies` on session start or on tab open to reconcile.




