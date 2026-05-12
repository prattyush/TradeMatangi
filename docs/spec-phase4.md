#### Phase-IV BetaMinorUpdates

##### UI-Upgrade
1. We need option to update the open orders, whether it be Stoploss Orders, Target Orders or Limit Orders. The open orders which is present in UI, can be clickable and when clicked the trigger value can be updated. At least the price should be available to be updated, i.e the trigger price.
2. Further, if the trigger price can be chosen by clicking on the chart. UI should be able to pick the price which is the horizontal line at the click point. The chart should be saame as the symbol for which the price is being updated.
3. The % deviation which is currently set to 1% should be configurable in the settings menu. I am assuming the % deviation is used for both Target as well as StopLoss Orders.
4. Is it possible to draw markers on the symbol which was traded to show buy and sell at the price and the time. The marker can be circle marker at the time and price at which the trade was executed, that is buy or sell, with buy and sell being of different colors.
5. The user needs to know how much time is left for the bar close, that needs to be displayed and updated with every second of replay or with live data stream. The live OHLC Data fetched  with also have timestamp which can be used. The time to left can also be shown as the current time, ticking which will be same for all the charts, so only 1 is enough. Either, way feel free however, the implementation can be done.
6. The UI also needs to show the current P&L as per the trades already taken for the day.
7. Remove the Buy and Sell Button from below the LTP, instead add a Market tab next to Target, Limit, SL. To reduce the width taken by buttons, rename Market to Mkt, Target to Tgt, Limit to Lmt and SL is anyways SL. When market tab is selected and buy or sell is seelected, it takes the L,M or H value and uses that to calculate quantity.
8. Show position P&L below LTP and also, session P&L (P&L for all trades taken in this session) for the current session. Feel free to name it session P&L or Days P&L as suitable.
9. The trade history displayed button should have a expand icon just beside the Trade History words, when that is clicked the history is shown in a pop up window with width enough to show the entire data with all columns.

##### Options-HistoricalData
1. Please fetch last 2 days of ohlc data for the selected option as well for both, CE and PE. The same as it is done for NIFTY 50 or Equity.

##### TradeP&L
1. To calculate Trade P&L please inclulde the commision for the broker as well. The default value can be 10 rupees per trade buy or sell irrespective of the quantity. Include in Settings menu, a value to change the commission to any other value.
