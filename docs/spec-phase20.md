# Upgrades

## Desktop Client Continuous browse
1) In desktop client, when going through charts for any mode (browse, live, replay, stepwise), and only for underlying charts, not for options or futures, if the user goes to the end of the chart on the left side, first candle drawn. The desktop client should automatically fetch the data for previous days, upto 14 Days. This helps in desktop only as, we have more memory compared to website, or if is possible in website as well, please go ahead and do it, but primary requirement is for destkop only, as the lines and drawings are saved which can come in handy. Further, 14 days helps to look into previous weekly high and low which is important. By 14 days I didn't mean 14 trading days, I meant 14 days which can include holidays.

Include this feature for website, if it is simple otherwise leave it. When fetching and drawing on chart, you can fetch in buckets, like fetching 1 day at a time or 2 days at a time, till the user keeps going back and at max 14 days data is fetched. This is because for smaller intervals, user may not go to back 14 days, but for 15 mins, 14 days makes more sense. 

2) Separate, requirement, do, handle the case in website, as website draws all the candles on the screen, when refreshed, which may become a lot for 1 min candle, so maybe when refreshed it can only shows x number of candles, 150 candles in the view and rest can be scroolled. This 150 candle apply to desktop as well, if possible, only for first draw or refresh etc. It is max 150 just on view not backend fetch data. Not sure the complication of this requirement.

## Kite Broker For Real Trading
Supporting Kite for Real Trading API's, all the their is feature parity with Kotak Neo. With exactly the same implementation.

## Supporting Real Trading In Desktop Client
Support Real Trading in Desktop Client, with same support as with Website Real Trading, like trade history refresh button and others.


