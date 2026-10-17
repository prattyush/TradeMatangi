# ruff: noqa: F811 — imported pytest fixtures are injected by name
"""Synthetic broker/exchange evidence; no authentication or live orders."""

import io
import zipfile
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from app.services import futures_risk as risk
from app.services import futures_settlements as settlements
from app.services.kite_execution import KiteExecutionService
from fastapi import HTTPException

from tests.test_kotak_v3_migration import body, broker  # noqa: F401
from tests.test_swing_paper_runtime import db  # noqa: F401


def contract(provider="kite", exchange="NFO"):
    return {
        "provider": provider,
        "symbol": "NIFTY",
        "exchange": exchange,
        "expiry": "2026-10-27",
        "instrument_token": "42",
        "trading_symbol": "NIFTY26OCTFUT",
        "lot_size": 5,
        "tick_size": 0.05,
    }


@pytest.mark.parametrize("exchange", ["NFO", "BFO"])
@pytest.mark.parametrize("side", ["B", "S"])
@pytest.mark.parametrize("stop", [False, True])
def test_kotak_futures_real_sdk_routes_exact_contract_nrml(
    broker, exchange, side, stop
):
    service, _, requests, _ = broker
    args = {"contract": contract("kotak", exchange), "side": side, "qty": 5}
    if stop:
        result = service.place_futures_sl_order(
            **args, trigger_price=100, limit_price=100.05
        )
    else:
        result = service.place_futures_limit_order(**args, price=100.05)
    assert result == "K1"
    data = body(requests[0])
    assert data["pc"] == "NRML" and data["rt"] == "DAY"
    assert data["ts"] == "NIFTY26OCTFUT" and data["qt"] == "5"
    assert data["es"] == ("bse_fo" if exchange == "BFO" else "nse_fo")
    assert data["tt"] == side and data["pt"] == ("SL" if stop else "L")


@pytest.mark.parametrize("stop", [False, True])
def test_kite_futures_preserves_nrml_exact_contract_and_short_side(monkeypatch, stop):
    service = KiteExecutionService()
    write = MagicMock(return_value="K1")
    monkeypatch.setattr(service, "_write", write)
    if stop:
        service.place_futures_sl_order(contract(), "S", 5, 100, 99.95)
    else:
        service.place_futures_limit_order(contract(), "S", 5, 100)
    _, args = write.call_args
    assert args["product"] == "NRML" and args["transaction_type"] == "SELL"
    assert args["tradingsymbol"] == "NIFTY26OCTFUT" and args["quantity"] == 5
    assert args["order_type"] == ("SL" if stop else "LIMIT")


@pytest.mark.parametrize(
    "response,valid",
    [
        ({"stat": "Ok", "ordMrgn": "100", "reqdMrgn": "0"}, True),
        ({"stat": "Ok", "reqdMrgn": "100"}, False),
        ({"stat": "Not_Ok", "ordMrgn": "100"}, False),
        ({"stat": "Ok", "ordMrgn": "NaN"}, False),
        ({"stat": "Ok", "ordMrgn": "0"}, False),
    ],
)
def test_neo_margin_uses_order_requirement_never_shortfall(response, valid):
    client = SimpleNamespace(margin_required=MagicMock(return_value=response))
    broker = SimpleNamespace(_get_client=lambda: client)
    if valid:
        assert (
            risk.live_margin(contract("kotak"), "SELL", 5, 100, "kotak", broker=broker)[
                "margin"
            ]
            == 100
        )
        assert client.margin_required.call_args.kwargs["product"] == "NRML"
    else:
        with pytest.raises(ValueError):
            risk.live_margin(contract("kotak"), "SELL", 5, 100, "kotak", broker=broker)


def test_admin_settings_compare_and_swap_and_estimate_validation(db):
    first = risk.save(risk.RiskSettings())
    assert first.version == 1
    with pytest.raises(HTTPException) as exc:
        risk.save(risk.RiskSettings())
    assert exc.value.status_code == 409
    estimate = risk.MarginEstimate(
        provider="kite",
        symbol="NIFTY",
        expiry=date(2026, 10, 27),
        side="BUY",
        quantity=5,
        reference_price=100,
        margin=200,
        as_of=date(2026, 10, 13),
    )
    with pytest.raises(ValueError, match="Duplicate"):
        risk.save(first.model_copy(update={"estimates": [estimate, estimate]}))
    assert risk.settings().version == 1


CSV = "TradDt,FinInstrmTp,TckrSymb,XpryDt,FininstrmActlXpryDt,SttlmPric,ClsPric\n2026-10-12,IDF,NIFTY,2026-10-29,2026-10-27,110,999\n2026-10-12,IDF,NIFTY,2026-11-24,2026-11-24,120,999\n"


def test_settlement_uses_actual_expiry_official_price_not_candle_close():
    assert (
        settlements.settlement_from_csv(CSV, contract(), "2026-10-12")["price"] == 110
    )
    with pytest.raises(ValueError):
        settlements.settlement_from_csv(CSV, contract(), "2026-10-13")
    with pytest.raises(ValueError):
        settlements.settlement_from_csv(
            CSV.replace(",110,999", ",,999"), contract(), "2026-10-12"
        )


@pytest.mark.parametrize("exchange", ["NFO", "BFO"])
def test_official_download_formats_and_cached_restart(tmp_path, monkeypatch, exchange):
    monkeypatch.setattr(settlements, "DATA_DIR", tmp_path)
    monkeypatch.setattr(settlements, "_failures", {})
    content = CSV.encode()
    if exchange == "NFO":
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("bhav.csv", content)
        content = buffer.getvalue()
    response = MagicMock()
    response.__enter__.return_value.read.return_value = content
    fetch = MagicMock(return_value=response)
    monkeypatch.setattr(settlements.urllib.request, "urlopen", fetch)
    first = settlements.official(contract(exchange=exchange), "2026-10-12")
    assert first["price"] == 110
    assert first["source"].endswith(".csv" if exchange == "BFO" else ".csv.zip")
    assert settlements.official(contract(exchange=exchange), "2026-10-12") == first
    assert fetch.call_count == 1


def test_real_confirmed_partial_fills_preserve_fifo_and_fee_once():
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import futures_real

    session = SimpleNamespace(
        session_id="s",
        user_id="u",
        symbol="NIFTY",
        expiry="2026-10-27",
        execution_broker="kite",
        broker_account_id="account",
        portfolio_id="p",
        future_contract=contract(),
    )
    order = Order(
        session_id="s",
        user_id="u",
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.LIMIT,
        quantity=10,
        created_at=1,
        trigger_price=100,
        limit_price=100,
        broker_order_id="broker",
        analytics={
            "futures": {
                "fee_profile": risk.FeeProfile().model_dump(mode="json"),
                "margin": 200,
            }
        },
    )
    rows = [
        {
            "broker_order_id": "broker",
            "execution_id": "one",
            "exchange": "NFO",
            "side": "SELL",
            "quantity": 5,
            "price": 100,
            "timestamp": 1,
        },
        {
            "broker_order_id": "broker",
            "execution_id": "two",
            "exchange": "NFO",
            "side": "SELL",
            "quantity": 5,
            "price": 102,
            "timestamp": 2,
        },
    ]
    result = futures_real.confirmed_trades(session, rows, {order.order_id: order})
    assert [t.price for t in result] == [100, 102]
    assert (
        sum(t.commission for t in result)
        == risk.fees(risk.FeeProfile(), "NFO", "SELL", 101, 10)["total"]
    )
    assert sum(t.analytics["futures"]["entry_margin"] for t in result) == 200
    assert all(
        t.expiry == session.expiry and t.instrument_type == "futures" for t in result
    )
    with pytest.raises(ValueError, match="Unowned"):
        futures_real.confirmed_trades(
            session, [{**rows[0], "broker_order_id": "other"}], {order.order_id: order}
        )


def test_real_rebuild_keeps_settlement_basis_and_economic_basis_separate(monkeypatch):
    from datetime import UTC, datetime

    from app.services import futures_ledger as ledger
    from app.services import futures_real as real
    from app.services import trading

    def stamp(day):
        return int(
            datetime.fromisoformat(day + "T09:30:00").replace(tzinfo=UTC).timestamp()
        )

    session = SimpleNamespace(
        session_id="s",
        user_id="u",
        symbol="NIFTY",
        expiry="2026-10-27",
        execution_broker="kite",
        broker_account_id="a",
        portfolio_id="p",
        future_contract=contract(),
    )
    from app.models.schemas import Trade, TradeSide

    fills = [
        Trade(
            session_id="s",
            user_id="u",
            symbol="NIFTY",
            side=TradeSide.SELL,
            quantity=10,
            price=100,
            timestamp=stamp("2026-10-12"),
            trade_id="entry",
            instrument_type="futures",
            expiry=session.expiry,
            commission=2,
            analytics={"futures": {"entry_margin": 200}},
        ),
        Trade(
            session_id="s",
            user_id="u",
            symbol="NIFTY",
            side=TradeSide.BUY,
            quantity=5,
            price=80,
            timestamp=stamp("2026-10-13"),
            trade_id="cover",
            instrument_type="futures",
            expiry=session.expiry,
            commission=1,
            analytics={"futures": {"entry_margin": 0}},
        ),
    ]
    state = ledger.empty()
    state["settlements"] = {
        "2026-10-12": {"price": 90, "cash_change": 100, "source": "official"}
    }
    row = {"ledger": state, "version": 1}
    monkeypatch.setattr(ledger, "read", lambda _: row)
    monkeypatch.setattr(trading, "get_trades", lambda _: fills)
    writes = []

    def save(_s, _row, state):
        writes.append(state)
        row["ledger"] = state

    monkeypatch.setattr(real, "save_ledger", save)
    real.rebuild(session)
    metrics = ledger.values(row["ledger"], 80)
    assert metrics["cash_profit"] == 150 and metrics["held_margin"] == 100
    assert metrics["economic_pnl"] == 197 and metrics["unsettled_pnl"] == 50
    real.rebuild(session)
    assert len(writes) == 1


@pytest.mark.asyncio
async def test_futures_renewal_clears_prior_cancel_and_conversion_state(monkeypatch):
    from unittest.mock import AsyncMock

    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import broker_order_service, futures_real, order_service

    child = SimpleNamespace(
        session_id="s",
        execution_broker="kite",
        future_contract=contract(),
        date="2026-10-13",
    )
    old = Order(
        session_id="s",
        user_id="u",
        symbol="NIFTY",
        side=TradeSide.BUY,
        order_type=OrderType.STOPLOSS,
        quantity=5,
        created_at=1,
        limit_price=101,
        trigger_price=100,
        broker_order_id="old",
        cancel_request_id="cancel",
        cancellation_status="confirmed",
        broker_conversion={"state": "confirmed"},
        split_operation={"state": "confirmed"},
        expiry="2026-10-27",
        analytics={
            "futures": {"fee_profile": risk.FeeProfile().model_dump(mode="json")}
        },
    )
    monkeypatch.setattr(risk, "settings", lambda: risk.RiskSettings())
    monkeypatch.setattr(order_service, "_write_order_to_db", lambda *a, **k: None)
    monkeypatch.setattr(order_service, "_orders", {"s": {old.order_id: old}})
    submit = AsyncMock()
    monkeypatch.setattr(broker_order_service, "submit_immediate_async", submit)
    await futures_real.renew_exit(child, old, 5, "renewed", {"time": 2, "close": 102})
    renewed = order_service._orders["s"]["renewed"]
    assert renewed.side == TradeSide.BUY and renewed.order_type == OrderType.LIMIT
    assert (
        renewed.cancel_request_id is None
        and renewed.broker_conversion is None
        and renewed.split_operation is None
    )
    assert renewed.expiry == "2026-10-27" and renewed.broker_order_id is None
    submit.assert_awaited_once_with(child, renewed)
