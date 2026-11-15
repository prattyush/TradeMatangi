"""Desktop-authenticated adapters to the Patterns, Chart Structures and Fine Structures routers.

The website routers stay untouched. Each route is re-registered under
``/api/desktop/v1/patterns/<family>/...`` with the website's ``X-User-Id`` identity swapped
for a required desktop bearer, so the Windows app gets the same request validation and
response models without proxying HTTP. None of these routes touch orders, sessions,
brokers or streams: they read minute candles and store the user's own pattern notes.
"""
import asyncio
import inspect
from functools import wraps
from typing import get_type_hints

from fastapi import APIRouter, Depends, Header
from fastapi.routing import APIRoute

from app.dependencies import get_desktop_user_id
from app.routers import chart_structures, data, fine_structures, pattern_logger
from app.services.history_workers import desktop_history_scope, run_history

router = APIRouter(prefix="/api/desktop/v1/patterns", tags=["desktop-patterns"])


def get_patterns_user_id(authorization: str | None = Header(default=None)) -> str:
    """Desktop bearer only; the website's X-User-Id header is not proof of identity here."""
    return get_desktop_user_id(authorization=authorization, x_user_id=None)


def adapt(route: APIRoute, path: str, *, history_scope: bool = False) -> None:
    endpoint = route.endpoint
    signature = inspect.signature(endpoint)
    hints = get_type_hints(endpoint)
    parameters = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in signature.parameters.values()]
    identity = next((name for name in ("user_id", "_user_id") if name in signature.parameters), None)
    if identity is not None:
        parameters = [p.replace(default=Depends(get_patterns_user_id)) if p.name == identity else p for p in parameters]
    else:
        parameters.append(inspect.Parameter("desktop_owner", inspect.Parameter.KEYWORD_ONLY,
                                            default=Depends(get_patterns_user_id), annotation=str))

    @wraps(endpoint)
    async def authenticated(**kwargs):
        if identity is None:
            kwargs.pop("desktop_owner")
        if history_scope:
            with desktop_history_scope():
                return await endpoint(**kwargs)
        # The website handlers do synchronous storage and provider work inside async defs:
        # run them on the bounded history pool so they never block the event loop.
        return await run_history(lambda: asyncio.run(endpoint(**kwargs)))

    authenticated.__signature__ = signature.replace(
        parameters=parameters, return_annotation=hints.get("return", signature.return_annotation))
    router.add_api_route(path, authenticated, methods=list(route.methods), response_model=route.response_model,
                         status_code=route.status_code, dependencies=route.dependencies,
                         name=f"desktop_patterns_{route.name}")


# Whole routers (every route is the user's own notes or read-only candles).
for source, legacy_prefix, family in (
    (pattern_logger.router, "/api/pattern", "/pattern"),
    (chart_structures.router, "/api/chart-structures", "/chart-structures"),
    (fine_structures.router, "/api/fine-structures", "/fine-structures"),
):
    for route in source.routes:
        if isinstance(route, APIRoute) and route.path.startswith(legacy_prefix):
            adapt(route, family + route.path.removeprefix(legacy_prefix))

# Helper lookups the three pages call. Read-only; nothing else from the data router.
DATA_HELPERS = {"/api/data/symbols", "/api/data/price-at", "/api/data/expiry", "/api/data/options/find-strike-by-price"}
for route in data.router.routes:
    if isinstance(route, APIRoute) and route.path in DATA_HELPERS and route.methods <= {"GET"}:
        adapt(route, "/data/" + route.path.removeprefix("/api/data/"), history_scope=True)
