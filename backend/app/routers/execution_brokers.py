"""Broker-neutral authenticated account and Real lifecycle facade."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import require_real_trading_access
from app.services import execution_broker, real_broker_state, real_close, simulation
from app.services.real_recovery import CloseRequest

router = APIRouter(prefix="/api/brokers", tags=["brokers"])


def owned(session_id, user_id):
    session = simulation.get_session(session_id)
    if not session or session.user_id != user_id or session.session_type != "real":
        raise HTTPException(404, "Real session not found")
    return session


async def saved_real_record(session_id, user_id):
    from app.services.db import get_dynamodb_resource

    record = await asyncio.to_thread(
        lambda: (
            get_dynamodb_resource()
            .Table("Sessions")
            .get_item(Key={"session_id": session_id}, ConsistentRead=True)
            .get("Item")
        )
    )
    if not record or record.get("session_type") != "real":
        return None
    if record.get("user_id") != user_id:
        raise HTTPException(404, "Real session not found")
    require_real_trading_access(user_id)
    return record


async def status_for(user_id):
    from app.services.user_settings_service import get_settings

    chosen = (await asyncio.to_thread(get_settings, user_id, strict=True))[
        "real_execution_broker"
    ]
    broker = execution_broker.get_service(chosen)
    authenticated = await asyncio.to_thread(broker.is_authenticated)
    from app.services import real_session_slots as slots
    from app.services import real_sessions

    active_slots = await asyncio.to_thread(real_sessions.active_all, user_id)
    sessions = []
    for row in active_slots:
        runtime = simulation.get_session(row["session_id"])
        item = {
            "session_id": row["session_id"],
            "broker": row["broker"],
            "trading_style": row["style"],
            "state": "recovery_required"
            if row.get("recovery_conflict") or row.get("unbound_account")
            else "closing"
            if row["state"] == "closing" or (runtime and runtime.real_closing)
            else "reconciling"
            if runtime and runtime.real_recovery_pending
            else "running"
            if runtime and runtime.state != simulation.SimulationState.ENDED
            else "reconnecting",
        }
        if row['style'] == 'swing' and not row.get('recovery_conflict') and not row.get('unbound_account'):
            import time

            from app.services import swing_portfolio_service, swing_portfolio_store
            portfolio = await asyncio.to_thread(swing_portfolio_store.owned, user_id, row['session_id'])
            current = swing_portfolio_service._runtimes.get(row['session_id'])
            item['state'] = ('closing' if portfolio['state'] == 'closing' else
                             'reconciling' if current and (not current.real_ready or any(child.real_recovery_pending for child in current.contexts.values())) else
                             'running' if current and getattr(current, 'real_valid_until', 0) > time.monotonic() else 'reconnecting')
        from app.services import swing_funding_store as funding

        pool = (
            await asyncio.to_thread(
                funding.read, user_id, row["broker"], row["account"]
            )
            if isinstance(row.get("account"), str) and row["account"]
            else None
        )
        participant = (pool or {}).get("participants", {}).get(row["style"])
        if (
            participant
            and participant.get("owner_user_id") == user_id
            and participant["identity"] == row["session_id"]
        ):
            mode = pool["funding"]["modes"][row["style"]]
            from app.services.swing_accounting import mode_available
            local_reserved = sum(ticket['amount'] for ticket in pool['funding'].get('reservations', {}).values() if ticket['owner'] == 'local')
            verified_cash = (pool.get('funding_status') or {}).get('available')
            book_available = mode_available(pool['funding'], row['style'])
            if verified_cash is not None:
                book_available = min(book_available, verified_cash - local_reserved)
            item.update(
                available=max(0, book_available),
                capital=mode["capital"],
                allocation_pct=mode.get("funding_allocation", mode["capital"])
                / pool["funding"]["allocation_reference"],
                funding_status={key: value for key, value in (pool.get("funding_status") or {}).items() if key != "modes"},
            )
        sessions.append(item)
    account = (
        await asyncio.to_thread(broker.account_identity) if authenticated else None
    )
    availability = []
    if account:
        for style in slots.STYLES:
            row = await asyncio.to_thread(slots.read, chosen, account, style)
            availability.append(
                {
                    "trading_style": style,
                    "occupied": bool(row),
                    "owned_by_you": bool(row and row["owner_user_id"] == user_id),
                }
            )
    selected = next(
        (
            r
            for r in sessions
            if r["broker"] == chosen and r["trading_style"] == "intraday"
        ),
        None,
    )
    return {
        "broker": chosen,
        "authenticated": authenticated,
        "active_session_id": selected["session_id"] if selected else None,
        "account_id": account,
        "active_sessions": sessions,
        "availability": availability,
        "recovery_ready": real_sessions._ready,
    }


@router.get("/status")
async def status(user_id: str = Depends(require_real_trading_access)):
    return await status_for(user_id)


@router.post("/{session_id}/reconcile")
async def reconcile(
    session_id: str, user_id: str = Depends(require_real_trading_access)
):
    session = simulation.get_session(session_id)
    if session:
        session = owned(session_id, user_id)
    else:
        record = await saved_real_record(session_id, user_id)
        if not record:
            raise HTTPException(404, "Real session not found")
        session = await asyncio.to_thread(
            simulation.rebuild_session_from_db, record, user_id, read_only=True
        )
    from app.services import real_session_slots as slots
    slot = await asyncio.to_thread(slots.read, session.execution_broker, session.broker_account_id, session.trading_style)
    identity = session.portfolio_id if session.trading_style == 'swing' else session.session_id
    if not slot or slot['owner_user_id'] != user_id or slot['session_id'] != identity:
        raise HTTPException(409, 'This book is no longer active; view its archived history')
    from app.services import real_recovery
    from app.services.real_trading_day import market_date
    verification = await real_recovery.verify(session)
    if session.date == market_date() and simulation.get_session(session_id) is session:
        try:
            await real_broker_state.refresh(session, execution_broker.get_service(session))
        except (ValueError, real_broker_state.SnapshotPersistenceError) as exc:
            verification["reconciliation_error"] = str(exc)
    return verification


@router.get("/{session_id}/close-summary")
async def close_summary(
    session_id: str, user_id: str = Depends(require_real_trading_access)
):
    if simulation.get_session(session_id):
        return real_close.summary(owned(session_id, user_id))
    record = await saved_real_record(session_id, user_id)
    if not record:
        raise HTTPException(404, "Real session not found")
    return real_close.summary(
        await asyncio.to_thread(
            simulation.rebuild_session_from_db, record, user_id, read_only=True
        )
    )


@router.post("/{session_id}/stop")
async def stop(session_id: str, user_id: str = Depends(require_real_trading_access), req: CloseRequest | None = None):
    if simulation.get_session(session_id):
        return await real_close.close(owned(session_id, user_id), req.acknowledge_undated_submission_ids if req else None)
    record = await saved_real_record(session_id, user_id)
    if not record:
        raise HTTPException(404, "Real session not found")
    from app.services.real_sessions import restore_for_close

    return await real_close.close(await restore_for_close(record, user_id), req.acknowledge_undated_submission_ids if req else None)


from pydantic import BaseModel, Field


class AllocationRequest(BaseModel):
    fraction: float = Field(gt=0, le=1, allow_inf_nan=False)
    request_id: str = Field(min_length=1, max_length=100)


async def _change_allocation_locked(
    session_id: str,
    req: AllocationRequest,
    user_id: str = Depends(require_real_trading_access),
):
    from app.services import swing_funding_store as funding

    session = owned(session_id, user_id)
    if (
        getattr(session, "trading_style", "intraday") != "intraday"
        or session.real_closing
    ):
        raise HTTPException(
            409,
            "Use the portfolio allocation controls for Swing; closing books cannot change allocation",
        )
    if not getattr(session, "real_funding_period", None):
        raise HTTPException(
            409, "Recover this legacy book before editing its shared allocation"
        )
    from app.services import real_session_slots as slots

    def metadata(row):
        return [
            {
                "Update": {
                    "TableName": "Sessions",
                    "Key": slots.serialize({"session_id": session_id}),
                    "UpdateExpression": "SET session_capital = :capital",
                    "ConditionExpression": "user_id = :owner AND real_funding_period = :period AND #state <> :ended",
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": slots.serialize(
                        {
                            ":capital": row["funding"]["modes"]["intraday"]["capital"],
                            ":owner": user_id,
                            ":period": session.real_funding_period,
                            ":ended": "ended",
                        }
                    ),
                }
            },
            {
                "ConditionCheck": {
                    "TableName": "WalletLedgers",
                    "Key": slots.serialize(
                        slots.key(
                            session.execution_broker,
                            session.broker_account_id,
                            "intraday",
                        )
                    ),
                    "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND #state = :running",
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": slots.serialize(
                        {
                            ":owner": user_id,
                            ":sid": session_id,
                            ":token": session.real_claim_token,
                            ":running": "running",
                        }
                    ),
                }
            },
        ]

    try:
        row = await asyncio.to_thread(
            funding.change_allocation,
            user_id,
            session.execution_broker,
            session.broker_account_id,
            "intraday",
            session.session_id,
            req.fraction,
            req.request_id,
            extra_actions=metadata,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    session.session_capital = row["funding"]["modes"]["intraday"]["capital"]
    return await status_for(user_id)


@router.post("/{session_id}/allocation")
async def change_allocation(
    session_id: str,
    req: AllocationRequest,
    user_id: str = Depends(require_real_trading_access),
):
    from app.routers.orders import _session_edit_lock

    session = owned(session_id, user_id)
    async with _session_edit_lock(session):
        return await _change_allocation_locked(session_id, req, user_id)
