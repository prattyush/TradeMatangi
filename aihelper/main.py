import logging
import logging.handlers
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config  # noqa: F401 — sets LangFuse/LiteLLM env vars on import
from config import LOG_DIR
from routers import chat, hook, decisions, strategies


def _configure_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / "aihelper.log"

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    fh = logging.handlers.TimedRotatingFileHandler(
        log_file, when="midnight", backupCount=30, encoding="utf-8", utc=False
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    root = logging.getLogger()
    if not any(isinstance(h, logging.handlers.TimedRotatingFileHandler) for h in root.handlers):
        root.addHandler(fh)

    for name in ("aihelper", "uvicorn", "uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).setLevel(logging.DEBUG)

    logging.getLogger(__name__).info("Logging initialised — file: %s", log_file)


_configure_logging()

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("aihelper starting up on port %s", config.AI_HELPER_PORT)
    yield
    logger.info("aihelper shutting down")


app = FastAPI(
    title="TradeMatangi AI Helper",
    description="LLM-powered AI assistant for trading — Phase XI",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(hook.router)
app.include_router(decisions.router)
app.include_router(strategies.router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "aihelper"}
