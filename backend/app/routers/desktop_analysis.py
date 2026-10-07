"""Desktop-authenticated adapters to the existing analysis services.

Only the explicitly listed routes are exposed. Signature adaptation preserves the
website's request validation and response models without proxying HTTP requests.
"""
import asyncio
import inspect
from functools import wraps
from typing import get_type_hints

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.routing import APIRoute
from app.dependencies import get_desktop_user_id
from app.routers import analysis, data, labels, pattern_logger, performance, snapshots
from app.services import analysis_service, performance_service
from app.services.history_workers import desktop_history_scope, run_history

router = APIRouter(prefix="/api/desktop/v1/analysis", tags=["desktop-analysis"])


def get_analysis_user_id(authorization: str | None = Header(default=None)) -> str:
    """Analysis requires a desktop bearer; legacy website identity is not proof."""
    return get_desktop_user_id(authorization=authorization, x_user_id=None)


def owned_session(session_id, user_id):
    session = labels.svc._load_session(session_id)
    if not session or session.get("user_id") != user_id:
        raise HTTPException(404, "Session not found")
    return session


def adapt(route: APIRoute, path: str):
    endpoint = route.endpoint
    signature = inspect.signature(endpoint)
    hints = get_type_hints(endpoint)
    parameters = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in signature.parameters.values()]
    identity_parameter = next((name for name in ("user_id", "_user_id") if name in signature.parameters), None)
    has_user = identity_parameter is not None
    if has_user:
        parameters = [p.replace(default=Depends(get_analysis_user_id)) if p.name == identity_parameter else p for p in parameters]
    else:
        parameters.append(inspect.Parameter("desktop_owner", inspect.Parameter.KEYWORD_ONLY, default=Depends(get_analysis_user_id), annotation=str))

    @wraps(endpoint)
    async def authenticated(**kwargs):
        owner = kwargs.get(identity_parameter) if has_user else kwargs.pop("desktop_owner")
        if "session_id" in kwargs:
            await asyncio.to_thread(owned_session, kwargs["session_id"], owner)
        if path.startswith('/data/'):
            with desktop_history_scope():
                return await endpoint(**kwargs)
        if path.startswith('/pattern/ohlc/'):
            # These legacy async endpoints do synchronous provider/cache work.
            return await run_history(lambda: asyncio.run(endpoint(**kwargs)))
        return await endpoint(**kwargs)

    authenticated.__signature__ = signature.replace(parameters=parameters, return_annotation=hints.get("return", signature.return_annotation))
    router.add_api_route(path, authenticated, methods=list(route.methods), response_model=route.response_model,
                         status_code=route.status_code, dependencies=route.dependencies, name=f"desktop_analysis_{route.name}")


# Deliberately exclude arbitrary trades/user queries, trading writes, pattern writes
# and snapshot creation. Labels and confirmed snapshot deletion are the only writes.
allowed = [
    (analysis.router, {"/api/analysis/sessions": {"GET"}}),
    (labels.router, {f"/api/analysis/{p}": {"GET", "POST"} if p == "labels" else {"GET"}
                    for p in ("round-trips", "labels", "entry-tags", "exit-tags")}),
    (performance.router, {f"/api/analysis/performance{p}": {"GET"} for p in ("", "/cycles", "/cycles/{cycle_id}")}),
    (data.router, {f"/api/data/{p}": {"GET"} for p in ("historical", "pre-session", "options-historical", "expiry")}),
    (pattern_logger.router, {f"/api/pattern/{p}": {"GET"} for p in ("strategies", "categories", "chart/by-date", "ohlc/equity", "ohlc/options")}),
    (snapshots.router, {"/api/snapshots": {"GET", "DELETE"}}),
]
for source, paths in allowed:
    for route in source.routes:
        if not isinstance(route, APIRoute) or route.path not in paths or not route.methods <= paths[route.path]:
            continue
        if route.path.startswith("/api/analysis/"):
            relative = route.path.removeprefix("/api/analysis")
        elif route.path.startswith("/api/data/"):
            relative = "/data/" + route.path.removeprefix("/api/data/")
        elif route.path.startswith("/api/pattern/"):
            relative = "/pattern/" + route.path.removeprefix("/api/pattern/")
        else:
            relative = "/snapshots"
        adapt(route, relative)


@router.get("/sessions/{session_id}")
async def session_detail(session_id: str, user_id: str = Depends(get_analysis_user_id)):
    def load():
        session = owned_session(session_id, user_id)
        cycles = performance_service.load_session_cycles(session)
        # The same execution can belong to two cycles during a reversal. Keep its
        # role quantities in cycles, but show one physical fill in the table/chart.
        executions = {}
        for cycle in cycles:
            for row in cycle["executions"]:
                identity = str(row.get("execution_id") or row.get("trade_id"))
                if identity not in executions:
                    executions[identity] = {**row, "quantity": 0, "commission": 0}
                executions[identity]["quantity"] += row["quantity"]
                executions[identity]["commission"] += row.get("commission", 0)
        trades = []
        for identity, row in executions.items():
            trades.append({**analysis_service._serialize_trade({**row, "session_id": session_id,
                           "user_id": user_id, "symbol": session["symbol"],
                           "instrument_type": session.get("instrument_type", "equity")}),
                           "trade_id": identity, "execution_id": row.get("execution_id"),
                           "order_id": row.get("order_id"), "kotak_order_id": row.get("kotak_order_id"),
                           "exchange": row.get("broker_exchange") or row.get("exchange"),
                           "product": row.get("broker_product") or row.get("product")})
        trades.sort(key=performance_service.execution_order_key)
        summary = analysis_service.compute_session_summary(session, trades, cycles)
        return {**summary, "trades": trades, "cycles": cycles}
    try:
        return await asyncio.to_thread(load)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, "Analysis session could not be read; retry later") from exc
