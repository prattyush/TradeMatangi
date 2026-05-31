"""
Command evaluator — evaluates bar-close conditions per active AICommand.
Full implementation in Step 4 (trade execution).
Step 1 stub: defines the interface and wires up the processor.
"""
import logging
from typing import Any

from processors.base import BarCloseHook

logger = logging.getLogger("aihelper.services.command_evaluator")


async def evaluate(hook: BarCloseHook, command: dict[str, Any]) -> None:
    """
    Evaluate one active AICommand against the current bar close.
    Placeholder — Step 4 implements LLM call + order placement + decision log.
    """
    logger.debug(
        "evaluate() called for command %s (session %s) — not yet implemented (Step 4)",
        command.get("command_id"),
        hook.session_id,
    )
