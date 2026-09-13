import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.models.schemas import (
    SimulationStartRequest,
    SimulationStartResponse,
    SimulationControlRequest,
    SimulationStatusResponse,
    SimulationState,
    UpdatePaneStrikeRequest,
    SessionGroupResponse,
    SessionGroupMember,
    RenameSessionGroupMemberRequest,
)
from app.services import simulation as sim_svc
from app.config import SUPPORTED_SYMBOLS
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


def _session_response(session, group=None) -> SimulationStartResponse:
    group = group or (session.group_id and __import__("app.services.session_group_service", fromlist=["get_group"]).get_group(session.group_id, session.user_id))
    return SimulationStartResponse(
        session_id=session.session_id, symbol=session.symbol, date=session.date,
        start_time=session.start_time, speed=session.speed, session_capital=session.session_capital,
        instrument_type=session.instrument_type, strike=session.strike, expiry=session.expiry,
        right=session.right, strike_ce=session.strike_ce, strike_pe=session.strike_pe,
        brokerage_per_order=session.brokerage_per_order, session_type=session.session_type,
        state=session.state, stepwise=session.stepwise,
        total_bars=session.total_bars if session.stepwise else None,
        group_id=session.group_id, clock_family=group.get("clock_family") if group else None,
        group_state=group.get("state") if group else None,
        group_current_time=group.get("current_time") if group else None,
        session_alias=session.session_alias, wallet_ledger_id=session.wallet_ledger_id,
    )


def _group_response(group: dict) -> SessionGroupResponse:
    members = []
    for member in group.get("members", []):
        session = sim_svc.get_session(member["session_id"])
        members.append(SessionGroupMember(**member, state=session.state if session else None))
    return SessionGroupResponse(group_id=group["group_id"], date=group["date"],
        clock_family=group["clock_family"], state=group["state"], speed=group["speed"],
        current_time=group.get("current_time"), strategy_interval_secs=group.get("strategy_interval_secs"), members=members)


def _has_live_group_session(group: dict) -> bool:
    for session_id in group.get("member_session_ids", []):
        session = sim_svc.get_session(session_id)
        if session and session.state != sim_svc.SimulationState.ENDED:
            return True
    return False


def _active_group_with_live_sessions(group: dict | None) -> dict | None:
    if not group:
        return None
    if _has_live_group_session(group):
        return group
    try:
        from app.services import session_group_service as groups
        groups.update_clock(group, state="ended")
    except Exception:
        logger.exception("Could not end stale session group %s", group.get("group_id"))
    return None


def _delete_existing_context_sessions(user_id: str, date: str, session_type: str, symbol: str, instrument_type: str) -> None:
    from app.services.session_cleanup_service import delete_session_cascade
    all_sessions = sim_svc.find_all_sessions_by_context(
        user_id, symbol, date, session_type, instrument_type
    )
    logger.info("start_simulation: override requested - cascade deleting %d session(s)", len(all_sessions))
    for record in all_sessions:
        sid = record["session_id"]
        active = sim_svc.get_session(sid)
        if active:
            sim_svc.stop_session(active)
        try:
            delete_session_cascade(sid, user_id, date)
        except Exception:
            logger.exception("start_simulation: failed to cascade delete session %s", sid)


def _normalise_option_contract_request(req: SimulationStartRequest) -> None:
    """Defend against stale client option metadata after symbol/date switches."""
    if req.instrument_type != "options" or req.expiry is None:
        return
    try:
        from app.services import options_service
        expected_expiry = options_service.get_expiry_date(req.symbol, req.date)
        if req.expiry != expected_expiry:
            logger.warning(
                "start_simulation: correcting stale expiry for %s %s: %s -> %s",
                req.symbol, req.date, req.expiry, expected_expiry,
            )
            req.expiry = expected_expiry

        requested_strikes = [
            strike for strike in (req.strike, req.strike_ce, req.strike_pe)
            if strike is not None
        ]
        has_obvious_cross_symbol_strike = (
            (req.symbol == "BSESEN" and any(int(strike) < 50000 for strike in requested_strikes)) or
            (req.symbol == "NIFTY" and any(int(strike) > 50000 for strike in requested_strikes))
        )

        # Historical sim/stepwise sessions must have the selected symbol/date
        # cached before strike validation.  Otherwise a stale NIFTY strike can
        # slip into a newly-added SENSEX session when the cache miss makes
        # get_underlying_price_at() return None.
        if req.session_type not in ("paper", "real") or has_obvious_cross_symbol_strike:
            _ensure_session_data(req.symbol, req.date)

        start_time = req.start_time if len(req.start_time) == 8 else f"{req.start_time}:00"
        ts = int(datetime.strptime(f"{req.date} {start_time}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
        underlying = options_service.get_underlying_price_at(req.symbol, req.date, ts)
        if underlying is None or underlying <= 0:
            if has_obvious_cross_symbol_strike:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Could not validate option strikes for {req.symbol} on {req.date}. "
                        "Please retry after the underlying data loads."
                    ),
                )
            return
        atm = options_service.get_atm_strike(req.symbol, underlying)
        interval = options_service.STRIKE_INTERVALS.get(req.symbol, 5)
        max_distance = max(interval * 30, atm * 0.15)

        ce = req.strike_ce if req.strike_ce is not None else req.strike
        pe = req.strike_pe if req.strike_pe is not None else req.strike
        stale = has_obvious_cross_symbol_strike or any(abs(int(strike) - atm) > max_distance for strike in (req.strike, ce, pe) if strike is not None)
        if stale:
            logger.warning(
                "start_simulation: correcting stale option strikes for %s %s underlying=%.2f atm=%s strike=%s ce=%s pe=%s",
                req.symbol, req.date, underlying, atm, req.strike, req.strike_ce, req.strike_pe,
            )
            req.strike = atm
            req.strike_ce = atm
            req.strike_pe = atm
    except HTTPException:
        raise
    except Exception:
        logger.exception("start_simulation: option contract normalisation failed")


def _ensure_session_data(symbol: str, date: str) -> None:
    """Validate symbol and ensure equity data is cached before starting a session."""
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")
    logger.info("start_simulation: fetching equity data %s %s", symbol, date)
    try:
        from app.services.broker_service import (
            fetch_historical, BreezeTokenError, BreezeSymbolError,
        )
        fetch_historical(symbol, date)
        logger.info("start_simulation: equity data ready %s %s", symbol, date)
    except HTTPException:
        raise
    except Exception as exc:
        from app.services.broker_service import BreezeTokenError, BreezeSymbolError
        logger.error("start_simulation: equity data fetch failed %s %s — %s", symbol, date, exc)
        if isinstance(exc, BreezeTokenError):
            raise HTTPException(status_code=503, detail=str(exc))
        if isinstance(exc, BreezeSymbolError):
            raise HTTPException(status_code=400, detail=str(exc))
        if isinstance(exc, RuntimeError):
            raise HTTPException(status_code=404, detail=str(exc))
        raise HTTPException(status_code=500, detail=f"Data fetch failed: {exc}")


def _ensure_options_data(
    symbol: str, date: str, strike: int, expiry: str, right: str
) -> None:
    """Validate options params and ensure options data is cached."""
    logger.info("start_simulation: fetching options data %s %s %s %s %s", symbol, date, strike, expiry, right)
    try:
        from app.services.options_service import fetch_options_historical
        from app.services.broker_service import BreezeTokenError
        fetch_options_historical(symbol, date, strike, expiry, right)
        logger.info("start_simulation: options data ready %s %s %s %s %s", symbol, date, strike, expiry, right)
    except HTTPException:
        raise
    except Exception as exc:
        from app.services.broker_service import BreezeTokenError
        logger.error("start_simulation: options data fetch failed %s %s %s %s %s — %s", symbol, date, strike, expiry, right, exc)
        if isinstance(exc, BreezeTokenError):
            raise HTTPException(status_code=503, detail=str(exc))
        if isinstance(exc, RuntimeError):
            raise HTTPException(status_code=404, detail=str(exc))
        raise HTTPException(status_code=500, detail=f"Options data fetch failed: {exc}")


def _soft_ensure(fn: Callable[[], None]) -> None:
    """Run a data-fetch helper; log but swallow all errors (paper-mode best-effort caching)."""
    try:
        fn()
    except Exception as exc:
        logger.warning("paper mode: data pre-cache failed (non-fatal) — %s", exc)


@router.post("/start", response_model=SimulationStartResponse)
async def start_simulation(
    req: SimulationStartRequest,
    user_id: str = Depends(get_request_user_id),
):
    internal_session_type = req.session_type
    is_stepwise = (req.session_type == "stepwise")
    is_paper = (req.session_type == "paper")
    is_real = (req.session_type == "real")

    if is_stepwise and (is_paper or is_real):
        raise HTTPException(status_code=400, detail="Stepwise mode is only supported for historical simulation (session_type='stepwise')")

    # Resolve the session group before any date-sensitive work. Add-session
    # requests inherit the group's locked date/speed/clock, so using the form's
    # stale date here can cache or validate the wrong market data.
    from app.services import session_group_service as groups
    active_group = _active_group_with_live_sessions(groups.get_active_group(user_id))
    if req.group_id:
        group = groups.get_group(req.group_id, user_id)
        if not group:
            raise HTTPException(status_code=404, detail="Session group not found")
        if not _has_live_group_session(group):
            groups.update_clock(group, state="ended")
            raise HTTPException(status_code=410, detail="Session group has ended. Start a new session.")
        req.date = group["date"]
        if req.override:
            _delete_existing_context_sessions(user_id, req.date, internal_session_type, req.symbol, req.instrument_type)
            for member in list(group.get("members", [])):
                if (member.get("symbol") == req.symbol and
                    member.get("session_type") == internal_session_type and
                    member.get("instrument_type") == req.instrument_type):
                    groups.remove_member(group, member["session_id"])
            if group.get("state") == "ended":
                groups.update_clock(group, state="running")
        try:
            groups.validate_add(group, date=group["date"], session_type=internal_session_type, speed=req.speed,
                strategy_interval_secs=req.strategy_interval_secs, symbol=req.symbol, instrument_type=req.instrument_type)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    elif active_group:
        raise HTTPException(status_code=409, detail="You already have an active session group. Use Add Session to add a member.")
    else:
        group = groups.create_group(user_id, req.date, internal_session_type, req.speed, req.strategy_interval_secs)

    # Group fields are locked values, never values supplied by a later tab.
    req.date = group["date"]
    if group["clock_family"] == "sim":
        req.speed = float(group["speed"])
        if group.get("current_time"):
            from datetime import datetime, timezone
            req.start_time = datetime.fromtimestamp(int(group["current_time"]), tz=timezone.utc).strftime("%H:%M:%S")
    if group["clock_family"] == "stepwise":
        req.strategy_interval_secs = int(group["strategy_interval_secs"])

    _normalise_option_contract_request(req)

    if is_real:
        # Real trading: whitelist + Kotak auth + fund sync
        from app.services import real_trading_service
        from app.services.user_service import get_user_info
        info = get_user_info(user_id)
        is_admin = bool(info and info.get("is_admin"))
        if not is_admin and not real_trading_service.is_whitelisted_user(user_id):
            raise HTTPException(status_code=403, detail="Real trading access is not enabled for your account")
        from app.services.kotak_service import get_service as get_kotak, KotakError
        kotak_svc = get_kotak()
        if not kotak_svc.is_authenticated():
            raise HTTPException(status_code=401, detail="Kotak login required. Please authenticate via /api/kotak/login before starting a real session.")
        try:
            funds = kotak_svc.get_funds()
            from app.services import wallet_service
            wallet_service.reset(user_id, req.date, funds)
        except KotakError as exc:
            raise HTTPException(status_code=502, detail=f"Could not fetch Kotak funds: {exc}")

    # Paper and real sessions use best-effort data caching — Kite streams live ticks
    use_soft_ensure = is_paper or is_real

    if req.instrument_type == "options":
        if req.strike is None or req.expiry is None:
            raise HTTPException(
                status_code=400,
                detail="strike and expiry are required for options sessions",
            )
        if req.right is not None and req.right.upper() not in ("CE", "PE"):
            raise HTTPException(status_code=400, detail="right must be 'CE', 'PE', or null (dual-stream)")
        if use_soft_ensure:
            _soft_ensure(lambda: _ensure_session_data(req.symbol, req.date))
            ce_strike = req.strike_ce if req.strike_ce is not None else req.strike
            pe_strike = req.strike_pe if req.strike_pe is not None else req.strike
            if req.right:
                _soft_ensure(lambda: _ensure_options_data(req.symbol, req.date, ce_strike if req.right.upper() == "CE" else pe_strike, req.expiry, req.right))
            else:
                _soft_ensure(lambda: _ensure_options_data(req.symbol, req.date, ce_strike, req.expiry, "CE"))
                _soft_ensure(lambda: _ensure_options_data(req.symbol, req.date, pe_strike, req.expiry, "PE"))
        else:
            _ensure_session_data(req.symbol, req.date)  # always cache equity data too (for margin checks)
            # Dual-stream: cache CE at strike_ce, PE at strike_pe (fall back to strike for both)
            ce_strike = req.strike_ce if req.strike_ce is not None else req.strike
            pe_strike = req.strike_pe if req.strike_pe is not None else req.strike
            if req.right:
                strike_for_right = ce_strike if req.right.upper() == "CE" else pe_strike
                _ensure_options_data(req.symbol, req.date, strike_for_right, req.expiry, req.right)
            else:
                _ensure_options_data(req.symbol, req.date, ce_strike, req.expiry, "CE")
                _ensure_options_data(req.symbol, req.date, pe_strike, req.expiry, "PE")
    elif req.instrument_type == "equity":
        if SUPPORTED_SYMBOLS.get(req.symbol, {}).get("options_only"):
            raise HTTPException(
                status_code=400,
                detail=f"{req.symbol} is an index — only options sessions are supported",
            )
        if use_soft_ensure:
            _soft_ensure(lambda: _ensure_session_data(req.symbol, req.date))
        else:
            _ensure_session_data(req.symbol, req.date)
    else:
        raise HTTPException(status_code=400, detail="instrument_type must be 'equity' or 'options'")

    # Enforce one session per (user, symbol, date, type) per day.
    # For paper/real: resume the existing session so positions and trades remain visible
    # under the same session_id after a reconnect.
    # For sim: if the user restarts with new params (start_time, speed, OTM), stop the
    # old session and create a fresh one — the user wants a new practice run, not a resume.
    existing_record = sim_svc.find_session_by_context(
        user_id, req.symbol, req.date, internal_session_type, req.instrument_type
    )
    if existing_record:
        existing_session_id = existing_record["session_id"]
        active = sim_svc.get_session(existing_session_id)
        if req.override:
            _delete_existing_context_sessions(user_id, req.date, internal_session_type, req.symbol, req.instrument_type)
            existing_record = None
        # For sim and stepwise sessions: stop the old one and create fresh with new params
        elif internal_session_type in ("sim", "stepwise"):
            if active:
                logger.info("start_simulation: stopping existing sim session %s for restart", existing_session_id)
                sim_svc.stop_session(active)
            else:
                logger.info("start_simulation: reusing stale sim session record %s (preserved for trade history)", existing_session_id)
            # Fall through to create_session below
        elif active:
            # Paper/real: already running in memory — return it (idempotent start)
            logger.info("start_simulation: returning already-active session %s", existing_session_id)
            return _session_response(active, group)
        else:
            # Paper/real: session exists in DB but not in memory — rebuild and resume.
            # Forward the request's CE/PE strikes so the user can change OTM on each restart.
            logger.info("start_simulation: resuming session %s from DB", existing_session_id)
            req_ce = req.strike_ce if req.strike_ce is not None else req.strike
            req_pe = req.strike_pe if req.strike_pe is not None else req.strike
            session = sim_svc.rebuild_session_from_db(
                existing_record,
                user_id=user_id,
                strike_ce=req_ce,
                strike_pe=req_pe,
                brokerage_per_order=req.brokerage_per_order,
                strategy_interval_secs=req.strategy_interval_secs,
            )
            # For real trading: re-sync wallet from broker so balance reflects any trades
            # that happened at the broker while the session was down.
            if is_real:
                try:
                    from app.services.kotak_service import get_service as get_kotak, KotakError
                    funds = get_kotak().get_funds()
                    from app.services import wallet_service
                    wallet_service.reset(user_id, req.date, funds)
                    session.session_capital = funds
                    logger.info(
                        "start_simulation: real session resume — wallet synced from Kotak: %.2f",
                        funds,
                    )
                except Exception as exc:
                    logger.warning("start_simulation: Kotak wallet sync on resume failed: %s", exc)
            sim_svc.start_session(session)
            return _session_response(session, group)

    session = sim_svc.create_session(
        symbol=req.symbol,
        date=req.date,
        start_time=req.start_time,
        speed=req.speed,
        user_id=user_id,
        instrument_type=req.instrument_type,
        strike=req.strike,
        expiry=req.expiry,
        right=req.right,
        strike_ce=req.strike_ce,
        strike_pe=req.strike_pe,
        brokerage_per_order=req.brokerage_per_order,
        strategy_interval_secs=req.strategy_interval_secs,
        session_type=internal_session_type,
        stepwise=is_stepwise,
        group_id=group["group_id"],
        session_alias=req.session_alias,
        wallet_ledger_id=(f"paper:{group['group_id']}" if internal_session_type == "paper" else f"real:{req.date}" if internal_session_type == "real" else f"sim:{req.date}"),
    )
    groups.add_member(group, {"session_id": session.session_id, "symbol": session.symbol,
        "session_type": session.session_type, "instrument_type": session.instrument_type,
        "session_alias": session.session_alias})
    sim_svc.start_session(session)
    return _session_response(session, group)


@router.get("/check-existing")
async def check_existing_session(
    symbol: str,
    date: str,
    session_type: str,
    instrument_type: str = "equity",
    user_id: str = Depends(get_request_user_id),
):
    """Check if a previous session exists for the given combination. Returns the session record or null."""
    existing = sim_svc.find_session_by_context(user_id, symbol, date, session_type, instrument_type)
    if existing is None:
        return {"exists": False, "session": None}
    return {
        "exists": True,
        "session": {
            "session_id": existing.get("session_id"),
            "symbol": existing.get("symbol"),
            "date": existing.get("date"),
            "session_type": existing.get("session_type"),
            "instrument_type": existing.get("instrument_type"),
            "created_at": existing.get("created_at"),
        },
    }


@router.post("/pause")
async def pause_simulation(req: SimulationControlRequest, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != user_id:
        raise HTTPException(status_code=403, detail="Session does not belong to this user")
    if session.group_id:
        return await pause_group(session.group_id, user_id)
    sim_svc.pause_session(session)
    return {"status": session.state}


@router.post("/resume")
async def resume_simulation(req: SimulationControlRequest, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != user_id:
        raise HTTPException(status_code=403, detail="Session does not belong to this user")
    if session.group_id:
        return await resume_group(session.group_id, user_id)
    sim_svc.resume_session(session)
    return {"status": session.state}


@router.put("/{session_id}/update-pane-strike")
async def update_pane_strike(session_id: str, req: UpdatePaneStrikeRequest):
    """
    Update the CE or PE streaming strike for a running options session.
    Fetches and caches options data for the new strike before updating.
    Called when the user adds a new CE/PE pane mid-session.
    """
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.instrument_type != "options" or not session.expiry:
        raise HTTPException(status_code=400, detail="Session is not an options session")
    if req.right.upper() not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be CE or PE")

    # Run blocking data fetch in a thread pool so the event loop (and Phase 3 tick
    # processing) is not frozen while Breeze/parquet I/O happens.
    # Paper sessions use soft-ensure (swallow errors) — session is already live.
    # Sim sessions propagate errors — tick loop needs the parquet to exist.
    loop = asyncio.get_running_loop()
    if session.session_type in ("paper", "real"):
        await loop.run_in_executor(None, lambda: _soft_ensure(
            lambda: _ensure_options_data(
                session.symbol, session.date, req.strike, session.expiry, req.right.upper()
            )
        ))
    else:
        await loop.run_in_executor(None, lambda: _ensure_options_data(
            session.symbol, session.date, req.strike, session.expiry, req.right.upper()
        ))

    if req.right.upper() == "CE":
        session.strike_ce = req.strike
    else:
        session.strike_pe = req.strike

    # For paper/real sessions: re-subscribe KiteBroadcaster to the new strike's token
    if session.session_type in ("paper", "real"):
        try:
            from app.services import kite_service
            new_token = await loop.run_in_executor(
                None,
                lambda: kite_service.fetch_options_instrument_token(
                    session.symbol, session.expiry, req.strike, req.right.upper()
                ),
            )
            kite_service.get_broadcaster().update_session_right(
                session.session_id, req.right.upper(), new_token,
                session.paper_tick_queue, loop,
            )
        except Exception as exc:
            logger.warning(
                "update_pane_strike: Kite re-subscribe failed for session %s right=%s: %s",
                session_id, req.right.upper(), exc,
            )

    return {"session_id": session_id, "right": req.right.upper(), "strike": req.strike}


@router.post("/stop")
async def stop_simulation(req: SimulationControlRequest, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(req.session_id)
    if not session:
        return {"status": "stopped"}
    if session.user_id != user_id:
        raise HTTPException(status_code=403, detail="Session does not belong to this user")
    group_id = session.group_id
    sim_svc.stop_session(session)
    if group_id:
        from app.services import session_group_service as groups
        group = groups.get_group(group_id, user_id)
        if group:
            groups.remove_member(group, req.session_id)
    return {"status": "stopped"}


@router.get("/status", response_model=SimulationStatusResponse)
async def get_status(session_id: str):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return SimulationStatusResponse(
        session_id=session.session_id,
        state=session.state,
        current_time=session.current_time,
        speed=session.speed,
        symbol=session.symbol,
        date=session.date,
    )


@router.get("/active", response_model=SimulationStartResponse)
async def get_active_session(
    session_id: str,
    user_id: str = Depends(get_request_user_id),
):
    """Return attach metadata for an in-memory session without starting a new one."""
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.user_id != user_id:
        raise HTTPException(status_code=403, detail="Session does not belong to this user")
    if session.state == sim_svc.SimulationState.ENDED:
        raise HTTPException(status_code=410, detail="Session has ended")
    return _session_response(session)


@router.get("/groups/active", response_model=SessionGroupResponse | None)
async def get_active_group(user_id: str = Depends(get_request_user_id)):
    from app.services import session_group_service as groups
    group = _active_group_with_live_sessions(groups.get_active_group(user_id))
    return _group_response(group) if group else None


@router.patch("/groups/{group_id}/members/{session_id}", response_model=SessionGroupMember)
async def rename_group_member(group_id: str, session_id: str, req: RenameSessionGroupMemberRequest,
                              user_id: str = Depends(get_request_user_id)):
    from app.services import session_group_service as groups
    group = groups.get_group(group_id, user_id)
    if not group:
        raise HTTPException(status_code=404, detail="Session group not found")
    try:
        member = groups.rename_member(group, session_id, req.session_alias)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    session = sim_svc.get_session(session_id)
    if session:
        session.session_alias = member.get("session_alias")
        sim_svc._upsert_session_to_db(session)
    return SessionGroupMember(**member, state=session.state if session else None)


async def _control_group(group_id: str, user_id: str, action: str):
    from app.services import session_group_service as groups
    group = groups.get_group(group_id, user_id)
    if not group:
        raise HTTPException(status_code=404, detail="Session group not found")
    if group["clock_family"] == "live":
        raise HTTPException(status_code=400, detail="Live session groups cannot be paused")
    for session_id in group["member_session_ids"]:
        session = sim_svc.get_session(session_id)
        if session:
            (sim_svc.pause_session if action == "pause" else sim_svc.resume_session)(session)
    groups.update_clock(group, state="paused" if action == "pause" else "running")
    return _group_response(group)


@router.post("/groups/{group_id}/pause", response_model=SessionGroupResponse)
async def pause_group(group_id: str, user_id: str = Depends(get_request_user_id)):
    return await _control_group(group_id, user_id, "pause")


@router.post("/groups/{group_id}/resume", response_model=SessionGroupResponse)
async def resume_group(group_id: str, user_id: str = Depends(get_request_user_id)):
    return await _control_group(group_id, user_id, "resume")


@router.post("/groups/{group_id}/next-bar", response_model=SessionGroupResponse)
async def next_group_bar(group_id: str, user_id: str = Depends(get_request_user_id)):
    from app.services import session_group_service as groups
    group = groups.get_group(group_id, user_id)
    if not group:
        raise HTTPException(status_code=404, detail="Session group not found")
    if group["clock_family"] != "stepwise":
        raise HTTPException(status_code=400, detail="Next Bar is only available for Stepwise groups")
    for session_id in group["member_session_ids"]:
        session = sim_svc.get_session(session_id)
        if session:
            session.step_event.set()
    return _group_response(group)


class AICommandsActiveRequest(BaseModel):
    session_id: str


@router.post("/{session_id}/next-bar")
async def next_bar(session_id: str):
    """Advance a stepwise session by one bar. Sets the step_event to unpark the tick loop."""
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.stepwise:
        raise HTTPException(status_code=400, detail="Session is not in stepwise mode")
    if session.state == SimulationState.ENDED:
        raise HTTPException(status_code=400, detail="Session has ended")
    session.step_event.set()
    return {
        "session_id": session_id,
        "bar_index": session.current_bar_index,
        "total_bars": session.total_bars,
    }


@router.post("/ai-commands/active")
async def set_ai_commands_active(req: AICommandsActiveRequest):
    """
    Called by aihelper after registering an AI command (Step 3).
    Tells the backend to start firing bar-close hooks to aihelper for this session.
    """
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.ai_commands_active = True
    logger.info("AI commands active for session %s", req.session_id)
    return {"status": "ok", "session_id": req.session_id}
