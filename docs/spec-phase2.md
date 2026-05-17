
#### Phase-II Older Data Fetch

This phase the simulated engine and the UI will support taken symbol and types and the respective dates and fetch the data from Breeze Library. The UI should also be advanced for supporting different charts for the same symbol for different intevals. In this phase

##### MultiPane Charts
1. UI will support multiple formats, or panes for displaying the OHLC data, these different panes can display data in different time-intervals.
2. UI should support add indicators Exponential Moving Average for a window of 9 and 21. The data for the EMA can be either calculated in the backend and through streaming or calculated in the frontend.
3. UI should have option to provide dates for which the simulated trading is to be done and based on that the backend will fetch the data.
4. UI should support drawing horizontal and trend lines on the chart.

##### BROKER Integration
1. The backend should integrate with breeze library to fetch the data for the respective symbol. 
2. The backend should in this phase persist all fetched data from broker and also the trades taken in a database DynamoDb Local.
3. Use the broker integration to only fetch, don't place orders.
4. The access credentials are present in the data/ folder in the files accesskeys.ini. It is in config format for python to read. Already added .ini in .gitignore so that it is not included in the git files. The code snippet for creating breeze instance is as below:-
```
from breeze_connect import BreezeConnect
import configparser

credentials_config_parser = configparser.ConfigParser()
credentials_config_parser.read('data/accesskeys.ini')
breeze = BreezeConnect(api_key=credentials_config_parser['icicidirect']['api_key'])
breeze.generate_session(api_secret=credentials_config_parser['icicidirect']['api_secret'],
                        session_token=credentials_config_parser['icicidirect']['session_token'])
```


##### Basic AllOrders
1. The UI will support another feature called stop limit placement and limit and target order.
2. The backend should be able to persist these limit, stop limit and target orders and trigger them in the simulated trading environment when the condition for the respective order is fullfilled.
3. The UI and backend should support clearing of these orders and also display of the open orders when asked for.

**Design Note (2026-05-10):** Two order types are supported: TARGET (stop-limit) and LIMIT. TARGET: user enters a trigger price; limit execution price is auto-computed at 1% deviation (`BUY limit = trigger × 1.01`, `SELL limit = trigger × 0.99`); BUY fills when `price >= trigger`, SELL when `price <= trigger`. LIMIT: user enters the limit price directly; BUY fills when `price <= limit`, SELL when `price >= limit`. Both types are persisted to DynamoDB. OrderPanel shows a TARGET/LIMIT toggle. Quantity is selectable (default 1 unit); lot-based quantity for options/futures deferred to Phase-III.

##### Flexible Inputs
1. UI and backend will allow to choose date on which replay is to be done. And fetch last 2 days of data for the respective symbol.
2. UI and backend will allow to choose the symbol. The choices can be restricted for now, that is NIFTY, TATPOW (Tata Power), TATMOT (Tata Motors), RELIND (Reliance). These are the ICICI Direct / Breeze API stock codes.

