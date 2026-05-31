import configparser
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))

_cfg = configparser.ConfigParser()
_cfg.read(str(DATA_DIR / "accesskeys.ini"))

_paths = _cfg["paths"] if _cfg.has_section("paths") else {}
LOG_DIR = Path(_paths.get("logs", str(DATA_DIR / "logs")))

AI_HELPER_PORT = int(os.getenv("AI_HELPER_PORT", "8701"))
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8700")

USE_DYNAMODB_LOCAL = os.getenv("USE_DYNAMODB_LOCAL", "true").lower() == "true"
DYNAMODB_LOCAL_ENDPOINT = os.getenv("DYNAMODB_LOCAL_ENDPOINT", "http://localhost:8000")
DYNAMODB_REGION = os.getenv("DYNAMODB_REGION", "us-east-1")

_langfuse = _cfg["langfusecloud"] if _cfg.has_section("langfusecloud") else {}
LANGFUSE_SECRET_KEY = _langfuse.get("secret_key", "")
LANGFUSE_PUBLIC_KEY = _langfuse.get("publickey", "")
LANGFUSE_BASE_URL = _langfuse.get("baseurl", "https://cloud.langfuse.com")

_llm = _cfg["llm"] if _cfg.has_section("llm") else {}
OPENAI_API_KEY = _llm.get("openai_api_key", "")
DEEPSEEK_API_KEY = _llm.get("deepseek_api_key", "")
OPENROUTER_API_KEY = _llm.get("open_router_api_key", "")
ANTHROPIC_API_KEY = _llm.get("claude_api_key", "")

_models = _cfg["llm-models"] if _cfg.has_section("llm-models") else {}
MODEL_INTENT_CLASSIFIER = _models.get("intent_classifier", "deepseek/deepseek-chat")
MODEL_COMMAND_EVALUATOR = _models.get("command_evaluator", "deepseek/deepseek-chat")
MODEL_ANALYSIS = _models.get("analysis", "openai/gpt-4o-mini")
MODEL_FALLBACK = _models.get("fallback", "openrouter/meta-llama/llama-3.1-8b-instruct:free")

# Processor type: bounded_queue | drop_if_busy | background_tasks
PROCESSOR_TYPE = os.getenv("PROCESSOR_TYPE", "bounded_queue")

MARKET_OPEN_IST = "09:15:00"
MARKET_CLOSE_IST = "15:30:00"

# Set LiteLLM / LangFuse env vars so their SDKs pick them up automatically
os.environ.setdefault("OPENAI_API_KEY", OPENAI_API_KEY)
os.environ.setdefault("DEEPSEEK_API_KEY", DEEPSEEK_API_KEY)
os.environ.setdefault("OPENROUTER_API_KEY", OPENROUTER_API_KEY)
os.environ.setdefault("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY)
os.environ.setdefault("LANGFUSE_SECRET_KEY", LANGFUSE_SECRET_KEY)
os.environ.setdefault("LANGFUSE_PUBLIC_KEY", LANGFUSE_PUBLIC_KEY)
os.environ.setdefault("LANGFUSE_HOST", LANGFUSE_BASE_URL)
