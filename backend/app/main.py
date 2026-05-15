from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import data, simulation, trading, stream, orders, wallet, auth, analysis, strategies


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.user_service import seed_user
    seed_user()
    yield


app = FastAPI(
    title="TradeMatangi Backend",
    description="Simulated trading platform API — Phase III",
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(data.router)
app.include_router(simulation.router)
app.include_router(trading.router)
app.include_router(stream.router)
app.include_router(orders.router)
app.include_router(wallet.router)
app.include_router(analysis.router)
app.include_router(strategies.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
