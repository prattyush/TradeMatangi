"""
LangFuse Cloud tracing — @observe decorator wrapper.
Graceful no-op when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are absent.

Targets langfuse>=4.0.0. Includes a one-liner shim so LiteLLM 1.86.2 can
coexist: LiteLLM reads langfuse.version.__version__ which langfuse 4.x dropped.
"""
import logging
import os
import types
from functools import wraps

logger = logging.getLogger("aihelper.observability.tracing")

_enabled = bool(os.environ.get("LANGFUSE_SECRET_KEY") and os.environ.get("LANGFUSE_PUBLIC_KEY"))
tracing_enabled = _enabled  # exported for conditional callback wiring

if _enabled:
    try:
        import langfuse as _langfuse_pkg
        # LiteLLM 1.86.2 compat: reads langfuse.version.__version__ at callback init
        if not hasattr(_langfuse_pkg, "version"):
            _langfuse_pkg.version = types.SimpleNamespace(__version__=_langfuse_pkg.__version__)
        from langfuse import observe as _langfuse_observe
        logger.info("LangFuse tracing enabled (host: %s)", os.environ.get("LANGFUSE_HOST"))
    except ImportError:
        _langfuse_observe = None
        _enabled = False
        logger.warning("langfuse package not installed — tracing disabled")
else:
    _langfuse_observe = None
    logger.info("LangFuse keys absent — tracing disabled (no-op mode)")


def observe(name: str | None = None, as_type: str | None = None):
    """
    Decorator that wraps a function with LangFuse tracing.
    as_type="generation" marks the span as a generation observation.
    Falls back to identity decorator when LangFuse is not configured.
    """
    def decorator(fn):
        if _enabled and _langfuse_observe is not None:
            kwargs: dict = {}
            if name:
                kwargs["name"] = name
            if as_type:
                kwargs["as_type"] = as_type
            return _langfuse_observe(**kwargs)(fn) if kwargs else _langfuse_observe(fn)

        @wraps(fn)
        async def wrapper(*args, **kwargs):
            return await fn(*args, **kwargs)

        return wrapper

    return decorator
