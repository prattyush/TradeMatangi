#!/usr/bin/env python3
"""
Import Kotak broker orders into TradeMatangi DynamoDB.
Creates a dummy "real" session and populates Orders and Trades tables.
Supports rollback of imported sessions.
"""
import json
import uuid
import sys
import os
import argparse
from datetime import datetime
import boto3
from decimal import Decimal
from boto3.dynamodb.conditions import Key

# DynamoDB Configuration
# Use environment variables or defaults for local development
ENDPOINT_URL = os.getenv("DYNAMODB_URL", "http://localhost:8000")
REGION = os.getenv("DYNAMODB_REGION", "us-east-1")

def get_dynamodb():
    """Return a boto3 DynamoDB resource."""
    return boto3.resource(
        "dynamodb",
        endpoint_url=ENDPOINT_URL,
        region_name=REGION,
        aws_access_key_id="fakeKey",
        aws_secret_access_key="fakeSecret",
    )

def float_to_decimal(f):
    """Convert float to Decimal for DynamoDB."""
    if f is None:
        return None
    try:
        # Use string conversion to avoid precision issues
        return Decimal(str(f))
    except (ValueError, TypeError):
        return None

def parse_order_datetime(dt_str):
    """Parse Kotak order_datetime: 09-Apr-2026 10:28:45"""
    try:
        return datetime.strptime(dt_str, "%d-%b-%Y %H:%M:%S")
    except ValueError:
        try:
            # Fallback if format is slightly different
            return datetime.fromisoformat(dt_str)
        except ValueError:
            print(f"Error parsing datetime: {dt_str}")
            return datetime.now()

def parse_expiry_date(expiry_str):
    """Parse Kotak expiry_date: 13-Apr-2026 -> 2026-04-13"""
    if not expiry_str:
        return None
    try:
        return datetime.strptime(expiry_str, "%d-%b-%Y").strftime("%Y-%m-%d")
    except ValueError:
        return expiry_str

def import_orders(email, orders_json, session_id=None):
    db = get_dynamodb()
    users_table = db.Table("Users")
    sessions_table = db.Table("Sessions")
    orders_table = db.Table("Orders")
    trades_table = db.Table("Trades")

    # 1. Find or create user
    email = email.strip().lower()
    resp = users_table.query(
        IndexName="EmailIndex",
        KeyConditionExpression=Key("email").eq(email)
    )
    
    if resp.get("Items"):
        user_id = resp["Items"][0]["user_id"]
        print(f"Using existing user: {email} ({user_id})")
    else:
        user_id = str(uuid.uuid4())
        users_table.put_item(Item={
            "user_id": user_id,
            "email": email,
            "password_hash": "dummy_script_import",
            "is_admin": False
        })
        print(f"Created new dummy user: {email} ({user_id})")

    if not orders_json:
        print("No orders provided in JSON.")
        return

    # 2. Create Session
    # Use the first order to derive session metadata
    first_order = orders_json[0]
    dt_first = parse_order_datetime(first_order["order_datetime"])
    session_date = dt_first.strftime("%Y-%m-%d")
    
    if not session_id:
        session_id = f"imp_{uuid.uuid4().hex[:8]}"
    
    symbol = first_order.get("stock_code", "NIFTY")
    # Determine instrument type
    is_options = bool(first_order.get("strike_price") or first_order.get("right"))
    instrument_type = "options" if is_options else "equity"

    # Use trade_funds from the JSON for session capital and wallet
    trade_funds = first_order.get("trade_funds")
    session_capital = float_to_decimal(trade_funds) if trade_funds else Decimal("100000.0")

    session_item = {
        "session_id": session_id,
        "user_id": user_id,
        "symbol": symbol,
        "date": session_date,
        "start_time": "09:15:00",
        "instrument_type": instrument_type,
        "session_type": "real",
        "session_capital": session_capital,
    }
    
    # Optional options fields for session
    if is_options:
        session_item["strike"] = int(float(first_order["strike_price"])) if first_order.get("strike_price") else None
        session_item["expiry"] = parse_expiry_date(first_order.get("expiry_date"))

    sessions_table.put_item(Item=session_item)
    print(f"Created session {session_id} for {symbol} on {session_date}")

    # 3. Update Wallet for that user and date
    wallet_table = db.Table("Wallet")
    wallet_table.put_item(Item={
        "user_id": user_id,
        "date": session_date,
        "current_balance": session_capital
    })
    print(f"Updated wallet for {user_id} on {session_date} with current_balance {session_capital}")

    orders_count = 0
    trades_count = 0

    for o in orders_json:
        # Mapping Kotak "right" to platform "PE"/"CE"
        k_right = o.get("right") or o.get("type")
        right = None
        if k_right:
            if "put" in k_right.lower(): right = "PE"
            elif "call" in k_right.lower(): right = "CE"
        
        dt = parse_order_datetime(o["order_datetime"])
        timestamp = int(dt.timestamp())
        
        side = o.get("action", "Buy").upper()
        quantity = int(o.get("quantity", 0))
        
        order_id = o.get("order_id") or str(uuid.uuid4())
        
        # 4. Create Order entry
        order_item = {
            "order_id": order_id,
            "session_id": session_id,
            "user_id": user_id,
            "symbol": symbol,
            "side": side,
            "order_type": "LIMIT", # Defaulting to LIMIT for imported real orders
            "quantity": quantity,
            "trigger_price": float_to_decimal(o.get("trigger_price")),
            "limit_price": float_to_decimal(o.get("price") or o.get("average_price")),
            "status": "FILLED" if o.get("status") == "Executed" else "CANCELLED",
            "created_at": timestamp,
            "filled_at": timestamp if o.get("status") == "Executed" else None,
            "filled_price": float_to_decimal(o.get("average_price")),
            "right": right,
            "strike": int(float(o["strike_price"])) if o.get("strike_price") else None,
            "kotak_order_id": o.get("order_id"),
            "kotak_fill_confirmed": True if o.get("status") == "Executed" else False,
            "session_type": "real", # Ensure order also has session_type
        }
        orders_table.put_item(Item=order_item)
        orders_count += 1

        # 5. Create Trade entry if Executed
        if o.get("status") == "Executed":
            trade_id = str(uuid.uuid4())
            trade_item = {
                "trade_id": trade_id,
                "user_id": user_id,
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "price": float_to_decimal(o.get("average_price")),
                "timestamp": timestamp,
                "session_id": session_id,
                "instrument_type": instrument_type,
                "strike": int(float(o["strike_price"])) if o.get("strike_price") else None,
                "expiry": parse_expiry_date(o.get("expiry_date")),
                "right": right,
                "commission": Decimal("20.0"), # Dummy fixed commission
                "session_type": "real",
            }
            trades_table.put_item(Item=trade_item)
            trades_count += 1

    print(f"Import Summary: {orders_count} orders, {trades_count} trades.")
    print(f"Rollback Command: python scripts/import_kotak_orders.py --rollback {session_id}")
    return session_id

def rollback(session_id):
    """Delete session, trades, and orders for a given session_id."""
    db = get_dynamodb()
    sessions_table = db.Table("Sessions")
    orders_table = db.Table("Orders")
    trades_table = db.Table("Trades")

    print(f"Rolling back session: {session_id}...")

    # Delete trades (queried by session_id)
    resp = trades_table.query(KeyConditionExpression=Key("session_id").eq(session_id))
    for item in resp.get("Items", []):
        trades_table.delete_item(Key={"session_id": session_id, "trade_id": item["trade_id"]})
        print(f"  Deleted trade {item['trade_id']}")

    # Delete orders (queried by session_id)
    resp = orders_table.query(KeyConditionExpression=Key("session_id").eq(session_id))
    for item in resp.get("Items", []):
        orders_table.delete_item(Key={"session_id": session_id, "order_id": item["order_id"]})
        print(f"  Deleted order {item['order_id']}")

    # Delete session
    sessions_table.delete_item(Key={"session_id": session_id})
    print(f"  Deleted session {session_id}")
    print("Rollback complete.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import Kotak orders to DynamoDB")
    parser.add_argument("--email", help="Email of the user")
    parser.add_argument("--file", help="Path to JSON file with orders")
    parser.add_argument("--json", help="Raw JSON string with orders")
    parser.add_argument("--rollback", help="Session ID to rollback")
    parser.add_argument("--session-id", help="Explicit session ID to use")
    
    args = parser.parse_args()

    if args.rollback:
        rollback(args.rollback)
    elif args.email and (args.file or args.json):
        try:
            if args.file:
                with open(args.file, "r") as f:
                    orders = json.load(f)
            else:
                orders = json.loads(args.json)
            
            if not isinstance(orders, list):
                orders = [orders]
                
            import_orders(args.email, orders, session_id=args.session_id)
        except Exception as e:
            print(f"Error: {e}")
            import traceback
            traceback.print_exc()
    else:
        parser.print_help()
