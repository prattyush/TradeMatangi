#### Phase-V Strategies
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
3. If a stoploss order is already open it would use that and only change the price. And if not at bar close it would find the current open position quantity and direction and create a stoploss order accordingly.




