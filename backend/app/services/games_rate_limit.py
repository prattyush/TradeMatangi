"""Small in-process per-user token bucket for the Games endpoints (Phase 25).

There is no shared limiter in the backend (the broker history modules pace broker calls, not users),
so Games carries its own. It is per process: with several workers the effective limit is
``workers x rate``, which is fine for a soft protection against a runaway client.
"""
from __future__ import annotations

import time
from collections.abc import Callable


class TokenBucket:
    def __init__(self, rate_per_second: float, burst: int, clock: Callable[[], float] = time.monotonic, max_users: int = 2000):
        self.rate = float(rate_per_second)
        self.burst = float(burst)
        self._clock = clock
        self._max_users = max_users
        self._state: dict[str, tuple[float, float]] = {}  # user -> (tokens, last_time)

    def allow(self, user_id: str, cost: float = 1.0) -> bool:
        now = self._clock()
        tokens, last = self._state.get(user_id, (self.burst, now))
        tokens = min(self.burst, tokens + (now - last) * self.rate)
        allowed = tokens >= cost
        if allowed:
            tokens -= cost
        if len(self._state) >= self._max_users and user_id not in self._state:
            # Drop the least recently used entry so a flood of ids cannot grow memory without bound.
            self._state.pop(min(self._state, key=lambda key: self._state[key][1]))
        self._state[user_id] = (tokens, now)
        return allowed

    def retry_after(self, user_id: str) -> float:
        tokens, _ = self._state.get(user_id, (self.burst, 0.0))
        return max(0.0, (1.0 - tokens) / self.rate) if self.rate > 0 else 1.0
