# Improvements

## Integration Desktop Client With Real Trading
Integrate Desktop Client to support Real Trading.
Keep an option in Paper trading live to switch between paper and real (toggle switch). The real trading option would come only if admin has allowed that user for real trading. 

Include all the features that is available in Paper Trading. Also, look through website, for specific real trading flows like target orders, limit orders, take profit strategy or underlying target strategy, stoploss orders.

## Supporting Kite Streaming In Desktop Client
Support Kite Streaming data is Desktop Client. If Kite is selected in the settings in admin to be streaming data source, then use Kite for streaming symbols. However, if possible maintain a single Kite Client for both website and desktop, I mean the actual kite client (external library), you are free to abstract it and use separate classes for Desktop and Website. I am suggesting only single kite client as Kite supports multiple symbols being asked to stream, not sure what would happen if we have 2 kite cclients on same process in python backend, how would SSE events From Kite Zerodha work (Kite server to our backend).

Do discuss this approach.


## Enhanced Take Profit Strategy
Introduce in take profit strategy an option to apply the strategy on half of the open position. The strategy should only apply the change
or the take action on half of the position. For calculating half, maximum it to 50%, when considering lot sizes for options. However, if one 1 lot is in position, then apply the strategy on that 1 lot, it should be applied to atleast 1 lot and maximum upto 50%.

In the website, the take profit strategy UI include an option to select half. In right click UI for website and desktop, when take profit strategy is selected give a sub menu of half or full. After a strategy is already triggered I can have an option to edit the strategy to select half size.

It may happen that when take profit strategy (half) was triggered we had 4 lots and by the time it reaches the pricce, user had already exited 2 lots. In that case, exit only 1 lot, i.ee half of the current position size. 


## Desktop Client Open Orders
1) Reduce the open orders text size in desktop client. It just for notification.  

