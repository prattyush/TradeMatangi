#### Phase-VII PaperTrading
This phase will support PaperTrading and realtime streaming of data.

##### PAPERTRADING
1. To support papertrading, only extra that needs to be supported is to fetch current streaming data from a broker. The data will be directly streamed to the UI. Backend can decide to store it if suitable.
2. Option to choose whether the current session would be papertrading session or simulated trading session. Or based on date automatically paper trading will be launched, if the date is todays date based on IST Timezone. We will also need to introduce realtrading going forward so plan accordingly.
3. Use the same wallet for both simulated and paper trading. And the wallet should reflect the P&L. Easier to implement. If user wants they can always reset it.
4. While persisting trades, include an option to specify that these trades where taken in paper trading case. When doing analysis of trades, simulated and paper trading can be analyzed separately and both are very different situations and require different mental states.
5. Papertrading needs to be suppoorted for both options and symbol trading.
6. In PaperTrading pause button doesn't make much sense, I will leave it to you to whether have it or disable it. If present, then just stop the showing of streaming of data and when resumed, it would be users responsibility to click on refresh against a symbol and fetch the latest data. Refresh is explained in the UI-Upgrade Feature.

##### UI-Upgrade
1. One of the problems in UI with papertrading is that, when we start the session which lets say can be at 9:50am. Now, first historical data would needed to be fetched for that day. So, ideally data should come till 09:49am. However, due to a number of issues or data not get present in server, we might only get it till 09:48am. So, to solve this, the UI should have a refresh option present beside the Trend and H-Line option to refresh data. When refresh data would be clicked it would fetch the historical data for that symbol till the previous bar. That is lets say the chart is showing data at 5 minutes interval and current time is 10:13am. Then the historical data should be fetched till 10:10 or 10:05 whichever is more suitable and UI updated. This will make sure that if any data is missing user can refresh it later and get the accurate bar chart. Though I think the refresh is already implemented as part of Phase 5, just check and validate.
2. UI Settings should have an option of how many days old data needs to fetched whenever either the simulated trading is running or papertrading. I think currently it is hard coded to 2 or 3 days. Now that should be configurable through UI Settings and default to 2 days (previous days). These settings are user based so needs to be persisted accordingly.


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
5. Don't use Kite to fetch historical data as it only gives at minute granularity which is of no use. You can use Kite to fetch older data for today's date based on IST and then extrapolate the seconds data from the 1 minute granularity. I will leave the choice to you, but, don't use Kite to fetch historical data for simulated trading, or fetching data for yesterday or day before yesterday or any previous days. You can also use ICICIDirect to fetch todays data as well, use as suited.
6. If the access token has expired show an error in UI and mention shifting to ICICIDirect for Streaming Data and revert to ICICIDirect broker. If ICICIDirect is also failing, show an error to UI and stop.
7. Sometimes the live streaming stops sending data and hangs for both kite and breeze (icicidirect). Please don't timeout and wait. A possible wait would be 5-10 minutes before raising any errors, or maybe wait indefinitely and wait for the user to stop the session.