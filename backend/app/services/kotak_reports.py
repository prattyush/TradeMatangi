"""Account-wide single-flight Kotak reports; no polling or order-operation lock."""
import asyncio
from dataclasses import dataclass, field
import logging
import math
import time

logger = logging.getLogger(__name__)
MIN_INTERVAL = 2.0


@dataclass
class Bundle:
    orders: list | None
    executions: list
    positions: list
    started: float
    revision: int


@dataclass
class Account:
    task: asyncio.Task | None = None
    bundle: Bundle | None = None
    revision: int = 0
    next_start: float = 0
    cooldown: float = 0
    failures: int = 0
    submission: asyncio.Lock = field(default_factory=asyncio.Lock)
    foreground: int = 0


_accounts = {}


def retry_delay(error):
    delay = 0
    while error is not None:
        headers = getattr(error, 'headers', None) or {}
        value = getattr(error, 'retry_after', None)
        if value is None and hasattr(headers, 'get'):
            value = headers.get('Retry-After', headers.get('retry-after', 0))
        try:
            seconds = float(value or 0)
            if math.isfinite(seconds):
                delay = max(delay, seconds)
        except (TypeError, ValueError):
            pass
        error = error.__cause__
    return delay


def state(broker):
    # Include the loop: tasks/locks never cross backend lifetimes or test loops.
    return _accounts.setdefault((asyncio.get_running_loop(), broker.account_identity(), getattr(broker, '_generation', 0)), Account())


def invalidate(broker):
    state(broker).revision += 1


async def fetch(broker, *, background=False, force=False, include_orders=True):
    account = state(broker)
    if account.task and not account.task.done():
        logger.debug('kotak_reports_join revision=%d', account.revision)
        result = await asyncio.shield(account.task)
        if include_orders and result.orders is None:
            return await fetch(broker, background=background)
        return result
    now = time.monotonic()
    cached = account.bundle
    fresh = not force and cached and cached.revision == account.revision and now - cached.started < MIN_INTERVAL
    if fresh and (not include_orders or cached.orders is not None):
        return cached

    async def run():
        while True:
            now = time.monotonic()
            wait = max(account.cooldown, account.next_start if background else 0) - now
            if wait > 0 or (background and account.foreground):
                await asyncio.sleep(min(max(wait, .05), .25))
                continue
            break
        started, revision = time.monotonic(), account.revision
        account.next_start = started + MIN_INTERVAL
        # Wait for all threads, even if one report fails. A canceled waiter must
        # not spawn a second bundle while a 30-second SDK request is still alive.
        reuse = cached if (fresh and cached.revision == account.revision
                           and time.monotonic() - cached.started < MIN_INTERVAL) else None
        methods = [('executions', broker.get_trade_history), ('positions', broker.get_positions)]
        if include_orders:
            methods.insert(0, ('orders', broker.get_order_history))
        needed = [(name, method) for name, method in methods if reuse is None or getattr(reuse, name) is None]
        results = await asyncio.gather(*(asyncio.to_thread(method) for _, method in needed), return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            account.failures += 1
            delay = (2, 5, 10)[min(account.failures - 1, 2)]
            retry_after = max((retry_delay(e) for e in errors), default=0)
            account.cooldown = time.monotonic() + max(delay, retry_after)
            logger.warning('kotak_reports_failed requests=%d backoff=%s', len(needed), max(delay, retry_after))
            raise errors[0]
        if any(not isinstance(r, list) for r in results):
            raise ValueError('Kotak report bundle contains malformed records')
        account.failures = 0
        account.cooldown = 0
        values = {name: getattr(reuse, name) if reuse else None for name in ('orders', 'executions', 'positions')}
        values.update({name: result for (name, _), result in zip(needed, results)})
        bundle = Bundle(**values, started=reuse.started if reuse else started, revision=revision)
        account.bundle = bundle
        logger.info('kotak_reports_fetched requests=%d revision=%d background=%s', len(needed), revision, background)
        return bundle

    account.task = asyncio.create_task(run())
    account.task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
    return await asyncio.shield(account.task)


async def shutdown():
    tasks = [s.task for s in _accounts.values() if s.task and not s.task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _accounts.clear()
