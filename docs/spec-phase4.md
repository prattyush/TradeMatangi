#### Phase-IV PaperTrading
This phase will support PaperTrading and realtime streaming of data.

##### PAPERTRADING
1. To support papertrading, only extra that needs to be supported is to fetch current streaming data from a broker. The data will be directly streamed to the UI. Backend can decide to store it if suitable.
2. Option to choose whether the current session would be papertrading session or simulated trading session. Or based on date automatically paper trading will be launched, if the date is todays date based on IST Timezone.
3. Use the same wallet for both simulated and paper trading. And the wallet should reflect the P&L. Easier to implement. If user wants they can always reset it.
4. While persisting trades, include an option to specify that these trades where taken in paper trading case. When doing analysis of trades, simulated and paper trading can be analyzed separately and both are very different situations and require different mental states.

##### UI-Upgrade
1. We need option to update the open orders, whether it be Stoploss Orders, Target Orders or Limit Orders. The open orders which is present in UI, can be clickable and when clicked the trigger value can be updated.
2. The % deviation which is currently set to 1% should be configurable in the settings menu. I am assuming the % deviation is used for both Target as well as StopLoss Orders.
3. Is it possible to draw markers on the symbol which was traded to show buy and sell. The marker can be circle marker at the time and price at which the trade was executed, that is buy and sell.
4. The user needs to know how much time is left for the bar close, that needs to be displayed and updated with every second of replay or with live data stream. The live OHLC Data fetched  with also have timestamp which can be used.
5. One of the problems in UI with papertrading is that, when we start the session which lets say can be at 9:50am. Now, first historical data would needed to be fetched for that day. So, ideally data should come till 09:49am. However, due to a number of issues or data not get present in server, we might only get it till 09:48am. So, to solve this, the UI should have a refresh option present beside the Trend and H-Line option to refresh data. When refresh data would be clicked it would fetch the historical data for that symbol till the previous bar. That is lets say the chart is showing data at 5 minutes interval and current time is 10:13am. Then the historical data should be fetched till 10:10 or 10:05 whichever is more suitable and UI updated. This will make sure that if any data is missing user can refresh it later and get the accurate bar chart.


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
5. Don't use Kite to fetch historical data as it only gives at minute granularity which is of no use.