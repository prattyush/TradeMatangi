#!/usr/bin/env python3
"""
Export all DynamoDB Local tables to JSON files, and import them back.

Usage:
  Export all tables:
    python scripts/dynamodb-export-import.py export --dir /path/to/backup

  Export specific tables:
    python scripts/dynamodb-export-import.py export --dir /path/to/backup --tables Trades Sessions Users

  Import all tables from a backup directory:
    python scripts/dynamodb-export-import.py import --dir /path/to/backup

  Import specific tables:
    python scripts/dynamodb-export-import.py import --dir /path/to/backup --tables Trades Sessions

  List available tables:
    python scripts/dynamodb-export-import.py list-tables
"""
import argparse
import configparser
import json
import math
import os
import sys
import uuid
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import boto3


def get_config_and_client() -> dict:
    cfg = configparser.ConfigParser()
    project_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    cfg.read(os.path.join(project_root, "data", "accesskeys.ini"))
    aws = cfg["aws"]
    endpoint_url = aws.get("url", "http://localhost:8000")
    region = aws.get("region", "us-east-1")
    client = boto3.client(
        "dynamodb",
        endpoint_url=endpoint_url,
        region_name=region,
        aws_access_key_id=aws.get("access_key", "fakekey"),
        aws_secret_access_key=aws.get("secret_access_key", "fakesecret"),
    )
    return {"client": client, "endpoint_url": endpoint_url, "region": region}


PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


# ── serialization helpers ────────────────────────────────────────────────────

class DDBEncoder(json.JSONEncoder):
    """Encode DynamoDB attribute values into plain JSON.

    Format per item:
      { "M": {...}, "S": "str", "N": "123", "L": [...], "BOOL": true, "SS": [...],
        "NS": [...], "NULL": true, "B": "base64..." }
    Matches boto3 DynamoDB low-level GetItem/Scan item format exactly.
    """

    def default(self, obj):
        if isinstance(obj, Decimal):
            if obj == obj.to_integral_value():
                return int(obj)
            return float(obj)
        if isinstance(obj, set):
            return list(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)


def _convert_numbers(obj):
    """Recursively convert floats in a dict list to their original form."""
    if isinstance(obj, dict):
        return {k: _convert_numbers(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_numbers(i) for i in obj]
    return obj


def decode_ddb_item(plain: dict) -> dict:
    """Convert a {attr: {type: val}, ...} plain dict to DynamoDB item format.

    Handles:
      - N → Decimal(str(val))
      - L → list of recursively decoded values
      - M → recursively decoded dict
      - SS/NS → string/number sets
      - B → bytes (from base64 or list of ints)
      - BOOL → bool
      - NULL → True
      - S → str
    """
    item = {}
    for attr_name, type_val in plain.items():
        if not isinstance(type_val, dict) or len(type_val) != 1:
            item[attr_name] = type_val
            continue
        ddb_type, raw = next(iter(type_val.items()))
        if ddb_type == "N":
            item[attr_name] = {"N": str(raw)}
        elif ddb_type == "S":
            item[attr_name] = {"S": str(raw)}
        elif ddb_type == "BOOL":
            item[attr_name] = {"BOOL": bool(raw)}
        elif ddb_type == "NULL":
            item[attr_name] = {"NULL": True}
        elif ddb_type == "L":
            item[attr_name] = {"L": [decode_ddb_value(v) for v in raw]}
        elif ddb_type == "M":
            item[attr_name] = {"M": {k: decode_ddb_value(v) for k, v in raw.items()}}
        elif ddb_type == "SS":
            item[attr_name] = {"SS": [str(s) for s in raw]}
        elif ddb_type == "NS":
            item[attr_name] = {"NS": [str(s) for s in raw]}
        elif ddb_type == "B":
            if isinstance(raw, str):
                import base64
                item[attr_name] = {"B": base64.b64decode(raw)}
            elif isinstance(raw, list):
                item[attr_name] = {"B": bytes(raw)}
            else:
                item[attr_name] = {"B": bytes(raw)}
        else:
            item[attr_name] = {ddb_type: raw}
    return item


def decode_ddb_value(val):
    """Recursively decode a single DynamoDB typed value from its serialized form."""
    if isinstance(val, dict) and len(val) == 1:
        ddb_type, raw = next(iter(val.items()))
        if ddb_type == "N":
            return {"N": str(raw)}
        if ddb_type == "S":
            return {"S": str(raw)}
        if ddb_type == "BOOL":
            return {"BOOL": bool(raw)}
        if ddb_type == "NULL":
            return {"NULL": True}
        if ddb_type == "L":
            return {"L": [decode_ddb_value(v) for v in raw]}
        if ddb_type == "M":
            return {"M": {k: decode_ddb_value(v) for k, v in raw.items()}}
        if ddb_type == "SS":
            return {"SS": [str(s) for s in raw]}
        if ddb_type == "NS":
            return {"NS": [str(s) for s in raw]}
        if ddb_type == "B":
            return val
        return val
    return val


# ── export ────────────────────────────────────────────────────────────────────

def export_table(client, table_name: str, out_dir: Path, rename_map: dict[str, str] | None = None):
    """Scan the entire table and write items to <out_dir>/<safe_name>.json."""
    rename_map = rename_map or {}
    file_name = rename_map.get(table_name, table_name)
    out_path = out_dir / f"{file_name}.json"

    items = []
    params = {"TableName": table_name}
    count = 0

    while True:
        resp = client.scan(**params)
        for item in resp.get("Items", []):
            items.append(item)
            count += 1

        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        params["ExclusiveStartKey"] = last_key
        print(f"  ... scanned {count} items so far ...")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(items, f, cls=DDBEncoder, indent=2)

    print(f"  exported {count} items → {out_path}")

    desc = client.describe_table(TableName=table_name)["Table"]
    key_schema = desc["KeySchema"]
    return {"table_name": table_name, "key_schema": key_schema, "item_count": count}


def export_all(client, out_dir: Path, table_filter: list[str] | None):
    """Export all tables (or a subset if table_filter is given)."""
    table_names = sorted(client.list_tables()["TableNames"])
    if table_filter:
        table_names = [t for t in table_names if t in table_filter]
        missing = set(table_filter) - set(table_names)
        if missing:
            print(f"Warning: tables not found: {missing}")

    if not table_names:
        print("No tables to export.")
        return

    session_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    session_dir = out_dir / session_ts

    print(f"Exporting {len(table_names)} table(s) to {session_dir}/")
    manifest = {
        "exported_at": datetime.now().isoformat(),
        "endpoint": client.meta.endpoint_url,
        "region": client.meta.region_name,
        "tables": [],
    }

    for tn in table_names:
        print(f"\n[{tn}]")
        info = export_table(client, tn, session_dir)
        manifest["tables"].append(info)

    manifest_path = session_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest written → {manifest_path}")


# ── import ────────────────────────────────────────────────────────────────────

def import_table(client, table_name: str, file_path: Path, key_schema: list | None):
    """Batch-write items from a .json file back into DynamoDB."""
    if not file_path.exists():
        print(f"  [skip] no file {file_path}")
        return 0

    with open(file_path) as f:
        items = json.load(f)

    if not items:
        print(f"  [skip] empty file")
        return 0

    # Convert plain JSON items back to DynamoDB typed format for put_item
    batch_items = []
    count = 0
    for i, item in enumerate(items):
        ddb_item = decode_ddb_item(item)
        batch_items.append({"PutRequest": {"Item": ddb_item}})

        if len(batch_items) == 25:
            resp = client.batch_write_item(RequestItems={table_name: batch_items})
            count += len(batch_items)
            unprocessed = resp.get("UnprocessedItems", {}).get(table_name, [])
            retries = 0
            while unprocessed and retries < 5:
                resp = client.batch_write_item(RequestItems={table_name: unprocessed})
                count += len(unprocessed) - len(resp.get("UnprocessedItems", {}).get(table_name, []))
                unprocessed = resp.get("UnprocessedItems", {}).get(table_name, [])
                retries += 1
            batch_items = []

    # flush remaining
    if batch_items:
        resp = client.batch_write_item(RequestItems={table_name: batch_items})
        count += len(batch_items)
        unprocessed = resp.get("UnprocessedItems", {}).get(table_name, [])
        retries = 0
        while unprocessed and retries < 5:
            resp = client.batch_write_item(RequestItems={table_name: unprocessed})
            count += len(unprocessed) - len(resp.get("UnprocessedItems", {}).get(table_name, []))
            unprocessed = resp.get("UnprocessedItems", {}).get(table_name, [])
            retries += 1

    print(f"  imported {count} items from {file_path.name}")
    return count


def import_all(client, in_dir: Path, table_filter: list[str] | None):
    """Import all tables from a directory (reads manifest.json)."""
    manifest_path = in_dir / "manifest.json"
    if not manifest_path.exists():
        # No manifest — try importing any .json files in the directory
        print(f"No manifest.json found in {in_dir}, scanning for .json files...")
        json_files = sorted(in_dir.glob("*.json"))
        total = 0
        for jf in json_files:
            tn = jf.stem
            if table_filter and tn not in table_filter:
                continue
            # Skip manifest itself
            if tn == "manifest":
                continue
            print(f"\n[{tn}]")
            # Ensure table exists; skip if not
            existing = set(client.list_tables()["TableNames"])
            if tn not in existing:
                print(f"  [skip] table does not exist")
                continue
            total += import_table(client, tn, jf, None)
        print(f"\nTotal imported: {total} items")
        return

    with open(manifest_path) as f:
        manifest = json.load(f)

    tables = manifest.get("tables", [])
    if table_filter:
        tables = [t for t in tables if t["table_name"] in table_filter]

    if not tables:
        print("No tables to import.")
        return

    print(f"Importing {len(tables)} table(s) into {client.meta.endpoint_url}")
    existing = set(client.list_tables()["TableNames"])
    total = 0

    for tinfo in tables:
        tn = tinfo["table_name"]
        print(f"\n[{tn}]")
        if tn not in existing:
            print(f"  [skip] table does not exist")
            continue
        file_path = in_dir / f"{tn}.json"
        total += import_table(client, tn, file_path, tinfo.get("key_schema"))

    print(f"\nTotal imported: {total} items")


# ── CLI ────────────────────────────────────────────────────────────────────────

def cmd_list_tables(ctx):
    client = ctx["client"]
    tables = sorted(client.list_tables()["TableNames"])
    if not tables:
        print("No tables found.")
        return
    for t in tables:
        desc = client.describe_table(TableName=t)["Table"]
        count = desc.get("ItemCount", 0)
        print(f"  {t}  ({count} items)")


def cmd_export(ctx, args):
    out_dir = Path(args.dir).resolve()
    table_filter = args.tables if args.tables else None
    export_all(ctx["client"], out_dir, table_filter)


def cmd_import(ctx, args):
    in_dir = Path(args.dir).resolve()
    if not in_dir.is_dir():
        print(f"Error: directory not found: {in_dir}")
        sys.exit(1)
    table_filter = args.tables if args.tables else None
    import_all(ctx["client"], in_dir, table_filter)


def main():
    parser = argparse.ArgumentParser(
        description="Export/Import DynamoDB Local tables to/from JSON files"
    )
    sub = parser.add_subparsers(dest="command")

    p_export = sub.add_parser("export", help="Export tables to directory")
    p_export.add_argument("--dir", required=True, help="Output directory")
    p_export.add_argument("--tables", nargs="*", help="Specific tables to export (default: all)")

    p_import = sub.add_parser("import", help="Import tables from directory")
    p_import.add_argument("--dir", required=True, help="Input directory (contains .json files and manifest.json)")
    p_import.add_argument("--tables", nargs="*", help="Specific tables to import (default: all)")

    sub.add_parser("list-tables", help="List all DynamoDB tables and item counts")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    ctx = get_config_and_client()

    if args.command == "list-tables":
        cmd_list_tables(ctx)
    elif args.command == "export":
        cmd_export(ctx, args)
    elif args.command == "import":
        cmd_import(ctx, args)


if __name__ == "__main__":
    main()
