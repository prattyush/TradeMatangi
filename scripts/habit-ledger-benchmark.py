"""Measure GET /api/behavior/habit-ledger against the Stats overview on a large seeded history (moto, in-process).

    cd backend && source ~/venvs/tradematangi/bin/activate
    PYTHONPATH=. python ../scripts/habit-ledger-benchmark.py [days] [round_trips_per_day] [mark_ratio]

moto removes network latency, so the report counts DynamoDB requests as well: on AWS the cost is roughly
(requests × round-trip time) + the Python time shown here.
"""
import json
import random
import sys
import time
from decimal import Decimal

import boto3
from moto import mock_aws

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 250
TRIPS = int(sys.argv[2]) if len(sys.argv) > 2 else 10
RATIO = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3
USER = "alice"


def make_tables(db):
    def table(name, keys, attrs, gsi=None):
        extra = {"GlobalSecondaryIndexes": gsi} if gsi else {}
        db.create_table(TableName=name, BillingMode="PAY_PER_REQUEST", KeySchema=keys, AttributeDefinitions=attrs, **extra)
    s, n = "S", "N"
    table("Sessions", [{"AttributeName": "session_id", "KeyType": "HASH"}], [{"AttributeName": "session_id", "AttributeType": s}, {"AttributeName": "user_id", "AttributeType": s}],
          [{"IndexName": "UserIdIndex", "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}])
    for name, sort in (("Trades", "trade_id"), ("Orders", "order_id")):
        table(name, [{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": sort, "KeyType": "RANGE"}], [{"AttributeName": "session_id", "AttributeType": s}, {"AttributeName": sort, "AttributeType": s}])
    table("TradeLabels", [{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "round_trip_index", "KeyType": "RANGE"}], [{"AttributeName": "session_id", "AttributeType": s}, {"AttributeName": "round_trip_index", "AttributeType": n}])


def main():
    random.seed(7)
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
        import app.services.db as dbmod
        dbmod.get_dynamodb_resource = lambda: db
        dbmod.get_dynamodb_client = lambda: client
        from app.services import behavior_service as bsvc, habit_ledger_service as ledger, performance_service as perf
        make_tables(db)
        questions = [bsvc.add_question(USER, f"Habit {i}", "entry" if i % 2 == 0 else "exit")["question_id"] for i in range(8)]
        t0 = time.time()
        base = 1_791_447_300
        marked = 0
        with db.Table("Trades").batch_writer() as trades:
            for day in range(DAYS):
                sid, date = f"s{day:04d}", f"2025-{1 + day // 28:02d}-{1 + day % 28:02d}"
                db.Table("Sessions").put_item(Item=dict(session_id=sid, user_id=USER, symbol="NIFTY", date=date, session_capital=Decimal(100000), session_type="paper", instrument_type="equity"))
                tick = base + day * 86400
                for trip in range(TRIPS):
                    for side, price in (("BUY", 100), ("SELL", 100 + random.randint(-5, 6))):
                        tick += 150
                        trades.put_item(Item=dict(session_id=sid, trade_id=f"{sid}-{trip}-{side}", user_id=USER, symbol="NIFTY", side=side, quantity=40, price=Decimal(price), timestamp=tick, commission=Decimal(1)))
                    if random.random() < RATIO:
                        session = {"session_id": sid, "date": date, "symbol": "NIFTY", "session_type": "paper", "instrument_type": "equity"}
                        bsvc.set_marks(USER, session, trip, {random.choice(questions): True})
                        marked += 1
        print(f"seeded {DAYS} sessions, {DAYS * TRIPS * 2} trades, {marked} marks in {time.time() - t0:.1f}s")

        calls = {"n": 0}
        for resource in (client, db.meta.client):
            resource.meta.events.register("before-call.dynamodb.*", lambda **kw: calls.__setitem__("n", calls["n"] + 1))

        def timed(label, fn):
            calls["n"] = 0
            start = time.perf_counter()
            result = fn()
            print(f"{label:38s} {time.perf_counter() - start:7.2f}s  {calls['n']:6d} DynamoDB requests")
            return result

        cycles = timed("Stats overview read (load_cycles)", lambda: perf.load_cycles(USER, include_shared=False))
        result = timed("Habit ledger (load_ledger)", lambda: ledger.load_ledger(USER, {}))
        timed("build_ledger only (no I/O)", lambda: ledger.build_ledger(cycles, bsvc._user_marks(USER, None, None), ledger._fetch_sessions({m["session_id"] for m in bsvc._user_marks(USER, None, None)}), []))
        body = json.dumps(result)
        print(f"ledger rows {len(result['trades'])}, response {len(body) / 1024:.0f} KiB ({len(body) / max(1, len(result['trades'])):.0f} B/row), truncated={result['coverage']['truncated']}")


main()
