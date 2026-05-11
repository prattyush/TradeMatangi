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
    """Validate symbol and ensure data is cached before starting a session."""
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


@router.post("/start", response_model=SimulationStartResponse)
async def start_simulation(req: SimulationStartRequest):
    _ensure_session_data(req.symbol, req.date)
    session = sim_svc.create_session(
        symbol=req.symbol,
        date=req.date,
        start_time=req.start_time,
        speed=req.speed,
    )
    sim_svc.start_session(session)
    return SimulationStartResponse(
        session_id=session.session_id,
        symbol=session.symbol,
        date=session.date,
        start_time=session.start_time,
        speed=session.speed,
        session_capital=session.session_capital,
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
