"""Real funds are broker snapshots, never Paper balances or synthetic capital."""
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app.services import wallet_service, simulation, kotak_service
from app.routers import wallet, simulation as start_router
from app.models.schemas import SimulationStartRequest

USER, DATE = "broker-wallet-user", "2026-10-01"

@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    async def inline_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    monkeypatch.setattr("asyncio.to_thread", inline_thread)
    wallet_service._wallets.clear()
    wallet_service._ledgers.clear()
    items, table = {}, MagicMock()
    def update(**kwargs):
        item = items.setdefault(tuple(kwargs["Key"].values()), dict(kwargs["Key"]))
        values = kwargs["ExpressionAttributeValues"]
        item.update(date=values[":date"], ledger_kind=values[":kind"], current_balance=values[":balance"])
        if "broker_balance" in kwargs["UpdateExpression"]:
            item.update(broker_balance=values[":balance"], broker_funds_updated_at=values[":updated"])
    table.update_item.side_effect = update
    table.get_item.side_effect = lambda **kwargs: {"Item": items.get(tuple(kwargs["Key"].values()), {})}
    resource = MagicMock()
    resource.Table.return_value = table
    monkeypatch.setattr(wallet_service, "_ensure_ledger_table", lambda: None)
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
    yield table
    wallet_service._wallets.clear()
    wallet_service._ledgers.clear()
    for sid, s in list(simulation._sessions.items()):
        if s.user_id == USER:
            simulation._sessions.pop(sid)

def session(sid="real-snapshot", kind="real"):
    return simulation.SimulationSession(session_id=sid, symbol="RELIANCE", date=DATE,
        start_time="09:15:00", speed=1, user_id=USER, session_type=kind,
        session_capital=900, wallet_ledger_id=f"{kind}:{DATE}")

def test_snapshot_survives_local_debit_and_reload(isolated):
    wallet_service._wallets[(USER, DATE)] = 150000
    wallet_service._ledgers[(USER, f"sim:{DATE}")] = 12345
    wallet_service.sync_real_funds(USER, DATE, 900, reason="start")
    wallet_service.debit_ledger(USER, 900, DATE, f"real:{DATE}", "real")
    assert wallet_service.get_real_funds_snapshot(USER, DATE)[0] == 900
    assert wallet_service.get_real_funds_snapshot(USER, DATE)[0] == 900
    assert wallet_service._wallets[(USER, DATE)] == 150000
    assert wallet_service._ledgers[(USER, f"sim:{DATE}")] == 12345

def test_failed_snapshot_write_preserves_previous_amount(isolated):
    wallet_service.sync_real_funds(USER, DATE, 900, reason="start")
    isolated.update_item.side_effect = RuntimeError("database unavailable")
    with pytest.raises(RuntimeError):
        wallet_service.sync_real_funds(USER, DATE, 0, reason="refresh")
    assert wallet_service.get_real_funds_snapshot(USER, DATE)[0] == 900
    assert wallet_service._ledgers[(USER, f"real:{DATE}")] == 900

@pytest.mark.parametrize("value", ["900", "0", "-20.5"])
def test_kotak_accepts_actual_numeric_funds(value, monkeypatch):
    service, client = kotak_service.KotakNeoService(), MagicMock()
    client.limits.return_value = {"Net": value}
    monkeypatch.setattr(service, "_get_client", lambda: client)
    assert service.get_funds() == float(value)

@pytest.mark.parametrize("response", [{}, {"Net": None}, {"Net": ""}, {"Net": "NaN"}, {"Net": "inf"}, {"Net": "bad"}, {"Net": True}, []])
def test_kotak_invalid_funds_is_not_zero(response, monkeypatch):
    service, client = kotak_service.KotakNeoService(), MagicMock()
    client.limits.return_value = response
    monkeypatch.setattr(service, "_get_client", lambda: client)
    with pytest.raises(kotak_service.KotakError):
        service.get_funds()

@pytest.mark.asyncio
async def test_real_get_uses_snapshot_without_margin_or_broker_call(monkeypatch):
    s, broker = session(), MagicMock()
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    wallet_service.sync_real_funds(USER, DATE, 900, reason="start")
    wallet_service._ledgers[(USER, s.wallet_ledger_id)] = 0
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    result = await wallet.get_wallet(DATE, s.session_id, USER)
    assert result.balance == 900 and result.capital_balance is None
    assert result.session_capital == 900
    broker.get_funds.assert_not_called()

@pytest.mark.asyncio
async def test_explicit_refresh_keeps_capital_and_paper_isolation(monkeypatch):
    s, broker = session(), MagicMock()
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    broker.get_funds.return_value = 750
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    paper_balance = MagicMock(return_value=123000)
    monkeypatch.setattr("app.services.paper_wallet.balance", paper_balance)
    result = await wallet.refresh_real_wallet(s.session_id, USER)
    assert result.balance == 750 and result.session_capital == 900
    paper_balance.assert_not_called()
    s.session_type = "paper"
    with pytest.raises(HTTPException) as error:
        await wallet.refresh_real_wallet(s.session_id, USER)
    assert error.value.status_code == 400
    broker.get_funds.assert_called_once()

@pytest.mark.asyncio
async def test_refresh_failure_retains_snapshot(monkeypatch):
    s, broker = session(), MagicMock()
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    wallet_service.sync_real_funds(USER, DATE, 900, reason="start")
    broker.get_funds.side_effect = kotak_service.KotakError("token expired")
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    with pytest.raises(HTTPException) as error:
        await wallet.refresh_real_wallet(s.session_id, USER)
    assert error.value.status_code == 502
    assert wallet_service.get_real_funds_snapshot(USER, DATE)[0] == 900

@pytest.mark.asyncio
@pytest.mark.parametrize("branch", ["new", "active", "saved"])
async def test_each_real_start_fetches_once(branch, monkeypatch):
    from app.services import session_group_service as groups
    group = {"group_id": "wallet-group", "date": DATE, "clock_family": "live",
             "state": "running", "member_session_ids": [], "members": []}
    monkeypatch.setattr(groups, "get_active_group", lambda *args: None)
    monkeypatch.setattr(groups, "create_group", lambda *args: group)
    monkeypatch.setattr(groups, "add_member", lambda *args: None)
    monkeypatch.setattr("app.services.user_service.get_user_info", lambda *args: {"is_admin": True})
    monkeypatch.setattr(start_router, "_ensure_session_data", lambda *args: None)
    monkeypatch.setattr(simulation, "_upsert_session_to_db", lambda *args, **kwargs: None)
    monkeypatch.setattr(simulation, "start_session", lambda *args: None)
    monkeypatch.setattr("app.services.guardrail_service.initialize_guardrails", lambda *args: None)
    existing = None if branch == "new" else {"session_id": "existing-real", "wallet_ledger_id": f"sim:{DATE}"}
    monkeypatch.setattr(simulation, "find_session_by_context", lambda *args: existing)
    s = session("existing-real")
    s.session_capital, s.wallet_ledger_id = 0, f"sim:{DATE}"
    monkeypatch.setattr(simulation, "get_session", lambda sid: s if branch == "active" else None)
    def rebuild(record, **kwargs):
        assert record["wallet_ledger_id"] == f"real:{DATE}"
        s.wallet_ledger_id = record["wallet_ledger_id"]
        return s
    monkeypatch.setattr(simulation, "rebuild_session_from_db", rebuild)
    wallet_service._wallets[(USER, DATE)] = 150000
    wallet_service._ledgers[(USER, f"real:{DATE}")] = 0
    broker = MagicMock()
    broker.is_authenticated.return_value, broker.get_funds.return_value = True, 900
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    result = await start_router._start_simulation(SimulationStartRequest(symbol="RELIANCE", date=DATE,
        start_time="09:15:00", speed=1, session_type="real"), USER)
    assert result.session_capital == 900
    assert result.wallet_ledger_id == f"real:{DATE}"
    assert wallet_service._wallets[(USER, DATE)] == 150000
    broker.get_funds.assert_called_once()


@pytest.mark.asyncio
async def test_refresh_rejects_other_session_owner_without_broker_call(monkeypatch):
    s, broker = session(), MagicMock()
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    with pytest.raises(HTTPException) as error:
        await wallet.refresh_real_wallet(s.session_id, "other-user")
    assert error.value.status_code == 404
    broker.get_funds.assert_not_called()


@pytest.mark.asyncio
async def test_legacy_real_wallet_never_falls_back_to_paper_balance(monkeypatch):
    s = session()
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    wallet_service._wallets[(USER, DATE)] = 150000
    with pytest.raises(HTTPException) as error:
        await wallet.get_wallet(DATE, s.session_id, USER)
    assert error.value.status_code == 409
