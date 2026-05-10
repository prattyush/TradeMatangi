from fastapi import APIRouter, HTTPException
from app.models.schemas import (
    SimulationStartRequest,
    SimulationStartResponse,
    SimulationControlRequest,
    SimulationStatusResponse,
    SimulationState,
)
from app.services import simulation as sim_svc

router = APIRouter(prefix="/api/simulation", tags=["simulation"])


@router.post("/start", response_model=SimulationStartResponse)
async def start_simulation(req: SimulationStartRequest):
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
