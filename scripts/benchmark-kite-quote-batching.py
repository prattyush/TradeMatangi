"""Synthetic callback/diagnostic cost check; never connects to a broker.

Run with the project's Python environment. The deterministic scheduler simulates
burst ingress and blocked-loop recovery, not live network or broker latency.
"""
import json
from pathlib import Path
import statistics
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import kite_service, performance_diagnostics as diagnostics
from app.services.kite_service import KiteBroadcaster


class OwnerLoop:
    def __init__(self):
        self.ready = []
        self.timers = []
        self.callbacks = 0
        self.candle_delays = []

    def is_closed(self):
        return False

    def call_soon_threadsafe(self, function, *args):
        self.ready.append((function, args, time.perf_counter()))
        self.callbacks += 1

    def call_later(self, delay, function, *args):
        assert delay == .1
        self.timers.append((function, args))

    def drain(self):
        callbacks, self.ready = self.ready, []
        for function, args, queued in callbacks:
            if function.__name__ == "_safe_put":
                self.candle_delays.append((time.perf_counter() - queued) * 1000)
            function(*args)
        callbacks, self.timers = self.timers, []
        for function, args in callbacks:
            function(*args)


class QuoteCache:
    def update_quote(self, value):
        self.latest = value

    def put_nowait(self, value):
        pass


def percentile95(values):
    return sorted(values)[int(.95 * (len(values) - 1))]


ROWS = [dict(instrument_token=token, last_price=100 + index % 17)
        for index in range(100) for token in range(1, 4)]


def run(enabled):
    diagnostics.ENABLED = enabled
    broadcaster = KiteBroadcaster()
    broadcaster._ticker = object()
    loop = OwnerLoop()
    for token in range(1, 4):
        broadcaster._token_sessions[token]["shared"] = (QuoteCache(), None, loop)
    durations = []
    started = time.process_time()
    with patch.object(kite_service._time, "time", return_value=1000.) as wall:
        for frame in range(500):
            wall.return_value = 1000. + frame // 50
            broadcaster._on_ticks(broadcaster._ticker, ROWS)
            if frame % 50 == 49:
                drain_start = time.perf_counter()
                loop.drain()
                durations.append((time.perf_counter() - drain_start) * 1000)
    return (time.process_time() - started, loop.callbacks,
            percentile95(durations), percentile95(loop.candle_delays))


def main():
    run(False)
    run(True)
    off, on = [], []
    for iteration in range(9):
        # Alternate order to reduce warm-up and scheduling bias.
        for enabled in ([False, True] if iteration % 2 else [True, False]):
            (on if enabled else off).append(run(enabled))
    cpu_off = statistics.median(row[0] for row in off)
    cpu_on = statistics.median(row[0] for row in on)
    result = dict(
        ticks_per_run=150000, batches=500, quote_drains=10,
        scheduled_callbacks=off[0][1], unbatched_quote_callbacks=150000,
        scheduled_quote_callbacks=10, scheduled_candle_callbacks=27,
        cpu_off_s=cpu_off, cpu_on_s=cpu_on,
        overhead_pct=100 * (cpu_on / cpu_off - 1),
        drain_p95_off_ms=statistics.median(row[2] for row in off),
        drain_p95_on_ms=statistics.median(row[2] for row in on),
        candle_callback_p95_off_ms=statistics.median(row[3] for row in off),
        candle_callback_p95_on_ms=statistics.median(row[3] for row in on),
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
