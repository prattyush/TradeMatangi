"""One application operator for centrally shared Real account credentials.

The owner remains while either funded mode is active, including screen detach
and backend downtime. This is account ownership, not a short engine lease.
"""

import time
from botocore.exceptions import ClientError
from fastapi import HTTPException


def _key(broker, account):
    from app.services.execution_broker import name

    if not isinstance(account, str) or not account:
        raise ValueError("Broker account identity is required")
    return {"user_id": "real-account-owner", "ledger_id": f"{name(broker)}:{account}"}


def read(broker, account):
    from app.services.swing_funding_store import _table, decode

    row = _table().get_item(Key=_key(broker, account), ConsistentRead=True).get("Item")
    return decode(row) if row else None


def claim(user, broker, account, period_id):
    from app.services.swing_funding_store import _table

    current = read(broker, account)
    replace_closed = None
    if current and current.get("state") == "active":
        if (
            current.get("owner_user_id") == user
            and current.get("period_id") == period_id
        ):
            return current
        archived = (
            _table()
            .get_item(
                Key={
                    "user_id": current["owner_user_id"],
                    "ledger_id": "funding-period:" + current["period_id"],
                },
                ConsistentRead=True,
            )
            .get("Item")
        )
        if (
            archived
            and archived.get("state") == "ended"
            and not any(p.get("active") for p in archived["participants"].values())
        ):
            replace_closed = current
        else:
            raise HTTPException(
                409,
                "This Real broker account already has an active application operator; close its funded modes first",
            )
    row = {
        **_key(broker, account),
        "owner_user_id": user,
        "period_id": period_id,
        "state": "active",
        "claimed_at": int(time.time() * 1000),
    }
    try:
        if replace_closed:
            _table().put_item(
                Item=row,
                ConditionExpression="owner_user_id = :olduser AND period_id = :oldperiod AND #state = :active",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={
                    ":olduser": replace_closed["owner_user_id"],
                    ":oldperiod": replace_closed["period_id"],
                    ":active": "active",
                },
            )
        else:
            _table().put_item(
                Item=row,
                ConditionExpression="attribute_not_exists(ledger_id) OR #state = :ended",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={":ended": "ended"},
            )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            latest = read(broker, account)
            if (
                latest
                and latest.get("owner_user_id") == user
                and latest.get("period_id") == period_id
            ):
                return latest
            raise HTTPException(
                409, "Another operator claimed the Real broker account"
            ) from exc
        raise
    return row


def release(user, broker, account, period_id):
    from app.services.swing_funding_store import _table, read as funding_read

    period = funding_read(user, broker, account)
    if not period or period["period_id"] != period_id or period.get("state") != "ended":
        raise HTTPException(
            409, "Real account ownership remains until both funded modes close"
        )
    try:
        _table().update_item(
            Key=_key(broker, account),
            UpdateExpression="SET #state = :ended",
            ConditionExpression="owner_user_id = :user AND period_id = :period",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":ended": "ended",
                ":user": user,
                ":period": period_id,
            },
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(409, "Real account ownership changed") from exc
        raise
