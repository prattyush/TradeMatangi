#!/usr/bin/env python3
"""
Backfill missing underlying_price for options trades in DynamoDB.
Reads configuration from data/accesskeys.ini.
"""
import os
import sys
import uuid
import argparse
import configparser
import boto3
from decimal import Decimal
from boto3.dynamodb.conditions import Key, Attr

# Add backend to sys.path
PROJECT_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.append(os.path.join(PROJECT_ROOT, "backend"))

# Set DATA_DIR environment variable
os.environ["DATA_DIR"] = os.path.join(PROJECT_ROOT, "data")

def get_dynamodb():
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(PROJECT_ROOT, "data", "accesskeys.ini"))
    if not cfg.has_section("aws"):
        raise ValueError("Missing [aws] section in data/accesskeys.ini")
    aws = cfg["aws"]
    return boto3.resource(
        "dynamodb",
        endpoint_url=aws.get("url"),
        region_name=aws.get("region", "us-east-1"),
        aws_access_key_id=aws.get("access_key"),
        aws_secret_access_key=aws.get("secret_access_key"),
    )

def float_to_decimal(f):
    if f is None: return None
    return Decimal(str(f))

def backfill(session_id=None, force=False):
    db = get_dynamodb()
    trades_table = db.Table("Trades")
    sessions_table = db.Table("Sessions")
    
    from app.services.options_service import get_underlying_price_at

    # 1. Resolve which sessions to process
    if session_id:
        resp = sessions_table.get_item(Key={"session_id": session_id})
        sessions = [resp["Item"]] if "Item" in resp else []
    else:
        print("Scanning all sessions...")
        sessions = sessions_table.scan().get("Items", [])

    print(f"Processing {len(sessions)} sessions...")

    for sess in sessions:
        sid = sess["session_id"]
        symbol = sess["symbol"]
        date = sess["date"]
        itype = sess.get("instrument_type", "equity")
        
        if itype != "options":
            continue

        print(f"Session {sid} ({symbol} on {date}):")
        
        # Query trades for this session
        trades = trades_table.query(
            KeyConditionExpression=Key("session_id").eq(sid)
        ).get("Items", [])
        
        updated_count = 0
        for t in trades:
            # Skip if already has underlying_price unless force is True
            if t.get("underlying_price") is not None and not force:
                continue
            
            # Skip equity trades inside an options session (if any)
            if not t.get("right"):
                continue

            ts = int(t["timestamp"])
            price = get_underlying_price_at(symbol, date, ts)
            
            if price is not None:
                trades_table.update_item(
                    Key={"session_id": sid, "trade_id": t["trade_id"]},
                    UpdateExpression="SET underlying_price = :p",
                    ExpressionAttributeValues={":p": float_to_decimal(price)}
                )
                updated_count += 1
            else:
                print(f"  Warning: No underlying price found for trade {t['trade_id']} at {ts}")

        print(f"  Updated {updated_count} trades.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill underlying_price for trades")
    parser.add_argument("--session-id", help="Process only this session")
    parser.add_argument("--force", action="store_true", help="Overwrite existing values")
    
    args = parser.parse_args()
    
    try:
        backfill(session_id=args.session_id, force=args.force)
        print("Done.")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
