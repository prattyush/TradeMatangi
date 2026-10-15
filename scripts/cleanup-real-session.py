#!/usr/bin/env python3
"""List Real Day sessions and explicitly delete one with a verified backup.

Stop all backend instances before deletion/restoration. Configuration and AWS
credentials are exactly those of the backend. See docs/ddb-maintenance.md.
"""
import argparse
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.services import ddb_maintenance as maintenance


def display(client, sessions):
    for number, raw in enumerate(sessions, 1):
        row = maintenance.native(raw)
        sid = row["session_id"]
        print(f"\nSession {number}: {sid} | {row.get('symbol')} | {row.get('execution_broker')} | {row.get('created_at')}")
        partition = sid
        root = row.get("broker_projection_id")
        if root:
            manifest = client.get_item(TableName="Sessions", Key={"session_id": {"S": root}}, ConsistentRead=True).get("Item", {})
            partition = maintenance.native(manifest).get("active_partition", sid)
            print(f"  Broker projection: {root}; owner: {row.get('broker_projection_owner')}")
        trades = maintenance.query(client, "Trades", "session_id", partition)
        orders = maintenance.query(client, "Orders", "session_id", partition)
        print(f"  Trades: {len(trades)} | Stored order records: {len(orders)}")
        print("  Time | Side | Qty | Price | Symbol | Right | Strike | Commission | Trade ID")
        def stamp(item):
            return float(maintenance.native(item).get("timestamp", 0))
        for trade in sorted(trades, key=stamp):
            t = maintenance.native(trade)
            timestamp = t.get("timestamp")
            # Stored timestamps encode IST wall-clock values as UTC (project invariant).
            time = datetime.fromtimestamp(float(timestamp), timezone.utc).strftime("%H:%M:%S") if timestamp is not None else "?"
            print("  " + " | ".join(str(v) for v in (time, t.get("side"), t.get("quantity"), t.get("price"), t.get("symbol"), t.get("right"), t.get("strike"), t.get("commission"), t.get("trade_id"))))
        print("  Orders: ID | Side | Type | Status | Qty | Limit | Trigger")
        for order in orders:
            o = maintenance.native(order)
            if "broker_execution" in o or "broker_position" in o or "mapped_label" in o:
                continue
            print("  " + " | ".join(str(o.get(k, "")) for k in ("order_id", "side", "order_type", "status", "quantity", "limit_price", "trigger_price")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--date", required=True, type=lambda value: date.fromisoformat(value).isoformat())
    parser.add_argument("--backend-stopped", action="store_true", help="Confirm every backend instance using this DB is stopped; needed to delete")
    parser.add_argument("--backup-dir", type=Path, default=ROOT / "data" / "backups")
    args = parser.parse_args()
    from app.services.db import get_dynamodb_client
    client = get_dynamodb_client()
    print(f"Database: {maintenance.target(client)}")
    sessions = maintenance.list_sessions(client, args.user_id, args.date)
    display(client, sessions)
    if not sessions:
        print("No matching Real Day sessions.")
        return
    if not args.backend_stopped:
        print("Read-only listing. Stop all backend instances and add --backend-stopped to enable deletion.")
        return
    command = input("\nEnter 'delete N' to back up and delete that session, or Enter to exit: ").strip().split()
    if not command:
        return
    if len(command) != 2 or command[0] != "delete" or not command[1].isdigit() or not 1 <= int(command[1]) <= len(sessions):
        raise ValueError("Expected delete N using a session number shown above")
    selected = sessions[int(command[1]) - 1]
    changes = maintenance.session_inventory(client, selected)
    print(f"Selected session: {maintenance.native(selected)['session_id']}")
    print(f"Records to delete/change: {dict(Counter(c['table'] for c in changes))}")
    path = maintenance.save_backup(client, changes, args.backup_dir, "session-cleanup")
    print(f"Verified backup: {path}", flush=True)
    try:
        maintenance.delete_inventory(client, changes, maintenance.load_backup(path))
        remaining = maintenance.session_inventory(client, selected)
        # The final entry is the synthetic selected root, which must now be absent.
        if len(remaining) != 1:
            raise RuntimeError("Session-associated records remain after cleanup")
    except Exception:
        print(f"Cleanup incomplete. Keep backend stopped. Restore using:\npython scripts/backup-ddb.py restore {path} --backend-stopped", file=sys.stderr)
        raise
    print("Selected session deleted and verified. Other sessions and wallet balances preserved.")
    print(f"Backup retained: {path}")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
