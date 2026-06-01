"""
Command evaluator — evaluates bar-close conditions per active AICommand.
Called by the BarCloseProcessor for each (hook, command) pair.
"""
import logging
from datetime import datetime, timezone
from typing import Any

from processors.base import BarCloseHook
from services import backend_client, llm_service
from guardrails import validator
from db import commands_store, decision_log_store
from observability.tracing import observe

logger = logging.getLogger("aihelper.services.command_evaluator")


@observe(name="evaluate_command")
async def evaluate(hook: BarCloseHook, command: dict[str, Any]) -> dict[str, Any]:
    """
    Evaluate one active AICommand against the current bar close.
    LLM decides should_trade; if yes → guardrail check → place order → log decision.
    No-ops (should_trade=False) produce no log entry.
    Returns a summary dict so LangFuse captures a meaningful output.
    """
    command_id = command.get("command_id", "")
    session_id = hook.session_id

    # Skip if the command targets a specific options leg but this hook is for a different stream.
    # e.g. a CE command must not fire on the Nifty or PE bar-close hook.
    command_right = command.get("right")  # "CE" | "PE" | None
    if command_right and command_right != hook.right:
        logger.debug(
            "evaluate: skipping command=%s (right=%s) on hook right=%s",
            command_id, command_right, hook.right,
        )
        return {"outcome": "skipped_wrong_stream", "command_id": command_id}

    logger.debug("evaluate: command=%s session=%s bars=%d", command_id, session_id, len(hook.bars))

    # Convert Pydantic models to plain dicts for JSON serialisation
    bars_dicts = [b.model_dump() for b in hook.bars]
    position_dict = hook.position.model_dump() if hook.position else None

    try:
        llm_result = await llm_service.evaluate_command(
            parsed_trigger=command.get("parsed_trigger", ""),
            parsed_price_expr=command.get("parsed_price_expr", "market"),
            order_type=command.get("order_type", "market"),
            quantity_type=command.get("quantity_type", "ratio_l"),
            quantity_value=command.get("quantity_value"),
            bars=bars_dicts,
            position=position_dict,
            command_text=command.get("command_text", ""),
        )
    except Exception:
        logger.exception("LLM evaluate_command failed for command %s", command_id)
        return {"outcome": "llm_error", "command_id": command_id}

    if not llm_result.get("should_trade"):
        logger.debug(
            "evaluate: no-op command=%s reason=%s",
            command_id, llm_result.get("reason", "")[:80],
        )
        return {
            "outcome": "no_trade",
            "command_id": command_id,
            "reason": llm_result.get("reason", ""),
        }

    # Build action object
    side = llm_result.get("side", "BUY").upper()
    if side not in ("BUY", "SELL"):
        side = "BUY"
    action: dict[str, Any] = {
        "side": side,
        "quantity_type": command.get("quantity_type", "ratio_l"),
        "quantity_value": command.get("quantity_value"),
        "price_type": command.get("order_type", "market"),
        "price_value": llm_result.get("computed_price"),
    }

    # Guardrail validation
    ok, rejection_reason = validator.validate_action(action, position_dict)
    now = datetime.now(timezone.utc).isoformat()
    reason_text = llm_result.get("reason", "")

    if not ok:
        logger.info("Guardrail blocked command=%s reason=%s", command_id, rejection_reason)
        _log_decision(
            session_id, now, command, hook.timestamp,
            reason_text, action, "rejected_guardrail",
        )
        return {
            "outcome": "rejected_guardrail",
            "command_id": command_id,
            "reason": rejection_reason,
        }

    # Place order via backend
    try:
        await backend_client.place_order(
            session_id=session_id,
            payload={
                "side": side,
                "order_type": command.get("order_type", "market"),
                "right": command.get("right"),
                "quantity_type": command.get("quantity_type", "ratio_l"),
                "quantity_value": command.get("quantity_value"),
                "computed_price": llm_result.get("computed_price"),
                "funds_ratios": hook.funds_ratios,
            },
        )
        action_result = "order_placed"
        logger.info(
            "Order placed: command=%s side=%s session=%s",
            command_id, side, session_id,
        )
    except Exception as exc:
        action_result = "backend_error"
        logger.warning("Backend order failed for command=%s: %s", command_id, exc)

    _log_decision(
        session_id, now, command, hook.timestamp,
        reason_text, action, action_result,
    )

    # Mark one-shot command as executed so it won't fire again
    if command.get("one_shot", True) and action_result == "order_placed":
        try:
            commands_store.mark_command_executed(command["user_id"], command_id)
        except Exception:
            logger.exception("Failed to mark command %s as executed", command_id)

    return {
        "outcome": action_result,
        "command_id": command_id,
        "side": side,
        "reason": reason_text,
        "computed_price": llm_result.get("computed_price"),
    }


def _log_decision(
    session_id: str,
    decision_ts: str,
    command: dict[str, Any],
    bar_time: str,
    reason: str,
    action: dict[str, Any],
    action_result: str,
) -> None:
    command_id = command.get("command_id", "")
    try:
        decision_log_store.write_decision({
            "session_id": session_id,
            "ts_command_id": f"{decision_ts}#{command_id}",
            "command_id": command_id,
            "command_text": command.get("command_text", ""),
            "bar_time": bar_time,
            "reason": reason,
            "action": action,
            "action_result": action_result,
            "timestamp": decision_ts,
        })
    except Exception:
        logger.exception("Failed to write decision log for command %s", command_id)
