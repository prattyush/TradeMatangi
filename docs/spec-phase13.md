#### Enhancements

##### Fyers ✅ Complete (PR #279 merged to dev)

Fyers live streaming is now available as the primary streaming source for paper and real trading sessions.

**Implementation:**
- `backend/app/services/fyers_service.py` — `FyersBroadcaster` singleton managing one `FyersDataSocket` WebSocket connection shared by all active sessions
- Uses `fyers_apiv3.data_ws.FyersDataSocket` with LTP mode for ticks
- 1-second OHLC accumulation (same `_OHLCAccumulator` as Kite/Kotak/Breeze), pushed to `session.paper_tick_queue`
- Token flow: DDB `BrokerTokens` table (`fyers_access`) → `data/accesskeys.ini` `[fyers]` section fallback
- Admin UI: "Fyers" button added to LIVE STREAMING SOURCE selector, Fyers Access Token and Refresh Token inputs in BROKER TOKENS section
- Admin API: `GET/PUT /api/admin/tokens` supports `fyers_access` and `fyers_refresh`; `PUT /api/admin/stream-source` accepts `"fyers"`
- Fallback chain: fyers → breeze → kotak → kite

**Fyers symbol format:**
- Equities: `NSE:RELIANCE-EQ`
- Indices: `NSE:NIFTY50-INDEX`, `BSE:SENSEX-INDEX`
- Options: `NSE:NIFTY30JUL26000CE` (symbol + day + month-abbr + strike + right)

**Files changed:**
| File | Change |
|---|---|
| `backend/app/services/fyers_service.py` | **New** — FyersBroadcaster singleton + symbol resolution |
| `backend/app/services/token_service.py` | Added `fyers_access`/`fyers_refresh` to masked tokens |
| `backend/app/routers/admin.py` | Added fyers fields to token models, `"fyers"` to allowed stream sources |
| `backend/app/services/simulation.py` | Fyers streaming branch in paper+real sessions, cleanup in `stop_session`, `fyers_streaming` flag |
| `frontend/src/services/api.ts` | Fyers in `AdminTokensResponse`, `setAdminTokens`, `getStreamSource`/`setStreamSource` types |
| `frontend/src/components/SettingsModal.tsx` | Fyers button in stream source selector, token inputs, inline status |

**Original spec:**
Can you add the support of Fyers to get realtime streaming data for symbols for papertrading and realtrading.
1. Include an option in settings to choose fyers, similar to icici, kotak or kite.
2. Add a placeholder to store access token and refresh token for fyers in the admin settings, just as other brokers.
3. You can use the fyers v3 api in https://pypi.org/project/fyers-apiv3/
4. Way to connect to fyers is
```
fyers = data_ws.FyersDataSocket(
            access_token=access_token,  # Access token in the format "appid:accesstoken"
            log_path="",  # Path to save logs. Leave empty to auto-create logs in the current directory.
            litemode=False,  # Lite mode disabled. Set to True if you want a lite response.
            write_to_file=False,  # Save response in a log file instead of printing it.
            reconnect=True,  # Enable auto-reconnection to WebSocket on disconnection.
            on_connect=self.onopen,  # Callback function to subscribe to data upon connection.
            on_close=self.onclose,  # Callback function to handle WebSocket connection close events.
            on_error=self.onerror,  # Callback function to handle WebSocket errors.
            on_message=self.onmessage # Callback function to handle incoming messages from the WebSocket.
        )

        fyers = fyersModel.FyersModel(
            client_id=client_id,
            token=access_token
        )

 The accesskey.ini file has the below information

[fyers]
 app_id=
app_secret=
redirect_url=h
app_pin=
sha_hash=
access_token=
refresh_token=

```
5. Use it the same way Kite is used as streaming data provider.
6. Example of the data received from the websockets.
```
Options
{'ltp': 108.65, 'vol_traded_today': 214798875, 'last_traded_time': 1703757599, 'exch_feed_time': 1703757600,
        'bid_size': 11835, 'ask_size': 6075, 'bid_price': 108.6, 'ask_price': 109.0, 'last_traded_qty': 15,
        'tot_buy_qty': 699855, 'tot_sell_qty': 79215, 'avg_trade_price': 163.22, 'low_price': 62.65, 'high_price': 347.85,
        'lower_ckt': 0, 'upper_ckt': 0, 'open_price': 160.0, 'prev_close_price': 142.25, 'type': 'sf',
        'symbol': 'NSE:BANKNIFTY23DEC48400CE', 'ch': -33.6, 'chp': -23.6204}

       Index
        {'ltp': 46650.05, 'prev_close_price': 46811.75, 'ch': -161.7, 'chp': -0.35, 'exch_feed_time': 1708931565,
         'high_price': 46893.15, 'low_price': 46513.55, 'open_price': 46615.85, 'type': 'if',
         'symbol': 'NSE:NIFTYBANK-INDEX'}

```


##### Chart Structure
This is new space where users can look at collection of symbol charts which are structure on 3 things, 
a) on how the chart opened, smalll Gap Up/Down, Gap Up/Down, Big Gap Up/Down, Within Yesterdays range, Withing day before yesterday range.
b) On how the chart performed till 12pm, Trading Range, breakout.
c) On how the chart performed from 12 to closing, Trading Range, Breakout, Reversal.
As we have patterns may be link in patterns or any other place where user can see the days's chart broken with multi select option for 3 choices, How was opening, uptill 12 , and after 12. So, users can select, show all charts where opening was Big Gap Up and Small Gap Up, Also, choose where Trading Range till 12 and Breakout till 12, similarly, for 3rd option, all charts with breakout. In such a command, the system will find all charts which have opening either Big Gap up or small Gap Upc+ and condition having trading range till 12 or breakout till 12 and 
a) Big Gap Up + trading range till 12 + breakout after 12.
b) Big Gap Up + breakout till 12 + breakout after 12.
c) Small Gap Up + breakout till 12 + breakout after 12.
d) Small Gap Up + trading range till 12 + breakout after 12.

The system will define a pre-defined set of types for opening, till 12 and after 12. Users can override it or define their own types, similar to how we do with paterns.
If no selection if made for after 12 then include all charts types after 12. similarly for opening and till 12 (or midday). If users are overriding or defining their own they shall only be visible to them with sharing optino taken from settings, like what we do in paterns.

Now, how to define pre-defined chart structure.
Opening Types
1. Within Yesterday's range -> If today opening value is within the total range of yesterday open and close prices then it is yesterday's range.
2. Within Day Before Yesterday's range -> if above condition is not met and If today opening value is within the total range of yday before esterday open and close prices then it is day before yesterday's range.
3. Gap Up/Down If above 2 conditions is not met and If today is opening is within 2 times yesterdays' range (range = math.abs(open-close)). Then, if yesterday was a bull day, then the todays opening should be within yesterday's close + range and yesterday's open - range. If yesterday was a bear day, then today's opening should be within yesterdays open + 2*range, yesterdays close - 2*range.
4. Big Gap Up/ Down -> If none of the above conditions met -> Then it is above or below yesterdays close too far, too far up or down or greater then 2x range.


Midday Types
1. Trading Range -> If the closing price at 12 is within the price range of the first 15 mins candle, ohlc value, then it is trading range.
2. Breakout -> If the closing price at 12 is greater/lesser than 2 times range of opening 15 mins candle ohlc value, range being defined as above.
3. Trend -> If the closing price at 12 is outside the ohlc values of opening 15 mins candle, but within 2xrange of 15 candle.

Closing Types
1. Trading Range -> If the closing price of the day within the price range from opening till 12 closing price.
2. Breakout -> Only if the first condition didn't satisfy, If the closing price of the day is outside the 2xprice range from opening till 12 closing price but in the same direction, so I the opening-closing price at 12 >0, then opening-closing price at day end should also be > 0, similarly vice versa.
3. Reversal Breakout -> Only if the first 2 conditions didn't satisfy  and If the closing price of the day is outside the 2xprice range from opening till 12 closing price but in the opposite direction, so I the opening-closing price at 12 >0, then opening-closing price at day end should also be < 0, similarly vice versa.
4. Trend -> Only if the first 3 conditions didn't satisfy and If the closing price of the day is within the 2xprice range from opening till 12 closing price but in the same direction, so I the opening-closing price at 12 >0, then opening-closing price at day end should also be > 0, similarly vice versa.
5. Trend Reversal -> Only if the first 4 conditions didn't satisfy and If the closing price of the day is within the 2xprice range from opening till 12 closing price but in the opposite direction, so I the opening-closing price at 12 >0, then opening-closing price at day end should also be < 0, similarly vice versa.


Implementations:-
1. Implement a script which when run gets the data for NIFTY to start with, it can be any symbol of the SENSEX, Reliance, Tata Power, Tata Motors CV, it get last 1.5 years of data. Use the http python server API which is used to get the data when the date is selected in UI. Basically, I want the second to second data and whatever ohlc data is fetched should be stored in parquet in the cache as it is done already.
2. Make change to create a new table for storing chart types or structures. Users can define their own similar to patterns, can shared them between users, and also the chart types created by this script would be pre-defined, which would be visible to all users.
3. The script can go through each days ohlc data of NIFTY 50 and classify the opening, midday and closing as different types as mentioned above and store them in ddb.
4. You can include another button like Pattern or add another option in pattern to redirect to the chart types. Or may be pattern page itsself can be used.
5. Similar to chart types user when select the values for 3 dropdowns, multi-selection in each dropdown is possible, they would see a 3 columns grid of the charts a small view with the entire ohlc data of the chart. They can maximize it.
6. Users can edit a particular day chart type and go to the edit screen to add different values or their own value.
7. Introduce another value called undefined in opening, middday and closing, if any chart doesn't in a particular segment (opening, midday or closing) couldn't classify into any particular types as mentioned above.