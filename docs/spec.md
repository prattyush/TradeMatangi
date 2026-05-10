
# Trade Matangi Project

## Overview
This project is a trading platform providing 3 major features, simulated trading on older days, simulated trading on current day with live data also known as paper trading and 3rd is real trading with a broker and live market data. This platform will also support advanced features like special entry and exit mechanisms, these mechanisms will be configurable and will require machine to take decisions based on market data. 
The entire project will be broker into 2 parts Frontend in the frontend folder and the backend in the backend folder. The frontend UI will be plotting showing market data in ohlc format for a time interval like 3 minutes, 5 minutes, 1 minutes etc. The UI will provide ways in which the advanced entry/exit mechanisms could be triggered. It will also have a AI Chat Option in which these same mechanisms can be triggered by chat commands. 
The backend will serve the UI. The backend will expose API's which the frontend will use to display data and trigger the respective mechanims or commands. The project will have login support using external vendors like Google and will persist the trades taken by the users and analysis of it. The platform will also provide ways to analyze the trades to better understand the good and bad traits of the manual trader. The platform will also provide live suggestions on the possible market structure and possible trading setups on the go and also post analysis period based on pre-set defined patterns. 

Currently, this platform will be only for Indian Markets and specifically supporting NSE exchange.


## Technology choices and guidelines
One overall guideline for the entire project is, this trading platform is very time critial at run-time. Basically, the time taken from clicking on buy button to actually buying in simulated environment or calling the broker endpoint should be minimum, similarly for squre-off or stoploss update feature.

The project will be divided into 2 parts, frontend and backend. 

The frontend UI platform, react JS, next JS etc, can be chosen as suited. However, below are a set of guidelines to be followed.
1. For plotting the OHLC Data, please use trading view open source library (light-weight charts) https://github.com/tradingview/lightweight-charts, with documentation link :- https://tradingview.github.io/lightweight-charts/docs
2. All the code of the frontend should be present in the frontend folder.
3. The frontend code should be able to be deployed separately on websites like vercel or any other free choices to test. However, only the tested and manually approved version needs to be deployed. Manual testing would be done locally.
4. The frontend framework can be of your choice, recommending reactJS or NextJs. But just check for NextJs if the running environment of WSL on windows is suitable for testing.
5. For fetching streaming data from the backend make your technology choice whether websocket or SSE whichever is suitable in a multi user distributed environment.
6. Apply CORS policy as suitable that is with Access-Control-Allow-Origin=* headers or as suited.



The backend should follow below guidelines.
1. The backend should be a fastAPI based backend.
2. The backend should be able to run threads or parallel processes as it needs to run these trading strategies for entry and exits parallely based on the data.
3. The backend design is open for discussion, however, it needs to persist data and allow multiple users to run trading sessions simulataneously like simulated trading on older days, paper trading or real trading.
4. The final project would be deployed in a multiple boxes and in a distributed environment, so the trading strategies which are running should persist some information so that they can be canceled if if the running thread running host is different from the one which got the cancel request for the particular strategy. Basically, it should also support fastapi inbuilt multiple cpu/process deployment where 2 processes of the server is running. The final Project will be using AWS Dynamo Db as database, instead of Dynamo DB Local which will be only for initial development beta phase, till all the bugs and features are finalized as AWS Dynamo Db will be costly so will be used for final phase as described in the below phase wise development below.
5. Cost is very important so refrain from using any external databases or tools like lambda or queues like sqs etc.
6. The backend should persist the data in a AWSDynamoDB database, which for initials version which is deployed in one machine as Docker version of Dynamo DB Local, and later the AWSDynamoDB databaset can be shifted to AWS Technologies.
7. The backend will be deployed separately from the frontend, so the frontend should store the ipaddress of the backend and the port in some config so that it can be changed if required or may be hard coded as seems fit.
8. The backend will integrate with multiple brokers like Zerodha, Kotak Neo and ICICI Direct.
9. For Cross-process strategy cancellation try to go with design choices to have < 200ms and the polling may or may not be required. One suggestion would be to only check when the strategy is triggered, then you can check if it is still enabled and if not then cancel. Make sure each time the entry or exit strategy is requested a new unique id is used. Uniqueness will be defined, per user, per symbol, trading date and the strategy name. Use that id to manage the strategy lifecycle. The id can be persisted in the database.


Data Storage Guidelines
1. The fetching of the OHLC Data will be through a broker like ICICI-Direct using Breeze library (https://pypi.org/project/breeze-connect/). The fetched data can be stored in a folder or any suitable directory structure as per choosing. In later version this data will be shifted to S3. 
2. The trading data or the trades taken and the analysis, needs to be stored separately per user, either in the AWS DynamoDb Local database (running in Docker at port 8000) of simple files as suitable. In later version, the possibiliy of periodic data backup should be present.

There should be scripts in scripts for starting the backend and frontend for Windows WSL Environment and AWS EC2 for backend as well something like:  
```bash

scripts/start-backend.sh    # Start Backend
scripts/stop-backend.sh     # Stop Backend

scripts/start-backend-ec2.sh    # Start Backend
scripts/stop-backend-ec2.sh     # Stop Backend

scripts/start-frontend.sh    # Start Frontend
scripts/stop-frontend.sh     # Stop Frontend
```
Backend available at http://localhost:8700


## Development process

When instructed to build a feature:
1. Develop the feature - do not skip any step from the feature-dev 7 step process
2. Thoroughly test the feature with unit tests and integration tests and fix any issues
3. Submit a PR using your github tools.


## Feature List
Below are the list of phases, and each phase has a list of features described. Each Feature has a label in front, use that label to inform the status of the feature and any issues detected in it. The entire project will be deployed in phases, below are each phase listed and their respective features.

### Phases

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



#### Phase-II Older Data Fetch

This phase the simulated engine and the UI will support taken symbol and types and the respective dates and fetch the data from Breeze Library. The UI should also be advanced for supporting different charts for the same symbol for different intevals. In this phase

##### MultiPane Charts
1. UI will support multiple formats, or panes for displaying the OHLC data, these different panes can display data in different time-intervals.
2. UI should support add indicators Exponential Moving Average for a window of 9 and 21. The data for the EMA can be either calculated in the backend and through streaming or calculated in the frontend.
3. UI should have option to provide dates for which the simulated trading is to be done and based on that the backend will fetch the data.
4. UI should support drawing horizontal and trend lines on the chart.

##### Broker Integration
1. The backend should integrate with breeze library to fetch the data for the respective symbol. 
2. The backend should in this phase persist all fetched data from broker and also the trades taken in a database DynamoDb Local.


##### Basic AllOrders
1. The UI will support another feature called stop limit placement and limit and target order.
2. The backend should be able to persist these limit, stop limit and target orders and trigger them in the simulated trading environment when the condition for the respective order is fullfilled.
3. The UI and backend should support clearing of these orders and also display of the open orders when asked for.



#### Phase-III Entry/Exit Custom Logic

The details are getting discussed.




## Notes

