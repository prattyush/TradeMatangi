import logging
import logging.handlers
import sys
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import LOG_DIR
from app.routers import data, simulation, trading, stream, orders, wallet, auth, analysis, strategies, users, admin, kotak, guardrails, internal, pattern_logger


def _configure_logging() -> None:
    # pytest imports app.main to get the FastAPI app object; skip the file
    # handler so test log output never pollutes backend.log.
    if "pytest" in sys.modules:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / "backend.log"

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Daily rotating handler — one file per day, keep last 30 days.
    # Rotated files are named backend.log.YYYY-MM-DD (suffix added automatically).
    fh = logging.handlers.TimedRotatingFileHandler(
        log_file, when="midnight", backupCount=30, encoding="utf-8", utc=False
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    root = logging.getLogger()
    # Only add if not already configured (uvicorn may have set up handlers)
    if not any(isinstance(h, logging.handlers.TimedRotatingFileHandler) for h in root.handlers):
        root.addHandler(fh)

    # Ensure our app loggers show at DEBUG level
    for name in ("app", "uvicorn", "uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).setLevel(logging.DEBUG)

    logging.getLogger(__name__).info("Logging initialised — file: %s", log_file)


_configure_logging()

logger = logging.getLogger(__name__)


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
app.include_router(users.router)
app.include_router(admin.router)
app.include_router(kotak.router)
app.include_router(guardrails.router)
app.include_router(internal.router)
app.include_router(pattern_logger.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
