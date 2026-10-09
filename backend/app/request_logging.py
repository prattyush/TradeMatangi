"""HTTP diagnostics without logging credentials, query values or trading bodies."""
import asyncio
from contextlib import suppress
from contextvars import ContextVar
import logging
import time
import uuid

logger = logging.getLogger("app.requests")
current_request_id = ContextVar("http_request_id", default=None)


class RequestLoggingMiddleware:
    def __init__(self, app, pending_after_s=2):
        self.app = app
        self.pending_after_s = pending_after_s

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = uuid.uuid4().hex
        context_token = current_request_id.set(request_id)
        method = scope["method"]
        path = scope.get("path", "").replace("\n", "\\n").replace("\r", "\\r")
        started = time.monotonic()
        response_started = False
        logger.debug("http_request_start request_id=%s method=%s path=%s", request_id, method, path)

        async def pending():
            await asyncio.sleep(self.pending_after_s)
            if not response_started:
                logger.warning("http_request_pending request_id=%s method=%s path=%s duration_ms=%.1f",
                               request_id, method, path, (time.monotonic() - started) * 1000)

        watchdog = asyncio.create_task(pending())

        async def traced_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                watchdog.cancel()
                elapsed = (time.monotonic() - started) * 1000
                status = message["status"]
                level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 or elapsed >= self.pending_after_s * 1000 else logging.DEBUG
                logger.log(level, "http_response request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
                           request_id, method, path, status, elapsed)
                message = {**message, "headers": [*message.get("headers", []), (b"x-request-id", request_id.encode())]}
            await send(message)

        try:
            await self.app(scope, receive, traced_send)
        except asyncio.CancelledError:
            logger.log(logging.DEBUG if response_started else logging.WARNING,
                       "http_request_cancelled request_id=%s method=%s path=%s", request_id, method, path)
            raise
        except Exception:
            logger.exception("http_request_failed request_id=%s method=%s path=%s", request_id, method, path)
            raise
        finally:
            watchdog.cancel()
            with suppress(asyncio.CancelledError):
                await watchdog
            current_request_id.reset(context_token)
