"""
Alt processor: discard bar-close hook if an LLM call is already in-flight for the session.
Best for fast simulation replay where missing a bar is acceptable.
"""
import asyncio
import logging
from typing import Any, Callable

from processors.base import BarCloseHook, BarCloseProcessor

logger = logging.getLogger("aihelper.processors.drop_if_busy")


class DropIfBusyProcessor(BarCloseProcessor):
    def __init__(self):
        self._in_flight: set[str] = set()
        self._eval_fn: Callable | None = None

    def set_evaluator(self, evaluator: Callable) -> None:
        self._eval_fn = evaluator

    async def submit(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        if hook.session_id in self._in_flight:
            logger.debug(
                "Session %s busy — dropping bar hook at %s", hook.session_id, hook.timestamp
            )
            return
        self._in_flight.add(hook.session_id)
        asyncio.create_task(self._process(hook, commands))

    async def _process(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        try:
            if self._eval_fn is None:
                return
            await asyncio.gather(
                *(self._eval_fn(hook, cmd) for cmd in commands),
                return_exceptions=True,
            )
        except Exception:
            logger.exception("Error processing bar hook for session %s", hook.session_id)
        finally:
            self._in_flight.discard(hook.session_id)

    def clear_session(self, session_id: str) -> None:
        self._in_flight.discard(session_id)
