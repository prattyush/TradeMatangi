#!/usr/bin/env python3
"""Back up every DynamoDB table, or restore a full/session-cleanup backup.

Uses the backend's database configuration. Stop every backend instance first
for a consistent backup and keep it stopped throughout restore.
"""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.services import ddb_maintenance as maintenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="Back up all tables and their records")
    backup.add_argument("--backup-dir", type=Path, default=ROOT / "data" / "backups")
    backup.add_argument("--backend-stopped", action="store_true", required=True)
    restore = commands.add_parser("restore", help="Restore missing/original records; refuse conflicting records")
    restore.add_argument("file", type=Path)
    restore.add_argument("--backend-stopped", action="store_true", required=True)
    args = parser.parse_args()
    from app.services.db import get_dynamodb_client
    client = get_dynamodb_client()
    print(f"Database: {maintenance.target(client)}")
    if args.command == "backup":
        path = maintenance.full_backup(client, args.backup_dir)
        print(f"Verified full database backup: {path}")
    else:
        data = maintenance.load_backup(args.file)
        maintenance.check_target(client, data)
        print(f"Restore {len(data['changes'])} records across {len(data['schemas'])} tables from {args.file}.")
        if input("Type 'restore' to continue: ").strip() != "restore":
            print("Cancelled; nothing changed.")
            return
        maintenance.restore(client, data)
        print("Restore complete and verified. Backup retained.")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"Error: {error}. If restore was interrupted, keep backend stopped and rerun restore.", file=sys.stderr)
        sys.exit(1)
