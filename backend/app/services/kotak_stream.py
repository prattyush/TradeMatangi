"""Own the v3 async feeds without changing synchronous broker call sites.

All sockets and subscription state belong to one background event loop. The
application, rather than the SDK, owns reconnects so async iterators are replaced
after disconnect and removals made during an outage cannot be resurrected.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import threading
from concurrent.futures import TimeoutError as FutureTimeout

logger = logging.getLogger(__name__)
_INDEX_NAMES = {"nse_cm": "Nifty 50", "bse_cm": "SENSEX"}


class KotakFeedBridge:
    def __init__(self, client, on_order, on_market, on_expired, *, reconnect_delay=5, timeout=30):
        self.client = client
        self.on_order = on_order
        self.on_market = on_market
        self.on_expired = on_expired
        self.reconnect_delay = reconnect_delay
        self.timeout = timeout
        self._closed = False
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="kotak-feeds", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("Kotak feed loop did not start")

    def _run(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._desired = set()  # (exchange, numeric token, is_index)
        self._sent = set()
        self._market_ws = None
        self._market_task = None
        self._market_ready = asyncio.Event()
        self._market_error = None
        self._subscription_lock = asyncio.Lock()
        self._order_task = self._loop.create_task(self._supervise("order"))
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self._loop)
            for task in pending:
                task.cancel()
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            self._loop.close()

    def _call(self, coroutine):
        if self._closed:
            coroutine.close()
            raise RuntimeError("Kotak feed bridge is closed")
        if threading.current_thread() is self._thread:
            coroutine.close()
            raise RuntimeError("Cannot wait synchronously on the Kotak feed loop")
        future = asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        try:
            return future.result(timeout=self.timeout)
        except FutureTimeout:
            future.cancel()
            raise TimeoutError("Kotak feed operation timed out") from None

    def replace_subscriptions(self, subscriptions, *, wait=True):
        """Commit a complete desired set; failed additions are rolled back."""
        desired = {(str(d["exchange_segment"]), str(d["instrument_token"]), bool(d.get("is_index")))
                   for d in subscriptions}
        return self._call(self._replace(desired, wait=wait))

    async def _replace(self, desired, *, wait=True):
        previous = self._desired
        self._desired = desired
        try:
            if not desired:
                await self._stop_market()
                return
            if self._market_task is None or self._market_task.done():
                self._market_ready.clear()
                self._market_error = None
                self._market_task = asyncio.create_task(self._supervise("market"))
            if not wait:
                return  # re-login restores desired state; supervisor connects it
            # A removal during an outage must take effect immediately. The next
            # connection reads _desired, never a stale socket subscription set.
            if desired <= previous and self._market_ws is None:
                return
            await self._market_ready.wait()
            if self._market_error:
                raise self._market_error
            await self._sync_market(self._market_ws)
        except BaseException:
            # Calls from the broadcaster are serialized, so rollback is safe.
            self._desired = previous
            if not previous:
                await self._stop_market()
            elif not self._closed and self._market_ws is not None:
                # Cancellation/timeouts can occur after a frame was sent.
                # Recreate the socket from the authoritative desired set.
                await self._stop_market()
                self._market_task = asyncio.create_task(self._supervise("market"))
            raise

    @staticmethod
    def _token(subscription):
        from neo_api_client.websocket.feed import WsToken
        exchange, token, is_index = subscription
        return WsToken(exchange, _INDEX_NAMES[exchange] if is_index else token)

    async def _sync_market(self, ws):
        if ws is None:
            raise RuntimeError("Kotak market feed is disconnected")
        async with self._subscription_lock:
            for is_index in (False, True):
                removed = [s for s in self._sent - self._desired if s[2] == is_index]
                added = [s for s in self._desired - self._sent if s[2] == is_index]
                if removed:
                    method = ws.unsubscribe_index if is_index else ws.unsubscribe_scrips
                    await method([self._token(s) for s in removed])
                    self._sent.difference_update(removed)
                if added:
                    method = ws.subscribe_index if is_index else ws.subscribe_scrips
                    await method([self._token(s) for s in added])
                    self._sent.update(added)

    async def _supervise(self, kind):
        from neo_api_client.websocket.feed.exceptions import AuthenticationError as MarketAuthError
        from neo_api_client.websocket.orderfeed.exceptions import AuthenticationError as OrderAuthError
        while not self._closed and (kind == "order" or self._desired):
            ws = None
            try:
                factory = self.client.create_order_feed if kind == "order" else self.client.create_websocket
                ws = factory(max_connect_retries=0, max_reconnect_attempts=0)
                # The SDK consumes connection control frames instead of yielding
                # them. Observe rejected sessions before that filtering happens.
                ws.on_raw = self._observe_raw_frame
                await ws.connect()
                if kind == "market":
                    self._market_ws = ws
                    self._sent.clear()
                    await self._sync_market(ws)
                    self._market_error = None
                    self._market_ready.set()
                logger.info("Kotak %s feed connected", kind)
                async for message in ws:
                    if self._closed:
                        break
                    callback = self.on_order if kind == "order" else self._market_message
                    try:
                        callback(message)
                    except Exception as exc:
                        logger.warning("Kotak %s message handler failed: %s", kind, type(exc).__name__)
            except (MarketAuthError, OrderAuthError):
                logger.warning("Kotak %s feed authentication failed; login required", kind)
                if kind == "market":
                    self._market_error = RuntimeError("Kotak session expired; login required")
                    self._market_ready.set()
                self.on_expired()
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Kotak %s feed failed: %s", kind, type(exc).__name__)
                if kind == "market":
                    self._market_error = RuntimeError("Kotak market feed connection/subscription failed")
                    self._market_ready.set()
            finally:
                if kind == "market":
                    self._market_ws = None
                    self._sent.clear()
                    if self._market_error is None:
                        self._market_ready.clear()
                if ws is not None:
                    with contextlib.suppress(Exception):
                        await ws.close()
            if not self._closed:
                await asyncio.sleep(self.reconnect_delay)
                if kind == "market":
                    self._market_ready.clear()
                    self._market_error = None

    def _observe_raw_frame(self, raw):
        self._check_auth_frame(raw)
        from app.services.kotak_cancel_audit import record, record_event
        record_event(raw)
        record(raw)

    def _check_auth_frame(self, raw):
        if self._closed or not isinstance(raw, (str, bytes, bytearray)):
            return
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(data, dict):
            return
        code = str(data.get("stCode") or data.get("code") or "")
        if code in ("100008", "401", "403") or (
            data.get("type") == "cn" and str(data.get("ak", "")).lower() in ("not_ok", "not ok", "error")
        ):
            self.on_expired()

    def _market_message(self, message):
        # SDK has already scaled prices. Control/position/depth messages do not
        # become chart ticks. Delivery remains keyed by the master numeric token.
        data = message.model_dump() if hasattr(message, "model_dump") else message
        if not isinstance(data, dict) or data.get("type") not in ("scrip", "index"):
            return
        exchange, token = data.get("exchange_segment"), str(data.get("instrument_token", ""))
        is_index = data["type"] == "index"
        if is_index and (exchange, token, True) not in self._desired:
            matches = [s for s in self._desired if s[2] and s[0] == exchange
                       and _INDEX_NAMES.get(exchange, "").casefold() == str(data.get("name", "")).strip().casefold()]
            if not matches:
                return
            token = matches[0][1]
        if (exchange, token, is_index) not in self._desired:
            return
        timestamp = None
        for value in (data.get("last_update_time"), data.get("last_trade_time")):
            try:
                if value is not None and math.isfinite(float(value)) and float(value) > 0:
                    timestamp = int(float(value))
                    break
            except (ValueError, TypeError, OverflowError):
                pass
        self.on_market({"type": "stock_feed", "data": {
            "tk": token, "e": exchange, "ltp": data.get("last_traded_price"),
            "exchange_timestamp": timestamp,
        }})

    async def _stop_market(self):
        task, self._market_task = self._market_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._market_ws = None
        self._sent.clear()
        self._market_ready.clear()

    async def _shutdown(self):
        await self._stop_market()
        self._order_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._order_task

    def close(self):
        if self._closed:
            return
        self._closed = True
        if threading.current_thread() is self._thread:
            async def stop():
                await self._shutdown()
                self._loop.stop()
            self._loop.create_task(stop())
        else:
            future = asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop)
            try:
                future.result(timeout=self.timeout)
            finally:
                self._loop.call_soon_threadsafe(self._loop.stop)
                self._thread.join(timeout=self.timeout)
