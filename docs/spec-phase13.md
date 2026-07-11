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

