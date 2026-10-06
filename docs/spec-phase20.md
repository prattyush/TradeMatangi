# Upgrades

## Desktop Client Continuous browse
1) In desktop client, when going through charts for any mode (browse, live, replay, stepwise), and only for underlying charts, not for options or futures, if the user goes to the end of the chart on the left side, first candle drawn. The desktop client should automatically fetch the data for previous days, upto 14 Days. This helps in desktop only as, we have more memory compared to website, or if is possible in website as well, please go ahead and do it, but primary requirement is for destkop only, as the lines and drawings are saved which can come in handy. Further, 14 days helps to look into previous weekly high and low which is important. By 14 days I didn't mean 14 trading days, I meant 14 days which can include holidays.

Include this feature for website, if it is simple otherwise leave it. When fetching and drawing on chart, you can fetch in buckets, like fetching 1 day at a time or 2 days at a time, till the user keeps going back and at max 14 days data is fetched. This is because for smaller intervals, user may not go to back 14 days, but for 15 mins, 14 days makes more sense. 

2) Separate, requirement, do, handle the case in website, as website draws all the candles on the screen, when refreshed, which may become a lot for 1 min candle, so maybe when refreshed it can only shows x number of candles, 150 candles in the view and rest can be scroolled. This 150 candle apply to desktop as well, if possible, only for first draw or refresh etc. It is max 150 just on view not backend fetch data. Not sure the complication of this requirement.


Don't implement continuous browse for website if it requires significant memory increase. Please discuss it first with some stats.


## Analytics Upgrade

### Order Info For Analytics
For each postion entry and exit we need to store how that particular position was entered or exited. Like for Entry we need to keep the information whether that entry was triggered by Market Order, Limit Order, Target Order, Auto Stop Order (Though Auto Stop results in Target Order, if Auto Stop needs to be stored), Auto Stop Limit Order.

Similarly for Exit Orders, we need to store per order, whether that particular order was Stoploss Order Exit, Limit Order Exit, Aggresive SL Order Exit, Target Profit Strategy Full Order Exit,  Target Profit Strategy Half Order Exit, Underlying Target Strategy Half Order Exit, Underlying Target Full Order Exit and similarly for Underlying SL (full and half exits).


### Analytics On Order Info
Now, a trade is different than a particular position. In one trade I can take 2 positions and exit one in some way and another in other way. While exitting I think, we take FIFO logic, for first exit would be for last entry, I am fine with that if quantities are same, if quuantities don't match, find a position in that trade that matches in quantity, if exit quantity is either low or high and doesn't match then match to last entry with min of (exit, entry) and use it in analytics. 

#### Stats On Entries
The stats windows needs to show per position, the breakdown of enter position types (based on previous section (Order Info of Analytics) values) against Profit and Loss % of that position and also the entire trade. What I mean lets say for one trade, we have 2 positions with Auto Stop entry with 100 quantity, the exit was in 2 ways, or total 100 quantity exit was in order, one in profit (40) and one in loss (60), then calculate actual profit and loss combined and calculate % against session capital. Also, in the same example, lets say 2nd entry was market order and the entire trade was in profit, but Auto Stop Order was in Loss Exit, when matched with FIFO logic or quantity match logic. Then, also show stat of Auto Stop entries against its own position profit and loss % and trade level profit and loss %. 

You have aggregate across days and may be within a day, so you can show aggregate, sum, mean and median to get an idea of distribution or show histogram etc.

#### Stats On Exits
The stats window also needs to show similar stats for exit trades as well, I mean whether take profit is more profitable or aggresive SL , similar to previous section (Stats On Entries), you can show per position P&L and also trade level P&L.


## Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation.

## Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.

