"""Process-local market data ownership; consumers own handles, not broker sockets.

Provider bridges reuse the SDK broadcasters' one-second aggregation. The hub
registers once per provider/instrument, so aggregation and token lookup are not
repeated for each screen or user. This boundary can later move to a feed process.
"""
from __future__ import annotations

import asyncio
import logging
import inspect
import time
import uuid
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


def normalize_instrument(instrument: dict) -> dict:
    from app.config import SUPPORTED_SYMBOLS
    symbol = instrument.get("underlying") or instrument.get("symbol")
    info = SUPPORTED_SYMBOLS[symbol]
    if instrument.get("kind") == "option":
        return {"kind": "option", "exchange": info["options_exchange_code"], "underlying": symbol,
                "expiry": instrument["expiry"], "strike": int(instrument["strike"]), "right": instrument["right"].upper()}
    return {"kind": "index" if info.get("options_only") else "equity", "exchange": info["exchange_code"], "symbol": symbol}


def instrument_key(instrument: dict) -> str:
    from app.services.desktop_persistence_service import canonical_instrument_id
    return canonical_instrument_id(normalize_instrument(instrument))


def selected_provider() -> str:
    from app.services.token_service import get_token
    return get_token("live_stream_source") or "kite"


def fallback_sources(source: str, real: bool = False) -> tuple[str, ...]:
    return {
        "kite": ("kite",) if real else ("kite", "breeze"),
        "kotak": ("kotak", "kite") if real else ("kotak", "kite", "breeze"),
        "breeze": ("breeze", "kite"),
        "fyers": ("fyers", "breeze", "kite"),
    }[source]


@dataclass
class FeedGroup:
    selected: str
    real: bool = False
    actual: str | None = None
    generation: int = 1
    quote_after: float = 0.0
    connection: str = "connecting"
    reason: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def status(self) -> dict:
        return {"selected_provider": self.selected, "actual_provider": self.actual,
                "connection": self.connection, "generation": self.generation,
                "reason": self.reason}


class Subscription:
    def __init__(self, hub, group, key, consumer_id, queue):
        self.hub, self.group, self.key = hub, group, key
        self.consumer_id, self.queue = consumer_id, queue
        self.closed = False
        self.dropped = 0
        self.last_drop_log = 0.0

    def close(self):
        if not self.closed:
            self.closed = True
            self.hub.release(self)


class _Delivery:
    """SDK callbacks schedule put_nowait on the asyncio loop, never block it."""
    def __init__(self, hub, key):
        self.hub, self.key = hub, key

    def put_nowait(self, tick):
        feed = self.hub.feeds.get(self.key)
        if feed and feed.get("delivery") is self:
            self.hub.deliver(self.key, tick)

    def update_quote(self, quote):
        feed = self.hub.feeds.get(self.key)
        if feed and feed.get("delivery") is self:
            self.hub.quotes[self.key] = {**quote, "received_at": time.time()}


class ProviderAdapter:
    def connected(self, source):
        """Socket health is independent of quote activity outside market hours."""
        if source == "kite":
            from app.services.kite_service import get_broadcaster
            return get_broadcaster()._connected
        if source == "fyers":
            from app.services.fyers_service import get_fyers_broadcaster
            return get_fyers_broadcaster()._connected
        return False

    def open(self, source, instrument, delivery, loop):
        from app.config import SUPPORTED_SYMBOLS
        symbol = instrument.get("underlying") or instrument.get("symbol")
        right = instrument.get("right")
        sid = f"feed:{source}:{uuid.uuid4()}"
        if source == "kite":
            from app.services import kite_service as service
            token = (service.fetch_options_instrument_token(symbol, instrument["expiry"], int(instrument["strike"]), right)
                     if right else service.fetch_equity_instrument_token(symbol)[1])
            manager = service.get_broadcaster()
            try:
                manager.register(sid, [token], [right], delivery, loop)
            except Exception:
                manager.unregister(sid)
                raise
            return lambda: manager.unregister(sid)
        if source == "fyers":
            from app.services import fyers_service as service
            name = (service._fyers_options_symbol(symbol, instrument["expiry"], int(instrument["strike"]), right)
                    if right else service._fyers_index_symbol(symbol) if instrument["kind"] == "index"
                    else service._fyers_equity_symbol(symbol))
            manager = service.get_fyers_broadcaster()
            try:
                manager.register(sid, [name], [right], delivery, loop)
            except Exception:
                manager.unregister(sid)
                raise
            return lambda: manager.unregister(sid)
        if source == "kotak":
            from app.services import kotak_service as service
            manager = service.get_kotak_broadcaster()
            if not manager.is_ready():
                raise RuntimeError("Kotak is not authenticated")
            token, exchange = (service.fetch_kotak_options_instrument_token(symbol, instrument["expiry"], int(instrument["strike"]), right)
                               if right else service.fetch_kotak_equity_instrument_token(symbol))
            try:
                manager.register(sid, [token], [exchange], [right], delivery, loop,
                                 is_indices=[instrument["kind"] == "index"])
            except Exception:
                manager.unregister(sid)
                raise
            return lambda: manager.unregister(sid)
        from app.services.breeze_service import BreezeStreamManager
        info = SUPPORTED_SYMBOLS[symbol]
        spec = {"stock_code": info.get("breeze_stock_code", symbol),
                "exchange_code": info["options_exchange_code"] if right else info["exchange_code"],
                "product_type": "options" if right else "cash"}
        if right:
            spec.update(expiry_date=f"{instrument['expiry']}T06:00:00.000Z",
                        strike_price=str(instrument["strike"]), right="call" if right == "CE" else "put")
        manager = BreezeStreamManager()
        try:
            manager.start(delivery, loop, [spec], session_id=sid)
        except Exception:
            manager.stop()
            raise
        return manager.stop


class MarketDataHub:
    def __init__(self, adapter=None):
        self.adapter = adapter or ProviderAdapter()
        self.feeds: dict[tuple[str, str], dict] = {}
        self.quotes: dict[tuple[str, str], dict] = {}
        self.lock = asyncio.Lock()
        self.recovery_tasks: dict[int, asyncio.Task] = {}

    async def subscribe(self, instrument, consumer_id, group, queue):
        instrument = normalize_instrument(instrument)
        key = instrument_key(instrument)
        async with group.lock:
            sources = (group.actual,) if group.actual else fallback_sources(group.selected, group.real)
            last_error = None
            for source in sources:
                feed_key = (source, key)
                try:
                    async with self.lock:
                        if feed_key not in self.feeds:
                            delivery = _Delivery(self, feed_key)
                            async def open_adapter():
                                if inspect.iscoroutinefunction(self.adapter.open):
                                    return await self.adapter.open(source, instrument, delivery, asyncio.get_running_loop())
                                return await asyncio.to_thread(self.adapter.open, source, instrument, delivery, asyncio.get_running_loop())
                            opening = asyncio.create_task(open_adapter())
                            try:
                                close = await asyncio.shield(opening)
                            except asyncio.CancelledError:
                                # An SDK startup thread cannot be cancelled. Wait
                                # for its result and release the orphan socket.
                                try:
                                    (await opening)()
                                finally:
                                    raise
                            self.feeds[feed_key] = {"close": close, "delivery": delivery, "consumers": {}, "instrument": dict(instrument), "first_tick": False}
                            logger.info("market_data_feed_opened provider=%s instrument=%s feeds=%d", source, key, len(self.feeds))
                        handle = Subscription(self, group, feed_key, consumer_id, queue)
                        self.feeds[feed_key]["consumers"][id(handle)] = handle
                    if group.actual is None or group.connection == "connecting":
                        group.connection, group.reason = "connected", None
                    group.actual = source
                    logger.info("market_data_subscribed consumer=%s provider=%s instrument=%s feeds=%d", consumer_id, source, key, len(self.feeds))
                    return handle
                except Exception as exc:
                    last_error = exc
                    logger.warning("market_data_subscribe_failed provider=%s instrument=%s reason=%s", source, key, exc)
            group.connection, group.reason = "unavailable", str(last_error)
            raise RuntimeError(f"Live data unavailable: {last_error}") from last_error

    def release(self, handle):
        feed = self.feeds.get(handle.key)
        if not feed:
            return
        feed["consumers"].pop(id(handle), None)
        if not feed["consumers"]:
            self.feeds.pop(handle.key, None)
            self.quotes.pop(handle.key, None)
            feed["close"]()
            logger.info("market_data_feed_released provider=%s instrument=%s feeds=%d", *handle.key, len(self.feeds))
        if handle.closed and not any(h.group is handle.group for f in self.feeds.values() for h in f["consumers"].values()):
            task = self.recovery_tasks.pop(id(handle.group), None)
            if task:
                task.cancel()

    def publish_status(self, group):
        """Notify consumers on lifecycle changes even when exchanges are quiet."""
        for key, feed in list(self.feeds.items()):
            for handle in list(feed["consumers"].values()):
                if handle.group is not group or handle.closed:
                    continue
                try:
                    handle.queue.put_nowait({"type": "feed_status", **group.status(),
                        "provider": key[0], "instrument_id": key[1], "feed_generation": group.generation})
                except asyncio.QueueFull:
                    # Never discard an observation merely to deliver status.
                    pass

    def deliver(self, key, tick):
        feed = self.feeds.get(key)
        if not feed:
            return
        if tick.get("type") == "tick" and not feed["first_tick"]:
            feed["first_tick"] = True
            logger.info("market_data_first_tick provider=%s instrument=%s token=%s time=%s consumers=%d", *key, tick.get("provider_token"), tick.get("time"), len(feed["consumers"]))
        if tick.get("type") == "tick" and (key not in self.quotes or tick["time"] >= self.quotes[key].get("time", 0)):
            self.quotes[key] = {**tick, "received_at": time.time()}
        groups = {id(h.group): (h.group, h.group.status()) for h in feed["consumers"].values()}
        for handle in list(feed["consumers"].values()):
            instrument = feed["instrument"]
            payload = {**tick, "provider": key[0], "instrument_id": key[1], "feed_generation": handle.group.generation}
            if instrument.get("right"):
                payload.update(right=instrument["right"], strike=instrument["strike"], expiry=instrument["expiry"])
            if tick.get("type") == "broker_error":
                handle.group.quote_after = time.time()
                handle.group.connection = "reconnecting"
                handle.group.reason = tick.get("message")
                self._schedule_recovery(handle.group)
            elif tick.get("type") == "tick":
                handle.group.connection, handle.group.reason = "connected", None
            try:
                handle.queue.put_nowait(payload)
            except asyncio.QueueFull:
                handle.dropped += 1
                now = time.monotonic()
                if handle.dropped == 1 or now - handle.last_drop_log >= 60:
                    handle.last_drop_log = now
                    logger.error("market_data_overflow consumer=%s instrument=%s dropped=%d", handle.consumer_id, key, handle.dropped)
                # Make loss explicit. Consumers reconcile charts/state, never
                # replay lost prices as executions.
                handle.queue.get_nowait()
                handle.queue.put_nowait({"type": "broker_error", "message": "Live data gap: consumer queue overflow", "stream_gap": True})
        for group, previous in groups.values():
            if group.status() != previous:
                self.publish_status(group)

    def _schedule_recovery(self, group):
        if id(group) in self.recovery_tasks:
            return
        async def recover():
            try:
                await asyncio.sleep(30)
                if group.connection != "connected":
                    connected = getattr(self.adapter, "connected", None)
                    if connected and connected(group.actual):
                        group.connection, group.reason = "connected", None
                        logger.info("market_data_connection_restored provider=%s generation=%d", group.actual, group.generation)
                        self.publish_status(group)
                    else:
                        await self.rebind(group, advance=True)
            except Exception:
                logger.exception("market_data_recovery_failed provider=%s", group.actual)
            finally:
                if self.recovery_tasks.get(id(group)) is asyncio.current_task():
                    self.recovery_tasks.pop(id(group), None)
        self.recovery_tasks[id(group)] = asyncio.create_task(recover())

    async def rebind(self, group, target=None, advance=False):
        async with group.lock:
            await self._rebind_locked(group, target, advance)

    async def _rebind_locked(self, group, target=None, advance=False):
        handles = [(dict(feed["instrument"]), handle) for feed in list(self.feeds.values())
                   for handle in list(feed["consumers"].values()) if handle.group is group and not handle.closed]
        if not handles:
            return
        sources = fallback_sources(group.selected, group.real)
        candidates = (target,) if target else sources[sources.index(group.actual) + 1:] if advance and group.actual in sources else sources
        if not candidates:
            group.connection = "unavailable"
            self.publish_status(group)
            return
        for source in candidates:
            replacements = []
            replacement_group = FeedGroup(group.selected, group.real, actual=source)
            try:
                for instrument, old in handles:
                    replacements.append(await self.subscribe(instrument, old.consumer_id, replacement_group, asyncio.Queue(maxsize=old.queue.maxsize)))
            except asyncio.CancelledError:
                for replacement in replacements:
                    replacement.close()
                raise
            except Exception:
                for replacement in replacements:
                    replacement.close()
                continue
            for (_, old), replacement in zip(handles, replacements):
                if old.closed:
                    replacement.close()
                    continue
                self.release(old)
                feed = self.feeds[replacement.key]
                feed["consumers"].pop(id(replacement))
                old.key = replacement.key
                feed["consumers"][id(old)] = old
            previous = group.actual
            group.actual, group.connection, group.reason = source, "connected", None
            group.generation += 1
            group.quote_after = time.time()
            logger.info("market_data_handover selected=%s previous=%s actual=%s generation=%d consumers=%d", group.selected, previous, source, group.generation, len(handles))
            self.publish_status(group)
            for (_, old), replacement in zip(handles, replacements):
                if not old.closed:
                    while not replacement.queue.empty():
                        event = replacement.queue.get_nowait()
                        if not old.queue.full():
                            old.queue.put_nowait({**event, "feed_generation": group.generation})
            return
        group.connection = "unavailable"
        self.publish_status(group)

    def shutdown(self):
        for task in self.recovery_tasks.values():
            task.cancel()
        self.recovery_tasks.clear()
        for feed in list(self.feeds.values()):
            feed["close"]()
        self.feeds.clear()
        self.quotes.clear()


_hub = MarketDataHub()


def get_hub():
    return _hub


def session_instruments(session):
    from app.config import SUPPORTED_SYMBOLS
    info = SUPPORTED_SYMBOLS[session.symbol]
    instruments = [{"kind": "index" if info.get("options_only") else "equity",
                    "exchange": info["exchange_code"], "symbol": session.symbol}]
    if session.instrument_type == "options" and session.expiry:
        for right in ("CE", "PE"):
            strike = getattr(session, f"strike_{right.lower()}", None) or session.strike
            if strike and session.right in (None, right):
                instruments.append({"kind": "option", "exchange": info["options_exchange_code"],
                                    "underlying": session.symbol, "expiry": session.expiry,
                                    "strike": int(strike), "right": right})
    return instruments


class SessionFeed:
    def __init__(self, session, group):
        self.session, self.group = session, group
        self.handles = []

    async def start(self):
        # Commit a provider only after its complete engine bundle opens.
        hub = get_hub()
        last_error = None
        for source in fallback_sources(self.group.selected, self.group.real):
            candidate = FeedGroup(self.group.selected, self.group.real, actual=source)
            handles = []
            candidate_queue = asyncio.Queue(maxsize=self.session.paper_tick_queue.maxsize)
            try:
                for instrument in session_instruments(self.session):
                    handles.append(await hub.subscribe(instrument, self.session.session_id, candidate, candidate_queue))
            except BaseException as exc:
                for handle in handles:
                    handle.close()
                if isinstance(exc, asyncio.CancelledError):
                    raise
                last_error = exc
                continue
            self.handles = handles
            self.group.actual, self.group.connection, self.group.reason = source, candidate.connection, candidate.reason
            for handle in handles:
                handle.group = self.group
                handle.queue = self.session.paper_tick_queue
            while not candidate_queue.empty():
                event = candidate_queue.get_nowait()
                if not self.session.paper_tick_queue.full():
                    self.session.paper_tick_queue.put_nowait(event)
            break
        else:
            self.group.connection, self.group.reason = "unavailable", str(last_error)
            raise RuntimeError(f"Live data unavailable: {last_error}") from last_error
        self.session.paper_stream_source = self.group.actual

    def stop(self):
        for handle in self.handles:
            handle.close()
        self.handles.clear()

    async def replace_right(self, right):
        instrument = next(item for item in session_instruments(self.session) if item.get("right") == right)
        new = await get_hub().subscribe(instrument, self.session.session_id, self.group, self.session.paper_tick_queue)
        for old in list(self.handles):
            feed = get_hub().feeds.get(old.key)
            if feed and feed["instrument"].get("right") == right:
                old.close()
                self.handles.remove(old)
        self.handles.append(new)


async def start_session_feed(session):
    group = getattr(session, "market_feed_group", None) or FeedGroup(selected_provider(), session.session_type == "real")
    session.market_feed_group = group
    feed = SessionFeed(session, group)
    await feed.start()
    session.stream_manager = feed
    return feed
