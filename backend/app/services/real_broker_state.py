"""Broker-authoritative day snapshots, staged in existing DynamoDB tables.

A manifest points to a complete revision; old local rows remain archived. Live
sessions reference one day projection rather than duplicating the broker day.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict
from boto3.dynamodb.conditions import Key
from app.models.schemas import Trade, TradeSide, Order, OrderType, OrderStatus, Position
from app.services import broker_reports as reports

logger = logging.getLogger(__name__)
_locks: dict[str, asyncio.Lock] = {}
_links: dict[str, dict] = {}
STATE_GENERATION = str(uuid.uuid4())
class SnapshotPersistenceError(RuntimeError):
    pass


OPEN = {"open", "trigger pending", "amo", "pending", "validation pending", "put order req received", "modify pending", "partially filled", "partial fill"}


def encode(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        from app.services.execution_analytics import normalize_metadata
        return {key: encode(normalize_metadata(item) if key == "analytics" else item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [encode(item) for item in value]
    return value


def query_all(table, **params):
    result = []
    while True:
        page = table.query(**params)
        result.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return result
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def projection_id(session, account_id):
    scope = f"{session.user_id}:{account_id}:{session.date}:{session.symbol}:{session.instrument_type}"
    return "broker-day:" + hashlib.sha256(scope.encode()).hexdigest()[:32]


def link_for(session_id):
    if session_id in _links:
        return _links[session_id]
    from app.services.db import get_dynamodb_resource
    row = get_dynamodb_resource().Table("Sessions").get_item(Key={"session_id": session_id}, ConsistentRead=True).get("Item", {})
    if isinstance(row, dict) and row.get("broker_projection_id"):
        return {"projection_id": row["broker_projection_id"]}
    return None


def read_projection(session_id):
    from app.services.db import get_dynamodb_resource
    link = link_for(session_id)
    if not link:
        return None
    db = get_dynamodb_resource()
    manifest = db.Table("Sessions").get_item(Key={"session_id": link["projection_id"]}, ConsistentRead=True).get("Item", {})
    partition = manifest.get("active_partition")
    if not partition:
        return None
    _links[session_id] = {"projection_id": link["projection_id"], **manifest}
    rows = query_all(db.Table("Trades"), KeyConditionExpression=Key("session_id").eq(partition), ConsistentRead=True)
    return sorted([{**row, "session_id": session_id} for row in rows], key=lambda row: (int(row["timestamp"]), row["trade_id"]))


def aggregate(session, executions, account_id, master=None):
    from app.services.trading import compute_commission
    groups, seen = {}, set()
    for execution in executions:
        if not reports.in_scope(session, execution):
            continue
        if datetime.fromtimestamp(execution["timestamp"], timezone.utc).date().isoformat() != session.date:
            continue
        identity = (execution.get("exchange", ""), execution["kotak_order_id"], execution["execution_id"])
        if identity in seen:
            continue
        seen.add(identity)
        contract = reports.contract(session, execution, master)
        key = (execution.get("exchange", ""), execution["kotak_order_id"])
        group = groups.setdefault(key, {"row": execution, "contract": contract, "quantity": 0, "value": 0., "first": execution["timestamp"], "ids": []})
        if group["contract"] != contract or group["row"]["side"] != execution["side"]:
            raise ValueError("Broker order contains inconsistent execution identities")
        group["quantity"] += execution["quantity"]
        group["value"] += execution["quantity"] * execution["price"]
        group["first"] = min(group["first"], execution["timestamp"])
        group["ids"].append(execution["execution_id"])
    trades = []
    for (exchange, order_id), group in groups.items():
        side = TradeSide(group["row"]["side"])
        price, qty = group["value"] / group["quantity"], group["quantity"]
        trades.append(Trade(trade_id=f"kotak:{account_id}:{exchange}:{order_id}",
            session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
            side=side, quantity=qty, price=price, timestamp=group["first"],
            instrument_type=session.instrument_type, session_type="real", source="broker",
            commission=compute_commission(side, price, qty, session.brokerage_per_order),
            kotak_order_id=order_id, broker_account_id=account_id, broker_exchange=exchange,
            broker_execution_ids=sorted(group["ids"]), **group["contract"]))
    return sorted(trades, key=lambda t: (t.timestamp, t.trade_id))


def normalize_positions(session, raw_positions, master=None):
    positions = []
    for raw in raw_positions:
        row = reports.normalize_order(raw)
        if not reports.in_scope(session, row):
            continue
        contract = reports.contract(session, row, master)
        buy = reports.number(raw.get("cfBuyQty")) + reports.number(raw.get("flBuyQty"))
        sell = reports.number(raw.get("cfSellQty")) + reports.number(raw.get("flSellQty"))
        net = int(reports.number(raw.get("netQty", raw.get("net_quantity", buy - sell))))
        avg = reports.number(raw.get("buyAvgPrc" if net > 0 else "sellAvgPrc") or raw.get("avgPrc") or raw.get("avg_entry_price"))
        if not avg and net:
            prefix = "Buy" if net > 0 else "Sell"
            quantity = buy if net > 0 else sell
            amount = reports.number(raw.get("cf" + prefix + "Amt")) + reports.number(raw.get("fl" + prefix + "Amt"))
            factor = reports.number(raw.get("prcFctr"), 1) or 1
            avg = amount / quantity / factor if quantity else 0
        positions.append({**Position(symbol=session.symbol, side="LONG" if net > 0 else "SHORT" if net < 0 else "FLAT", quantity=abs(net), avg_entry_price=avg).model_dump(), **contract, "product": row["product"], "broker_exchange": row["exchange"]})
    return positions


def build_orders(session, broker_orders, master=None):
    from app.services import order_service
    original = order_service.get_all_orders(session.session_id)
    tracked = {o.kotak_order_id: o for o in original if o.kotak_order_id}
    # A split placement may succeed while its HTTP acknowledgement is lost.
    # Adopt its unique, persisted tag rather than importing a duplicate exit.
    split_children = {o.split_operation.get('tag'): o for o in original
        if o.split_operation and o.split_operation.get('child_id') == o.order_id
        and o.split_operation.get('tag') and not o.kotak_order_id}
    result = {o.order_id: o.model_copy(deep=True) for o in original if not o.kotak_order_id}
    for row in broker_orders:
        status = row["status"]
        kind = OrderType.STOPLOSS if row["order_type"] in ("SL", "SL-M", "STOPLOSS") else OrderType.LIMIT
        previous = tracked.get(row["kotak_order_id"])
        tagged = split_children.get(row.get('tag'))
        if previous is None and tagged is not None and row['quantity'] == tagged.quantity and row['side'] == tagged.side.value and kind == tagged.order_type:
            contract = reports.contract(session, row, master)
            if (contract.get('right'), contract.get('strike'), contract.get('expiry')) == (tagged.right, tagged.strike, tagged.expiry):
                previous = tagged
        if previous is None and row["order_type"] == "MARKET" and status in OPEN:
            continue
        order = previous.model_copy(deep=True) if previous else Order(order_id="external_" + row["kotak_order_id"], session_id=session.session_id,
            user_id=session.user_id, symbol=session.symbol, side=TradeSide(row["side"]), order_type=kind,
            quantity=row["quantity"], trigger_price=row["trigger_price"], limit_price=row["limit_price"],
            created_at=reports.wall_time(row["order_time"]) if row.get("order_time") else 0,
            source="broker_external", kotak_order_id=row["kotak_order_id"], **reports.contract(session, row, master))
        order.kotak_order_id = row["kotak_order_id"]
        order.order_type = kind
        order.is_stoploss = kind == OrderType.STOPLOSS
        order.trigger_price, order.limit_price = row["trigger_price"], row["limit_price"]
        order.quantity = row["quantity"]
        order.broker_product, order.broker_exchange = row["product"], row["exchange"]
        order.broker_filled_quantity = row["filled_quantity"]
        order.broker_filled_value = row["filled_quantity"] * row["filled_price"]
        order.status = OrderStatus.FILLED if status in ("complete", "filled") else OrderStatus.CANCELLED if status in ("cancelled", "canceled", "rejected", "expired") else OrderStatus.PENDING
        order.kotak_fill_confirmed = order.status == OrderStatus.FILLED
        if order.broker_filled_quantity:
            order.filled_price = row["filled_price"]
        result[order.order_id] = order
    from app.services.order_split import reconcile_projection
    reconcile_projection(result, broker_orders)
    # Broker-backed locals absent from a complete report are not live orders.
    return result


def stage(session, account_id, trades, broker_orders, positions, executions, orders):
    from app.services.db import get_dynamodb_resource
    db = get_dynamodb_resource()
    root = projection_id(session, account_id)
    revision = str(uuid.uuid4())
    partition = root + ":" + revision
    sessions = db.Table("Sessions")
    old = sessions.get_item(Key={"session_id": root}, ConsistentRead=True).get("Item", {})
    # Archive before replacement, leaving original partitions available for audit.
    members = query_all(sessions, IndexName="UserIdIndex", KeyConditionExpression=Key("user_id").eq(session.user_id))
    members = [r for r in members if r.get("session_type") == "real" and r.get("date") == session.date and r.get("symbol") == session.symbol and r.get("instrument_type", "equity") == session.instrument_type and r.get("broker_projection_id") in (None, root)]
    mapped_labels = []
    if old.get("active_partition"):
        previous_rows = query_all(db.Table("Trades"), KeyConditionExpression=Key("session_id").eq(old["active_partition"]), ConsistentRead=True)
        previous_labels = [r["mapped_label"] for r in query_all(db.Table("Orders"), KeyConditionExpression=Key("session_id").eq(old["active_partition"]), ConsistentRead=True) if "mapped_label" in r]
        mapped_labels.extend(remap_labels(previous_rows, previous_labels, trades))
    if not old.get("archived"):
        for member in members:
            sid = member["session_id"]
            rows = query_all(db.Table("Trades"), KeyConditionExpression=Key("session_id").eq(sid), ConsistentRead=True)
            for row in rows:
                db.Table("Trades").put_item(Item={**row, "session_id": root + ":archive:" + sid})
            labels = read_labels(db, sid)
            mapped_labels.extend(remap_labels(rows, labels, trades))
            for label in labels:
                db.Table("Orders").put_item(Item=encode({"session_id": root + ":archive:" + sid, "order_id": "label:" + str(label["round_trip_index"]), "archived_label": label}))
    # Include labels added since the last revision only when they refer to it.
    if old.get("revision"):
        for member in members:
            sid = member["session_id"]
            labels = read_labels(db, sid)
            labels = [r for r in labels if r.get("broker_snapshot_revision") == old["revision"]]
            mapped_labels.extend(remap_labels(previous_rows, labels, trades))
    grouped_labels = defaultdict(list)
    for label in mapped_labels:
        grouped_labels[int(label["round_trip_index"])].append(label)
    for index, candidates in grouped_labels.items():
        edited = [r for r in candidates if old.get("revision") and r.get("broker_snapshot_revision") == old["revision"]]
        if edited:
            candidates = edited
        # Conflicting historical labels remain archived rather than guessing.
        choices = {json.dumps(encode_label_fields(r), sort_keys=True) for r in candidates}
        if len(choices) == 1:
            db.Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": f"label:{index}", "mapped_label": candidates[-1]}))
    for trade in trades:
        db.Table("Trades").put_item(Item=encode({**trade.model_dump(mode="json"), "session_id": partition}))
    for order in orders.values():
        db.Table("Orders").put_item(Item=encode({**order.model_dump(mode="json"), "session_id": partition}))
    for execution in executions:
        db.Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": "execution:" + execution.get("exchange", "") + ":" + execution["kotak_order_id"] + ":" + execution["execution_id"], "broker_execution": execution}))
    # Full broker order/position facts are separate from editable application orders.
    for index, row in enumerate(broker_orders):
        db.Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": f"report:{index}", "broker_order": row}))
    for index, row in enumerate(positions):
        db.Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": f"position:{index}", "broker_position": row}))
    return {"session_id": root, "active_partition": partition, "revision": revision, "owner_session_id": session.session_id,
            "synced_at": int(datetime.now(timezone.utc).timestamp()), "archived": True}, members


def commit(session, manifest, members):
    from app.services.db import get_dynamodb_resource
    table = get_dynamodb_resource().Table("Sessions")
    # Link only after staging is complete. Readers see either whole revision.
    identities = {session.session_id, *(m["session_id"] for m in members)}
    for sid in identities:
        table.update_item(Key={"session_id": sid}, UpdateExpression="SET broker_projection_id = :root, broker_projection_owner = :owner",
                          ExpressionAttributeValues={":root": manifest["session_id"], ":owner": session.session_id})
    # Publish once all aliases are durable. Existing aliases still read the old
    # complete revision if linking fails; first-time aliases have no active revision.
    table.put_item(Item=manifest)
    for sid in identities:
        _links[sid] = {"projection_id": manifest["session_id"], **manifest}
    session.broker_projection_id = manifest["session_id"]
    session.broker_projection_owner = manifest["owner_session_id"]


def fill_deferred(session, callback, *args):
    events = getattr(session, "broker_refresh_events", None)
    if events is not None:
        events.append((callback, args))
        return True
    return False


async def refresh(session, broker, *, protection=False, bundle=None):
    from app.services import trading, order_service, wallet_service, simulation
    from app.services import kotak_reports
    from app.services.protection_recovery import Deferred
    account = await asyncio.to_thread(broker.account_identity)
    root = projection_id(session, account)
    prefetched = bundle
    if protection:
        # Background reads must not set the foreground "refresh busy" barrier.
        version = getattr(session, '_protection_revision', 0)
        prefetched = prefetched or await kotak_reports.fetch(broker, background=True)
        if (version != getattr(session, '_protection_revision', 0)
                or prefetched.revision != kotak_reports.state(broker).revision
                or kotak_reports.state(broker).foreground):
            from app.services.protection_recovery import Deferred
            raise Deferred('Foreground operation or fill changed the broker snapshot')
    async with _locks.setdefault(root, asyncio.Lock()):
        if getattr(session, 'order_split_in_progress', None):
            raise ValueError('Order split is in progress; retry broker refresh shortly')
        if getattr(session, "broker_refresh_events", None) is not None:
            raise ValueError("A broker refresh is already running")
        if not protection:
            session.broker_refresh_events = []
        try:
            bundle = prefetched or await kotak_reports.fetch(broker, background=protection)
            raw_orders, executions, raw_positions = bundle.orders, bundle.executions, bundle.positions
            scoped_orders = [r for r in raw_orders if reports.in_scope(session, r)]
            scoped_executions = [r for r in executions if reports.in_scope(session, r)]
            master = None
            try:
                trades = aggregate(session, scoped_executions, account)
                positions = normalize_positions(session, raw_positions)
                orders = build_orders(session, scoped_orders)
            except reports.UnknownContractError:
                from app.services.kotak_service import _get_kotak_instruments
                master = await asyncio.to_thread(_get_kotak_instruments)
                trades = aggregate(session, scoped_executions, account, master)
                positions = normalize_positions(session, raw_positions, master)
                orders = build_orders(session, scoped_orders, master)
            # Independent broker endpoints can straddle a fill. Retry once
            # before publishing a revision whose reported fills disagree.
            def quantities_agree():
                quantities = {(t.broker_exchange, t.kotak_order_id): t.quantity for t in trades}
                if any(r["filled_quantity"] != quantities.get((r["exchange"], r["kotak_order_id"]), 0) for r in scoped_orders):
                    return False
                expected = defaultdict(int)
                for trade in trades:
                    expected[(trade.right, trade.strike, trade.expiry, trade.side.value)] += trade.quantity
                actual = defaultdict(int)
                checked = set()
                for raw in raw_positions:
                    row = reports.normalize_order(raw)
                    if not reports.in_scope(session, row) or not all(k in raw for k in ("flBuyQty", "flSellQty")):
                        continue
                    contract = reports.contract(session, row, master)
                    key = (contract["right"], contract["strike"], contract["expiry"])
                    checked.add(key)
                    actual[(*key, "BUY")] += int(reports.number(raw["flBuyQty"]))
                    actual[(*key, "SELL")] += int(reports.number(raw["flSellQty"]))
                return all(actual[(*key, side)] == expected[(*key, side)] for key in checked for side in ("BUY", "SELL"))
            from app.services.fifo_positions import verified_positions
            def fifo_agrees():
                if not quantities_agree():
                    return False
                try:
                    verified_positions(session, scoped_executions, positions, master)
                    return True
                except ValueError:
                    return False
            if not fifo_agrees():
                if protection:
                    from app.services.protection_recovery import Deferred
                    kotak_reports.disagree(broker, root)
                    raise Deferred('Broker reports are updating; retry entry protection after backoff')
                bundle = await kotak_reports.fetch(broker, background=True, force=True)
                raw_orders, executions, raw_positions = bundle.orders, bundle.executions, bundle.positions
                scoped_orders = [r for r in raw_orders if reports.in_scope(session, r)]
                scoped_executions = [r for r in executions if reports.in_scope(session, r)]
                trades = aggregate(session, scoped_executions, account, master)
                positions = normalize_positions(session, raw_positions, master)
                orders = build_orders(session, scoped_orders, master)
                if not fifo_agrees():
                    raise ValueError("Kotak execution history/positions are incomplete or still updating; FIFO refresh was not applied")
            positions = verified_positions(session, scoped_executions, positions, master)
            kotak_reports.consistent(broker, root)
            # Persist resolved monthly expiry so restart/live FIFO needs no instrument download.
            scoped_executions = [{**row, **reports.contract(session, row, master)} for row in scoped_executions]
            by_broker_id = {t.kotak_order_id: t for t in trades}
            for order in orders.values():
                if order.kotak_order_id and order.execution_role is None:
                    held = [p for p in positions if (p.get("right"), p.get("strike"), p.get("expiry")) == (order.right, order.strike, order.expiry)]
                    net = sum(p["quantity"] * (1 if p["side"] == "LONG" else -1 if p["side"] == "SHORT" else 0) for p in held)
                    order.execution_role = "exit" if (net > 0 and order.side == TradeSide.SELL) or (net < 0 and order.side == TradeSide.BUY) else "entry"
                if order.kotak_order_id in by_broker_id:
                    order.filled_at = by_broker_id[order.kotak_order_id].timestamp
            # New live facts are handled after publication; they cannot append duplicates.
            try:
                manifest, members = await asyncio.to_thread(stage, session, account, trades, scoped_orders, positions, scoped_executions, orders)
                if protection:
                    if (version != getattr(session, '_protection_revision', 0)
                            or bundle.revision != kotak_reports.state(broker).revision
                            or kotak_reports.state(broker).foreground):
                        from app.services.protection_recovery import Deferred
                        raise Deferred('Trading changed during background staging; the existing revision remains active')
                    # Publish under a short callback barrier; slow report reads
                    # and history staging never make manual order edits busy.
                    session.broker_refresh_events = []
                await asyncio.to_thread(commit, session, manifest, members)
            except Deferred:
                raise
            except Exception as exc:
                logger.warning("broker_snapshot_persistence_failed session=%s: %s", session.session_id, exc)
                raise SnapshotPersistenceError("Could not persist broker refresh; the previous revision remains active") from exc
            trading._trades[session.session_id] = trades
            order_service._orders[session.session_id] = orders
            session.kotak_order_map = {o.order_id: o.kotak_order_id for o in orders.values() if o.kotak_order_id}
            session.broker_positions = positions
            from app.services.fifo_positions import unique_executions
            session._fifo_executions = unique_executions(session, scoped_executions, master)
            session._fifo_account = account
            session._broker_state_version = getattr(session, "_broker_state_version", 0) + 1
            session._broker_snapshot_revision = manifest["revision"]
            session._protection_revision = getattr(session, "_protection_revision", 0) + 1
            session._kotak_report_bundle = bundle
            events, session.broker_refresh_events = session.broker_refresh_events, None
            for callback, args in events:
                callback(*args)
            for order in order_service.get_open_orders(session.session_id):
                if order.kotak_order_id:
                    simulation._register_kotak_sl_for_order(session, order, asyncio.get_running_loop(), attach_only=True)
            if not protection:
                from app.services.kotak_protection import request
                request(session, reason='refresh', delay=0, invalidate=False)
                from app.services.protection_recovery import resume
                await resume(session)
            from app.services.broker_conversion import reconcile_refresh
            await reconcile_refresh(session, scoped_orders)
            wallet_balance, wallet_error, wallet_display_balance = None, None, None
            try:
                from app.services import real_accounting
                account_wallet = (await real_accounting.refresh(session.user_id, session.date, broker,
                    reason="reconcile", executions=executions, positions=raw_positions)) if not protection else None
                if account_wallet is None:
                    account_wallet = {"session_capital": session.session_capital, "balance": None, "display_balance": None}
                real_accounting.apply_session_capital(session, account_wallet["session_capital"])
                wallet_balance = account_wallet["balance"]
                wallet_display_balance = account_wallet["display_balance"]
            except Exception as exc:
                wallet_balance, wallet_error = None, f"Could not refresh Kotak wallet: {exc}"
                logger.warning("broker_snapshot_wallet_failed session=%s: %s", session.session_id, exc)
            current = trading.get_trades(session.session_id)
            result = {"reconciled": len(current), "updated": len(scoped_orders), "imported": 0,
                      "orders": scoped_orders, "open_orders": [r for r in scoped_orders if r["status"] not in ("complete", "filled", "cancelled", "canceled", "rejected", "expired")],
                      "trades": [t.model_dump(mode="json") for t in current],
                      "positions": getattr(session, "broker_positions", positions),
                      "local_entry_orders": [o.model_dump(mode="json") for o in order_service.get_open_orders(session.session_id) if not o.kotak_order_id],
                      "application_orders": [o.model_dump(mode="json") for o in order_service.get_open_orders(session.session_id)],
                      "snapshot_revision": manifest["revision"], "synced_at": manifest["synced_at"],
                      "state_version": getattr(session, "_broker_state_version", 0), "state_generation": STATE_GENERATION,
                      "wallet_balance": wallet_balance, "wallet_display_balance": wallet_display_balance,
                      "session_capital": session.session_capital if wallet_error is None else None, "wallet_error": wallet_error}
            session.queue.put_nowait(json.dumps({"type": "broker_snapshot", "session_id": session.session_id, **result}))
            logger.info("broker_snapshot_published session=%s revision=%s orders=%d trades=%d deferred=%d wallet_ok=%s",
                        session.session_id, manifest["revision"], len(scoped_orders), len(current), len(events), wallet_error is None)
            return result
        finally:
            events = getattr(session, "broker_refresh_events", None)
            session.broker_refresh_events = None
            if events:
                for callback, args in events:
                    callback(*args)


def active_partition(session_id):
    """In-memory committed pointer for hot-path writes; restored before resuming."""
    return _links.get(session_id, {}).get("active_partition")


def restore_orders(session):
    from app.services import order_service
    from app.services.db import get_dynamodb_resource
    link = link_for(session.session_id)
    db = get_dynamodb_resource()
    manifest = db.Table("Sessions").get_item(Key={"session_id": link["projection_id"]}, ConsistentRead=True).get("Item", {}) if link else {}
    if manifest:
        _links[session.session_id] = {"projection_id": manifest["session_id"], **manifest}
        session.broker_projection_id = manifest["session_id"]
    rows = query_all(db.Table("Orders"), KeyConditionExpression=Key("session_id").eq(manifest.get("active_partition", session.session_id)), ConsistentRead=True)
    orders = {}
    for row in rows:
        if "order_type" in row:
            order = Order.model_validate({**row, "session_id": session.session_id})
            orders[order.order_id] = order
    order_service._orders[session.session_id] = orders
    session.kotak_order_map = {o.order_id: o.kotak_order_id for o in orders.values() if o.kotak_order_id}
    if manifest:
        session.broker_positions = [row["broker_position"] for row in rows if "broker_position" in row]
        executions = [dict(row["broker_execution"]) for row in rows if "broker_execution" in row]
        if executions or not any(p["quantity"] for p in session.broker_positions):
            from app.services.fifo_positions import unique_executions, verified_positions
            try:
                ledger = unique_executions(session, executions)
                restored = verified_positions(session, ledger, session.broker_positions)
            except ValueError:
                session._fifo_executions = None
                logger.exception("restored_fifo_incomplete session=%s; broker refresh required", session.session_id)
            else:
                session._fifo_executions = ledger
                session.broker_positions = restored
        session._broker_state_version = getattr(session, "_broker_state_version", 0) + 1


def apply_position_fill(session, order, quantity, price):
    from app.services.fifo_positions import live_delta, positions as fifo_positions
    execution = live_delta(session, order, quantity, price)
    if execution is not None:
        session.broker_positions = fifo_positions(session, session._fifo_executions)
        session._broker_state_version = getattr(session, "_broker_state_version", 0) + 1
        partition = active_partition(session.session_id)
        if partition:
            from app.services.db import get_dynamodb_resource
            db = get_dynamodb_resource()
            try:
                db.Table("Orders").put_item(Item=encode({"session_id": partition,
                    "order_id": "execution:" + execution["exchange"] + ":" + order.kotak_order_id + ":" + execution["execution_id"], "broker_execution": execution}))
                for index, row in enumerate(session.broker_positions):
                    db.Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": f"position:{index}", "broker_position": row}))
            except Exception:
                logger.exception("live_fifo_persistence_failed session=%s; refresh before reattachment", session.session_id)
        return
    # Legacy/unrefreshed open books keep broker basis until verified history is available.
    positions = session.broker_positions
    position = next((p for p in positions if (p.get("right"), p.get("strike"), p.get("expiry")) == (order.right, order.strike, order.expiry)), None)
    if position is None:
        position = {**Position(symbol=session.symbol, side="FLAT", quantity=0, avg_entry_price=0).model_dump(), "right": order.right, "strike": order.strike, "expiry": order.expiry}
        positions.append(position)
    signed = position["quantity"] * (1 if position["side"] == "LONG" else -1 if position["side"] == "SHORT" else 0)
    change = quantity * (1 if order.side == TradeSide.BUY else -1)
    net = signed + change
    avg = float(position["avg_entry_price"])
    if not signed or signed * change > 0:
        avg = (abs(signed) * avg + quantity * price) / abs(net)
    elif signed * net < 0:
        avg = price
    position.update(quantity=abs(net), side="LONG" if net > 0 else "SHORT" if net < 0 else "FLAT", avg_entry_price=avg if net else 0)
    partition = active_partition(session.session_id)
    if partition:
        from app.services.db import get_dynamodb_resource
        index = positions.index(position)
        get_dynamodb_resource().Table("Orders").put_item(Item=encode({"session_id": partition, "order_id": f"position:{index}", "broker_position": position}))


def remap_labels(old_rows, labels, new_trades):
    """Only carry labels whose entry/exit executions map uniquely to broker rows."""
    from app.services.trade_label_service import compute_round_trip_state
    new_rows = [t.model_dump(mode="json") for t in new_trades]
    def identity(row):
        return (row.get("side"), row.get("right"), row.get("strike"), row.get("expiry"),
                int(row.get("timestamp", 0)), int(row.get("quantity", 0)), round(float(row.get("price", 0)), 6))
    by_identity = defaultdict(list)
    for row in new_rows:
        by_identity[identity(row)].append(row["trade_id"])
    mapping = {}
    for row in old_rows:
        candidates = [r["trade_id"] for r in new_rows if row.get("kotak_order_id") and r.get("kotak_order_id") == row["kotak_order_id"]]
        if not candidates:
            candidates = by_identity[identity(row)]
        if len(candidates) == 1:
            mapping[row["trade_id"]] = candidates[0]
    old_completed, old_open = compute_round_trip_state(old_rows)
    completed, opened = compute_round_trip_state(new_rows)
    def fingerprint(rt, ids):
        entries = [ids.get(r["trade_id"]) for r in rt["entry_trades"]]
        exits = [ids.get(r["trade_id"]) for r in rt["exit_trades"]]
        return (tuple(entries), tuple(exits)) if entries and all(entries) and all(exits) else None
    targets = defaultdict(list)
    for rt in completed + opened:
        targets[fingerprint(rt, {r["trade_id"]: r["trade_id"] for r in new_rows})].append(rt["index"])
    old_by_index = {rt["index"]: rt for rt in old_completed + old_open}
    result = []
    for label in labels:
        rt = old_by_index.get(int(label["round_trip_index"]))
        key = fingerprint(rt, mapping) if rt else None
        if key and len(targets[key]) == 1:
            result.append({**label, "round_trip_index": targets[key][0]})
    return result


def projected_labels(session_id):
    from app.services.db import get_dynamodb_resource
    partition = active_partition(session_id)
    if not partition:
        link = link_for(session_id)
        if not link:
            return None
        manifest = get_dynamodb_resource().Table("Sessions").get_item(Key={"session_id": link["projection_id"]}, ConsistentRead=True).get("Item", {})
        partition = manifest.get("active_partition")
        if partition:
            _links[session_id] = {"projection_id": link["projection_id"], **manifest}
    if not partition:
        return None
    rows = query_all(get_dynamodb_resource().Table("Orders"), KeyConditionExpression=Key("session_id").eq(partition), ConsistentRead=True)
    return [{**row["mapped_label"], "session_id": session_id} for row in rows if "mapped_label" in row]


def encode_label_fields(row):
    return {k: str(row.get(k, "")) for k in ("expected_category", "expected_strategy", "actual_category", "actual_strategy", "entry_tag", "exit_tag")}


def read_labels(db, session_id):
    from botocore.exceptions import ClientError
    try:
        return query_all(db.Table("TradeLabels"), KeyConditionExpression=Key("session_id").eq(session_id), ConsistentRead=True)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return []
        raise
