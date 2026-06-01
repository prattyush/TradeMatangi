"""
Intent classifier — thin wrapper that calls llm_service.classify_intent().
Step 3 (command flow) will add field extraction logic here.
"""
import logging

from services.llm_service import classify_intent as _classify

logger = logging.getLogger("aihelper.services.intent_classifier")

VALID_INTENTS = {"command", "entry_command", "exit_command", "analysis", "question", "hotword", "list_commands", "cancel_commands"}


async def classify(message: str) -> tuple[str, float]:
    """
    Returns (intent, confidence).
    Falls back to "question" intent on LLM error.
    """
    try:
        result = await _classify(message)
        intent = result.get("intent", "question")
        confidence = float(result.get("confidence", 0.0))
        if intent not in VALID_INTENTS:
            logger.warning("Unknown intent '%s' from LLM — defaulting to 'question'", intent)
            intent = "question"
        return intent, confidence
    except Exception:
        logger.exception("Intent classification failed — defaulting to 'question'")
        return "question", 0.0
