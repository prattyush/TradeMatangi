import logging
import logging.handlers
import sys
import os
import time
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import LOG_DIR
from app.routers import data, simulation, trading, stream, orders, wallet, auth, analysis, strategies, users, admin, kotak, breeze, guardrails, internal, pattern_logger, snapshots, chart_structures, labels, fine_structures, desktop, desktop_persistence, desktop_live, desktop_replay, desktop_trading, desktop_settings, performance, desktop_analysis


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
    from app.services.desktop_paper_eod import reconciliation_loop
    seed_user()
    paper_reconciler = asyncio.create_task(reconciliation_loop())
    from app.services.order_service import exit_reconciliation_loop
    exit_reconciler = asyncio.create_task(exit_reconciliation_loop())
    diagnostics = None
    if os.getenv("TRADING_PERFORMANCE_DIAGNOSTICS") == "1":
        from app.services.performance_diagnostics import monitor_loop_lag
        diagnostics = asyncio.create_task(monitor_loop_lag())
    try:
        yield
    finally:
        from app.services.protection_recovery import shutdown
        await shutdown()
        from app.services.real_trading_day import shutdown as shutdown_day_jobs
        await shutdown_day_jobs()
        if diagnostics:
            diagnostics.cancel()
            try:
                await diagnostics
            except asyncio.CancelledError:
                pass
        from app.services.market_data import get_hub
        get_hub().shutdown()
        from app.services.kotak_service import get_service as get_kotak
        await asyncio.to_thread(get_kotak().shutdown)
        exit_reconciler.cancel()
        try:
            await exit_reconciler
        except asyncio.CancelledError:
            pass
        paper_reconciler.cancel()
        try:
            await paper_reconciler
        except asyncio.CancelledError:
            pass


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
app.include_router(desktop.router)
app.include_router(desktop_persistence.router)
app.include_router(desktop_live.router)
app.include_router(desktop_replay.router)
app.include_router(desktop_trading.router)
app.include_router(desktop_settings.router)
app.include_router(data.router)
app.include_router(simulation.router)
app.include_router(trading.router)
app.include_router(stream.router)
app.include_router(orders.router)
app.include_router(wallet.router)
app.include_router(analysis.router)
app.include_router(desktop_analysis.router)
app.include_router(strategies.router)
app.include_router(users.router)
app.include_router(admin.router)
app.include_router(kotak.router)
app.include_router(breeze.router)
app.include_router(guardrails.router)
app.include_router(internal.router)
app.include_router(pattern_logger.router)
app.include_router(snapshots.router)
app.include_router(chart_structures.router)
app.include_router(labels.router)
app.include_router(fine_structures.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


if os.getenv("TRADING_PERFORMANCE_DIAGNOSTICS") == "1":
    @app.middleware("http")
    async def trading_request_timing(request, call_next):
        started = time.monotonic()
        try:
            return await call_next(request)
        finally:
            path = request.url.path
            if path.startswith(("/api/orders", "/api/snapshots", "/api/data")):
                logger.info("trading_performance method=%s route=%s duration_ms=%.1f",
                            request.method, path, (time.monotonic() - started) * 1000)

# Phase 20 read-only analytics boundary.
app.include_router(performance.router)
