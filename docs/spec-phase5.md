#### Phase-V TradeAnalysis

This phase will allow trades to be analyzed for manual evaluation and later for AI Based analysis.


##### TradeAnalysis
1. We will an option to open separate screen for trade data analysis, maybe at the top left of the screen or anyplace suitable.
2. The new UI will allow to choose the type of trading (symbol or option trading) and the primary symbol like for option trading for NIFTY 50, option of NIFTY50 needs to be selected. Next would a range of days.
3. Given the values selected in the above step 2, the trade history for that day, symbol combination should be displayed. If a range of days are selected, show for each day. Open to suggestions whether all trade history will be displayed together or next=next type of option.
4. For each day also display net P&L for that symbol, day combination with % P&L calculated with respect to the wallet value before that of that day's session of trading. Also, display the % of winning or losing trades.
5. The charts should also be displayed, may be only the symbol and not options chart, And the chart should show buy and sell markers for all trades in the range of days.  A Buy in Call would be reflected as a buy and a sell in a call as a sell. A buy in Put would be shown as sell and a sell in Put would be shown as buy in the symbol chart. Here symbol means Nifty 50, sensex or likewise. 


##### LogIn
1. Add the first screen for user login, User login is defined by email address and a password, save the password and email in persistence layer. Better to save the password as one time hash. 
2. Password resetting is not present as of now, as that requires sending OTP to email which is not added now. Create a new table if required. Then, display the the usual screen. The settings shown the setting menu should be stored per user.

##### Persistence
1. For each trading session, store the trades taken also the wallet value captured at the start of the session. Better to store it in tables and then show it in the trade analysis, as that wallet value would be required to calculate the P&L % w.r.t to wallet value.


##### ReloadChart
1. One of the problems when a new pane is added is that the new pane start to show the data correctly but in the lightweight chart the old value still remains, thus it show the previous candle lowest or highest point from previous strike price value. Let say the value of strike price 73500 was in range of 60 to 61 then I removed the pane added a new pane of strike price 73900, with range around 41-42, then the current candle is showing the currrent price. But the candle has high point of 61. So add an icon to reload chart on the top may be beside the Bar close or anywhere as suited, when clicked the chart data is fetched till previous bar not the current candle and rendered on the chart. The user can click on refresh after the candle finishes to fixed the candles.