"""Opt-in, aggregate diagnostics; never include order payloads or credentials."""
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


async def monitor_loop_lag():
    maximum = 0.0
    samples = 0
    while True:
        expected = time.monotonic() + 1
        await asyncio.sleep(1)
        maximum = max(maximum, time.monotonic() - expected)
        samples += 1
        if samples == 60:
            logger.info("trading_performance loop_lag_max_ms=%.1f", maximum * 1000)
            maximum = 0.0
            samples = 0
