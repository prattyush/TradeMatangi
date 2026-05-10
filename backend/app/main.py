from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import data, simulation, trading, stream

app = FastAPI(
    title="TradeMatangi Backend",
    description="Simulated trading platform API — Phase I",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(data.router)
app.include_router(simulation.router)
app.include_router(trading.router)
app.include_router(stream.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
