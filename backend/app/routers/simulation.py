import asyncio
import logging
from typing import Callable
from fastapi import APIRouter, Depends, HTTPException
from app.models.schemas import (
    SimulationStartRequest,
    SimulationStartResponse,
    SimulationControlRequest,
    SimulationStatusResponse,
    SimulationState,
    UpdatePaneStrikeRequest,
)
from app.services import simulation as sim_svc
from app.config import SUPPORTED_SYMBOLS
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


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
    is_paper = (req.session_type == "paper")
    is_real = (req.session_type == "real")

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
        session_type=req.session_type,
    )
    sim_svc.start_session(session)
    return SimulationStartResponse(
        session_id=session.session_id,
        symbol=session.symbol,
        date=session.date,
        start_time=session.start_time,
        speed=session.speed,
        session_capital=session.session_capital,
        instrument_type=session.instrument_type,
        strike=session.strike,
        expiry=session.expiry,
        right=session.right,
        strike_ce=session.strike_ce,
        strike_pe=session.strike_pe,
        brokerage_per_order=session.brokerage_per_order,
        session_type=session.session_type,
    )


@router.post("/pause")
async def pause_simulation(req: SimulationControlRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    sim_svc.pause_session(session)
    return {"status": session.state}


@router.post("/resume")
async def resume_simulation(req: SimulationControlRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
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
async def stop_simulation(req: SimulationControlRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        return {"status": "stopped"}
    sim_svc.stop_session(session)
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
