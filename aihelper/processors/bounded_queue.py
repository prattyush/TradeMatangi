"""
Default processor: per-session bounded asyncio queue (max depth 10).
Oldest item is dropped when the queue is full to avoid unbounded backlog
during fast simulation replay.
"""
import asyncio
import logging
from typing import Any

from processors.base import BarCloseHook, BarCloseProcessor

logger = logging.getLogger("aihelper.processors.bounded_queue")

MAX_DEPTH = 10


class BoundedQueueProcessor(BarCloseProcessor):
    def __init__(self):
        # session_id → asyncio.Queue
        self._queues: dict[str, asyncio.Queue] = {}
        # session_id → asyncio.Task (worker)
        self._workers: dict[str, asyncio.Task] = {}

    def _get_or_create_queue(self, session_id: str) -> asyncio.Queue:
        if session_id not in self._queues:
            self._queues[session_id] = asyncio.Queue(maxsize=MAX_DEPTH)
        return self._queues[session_id]

    async def submit(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        q = self._get_or_create_queue(hook.session_id)

        if q.full():
            # Drop oldest to make room
            try:
                dropped = q.get_nowait()
                logger.warning(
                    "Session %s queue full — dropped bar hook at %s",
                    hook.session_id,
                    dropped[0].timestamp,
                )
            except asyncio.QueueEmpty:
                pass

        await q.put((hook, commands))

        # Ensure a worker is running for this session
        task = self._workers.get(hook.session_id)
        if task is None or task.done():
            self._workers[hook.session_id] = asyncio.create_task(
                self._worker(hook.session_id, q)
            )

    async def _worker(self, session_id: str, q: asyncio.Queue) -> None:
        while True:
            try:
                hook, commands = await asyncio.wait_for(q.get(), timeout=30.0)
            except asyncio.TimeoutError:
                break  # no activity for 30s — let the worker exit
            try:
                await self._process(hook, commands)
            except Exception:
                logger.exception("Error processing bar hook for session %s", session_id)
            finally:
                q.task_done()

    async def _process(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        """
        Run command evaluator for each active command in parallel.
        Actual evaluation logic is injected via set_evaluator().
        """
        if self._evaluator is None:
            logger.debug("No evaluator set — skipping bar hook processing")
            return
        await asyncio.gather(
            *(self._evaluator(hook, cmd) for cmd in commands),
            return_exceptions=True,
        )

    def set_evaluator(self, evaluator) -> None:
        """Inject the async evaluator callable: (hook, command) -> None."""
        self._evaluator = evaluator

    def _evaluator(self, hook: BarCloseHook, command: dict) -> Any:
        raise NotImplementedError  # overwritten by set_evaluator

    def clear_session(self, session_id: str) -> None:
        """Drain queue and cancel worker for a stopped session."""
        q = self._queues.pop(session_id, None)
        if q:
            while not q.empty():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    break
        task = self._workers.pop(session_id, None)
        if task and not task.done():
            task.cancel()
        logger.info("Cleared queue for session %s", session_id)
