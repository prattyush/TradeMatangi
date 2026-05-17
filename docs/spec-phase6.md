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
3. If any open exit-direction order exists (SELL if LONG, BUY if SHORT) with quantity matching the current position quantity and the same right (CE/PE/equity), update its trigger/limit price to the new SL level.
4. If no such order is present, create a TARGET order (with wallet credit on fill) with the position quantity.

---

## Phase-VI Status

### Phase VI — Strategies ✅ COMPLETE (352 tests passing) — PR on feature/phase-vi-strategies

All three strategy types shipped with full backend engine, REST API, DynamoDB persistence, frontend Strat tab, and settings UI:

1. **AutoStop** (Entry) — waits for a configured-interval bar to close, then places a TARGET order at bar high (BUY) or bar low (SELL); alternatively triggers at `close ± deviation%`. Options sessions always BUY. Sized by FundsRatio (L/M/H) or explicit quantity.
2. **BreakEven** (TradeManagement) — ticks every price update; when `price >= avg_entry` (LONG) or `price <= avg_entry` (SHORT): finds any open exit-direction order matching side + right + position quantity and moves its trigger price to `avg_entry`; if none found, places a TARGET order at `avg_entry` (fires if price drops back to breakeven). Only startable when position is open.
3. **AggressiveStoploss** (TradeManagement) — waits for bar close; finds open exit-direction order(s) matching side + right + position quantity and moves trigger price to `close × 0.99` (LONG) or `close × 1.01` (SHORT); if none found, creates a TARGET order with position quantity. Only startable when position is open.

**Backend:**
- `backend/app/services/strategy_service.py` — in-memory `_registry` per session; bar-close detection via epoch-aligned slot formula; DynamoDB Strategies table with `SessionIdIndex` GSI for cross-process cancellation; shared `_find_open_exit_orders` / `_update_exit_order_price` helpers used by both BreakEven and AggressiveStoploss
- `backend/app/routers/strategies.py` — `POST /api/strategies/start`, `POST /api/strategies/cancel-all`, `GET /api/strategies`
- `backend/tests/test_strategy_service.py` — 14 tests covering all three strategy types + cancel-all

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
- **BreakEven is trade-management, not immediate exit**: Original implementation placed a SELL LIMIT at `price × 0.99` to exit immediately. The correct behavior is trade management: find existing open exit-direction orders (by side + right + position quantity) and move their trigger to `avg_entry` so the position is protected at breakeven if price drops back. Only place a new TARGET order if no exit order exists. Never blindly add a second exit order — that risks double-exiting the position.
- **Exit-order search must filter by side + right + quantity, not `is_stoploss`**: AggressiveStoploss originally filtered `is_stoploss=True` orders only, missing regular TARGET/LIMIT sell orders the user may have placed as their stoploss. The correct filter is `side == exit_side AND right == tick_right AND quantity == position.quantity`. The `is_stoploss` flag is internal bookkeeping and irrelevant to whether an order acts as the position's protection.
- **`_update_exit_order_price` must dispatch by order type**: TARGET/STOPLOSS orders update via `trigger_price`; LIMIT orders update via `limit_price`. A single `update_order(trigger_price=x)` call silently does nothing for LIMIT orders. Extract a helper that reads `order.order_type` and passes the right parameter.
- **Fallback order type should be TARGET, not STOPLOSS**: STOPLOSS orders have zero wallet impact (no credit on fill). When creating a new protective sell order from a strategy, TARGET is the correct type — the fill credits the wallet, giving the user their money back on the trade exit.
- **Test isolation for strategy + trading state**: `strategy_service` and `trading` each have their own in-memory stores. If a test creates trades via `record_trade` and the next test checks for a flat position, the `clean_registry` fixture must clear both `svc._registry` and `trading.clear_session(SESSION)`. Missing either leaks state across tests.
- **Bar-close detection is per-strategy-instance, not global**: Each `StrategyInstance` carries its own `_last_bar_slot` and OHLC accumulators. This allows multiple concurrent strategies (AutoStop BUY CE + AutoStop SELL PE) to independently track their own bar state without shared mutable state.
- **`strategy_interval_secs` on `SimulationSession`, not per-request**: The interval is snapshotted at session start (from `POST /api/simulation/start`) and stored on `SimulationSession`. Individual strategy start requests don't re-specify it — this keeps all strategies on the same bar cadence per session. To change interval, start a new session.
- **Frontend `runningStrategies` is optimistic**: The list is updated client-side (`setRunningStrategies` appends on start, clears on cancel-all). There is no live polling against `GET /api/strategies`. This is safe because strategies self-complete or are cancelled by the same client. If a strategy completes server-side (BreakEven exits, AggressiveStoploss not applicable), the stale entry stays in the running list until the user cancels or resets. A future improvement could poll `GET /api/strategies` on session start or on tab open to reconcile.





---

## Phase VI Implementation Status

### ✅ COMPLETE (352 tests passing)

All three strategy types shipped with full backend engine, REST API, DynamoDB persistence, frontend Strat tab, and settings UI:

1. **AutoStop** (Entry) — bar close → TARGET order at bar high/low or `close ± deviation%`; options always BUY; sized by FundsRatio or explicit qty
2. **BreakEven** (TradeManagement) — every tick; when price reaches avg entry, moves existing exit-direction order (matched by side + right + qty) to breakeven trigger; places new TARGET if none exists
3. **AggressiveStoploss** (TradeManagement) — bar close → moves existing exit-direction order (matched by side + right + qty) to `close × 0.99` (LONG) or `close × 1.01` (SHORT); places new TARGET if none exists

**Next: Phase VII PaperTrading** (see `docs/spec-phase7.md`)

### Lessons Learned
- **Frontend `runningStrategies` is optimistic**: Updated client-side on start/cancel-all. No live polling against `GET /api/strategies`. Strategies that self-complete server-side stay in the list until user cancels or resets.
