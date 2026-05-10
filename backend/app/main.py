from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import data, simulation, trading, stream, orders

app = FastAPI(
    title="TradeMatangi Backend",
    description="Simulated trading platform API — Phase II",
    version="0.2.0",
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
app.include_router(orders.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
