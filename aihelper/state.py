"""
Global mutable state for the aihelper process.
Using a module-level variable avoids circular imports between main.py and routers.
"""
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from processors.base import BarCloseProcessor

# Set by main.py lifespan on startup
processor: "BarCloseProcessor | None" = None
