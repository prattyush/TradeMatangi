"""Real Day engines, pinned to durable broker/account/style ownership."""

import asyncio
import time
import uuid
from contextvars import ContextVar
from weakref import WeakValueDictionary

from fastapi import HTTPException

from app.services import real_session_slots as slots

_locks = WeakValueDictionary()
_context = ContextVar("real_start_claim", default=None)
_recovery = ContextVar("real_recovery_record", default=None)


def _table():
    return slots.table()


def active(user_id, broker=None, account=None):
    from app.services import execution_broker, user_settings_service

    broker = execution_broker.name(
        broker
        or user_settings_service.get_settings(user_id, strict=True)[
            "real_execution_broker"
        ]
    )
    if account:
        row = slots.read(broker, account, "intraday")
        return row if row and row["owner_user_id"] == user_id else None
    rows = [
        r
        for r in slots.for_user(user_id)
        if r["broker"] == broker and r["style"] == "intraday"
    ]
    return rows[0] if rows else None


def active_all(user_id):
    return slots.for_user(user_id)


def _claim(user_id, token, session_id, broker, account, *, record=None):
    return slots.claim(
        user_id, broker, account, "intraday", session_id, token, record=record
    )


def _finish(user_id, token, session_id, broker, account, *, closing=False):
    slots.update(
        broker,
        account,
        "intraday",
        user_id,
        session_id,
        token,
        state="closing" if closing else "running",
    )


def release(session):
    """Commit book completion and slot release together; caller verified exposure."""
    from app.services.db import get_dynamodb_client

    actions = [
        {
            "Update": {
                "TableName": "Sessions",
                "Key": slots.serialize({"session_id": session.session_id}),
                "UpdateExpression": "SET #state = :ended, real_closing = :no, real_verified_closed = :yes",
                "ConditionExpression": "user_id = :owner AND broker_account_id = :account",
                "ExpressionAttributeNames": {"#state": "state"},
                "ExpressionAttributeValues": slots.serialize(
                    {
                        ":ended": "ended",
                        ":no": False,
                        ":yes": True,
                        ":owner": session.user_id,
                        ":account": session.broker_account_id,
                    }
                ),
            }
        },
        slots.close_action(
            session.user_id,
            session.execution_broker,
            session.broker_account_id,
            "intraday",
            session.session_id,
            session.real_claim_token,
        ),
    ]
    if getattr(session, "real_funding_period", None):
        from app.services import swing_funding_store as funding

        actions.append(
            funding.completion_action(
                session.user_id,
                session.execution_broker,
                session.broker_account_id,
                session.real_funding_period,
                "intraday",
                session.session_id,
            )
        )
    get_dynamodb_client().transact_write_items(TransactItems=actions)


def prepared_identity():
    claim = _context.get()
    return claim["session_id"] if claim else None


def prepared_claim():
    return _context.get()


def prepared_broker():
    claim = _context.get()
    return claim["broker"] if claim else None


async def start(req, user_id, create):
    from app.dependencies import require_real_trading_access
    from app.services import execution_broker, simulation, user_settings_service
    from app.services.real_trading_day import market_date

    require_real_trading_access(user_id)
    if req.date != market_date():
        raise HTTPException(400, "Real trading requires today IST")
    req.override = False  # Practice reset preferences never overwrite a Real book.
    chosen = execution_broker.name(
        getattr(req, "execution_broker", None)
        or (
            await asyncio.to_thread(
                user_settings_service.get_settings, user_id, strict=True
            )
        )["real_execution_broker"]
    )
    req.execution_broker = chosen
    broker = execution_broker.get_service(chosen)
    if not await asyncio.to_thread(broker.is_authenticated):
        raise HTTPException(
            401,
            f"{chosen.title()} authentication required before starting a Real session",
        )
    if not _ready:
        raise HTTPException(
            503, "Real ownership recovery is still pending; retry shortly"
        )
    account = await asyncio.to_thread(broker.account_identity)
    lock = _locks.setdefault((chosen, account), asyncio.Lock())
    async with lock:
        runtime = next(
            (
                s
                for s in simulation._sessions.values()
                if s.user_id == user_id
                and s.session_type == "real"
                and getattr(s, "trading_style", "intraday") != "swing"
                and execution_broker.name(s) == chosen
                and s.broker_account_id == account
                and s.state != simulation.SimulationState.ENDED
            ),
            None,
        )
        slot = await asyncio.to_thread(slots.read, chosen, account, "intraday")
        if slot and slot["owner_user_id"] != user_id:
            raise HTTPException(
                409,
                f"{chosen.title()} Day already has an outstanding Real session owned by another user",
            )
        if slot and slot.get("recovery_conflict"):
            raise HTTPException(409, "Conflicting Real books require reconciliation")
        if runtime:
            if not slot:
                await asyncio.to_thread(
                    slots.adopt,
                    user_id,
                    {
                        "session_id": runtime.session_id,
                        "execution_broker": chosen,
                        "broker_account_id": account,
                    },
                    token=getattr(runtime, "real_claim_token", None),
                    engine_until=int(time.time()) + 45,
                )
            if (
                getattr(runtime, "real_start_preparing", False)
                and runtime.task is None
                and not runtime.real_closing
            ):
                raise HTTPException(
                    409,
                    "Real startup is incomplete; recover or close the outstanding session",
                )
            if runtime.date != req.date:
                raise HTTPException(
                    409,
                    "Close the outstanding previous-day Real session before starting today",
                )
            if (
                runtime.symbol != req.symbol
                or runtime.instrument_type != req.instrument_type
            ):
                raise HTTPException(
                    409,
                    "Close the active Real session before changing underlying or instrument type",
                )
            from app.routers.simulation import _session_response

            return _session_response(runtime)
        record = None
        if slot:
            if int(slot.get("engine_until") or 0) >= int(time.time()):
                raise HTTPException(
                    409,
                    "The outstanding Real engine is still active; attach or retry recovery shortly",
                )
            from app.services.db import get_dynamodb_resource

            record = await asyncio.to_thread(
                lambda: (
                    get_dynamodb_resource()
                    .Table("Sessions")
                    .get_item(
                        Key={"session_id": slot["session_id"]}, ConsistentRead=True
                    )
                    .get("Item")
                )
            )
            if not record:
                raise HTTPException(
                    409,
                    "Saved Real book is missing; recovery is required and its slot remains occupied",
                )
            if (
                record.get("user_id") != user_id
                or execution_broker.name(record.get("execution_broker")) != chosen
                or record.get("broker_account_id") != account
            ):
                raise HTTPException(
                    409,
                    "Saved Real account identity differs; restore the original account",
                )
            if (
                record["symbol"] != req.symbol
                or record["instrument_type"] != req.instrument_type
                or record["date"] != req.date
            ):
                raise HTTPException(
                    409,
                    "Restore and close the outstanding Real book before changing its context",
                )
            if record.get("real_verified_closed"):
                raise HTTPException(
                    409,
                    "Book completion needs verification; recover closure before starting again",
                )
        if record and record.get("real_funding_period"):
            from app.services import swing_funding_store as funding

            funded = await asyncio.to_thread(
                funding.owned_participant,
                user_id,
                chosen,
                account,
                "intraday",
                record["session_id"],
            )
            if funded["period_id"] != record["real_funding_period"]:
                raise HTTPException(
                    409,
                    "Saved Real funding period differs; recovery is required without resetting capital",
                )
        if not slot:
            from app.services import swing_accounting as rules
            from app.services import swing_funding_store as funding

            existing_funds = await asyncio.to_thread(
                funding.read, user_id, chosen, account
            )
            if existing_funds and existing_funds.get("state") == "active":
                participant = existing_funds["participants"].get("intraday")
                if participant and participant.get("active"):
                    raise HTTPException(
                        409,
                        "An outstanding funded Day book needs ownership recovery before starting another",
                    )
                try:
                    if "intraday" not in existing_funds["funding"]["modes"]:
                        rules.allocate(
                            existing_funds["funding"], "intraday", req.allocation_pct
                        )
                    else:
                        amount = rules.money(
                            existing_funds["funding"]["allocation_reference"]
                            * req.allocation_pct
                        )
                        rules.correct(
                            existing_funds["funding"],
                            "intraday",
                            amount,
                            0,
                            "New session allocation",
                            amount,
                        )
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from exc
        sid = slot["session_id"] if slot else str(uuid.uuid4())
        token = str(uuid.uuid4())
        preparation = (
            None
            if slot
            else {
                **req.model_dump(mode="json"),
                "session_id": sid,
                "user_id": user_id,
                "execution_broker": chosen,
                "broker_account_id": account,
                "record_type": "real_preparation",
                "state": "starting",
                "trading_style": "intraday",
            }
        )
        claim = await asyncio.to_thread(
            _claim, user_id, token, sid, chosen, account, record=preparation
        )
        context_token = _context.set(claim)
        recovery_token = _recovery.set(
            record
            if record and record.get("record_type") != "real_preparation"
            else None
        )

        async def renew_preparation():
            while True:
                await asyncio.sleep(10)
                try:
                    await asyncio.to_thread(
                        slots.update, chosen, account, "intraday", user_id, sid, token
                    )
                    live = simulation.get_session(sid)
                    if live and getattr(live, "real_claim_token", None) == token:
                        live.real_engine_valid_until = time.monotonic() + 40
                except Exception:  # noqa: BLE001 - lease failures must preserve the outstanding book
                    return

        preparing = asyncio.create_task(renew_preparation())
        try:
            response = await create()
            if response.session_id != sid:
                raise RuntimeError("Real startup changed its reserved book identity")
            session = simulation.get_session(sid)
            await asyncio.to_thread(
                _finish,
                user_id,
                token,
                sid,
                chosen,
                account,
                closing=bool(session and session.real_closing),
            )
            if session:
                session.real_active_claim = True
            if session and session.real_closing:
                from app.services.real_close import close

                await close(session)
            return response
        finally:
            # An exception never releases a potentially submitted book. Its saved
            # preparation/session identity allows retry after the engine expires.
            preparing.cancel()
            await asyncio.gather(preparing, return_exceptions=True)
            _context.reset(context_token)
            _recovery.reset(recovery_token)


def recovery_record():
    return _recovery.get()


async def bind_prepared(session):
    claim = _context.get()
    if claim is None:
        return
    task = getattr(session, "real_engine_task", None)
    if (
        task
        and not task.done()
        and getattr(session, "real_claim_token", None) == claim["operation_id"]
    ):
        return
    if (
        session.session_id != claim["session_id"]
        or session.broker_account_id != claim["account"]
    ):
        raise RuntimeError("Prepared Real book identity changed")
    await asyncio.to_thread(
        _finish,
        session.user_id,
        claim["operation_id"],
        session.session_id,
        claim["broker"],
        claim["account"],
        closing=session.real_closing,
    )
    session.real_claim_token = claim["operation_id"]
    session.real_active_claim = True
    session.real_engine_lease_required = True
    session.real_engine_valid_until = time.monotonic() + 40

    if isinstance(getattr(session, "real_funding_period", None), str) and session.real_funding_period:
        from app.services.real_funding import mark_pending

        await asyncio.to_thread(mark_pending, session)

    async def renew():
        while session.state.value != "ended":
            await asyncio.sleep(10)
            if session.state.value == "ended":
                return
            try:
                await asyncio.to_thread(
                    slots.update,
                    claim["broker"],
                    claim["account"],
                    "intraday",
                    session.user_id,
                    session.session_id,
                    claim["operation_id"],
                )
                session.real_engine_valid_until = time.monotonic() + 40
            except Exception:  # noqa: BLE001 - lease failures must preserve the outstanding book
                if time.monotonic() >= session.real_engine_valid_until:
                    import json

                    from app.services import simulation

                    session.queue.put_nowait(
                        json.dumps(
                            {
                                "type": "real_session_status",
                                "session_id": session.session_id,
                                "state": "recovery_required",
                                "message": "Real engine ownership expired; reconnect to recover this book.",
                            }
                        )
                    )
                    simulation.stop_session(session, preserve_trading_state=True)
                    return

    session.real_engine_task = asyncio.create_task(renew())


async def restore_for_close(record, user_id):
    """Recover the original book for explicit closure, including previous days."""
    from app.services import execution_broker, simulation

    if record.get("user_id") != user_id:
        raise HTTPException(404, "Real session not found")
    if record.get("real_verified_closed"):
        return await asyncio.to_thread(
            simulation.rebuild_session_from_db, record, user_id, read_only=True
        )
    sid = record["session_id"]
    chosen = execution_broker.name(record.get("execution_broker"))
    account = record.get("broker_account_id")
    if not isinstance(account, str) or not account:
        raise HTTPException(
            409,
            "Saved Real account identity is missing; verify its original account before recovery or closure",
        )
    lock = _locks.setdefault((chosen, account), asyncio.Lock())
    async with lock:
        runtime = simulation.get_session(sid)
        if runtime and runtime.state != simulation.SimulationState.ENDED:
            return runtime
        slot = await asyncio.to_thread(slots.read, chosen, account, "intraday")
        if not slot or slot["owner_user_id"] != user_id or slot["session_id"] != sid:
            raise HTTPException(
                409, "This saved session is not the outstanding Real book"
            )
        broker = execution_broker.get_service(chosen)
        actual = await asyncio.to_thread(broker.account_identity)
        if account != actual:
            raise HTTPException(
                409,
                "Restore the original broker account credentials before closing this book",
            )
        token = str(uuid.uuid4())
        claim = await asyncio.to_thread(_claim, user_id, token, sid, chosen, account)
        session = await asyncio.to_thread(
            simulation.rebuild_session_from_db, record, user_id, read_only=True
        )
        session.state = simulation.SimulationState.RUNNING
        session.broker_account_id = account
        session.desktop_read_only = False
        session.real_recovery_pending = True
        simulation._sessions[sid] = session
        context_token = _context.set(claim)
        try:
            await bind_prepared(session)
        finally:
            _context.reset(context_token)
        return session


_ready = True
_startup_task = None


def startup():
    """One cutover scan, then bounded recovery of the live slot partition."""
    global _ready, _startup_task
    _ready = False
    _startup_task = asyncio.create_task(_recover_outstanding())


async def shutdown():
    global _startup_task, _ready
    if _startup_task:
        _startup_task.cancel()
        await asyncio.gather(_startup_task, return_exceptions=True)
        _startup_task = None
    _ready = True


def _adopt_legacy():
    import logging

    from boto3.dynamodb.conditions import Attr

    from app.services.db import get_dynamodb_resource

    logger = logging.getLogger(__name__)
    params = {
        "FilterExpression": (
            Attr("session_type").eq("real")
            & Attr("state").ne("ended")
            & (
                Attr("record_type").not_exists()
                | Attr("record_type").ne("real_preparation")
            )
        )
        | (
            Attr("record_type").eq("swing_portfolio")
            & Attr("mode").eq("real")
            & Attr("state").ne("ended")
        ),
        "ConsistentRead": True,
    }
    sessions = get_dynamodb_resource().Table("Sessions")
    while True:
        page = sessions.scan(**params)
        for record in page.get("Items", []):
            if record.get("broker_projection_id") == record["session_id"]:
                continue
            try:
                legacy = (
                    slots.table()
                    .get_item(
                        Key={"user_id": record["user_id"], "ledger_id": "real-active"},
                        ConsistentRead=True,
                    )
                    .get("Item", {})
                )
                linked = (
                    legacy.get("session_id") == record["session_id"]
                    and legacy.get("state") != "closed"
                )
                slots.adopt(
                    record["user_id"],
                    record,
                    token=legacy.get("operation_id") if linked else None,
                    engine_until=legacy.get("engine_until", 0) if linked else 0,
                )
            except HTTPException as exc:
                logger.warning(
                    "Real legacy recovery needs attention for %s: %s",
                    record["session_id"],
                    exc.detail,
                )
                # Conflicting legacy records remain blocked in their canonical slots.
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    # Old pointers also preserve books whose stopped engines persisted ENDED.
    params = {
        "FilterExpression": Attr("ledger_id").eq("real-active")
        & Attr("state").ne("closed"),
        "ConsistentRead": True,
    }
    while True:
        page = slots.table().scan(**params)
        for pointer in page.get("Items", []):
            sid = pointer.get("session_id")
            if not sid:
                continue  # Legacy unbound starts could not submit broker orders.
            record = sessions.get_item(
                Key={"session_id": sid}, ConsistentRead=True
            ).get("Item")
            if not record:
                raise RuntimeError(
                    "Outstanding legacy Real record is missing; startup needs recovery"
                )
            try:
                slots.adopt(
                    pointer["user_id"],
                    record,
                    token=pointer.get("operation_id"),
                    engine_until=pointer.get("engine_until", 0),
                )
            except HTTPException as exc:
                logger.warning(
                    "Real legacy pointer conflict for %s: %s", sid, exc.detail
                )
        if not page.get("LastEvaluatedKey"):
            return
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _outstanding():
    from boto3.dynamodb.conditions import Key

    rows, params = (
        [],
        {
            "KeyConditionExpression": Key("user_id").eq("real-session-slots"),
            "ConsistentRead": True,
        },
    )
    while True:
        page = slots.table().query(**params)
        rows.extend(
            row for row in page.get("Items", []) if row.get("state") != "closed"
        )
        if not page.get("LastEvaluatedKey"):
            return rows
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


async def _recover_outstanding():
    global _ready
    import logging

    from app.models.schemas import SimulationStartRequest
    from app.services import simulation
    from app.services.db import get_dynamodb_resource

    logger = logging.getLogger(__name__)
    while True:
        try:
            if not _ready:
                await asyncio.to_thread(_adopt_legacy)
                _ready = True
            for row in await asyncio.to_thread(_outstanding):
                if (
                    row.get("recovery_conflict")
                    or row.get("engine_until", 0) >= int(time.time())
                ):
                    continue
                session = simulation.get_session(row["session_id"])
                if session and session.state != simulation.SimulationState.ENDED:
                    continue
                try:
                    record = await asyncio.to_thread(
                        lambda row=row: (
                            get_dynamodb_resource()
                            .Table("Sessions")
                            .get_item(
                                Key={"session_id": row["session_id"]},
                                ConsistentRead=True,
                            )
                            .get("Item")
                        )
                    )
                    if not record or record.get("record_type") == "real_preparation":
                        continue  # Incomplete startup needs explicit retry/close, not new automatic entries.
                    if row["style"] == "swing":
                        from app.services.swing_portfolio_service import ensure
                        await ensure(row["owner_user_id"], row["session_id"])
                        continue
                    from app.services.real_trading_day import market_date

                    if (
                        record.get("real_closing")
                        or row["state"] == "closing"
                        or record["date"] != market_date()
                    ):
                        from app.services.real_close import close

                        restored = await restore_for_close(record, row["owner_user_id"])
                        # Previous-day recovery requests verification/closure, never replays entries.
                        await close(restored)
                    else:
                        from app.routers.simulation import start_with_paper_claim

                        fields = {
                            k: v
                            for k, v in record.items()
                            if k in SimulationStartRequest.model_fields
                        }
                        fields["execution_broker"] = row["broker"]
                        fields["session_type"] = "real"
                        fields["override"] = False
                        await start_with_paper_claim(
                            SimulationStartRequest.model_validate(fields),
                            row["owner_user_id"],
                            desktop_independent=bool(record.get("desktop_created")),
                        )
                except Exception as exc:  # noqa: BLE001 - provider/storage recovery remains pending
                    logger.warning(
                        "Real recovery remains pending for %s: %s",
                        row["session_id"],
                        type(exc).__name__,
                    )
        except Exception as exc:  # noqa: BLE001 - provider/storage recovery remains pending
            logger.warning(
                "Real startup/recovery remains pending: %s", type(exc).__name__
            )
        await asyncio.sleep(30)
