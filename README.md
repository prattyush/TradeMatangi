# TradeMatangi
This repository will hold the backend and frontend for a trading website which will run simulated and paper trading, replaying older days ohlc data with advanced entry and exits strategies with AI Assist for Market Structure Understanding in real-time. It also adds essential risk management features like funds ratio based position sizing based on trade probabilities.


## Deployment
The current repo can be deployed by first creating a data folder and adding a accesskeys.ini with the below details
```
[icicidirect]
api_key=
api_secret=
session_token=

[aws]
access_key=
secret_access_key=
region=
```
Further, it also needs dynamodbLocal to be installed. And setup a virtual environment and running pip with requirements.txt in the backend folder shoulld get the work done.
Also, needs nodejs to be installed.  Howerver, the start backend.sh and frontend.sh should also take care of installing dependencies, just be vigilant for the same.
The scripts to run are
```
Setup Tables
./scripts/start-dynamodb.sh
./scripts/setup-dynamodb-tables.py

Run Backend
./scripts/start-backend.sh


Run Frontend
./scripts/start-frontend.sh

```

Currently, it is under deployment, will update the respective links, once it is deployed in vercel, with EC2 Backend.


## Development.

The entire repository is built using coding agents and spec based coding. To have more efficient, the spec.md is actually broker into more phase wise to save context. Further, multiple optimizing including choosing the right plugins when running specific phases to reduce context. Futher, optimization used according to https://platform.claude.com/docs/en/build-with-claude/context-windows. 
