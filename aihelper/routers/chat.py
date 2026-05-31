"""
POST /ai/chat — primary user-facing endpoint.
Step 3 (command flow) implements full intent → register/recall/list logic.
"""
import logging
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger("aihelper.routers.chat")

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    session_id: str
    user_id: str
    symbol: str | None = None
    strike_ce: int | None = None   # current CE strike from session state
    strike_pe: int | None = None   # current PE strike from session state


class ChatResponse(BaseModel):
    status: str
    message: str


@router.post("/ai/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Receives a user message, classifies intent, and dispatches to the appropriate handler.
    Step 3 will implement: intent classification → command registration | hotword recall | list | analysis.
    """
    logger.info("chat() called from session %s: %r", request.session_id, request.message[:80])
    return ChatResponse(
        status="pending",
        message="AI chat endpoint registered — full processing implemented in Step 3.",
    )
