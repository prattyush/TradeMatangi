"""Durable, account-scoped funding revisions and idempotent operations.

Uses WalletLedgers. It does not fetch broker data, decide fills or submit orders.
Callers reconcile broker evidence before publishing a funding status.
"""

import hashlib
import json
import time
import uuid
from copy import deepcopy
from decimal import Decimal

from botocore.exceptions import ClientError
from fastapi import HTTPException

from app.services import swing_accounting as rules


def _table():
    from app.services.db import get_dynamodb_resource
    from app.services.wallet_service import _ensure_ledger_table

    _ensure_ledger_table()
    return get_dynamodb_resource().Table("WalletLedgers")


def encode(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [encode(v) for v in value]
    return value


def decode(value):
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    if isinstance(value, dict):
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def key(broker, account):
    from app.services.execution_broker import name

    if not isinstance(account, str) or not account:
        raise ValueError("Broker account identity is required")
    return f"funding-active:{name(broker)}:{account}"


def partition(broker, account):
    """Application users share the centrally configured broker account money."""
    return "real-funding:" + key(broker, account).removeprefix("funding-active:")


def read(user, broker, account):
    row = (
        _table()
        .get_item(
            Key={"user_id": partition(broker, account), "ledger_id": key(broker, account)},
            ConsistentRead=True,
        )
        .get("Item")
    )
    return decode(row) if row else None


def initialize(user, broker, account, reference):
    existing = read(user, broker, account)
    if existing and existing.get("state") == "active" and existing.get("participants") and not any(p.get("active") for p in existing["participants"].values()) and not existing["funding"].get("reservations"):
        finish_period(user, broker, account, existing["period_id"])
    row = {
        "user_id": partition(broker, account),
        "created_by": user,
        "ledger_id": key(broker, account),
        "version": 0,
        "period_id": str(uuid.uuid4()),
        "funding": rules.create(reference),
        "participants": {},
        "state": "active",
        "updated_at": int(time.time() * 1000),
    }
    try:
        _table().put_item(
            Item=encode(row),
            ConditionExpression="attribute_not_exists(ledger_id) OR #state = :ended",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={":ended": "ended"},
        )
        return row
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        return read(user, broker, account)


def apply(user, broker, account, period_id, operation_id, kind, payload, mutate, *, extra_actions=None):
    """CAS the state and operation receipt together; retries cannot double-charge."""
    from boto3.dynamodb.types import TypeSerializer

    from app.services.db import get_dynamodb_client

    if not operation_id:
        raise ValueError("Funding operation identity is required")
    ledger = key(broker, account)
    fingerprint = hashlib.sha256(
        json.dumps(
            {"kind": kind, "payload": payload, "actor_user_id": user}, sort_keys=True, allow_nan=False
        ).encode()
    ).hexdigest()
    receipt = {
        "user_id": partition(broker, account),
        "ledger_id": f"funding-op:{period_id}:{hashlib.sha256(operation_id.encode()).hexdigest()}",
    }
    serialize = lambda row: {
        k: TypeSerializer().serialize(v) for k, v in encode(row).items()
    }
    for _ in range(4):
        current = read(user, broker, account)
        if not current or current["period_id"] != period_id:
            raise HTTPException(
                409, "Funding period changed; reconnect to the current account book"
            )
        existing = _table().get_item(Key=receipt, ConsistentRead=True).get("Item")
        if existing:
            if existing.get("fingerprint") != fingerprint:
                raise HTTPException(
                    409, "Funding operation identity was reused for different data"
                )
            return current
        if current.get("state")=="ended":
            raise HTTPException(409,"Funding period is closed; no new operations can change its archived evidence")
        changed = deepcopy(current)
        mutate(changed)
        changed["version"] = current["version"] + 1
        changed["updated_at"] = int(time.time() * 1000)
        try:
            get_dynamodb_client().transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": "WalletLedgers",
                            "Item": serialize(changed),
                            "ConditionExpression": "#version = :old AND period_id = :period",
                            "ExpressionAttributeNames": {"#version": "version"},
                            "ExpressionAttributeValues": serialize(
                                {":old": current["version"], ":period": period_id}
                            ),
                        }
                    },
                    {
                        "Put": {
                            "TableName": "WalletLedgers",
                            "Item": serialize(
                                {**receipt, "fingerprint": fingerprint, "kind": kind}
                            ),
                            "ConditionExpression": "attribute_not_exists(ledger_id)",
                        }
                    },
                ] + (extra_actions(changed) if extra_actions else [])
            )
            return changed
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
    raise HTTPException(
        409,
        "Account funding changed concurrently; refresh and retry the same operation",
    )


def start_participant(user, broker, account, period_id, mode, identity, fraction, *, session_record_id=None):
    existing = read(user, broker, account)
    participant = (existing or {}).get("participants", {}).get(mode)
    if existing and existing["period_id"] == period_id and participant and participant.get("active") and participant.get("owner_user_id") == user and participant["identity"] == identity:
        return existing  # Attach/recovery never edits frozen capital.
    def mutate(row):
        if row.get("state", "active") != "active":
            raise HTTPException(409, "Funding period is closed")
        current = row["participants"].get(mode)
        if current and current.get("active") and (current["identity"] != identity or current.get("owner_user_id") != user):
            raise HTTPException(
                409, "This account mode already has an active participant"
            )
        if mode not in row["funding"]["modes"]:
            row["funding"] = rules.allocate(row["funding"], mode, fraction)
        else:
            amount = rules.money(row["funding"]["allocation_reference"] * float(fraction))
            previous = row["funding"]["modes"][mode]
            reduction = rules.money(previous.get("funding_allocation", previous["capital"]) - amount)
            if reduction > 0 and reduction > rules.mode_available(row["funding"], mode):
                raise HTTPException(409, "Requested allocation is below this mode's retained commitments")
            if amount != previous.get("funding_allocation", previous["capital"]) or amount != previous["capital"]:
                row["funding"] = rules.correct(row["funding"], mode, amount, 0, "New session allocation", amount)
        row["participants"][mode] = {"identity": identity, "owner_user_id": user, "active": True, "reconciliation_pending": True, "baseline_balance": row["funding"]["modes"][mode]["expected_balance"], "baseline_realized_pnl": row["funding"]["modes"][mode]["realized_pnl"], "baseline_profit": row["funding"]["modes"][mode]["ignored_profit"]}
        row["funding_status"] = rules.status(row["funding"], (row.get("funding_status") or {}).get("available", 0), coherent=False)

    def metadata(row):
        from app.services import real_session_slots as slots
        return [{"Update": {"TableName": "Sessions",
            "Key": slots.serialize({"session_id": session_record_id}),
            "UpdateExpression": "SET real_funding_period = :period, session_capital = :capital",
            "ConditionExpression": "user_id = :owner AND broker_account_id = :account",
            "ExpressionAttributeValues": slots.serialize({":period": period_id, ":capital": row["funding"]["modes"][mode]["capital"], ":owner": user, ":account": account})}},
            {"ConditionCheck": {"TableName": "WalletLedgers", "Key": slots.serialize(slots.key(broker, account, mode)),
                "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND #account = :account AND #state <> :closed",
                "ExpressionAttributeNames": {"#account": "account", "#state": "state"},
                "ExpressionAttributeValues": slots.serialize({":owner": user, ":sid": identity, ":account": account, ":closed": "closed"})}}]

    return apply(
        user,
        broker,
        account,
        period_id,
        f"participant:{mode}:{identity}:start",
        "participant_start",
        {"mode": mode, "identity": identity, "fraction": fraction, "owner_user_id": user},
        mutate,
        extra_actions=metadata if session_record_id else None,
    )


def close_participant(user, broker, account, period_id, mode, identity):
    def mutate(row):
        current = row["participants"].get(mode)
        if not current or current["identity"] != identity or current.get("owner_user_id") != user:
            raise HTTPException(409, "Participant identity changed")
        if any(
            ticket["mode"] == mode
            for ticket in row["funding"].get("reservations", {}).values()
        ):
            raise HTTPException(409, "Participant still has funding reservations")
        row["participants"][mode] = {**current, "active": False}

    return apply(
        user,
        broker,
        account,
        period_id,
        f"participant:{mode}:{identity}:close",
        "participant_close",
        {"mode": mode, "identity": identity},
        mutate,
    )


def finish_period(user, broker, account, period_id):
    """Archive capture evidence after both managed participants have safely closed."""
    from boto3.dynamodb.types import TypeSerializer

    from app.services.db import get_dynamodb_client

    row = read(user, broker, account)
    if not row or row["period_id"] != period_id:
        raise HTTPException(409, "Funding period changed")
    if row.get("state") == "ended":
        return row
    if any(p.get("active") for p in row["participants"].values()) or row["funding"].get(
        "reservations"
    ):
        raise HTTPException(
            409, "Account funding still has active participants or reservations"
        )
    archive = {
        **row,
        "ledger_id": f"funding-period:{period_id}",
        "state": "ended",
        "ended_at": int(time.time() * 1000),
    }
    closed = {**archive, "ledger_id": row["ledger_id"], "version": row["version"] + 1}
    serialize = lambda value: {
        k: TypeSerializer().serialize(v) for k, v in encode(value).items()
    }
    try:
        get_dynamodb_client().transact_write_items(
            TransactItems=[
                {
                    "Put": {
                        "TableName": "WalletLedgers",
                        "Item": serialize(archive),
                        "ConditionExpression": "attribute_not_exists(ledger_id)",
                    }
                },
                {
                    "Put": {
                        "TableName": "WalletLedgers",
                        "Item": serialize(closed),
                        "ConditionExpression": "#version = :version AND period_id = :period",
                        "ExpressionAttributeNames": {"#version": "version"},
                        "ExpressionAttributeValues": serialize(
                            {":version": row["version"], ":period": period_id}
                        ),
                    }
                },
            ]
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            current = read(user, broker, account)
            if (
                current
                and current["period_id"] == period_id
                and current.get("state") == "ended"
            ):
                return current
            raise HTTPException(
                409, "Funding changed during closure; reconcile again"
            ) from exc
        raise
    return closed


def completion_action(user, broker, account, period_id, mode, identity):
    """Join verified participant closure to session/slot completion atomically."""
    from boto3.dynamodb.types import TypeSerializer
    row = read(user, broker, account)
    if not row or row['period_id'] != period_id:
        raise HTTPException(409, 'Funding period changed during closure')
    participant = row['participants'].get(mode)
    if not participant or participant.get('owner_user_id') != user or participant['identity'] != identity:
        raise HTTPException(409, 'Funding participant ownership changed')
    if any(t['mode'] == mode for t in row['funding'].get('reservations', {}).values()):
        raise HTTPException(409, 'Funding commitments must be reconciled before closure')
    changed = deepcopy(row)
    changed['participants'][mode]['active'] = False
    changed['version'] += 1
    return {'Put': {'TableName': 'WalletLedgers', 'Item': {k: TypeSerializer().serialize(v) for k, v in encode(changed).items()},
        'ConditionExpression': '#version = :old AND period_id = :period', 'ExpressionAttributeNames': {'#version': 'version'},
        'ExpressionAttributeValues': {':old': {'N': str(row['version'])}, ':period': {'S': period_id}}}}


def owned_participant(user, broker, account, mode, identity):
    row = read(user, broker, account)
    participant = (row or {}).get('participants', {}).get(mode)
    if not participant or participant.get('owner_user_id') != user or participant['identity'] != identity or not participant.get('active'):
        raise HTTPException(409, 'This Real book no longer owns its funding allocation')
    return row


def change_allocation(user, broker, account, mode, identity, fraction, operation_id, *, extra_actions=None):
    """Explicit owned-mode allocation edit; no automatic sibling resizing."""
    current = owned_participant(user, broker, account, mode, identity)
    def mutate(row):
        participant = row['participants'].get(mode)
        if not participant or participant.get('owner_user_id') != user or participant['identity'] != identity or not participant.get('active'):
            raise HTTPException(409, 'Funding ownership changed')
        fraction_value = float(fraction)
        if not 0 < fraction_value <= 1:
            raise ValueError('Allocation must be between zero and 100%')
        amount = rules.money(row['funding']['allocation_reference'] * fraction_value)
        previous = row['funding']['modes'][mode]
        reduction = rules.money(previous.get('funding_allocation', previous['capital']) - amount)
        if reduction > 0 and reduction > rules.mode_available(row['funding'], mode):
            raise HTTPException(409, 'Allocation cannot be reduced below committed funds')
        row['funding'] = rules.correct(row['funding'], mode, amount, 0, 'Explicit allocation edit', amount)
        participant['baseline_balance'] = rules.money(participant['baseline_balance'] - reduction)
        participant.pop('snapshot_fingerprint', None)
    return apply(user, broker, account, current['period_id'], operation_id, 'allocation', {'mode': mode, 'identity': identity, 'fraction': fraction}, mutate, extra_actions=extra_actions)
