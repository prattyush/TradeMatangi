"""Abstract BarCloseProcessor interface."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class OHLCBar(BaseModel):
    time: str
    open: float
    high: float
    low: float
    close: float


class PositionInfo(BaseModel):
    side: str | None = None
    qty: int = 0
    avg_entry: float = 0.0
    unrealized_pnl_pct: float = 0.0


class BarCloseHook(BaseModel):
    user_id: str
    session_id: str
    symbol: str
    right: str | None = None          # CE | PE | null (equity)
    bars: list[OHLCBar]               # last 15 bars for this stream, oldest → newest
    underlying_bars: list[OHLCBar] = []  # last 15 NIFTY bars when right=CE/PE; empty otherwise
    position: PositionInfo | None = None
    timestamp: str
    session_type: str | None = None   # "sim" | "stepwise" | "paper" | "real"; None treated as sim
    funds_ratios: dict[str, float] = {"ratio_l": 0.03, "ratio_m": 0.06, "ratio_h": 0.12}


class BarCloseProcessor(ABC):
    @abstractmethod
    async def submit(self, hook: BarCloseHook, commands: list[dict[str, Any]]) -> None:
        """
        Enqueue or process a bar-close event.
        hook: the bar-close payload from backend
        commands: active AICommand items from DynamoDB for this session
        """
        ...
