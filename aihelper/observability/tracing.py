"""
LangFuse Cloud tracing — @observe decorator wrapper.
Graceful no-op when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are absent.
"""
import logging
import os
from functools import wraps

logger = logging.getLogger("aihelper.observability.tracing")

_enabled = bool(os.environ.get("LANGFUSE_SECRET_KEY") and os.environ.get("LANGFUSE_PUBLIC_KEY"))

if _enabled:
    try:
        from langfuse import observe as _langfuse_observe
        logger.info("LangFuse tracing enabled (host: %s)", os.environ.get("LANGFUSE_HOST"))
    except ImportError:
        _langfuse_observe = None
        _enabled = False
        logger.warning("langfuse package not installed — tracing disabled")
else:
    _langfuse_observe = None
    logger.info("LangFuse keys absent — tracing disabled (no-op mode)")


def observe(name: str | None = None):
    """
    Decorator that wraps a function with LangFuse tracing.
    Falls back to identity decorator when LangFuse is not configured.
    """
    def decorator(fn):
        if _enabled and _langfuse_observe is not None:
            return _langfuse_observe(name=name)(fn) if name else _langfuse_observe(fn)

        @wraps(fn)
        async def wrapper(*args, **kwargs):
            return await fn(*args, **kwargs)

        return wrapper

    return decorator
