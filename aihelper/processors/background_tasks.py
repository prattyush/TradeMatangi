"""
Alt processor: asyncio.create_task per hook — no dropping.
Best for low-frequency sessions (paper trading with few active commands).
"""
import asyncio
import logging
from typing import Any, Callable

from processors.base import BarCloseHook, BarCloseProcessor

logger = logging.getLogger("aihelper.processors.background_tasks")


class BackgroundTasksProcessor(BarCloseProcessor):
    def __init__(self):
        self._eval_fn: Callable | None = None

    def set_evaluator(self, evaluator: Callable) -> None:
        self._eval_fn = evaluator

    async def submit(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        asyncio.create_task(self._process(hook, commands))

    async def _process(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        if self._eval_fn is None:
            return
        try:
            await asyncio.gather(
                *(self._eval_fn(hook, cmd) for cmd in commands),
                return_exceptions=True,
            )
        except Exception:
            logger.exception("Error processing bar hook for session %s", hook.session_id)

    def clear_session(self, session_id: str) -> None:
        pass  # no per-session state to clean up
