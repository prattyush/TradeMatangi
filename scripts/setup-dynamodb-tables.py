#!/usr/bin/env python3
"""
Create all DynamoDB Local tables for TradeMatangi.
Run once after starting DynamoDB Local:
    python scripts/setup-dynamodb-tables.py
"""
import configparser
import boto3
from botocore.exceptions import ClientError

ENDPOINT_URL = "http://localhost:8000"
REGION = "us-east-1"

config = configparser.ConfigParser()
config.read("data/accesskeys.ini")
aws_cfg = config["aws"]

dynamodb = boto3.client(
    "dynamodb",
    endpoint_url=ENDPOINT_URL,
    region_name=REGION,
    aws_access_key_id=aws_cfg.get("aws_access_key_id", "fakeKey"),
    aws_secret_access_key=aws_cfg.get("aws_secret_access_key", "fakeSecret"),
)

TABLES = [
    {
        "TableName": "Trades",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "trade_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "trade_id", "AttributeType": "S"},
            {"AttributeName": "user_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "UserIdIndex",
                "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "Orders",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "order_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "order_id", "AttributeType": "S"},
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "Users",
        "KeySchema": [
            {"AttributeName": "user_id", "KeyType": "HASH"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "email", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "EmailIndex",
                "KeySchema": [{"AttributeName": "email", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "Wallet",
        "KeySchema": [
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "date", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "date", "AttributeType": "S"},
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "Sessions",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "user_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "UserIdIndex",
                "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "Strategies",
        "KeySchema": [
            {"AttributeName": "strategy_id", "KeyType": "HASH"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "strategy_id", "AttributeType": "S"},
            {"AttributeName": "session_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "SessionIdIndex",
                "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    # ── Phase XI AI Helper tables ─────────────────────────────────────────────
    {
        "TableName": "AICommands",
        "KeySchema": [
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "command_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "command_id", "AttributeType": "S"},
            {"AttributeName": "session_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "SessionCommandsIndex",
                "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "AIStrategies",
        "KeySchema": [
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "hotword", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "hotword", "AttributeType": "S"},
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "AIDecisionLog",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "ts_command_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "ts_command_id", "AttributeType": "S"},
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    # ── Event Snapshots ───────────────────────────────────────────────────────
    {
        "TableName": "EventSnapshots",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "event_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "event_id", "AttributeType": "S"},
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    # ── Phase XII Pattern Library ─────────────────────────────────────────────
    {
        "TableName": "PatternAnnotations",
        "KeySchema": [
            {"AttributeName": "chart_id", "KeyType": "HASH"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "chart_id", "AttributeType": "S"},
            {"AttributeName": "user_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "UserIdIndex",
                "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "PatternShares",
        "KeySchema": [
            {"AttributeName": "owner_user_id", "KeyType": "HASH"},
            {"AttributeName": "shared_user_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "owner_user_id", "AttributeType": "S"},
            {"AttributeName": "shared_user_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "SharedUserIdIndex",
                "KeySchema": [{"AttributeName": "shared_user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    # ── Phase XIII Chart Structures ──────────────────────────────────────────
    {
        "TableName": "ChartStructures",
        "KeySchema": [
            {"AttributeName": "chart_structure_id", "KeyType": "HASH"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "chart_structure_id", "AttributeType": "S"},
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "symbol", "AttributeType": "S"},
            {"AttributeName": "date", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "UserIdIndex",
                "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            },
            {
                "IndexName": "SymbolDateIndex",
                "KeySchema": [
                    {"AttributeName": "symbol", "KeyType": "HASH"},
                    {"AttributeName": "date", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            },
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "ChartStructureShares",
        "KeySchema": [
            {"AttributeName": "owner_user_id", "KeyType": "HASH"},
            {"AttributeName": "shared_user_id", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "owner_user_id", "AttributeType": "S"},
            {"AttributeName": "shared_user_id", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "SharedUserIdIndex",
                "KeySchema": [{"AttributeName": "shared_user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
    },
    {
        "TableName": "TradeLabels",
        "KeySchema": [
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "round_trip_index", "KeyType": "RANGE"},
        ],
        "AttributeDefinitions": [
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "round_trip_index", "AttributeType": "N"},
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "date", "AttributeType": "S"},
        ],
        "GlobalSecondaryIndexes": [
            {
                "IndexName": "UserIdDateIndex",
                "KeySchema": [
                    {"AttributeName": "user_id", "KeyType": "HASH"},
                    {"AttributeName": "date", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
                "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
            }
        ],
        "BillingMode": "PAY_PER_REQUEST",
    },
]


def create_tables():
    existing = set(dynamodb.list_tables()["TableNames"])
    for table_def in TABLES:
        name = table_def["TableName"]
        if name in existing:
            print(f"  [skip]   {name} already exists")
            continue
        try:
            dynamodb.create_table(**table_def)
            print(f"  [created] {name}")
        except ClientError as e:
            print(f"  [error]  {name}: {e.response['Error']['Message']}")


if __name__ == "__main__":
    print("Setting up DynamoDB Local tables...")
    create_tables()
    print("Done.")
