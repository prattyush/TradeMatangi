
#### Phase-III BetaStage
This phase should support options and futures. We only need to support options and futures for stocks and indexes. No need to support commodity or currency at this phase.

##### Wallet
1. Wallet should be supported which will be simulated in simulated and paper trading. It will be prefilled with a defalt amount of 150000 rupees for now.
2. Every placed order, excluding limit and target orders which are just hanging and not placed yet, in run-time should reflect in the wallet. 
3. Every P&L should reflect in the wallet.
4. If at run-time the wallet goes negative then the orders should throw UI error and fail.
5. The wallet should be incremented and decremented with each days trades P&L and should carry forward. In Simulated environemnt where a user can replay 5th May 2026, incur a loss and then trade again at 4th May 2026, in that case the wallet should include the loss of 5th May 2026.
6. There should be a settings option may be at top corner clicking on that we would have a popup screen, or any other way. I will leave the choice to you. The only requirement is to have a settings option where the wallet can be reset to default value of 150000 rupees or any amount. 


##### User
1. The startup page should be a user signin. Harded inputs for now which is user and password both being abc123.
2. Make sure that all data persisted in the dynamo db w.r.t to trades, wallet have the userid in it to specify uniqueness. As going forward we would support multiple users thus fetching data per user, that is trades data and also wallet status.

##### FundsRatio
1. This feature requires to shift from lots or quantity to funds ratio. The funds available are defined as the money in the wallet left when the trading session started. We will have 3 different ratios configured. That is how to money to spend on this buy or sell which will a fixed ratio. The 3 ratios will be defined by "l, m and h". These signify the probabilities of success for that trade, l is low so by default only 3% of capital, m is medium probability so 6% of funds and h is high probability so 12% of funds.
2. The settings menu will have option to override these default % values for l, m and h for a specific user. 
3. When taking a trade if the funds % is lower than the money requried to take the trade then it would default to the least possible value if wallet funds allow it. Lets say 3% of 10,000 is 300 for buying a option at price 30 for lot size of 65 > 300, in that case just buy 1 lot that is 65.

##### OptionsTrading-UI
1. User can choose whether to trade in symbol or options. Symbol Trading should not be allowed for NIFTY 50 of indices. 
2. When option trading is selected, that we will have 3 windows, one top window of the symbol candlestick chart, then below 2 panes parallelly of 2 options types Put and Call.
3. In option trading mode, user can chooose which option to buy Put or Call.
4. To support options trading in UI. The UI should show options to choose symbol and then weekly or monthly expiry. Weekly contracts expire on Tuesdays for NSE if not holiday and Monthly on last Tuesday of the month. 
5. To choose strike price only applicable for options, we should 2 options, first how far from stocks or symbol current price like 2 means 2 strikes in out of money  and -2 means 2 strike price in money. For choosing the symbol current price use the replay start time or in case of paper trading the current price.
6. The second option should be choose the strike price where the option price range is within the ranges. The ranges will be 24-36, 36-60, 60-120, >120 at current time. To find current time use replay start time or current time for paper trading. 
7. To make it more clear for simulated trading, the user has to choose the option strike prices options that is either price range or how many below or above strike price above the symbols current price, before clicking on start replay, if not choosen default to first out of money strike price based on the symmbol current price. Mentioning again, curent price refers to price in simulated trading environment the price at start time and for paper trading, the current time.


##### Stoploss
1. Add one more tag in addition to Target and Limit, this tab will be SL for stoploss. The tab will be enabled only when an trade is running that is either a buy or a sell position is open. Based on the buy or sell position, when stoploss tab is selected, the opposite side i.e if already buy is open, sell would be selected and buy would be disabled and the quantity would be equal to the open position size of the current trade. But the quantity can be changed if required. 

