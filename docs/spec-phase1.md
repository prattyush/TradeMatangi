
#### Phase-I MVP (Minimum Viable Product)
This phase will have MVP proof of concept. It will use data which is already present in data/ folder which will have ohlc data for a particular stock symbol. No Integration with brokers is required at this point and neither any user login or user specific feeature. Focus would be to build the basic UI frontend and backend so support basic simulated trading. The first phase will only support simulated trading with older data with basic Buy/Sell buttons.

Below are the list of features:-

##### Chart Display
1. The UI should support displaying the ohlc data integrating with light-weight chart or any other suitable charting software.
2. The ohlc data displayed should have at least 3 days of data, with prior 2 days and current data being replayed at second level.
3. UI should have an option to start the data replay from a specific time let say from 9:39am when the market data for India NSE starts at 9:15am.
4. The Ui should have a buy and sell button to buy and sell the stock.
5. The UI should show the trade position and how the P&L is changing at real-time. This feature can be chosen whether the data comes from frontend or backend.
6. The UI will get the streamming OHLC data from backend preferrably through a websocket or a SSE. Make your technology choice whether websocket or SSE whichever is suitable in a multi user distributed environment. Or any other choices required. Do confirm the choice from the user.
7. The UI will fetch the data from backend for a required older days.
8. UI also needs to display trades taken during the simulated trading session. Backend will support the respective API.
9. The replay speed can be fixed for now lets say at second level or you can introduce a relative speed like .9 which is basically .9 seconds of replay = 1 second. That .9 number can be UI input provided to backend or can be in percentage like 10% faster slower etc.


##### Simulated Engine
1. The backend will support a simulated engine, for a particular symbol for a particular day. When triggered the backend should open a web-socket that the UI will connect to to get the data.
2. For the buy and sell information it can be stored in memory for this phase, no need to use AWS Dynamo Db Local for this phase.
3. The backend will expose trading API for buy and sell, the symbol can be harded for now or not as per choice. It should also have API's to show the older trades taken and the current position.


##### Testing Scenario
1. For this phase the symbol supported is NIFTY which can be harded.
2. The trading date would be 6th May 2026.
3. The NIFTY OHLC Data will be present in the format NIFTY-06-05-2026.pickle, NIFTY-05-05-2026.pickle and NIFTY-04-05-2026.pickle (NIFTY-dd-mm-yyyy format) in the folder data/ which can be used by the backend. The file is a dump of a python dataframe with index as DateTimeIndex and columns as open, close, high, low at a second level granularity starting from 09:15am. The DataTimeIndex time would be in IST Format.
4. The time interval for the data to be displayed can be set to 3 minutes for this phase.
5. For this phase we will be used NIFTY to buy and sell and 1 unit to buy and sell. In next phase buying and selling in NIFTY won't be allowed as it is an index, then options and futures would be introduced or different stocks and respecting the lot sizes of futures and options as described by NSE.
6. Handle the case that lightweight charts using UTC seconds and the data is present in IST, handle this either in backend or frontend as you seem fit.

