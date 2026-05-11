from fastapi import APIRouter, HTTPException
from app.models.schemas import (
    SimulationStartRequest,
    SimulationStartResponse,
    SimulationControlRequest,
    SimulationStatusResponse,
    SimulationState,
)
from app.services import simulation as sim_svc
from app.config import SUPPORTED_SYMBOLS

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


def _ensure_session_data(symbol: str, date: str) -> None:
    """Validate symbol and ensure equity data is cached before starting a session."""
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")
    try:
        from app.services.broker_service import (
            fetch_historical, BreezeTokenError, BreezeSymbolError,
        )
        fetch_historical(symbol, date)
    except HTTPException:
        raise
    except Exception as exc:
        from app.services.broker_service import BreezeTokenError, BreezeSymbolError
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
    try:
        from app.services.options_service import fetch_options_historical
        from app.services.broker_service import BreezeTokenError
        fetch_options_historical(symbol, date, strike, expiry, right)
    except HTTPException:
        raise
    except Exception as exc:
        from app.services.broker_service import BreezeTokenError
        if isinstance(exc, BreezeTokenError):
            raise HTTPException(status_code=503, detail=str(exc))
        if isinstance(exc, RuntimeError):
            raise HTTPException(status_code=404, detail=str(exc))
        raise HTTPException(status_code=500, detail=f"Options data fetch failed: {exc}")


@router.post("/start", response_model=SimulationStartResponse)
async def start_simulation(req: SimulationStartRequest):
    if req.instrument_type == "options":
        if req.strike is None or req.expiry is None:
            raise HTTPException(
                status_code=400,
                detail="strike and expiry are required for options sessions",
            )
        if req.right is not None and req.right.upper() not in ("CE", "PE"):
            raise HTTPException(status_code=400, detail="right must be 'CE', 'PE', or null (dual-stream)")
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
        _ensure_session_data(req.symbol, req.date)
    else:
        raise HTTPException(status_code=400, detail="instrument_type must be 'equity' or 'options'")

    session = sim_svc.create_session(
        symbol=req.symbol,
        date=req.date,
        start_time=req.start_time,
        speed=req.speed,
        instrument_type=req.instrument_type,
        strike=req.strike,
        expiry=req.expiry,
        right=req.right,
        strike_ce=req.strike_ce,
        strike_pe=req.strike_pe,
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
