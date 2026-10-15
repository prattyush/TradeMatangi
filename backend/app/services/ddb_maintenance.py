"""Offline DynamoDB maintenance. Never imported by request/session flows."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone

from boto3.dynamodb.types import TypeDeserializer

SESSION_TABLES = ("Trades", "Orders", "Strategies", "TradeLabels", "EventSnapshots", "AICommands", "AIDecisionLog", "BrokerProtectionRecovery")
CREATE_FIELDS = ("TableName", "KeySchema", "AttributeDefinitions", "GlobalSecondaryIndexes", "LocalSecondaryIndexes")


def pages(client, operation, **params):
    rows = []
    while True:
        page = getattr(client, operation)(**params)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return rows
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def tables(client):
    return [name for page in client.get_paginator("list_tables").paginate() for name in page["TableNames"]]


def native(item):
    return {k: TypeDeserializer().deserialize(v) for k, v in item.items()}


def query(client, table, field, value):
    return pages(client, "query", TableName=table, ConsistentRead=True,
                 KeyConditionExpression="#k = :v", ExpressionAttributeNames={"#k": field},
                 ExpressionAttributeValues={":v": {"S": value}})


def scan_equal(client, table, field, value):
    return pages(client, "scan", TableName=table, ConsistentRead=True,
                 FilterExpression="#k = :v", ExpressionAttributeNames={"#k": field},
                 ExpressionAttributeValues={":v": {"S": value}})


def key_for(schema, item):
    return {k["AttributeName"]: item[k["AttributeName"]] for k in schema["KeySchema"]}


def get(client, table, schema, item):
    return client.get_item(TableName=table, Key=key_for(schema, item), ConsistentRead=True).get("Item")


def _pack(value):
    if isinstance(value, bytes):
        return {"__bytes__": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {k: _pack(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_pack(v) for v in value]
    return value


def _unpack(value):
    if isinstance(value, dict):
        if set(value) == {"__bytes__"}:
            return base64.b64decode(value["__bytes__"], validate=True)
        return {k: _unpack(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_unpack(v) for v in value]
    return value


def target(client):
    return {"endpoint": client.meta.endpoint_url, "region": client.meta.region_name}


def save_backup(client, changes, directory, label, table_names=()):
    """Write exclusively, flush to disk, re-read and verify before any mutation."""
    names = sorted({c["table"] for c in changes} | set(table_names))
    schemas = {n: client.describe_table(TableName=n)["Table"] for n in names}
    definitions = {n: {k: v for k, v in s.items() if k in CREATE_FIELDS} for n, s in schemas.items()}
    # Restore definitions contain only CreateTable fields, without runtime metadata.
    for definition in definitions.values():
        for field in ("GlobalSecondaryIndexes", "LocalSecondaryIndexes"):
            if not definition.get(field):
                definition.pop(field, None)
                continue
            if field in definition:
                definition[field] = [{k: index[k] for k in ("IndexName", "KeySchema", "Projection")}
                                     for index in definition[field]]
    payload = _pack({"version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
                     "target": target(client), "schemas": definitions,
                     "table_arns": {n: s["TableArn"] for n, s in schemas.items()}, "changes": changes})
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    envelope = {"sha256": hashlib.sha256(encoded).hexdigest(), "payload": payload}
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + "-" + label + ".json")
    with open(path, "x", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        json.dump(envelope, stream)
        stream.flush()
        os.fsync(stream.fileno())
    if load_backup(path) != _unpack(payload):
        raise RuntimeError("Backup verification failed; nothing deleted")
    return path


def load_backup(path):
    envelope = json.loads(Path(path).read_text())
    encoded = json.dumps(envelope["payload"], sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(encoded).hexdigest() != envelope["sha256"]:
        raise ValueError("Backup checksum mismatch")
    data = _unpack(envelope["payload"])
    if data["version"] != 1:
        raise ValueError("Unsupported backup version")
    return data


def check_target(client, backup):
    if target(client) != backup["target"]:
        raise ValueError("Backup targets a different endpoint/region")
    existing = set(tables(client))
    for name, arn in backup["table_arns"].items():
        if name in existing and client.describe_table(TableName=name)["Table"]["TableArn"] != arn:
            raise ValueError(f"Backup table/account differs: {name}")


def restore(client, backup):
    """Preflight every record before writing. Idempotent after partial restore."""
    check_target(client, backup)
    existing = set(tables(client))
    for change in backup["changes"]:
        name = change["table"]
        current = get(client, name, backup["schemas"][name], change["before"]) if name in existing else None
        if current is not None and current != change["before"] and current != change.get("after"):
            raise ValueError(f"Restore conflict in {name}: {key_for(backup['schemas'][name], change['before'])}")
    for name, schema in backup["schemas"].items():
        if name not in existing:
            client.create_table(**schema, BillingMode="PAY_PER_REQUEST")
            client.get_waiter("table_exists").wait(TableName=name)
    # References first, Sessions last; the backend must remain stopped.
    for change in sorted(backup["changes"], key=lambda c: c["table"] == "Sessions"):
        client.put_item(TableName=change["table"], Item=change["before"])
    for change in backup["changes"]:
        if get(client, change["table"], backup["schemas"][change["table"]], change["before"]) != change["before"]:
            raise RuntimeError("Restore verification failed; keep backend stopped and retry restore")


def full_backup(client, directory):
    changes = []
    names = tables(client)
    for name in names:
        print(f"Backing up {name} ...", flush=True)
        changes.extend({"table": name, "before": row, "after": None}
                       for row in pages(client, "scan", TableName=name, ConsistentRead=True))
    return save_backup(client, changes, directory, "entire-ddb", names)


def list_sessions(client, user, date):
    # Maintenance uses consistent reads; no eventually consistent GSI dependence.
    rows = scan_equal(client, "Sessions", "user_id", user)
    return sorted([r for r in rows if native(r).get("date") == date
                   and native(r).get("session_type") == "real"
                   and native(r).get("trading_style", "intraday") == "intraday"
                   and native(r).get("record_type") not in ("real_preparation", "swing_portfolio")
                   and not native(r)["session_id"].startswith("broker-day:")],
                  key=lambda r: (str(native(r).get("created_at", "")), native(r)["session_id"]))


def session_inventory(client, selected):
    row = native(selected)
    sid, user = row["session_id"], row["user_id"]
    available = set(tables(client))
    changes = []
    def add(name, before, after=None):
        changes.append({"table": name, "before": before, "after": after})
    for name in SESSION_TABLES:
        if name not in available:
            continue
        schema = client.describe_table(TableName=name)["Table"]
        partition = next(k["AttributeName"] for k in schema["KeySchema"] if k["KeyType"] == "HASH")
        # Consistent scans for non-session primary keys avoid missed GSI writes.
        rows = query(client, name, "session_id", sid) if partition == "session_id" else scan_equal(client, name, "session_id", sid)
        for item in rows:
            add(name, item)
    if "WalletLedgers" in available:
        for item in scan_equal(client, "WalletLedgers", "session_id", sid):
            data = native(item)
            if data.get("owner_user_id") == user and data.get("user_id") in ("real-session-slots", "real-observe:" + user):
                add("WalletLedgers", item)
    root = row.get("broker_projection_id")
    if root:
        if not root.startswith("broker-day:") or root == sid:
            raise ValueError("Unexpected broker projection identity; refusing cleanup")
        # All aliases must be considered, including other dates/users; never delete shared facts.
        aliases = [r for r in scan_equal(client, "Sessions", "broker_projection_id", root)
                   if native(r)["session_id"] not in (sid, root)]
        manifest = client.get_item(TableName="Sessions", Key={"session_id": {"S": root}}, ConsistentRead=True).get("Item")
        if aliases:
            if (manifest and native(manifest).get("owner_session_id") == sid) or any(native(a).get("broker_projection_owner") == sid for a in aliases):
                owner = sorted(aliases, key=lambda r: (str(native(r).get("created_at", "")), native(r)["session_id"]))[-1]
                new_owner = owner["session_id"]
                if manifest:
                    add("Sessions", manifest, {**manifest, "owner_session_id": new_owner})
                for alias in aliases:
                    add("Sessions", alias, {**alias, "broker_projection_owner": new_owner})
            # Only this session's archived local facts are exclusive.
            for name in ("Trades", "Orders"):
                if name in available:
                    for item in query(client, name, "session_id", root + ":archive:" + sid):
                        add(name, item)
        else:
            for name in ("Trades", "Orders"):
                if name not in available:
                    continue
                # Revisions have partition keys root:<uuid>; no prefix query is possible
                # on a DynamoDB hash key. This offline scan includes old revisions.
                items = pages(client, "scan", TableName=name, ConsistentRead=True,
                              FilterExpression="begins_with(#s, :root)", ExpressionAttributeNames={"#s": "session_id"},
                              ExpressionAttributeValues={":root": {"S": root + ":"}})
                for item in items:
                    add(name, item)
            if manifest:
                add("Sessions", manifest)
    add("Sessions", selected)  # Logical session root is always deleted last.
    return changes


def delete_inventory(client, changes, backup):
    """Inventory must match the verified durable backup; abort on changed data."""
    if changes != backup["changes"]:
        raise ValueError("Deletion inventory differs from backup")
    check_target(client, backup)
    for c in changes:
        if get(client, c["table"], backup["schemas"][c["table"]], c["before"]) != c["before"]:
            raise RuntimeError("Records changed after backup; stop backend and re-list sessions")
    # Individual writes avoid unprocessed batch items and make failures explicit.
    for c in changes:
        if c["after"] is None:
            client.delete_item(TableName=c["table"], Key=key_for(backup["schemas"][c["table"]], c["before"]))
        else:
            client.put_item(TableName=c["table"], Item=c["after"])
    for c in changes:
        if get(client, c["table"], backup["schemas"][c["table"]], c["before"]) != c["after"]:
            raise RuntimeError("Cleanup verification failed; restore the backup before restarting")
