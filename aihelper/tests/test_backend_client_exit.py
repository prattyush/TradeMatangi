"""
Unit tests for the new exit-action functions in services/backend_client.py.

Covers:
  - get_position: returns dict from backend
  - get_open_orders: returns list from backend
  - update_stoploss_order: PATCHes the correct endpoint with trigger_price
  - create_stoploss_order: POSTs to /api/orders with is_stoploss=True
  - update_or_create_stoploss: updates existing SL when found; creates new when none
  - exit_position_market: POSTs to /api/trades/sell
  - start_takeprofit_strategy: POSTs to /api/strategies/start with TargetProfit
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_STUB_MODULES = ["config", "state", "litellm"]
for _mod in _STUB_MODULES:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

import config as _cfg  # noqa: E402
_cfg.BACKEND_URL = "http://localhost:8700"

from services import backend_client  # noqa: E402


def _mock_response(json_data, status_code=200):
    """Build a mock httpx response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status = MagicMock()
    return resp


class TestGetPosition:
    @pytest.mark.asyncio
    async def test_returns_position_dict(self):
        expected = {"side": "LONG", "qty": 50, "avg_entry": 99.0, "entry_commission": 1.0}
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.get_position("sess-001", "CE")
        mock_client.get.assert_called_once_with("/api/trades/position", params={"session_id": "sess-001", "right": "CE"})
        assert result == expected

    @pytest.mark.asyncio
    async def test_omits_right_param_when_none(self):
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=_mock_response({"side": "FLAT"}))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            await backend_client.get_position("sess-001", None)
        call_params = mock_client.get.call_args.kwargs["params"]
        assert "right" not in call_params


class TestGetOpenOrders:
    @pytest.mark.asyncio
    async def test_returns_list_of_orders(self):
        expected = [{"order_id": "o1", "is_stoploss": True, "right": "CE"}]
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.get_open_orders("sess-001")
        mock_client.get.assert_called_once_with(
            "/api/orders", params={"session_id": "sess-001", "open_only": "true"}
        )
        assert result == expected


class TestUpdateStoplossOrder:
    @pytest.mark.asyncio
    async def test_patches_correct_endpoint(self):
        expected = {"order_id": "o1", "trigger_price": 97.0}
        mock_client = MagicMock()
        mock_client.patch = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.update_stoploss_order("sess-001", "o1", 97.0)
        mock_client.patch.assert_called_once_with(
            "/api/orders/o1",
            params={"session_id": "sess-001"},
            json={"trigger_price": 97.0},
        )
        assert result == expected


class TestCreateStoplossOrder:
    @pytest.mark.asyncio
    async def test_posts_with_is_stoploss_true(self):
        expected = {"order_id": "o2"}
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.create_stoploss_order("sess-001", "CE", 97.0, 50)
        body = mock_client.post.call_args.kwargs["json"]
        assert body["is_stoploss"] is True
        assert body["order_type"] == "STOPLOSS"
        assert body["trigger_price"] == 97.0
        assert body["quantity"] == 50
        assert body["right"] == "CE"
        assert body["side"] == "SELL"


class TestUpdateOrCreateStoploss:
    @pytest.mark.asyncio
    async def test_updates_existing_stoploss_when_found(self):
        open_orders = [{"order_id": "existing-sl", "is_stoploss": True, "right": "CE"}]
        position = {"side": "LONG", "qty": 50}
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(return_value=open_orders)), \
             patch.object(backend_client, "update_stoploss_order", new=AsyncMock(return_value={"ok": True})) as mock_update, \
             patch.object(backend_client, "create_stoploss_order", new=AsyncMock()) as mock_create:
            result = await backend_client.update_or_create_stoploss("sess-001", "CE", 97.0, position)
        mock_update.assert_called_once_with("sess-001", "existing-sl", 97.0)
        mock_create.assert_not_called()
        assert result["action"] == "updated"

    @pytest.mark.asyncio
    async def test_creates_new_stoploss_when_none_found(self):
        open_orders = [{"order_id": "limit-order", "is_stoploss": False, "right": "CE"}]
        position = {"side": "LONG", "qty": 50}
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(return_value=open_orders)), \
             patch.object(backend_client, "update_stoploss_order", new=AsyncMock()) as mock_update, \
             patch.object(backend_client, "create_stoploss_order", new=AsyncMock(return_value={"ok": True})) as mock_create:
            result = await backend_client.update_or_create_stoploss("sess-001", "CE", 97.0, position)
        mock_update.assert_not_called()
        mock_create.assert_called_once_with("sess-001", "CE", 97.0, 50, side="SELL")
        assert result["action"] == "created"

    @pytest.mark.asyncio
    async def test_short_position_uses_buy_side_for_stoploss(self):
        open_orders = []
        position = {"side": "SHORT", "qty": 50}
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(return_value=open_orders)), \
             patch.object(backend_client, "create_stoploss_order", new=AsyncMock(return_value={"ok": True})) as mock_create:
            await backend_client.update_or_create_stoploss("sess-001", "PE", 103.0, position)
        call_kwargs = mock_create.call_args
        assert call_kwargs.kwargs["side"] == "BUY"


class TestExitPositionMarket:
    @pytest.mark.asyncio
    async def test_posts_to_trades_sell(self):
        expected = {"trade_id": "t1"}
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.exit_position_market("sess-001", "CE")
        mock_client.post.assert_called_once_with(
            "/api/trades/sell", json={"session_id": "sess-001", "right": "CE"}
        )
        assert result == expected


class TestCancelOpenStoploss:
    @pytest.mark.asyncio
    async def test_deletes_sl_orders_for_right(self):
        open_orders = [
            {"order_id": "sl-001", "is_stoploss": True, "right": "CE"},
            {"order_id": "limit-001", "is_stoploss": False, "right": "CE"},
            {"order_id": "sl-002", "is_stoploss": True, "right": "PE"},
        ]
        mock_client = MagicMock()
        mock_client.delete = AsyncMock(return_value=_mock_response({"ok": True}))
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(return_value=open_orders)), \
             patch.object(backend_client, "get_client", return_value=mock_client):
            await backend_client.cancel_open_stoploss("sess-001", "CE")
        # Only the CE SL order should be deleted
        assert mock_client.delete.call_count == 1
        call_args = mock_client.delete.call_args
        assert "sl-001" in call_args.args[0]

    @pytest.mark.asyncio
    async def test_no_delete_when_no_sl_for_right(self):
        open_orders = [{"order_id": "sl-pe", "is_stoploss": True, "right": "PE"}]
        mock_client = MagicMock()
        mock_client.delete = AsyncMock(return_value=_mock_response({}))
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(return_value=open_orders)), \
             patch.object(backend_client, "get_client", return_value=mock_client):
            await backend_client.cancel_open_stoploss("sess-001", "CE")
        mock_client.delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_swallows_exceptions(self):
        with patch.object(backend_client, "get_open_orders", new=AsyncMock(side_effect=Exception("network error"))):
            await backend_client.cancel_open_stoploss("sess-001", "CE")  # must not raise


class TestStartTakeprofitStrategy:
    @pytest.mark.asyncio
    async def test_posts_target_profit_strategy(self):
        expected = {"strategy_id": "s1"}
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=_mock_response(expected))
        with patch.object(backend_client, "get_client", return_value=mock_client):
            result = await backend_client.start_takeprofit_strategy("sess-001", "CE", 103.0)
        body = mock_client.post.call_args.kwargs["json"]
        assert body["strategy_type"] == "TargetProfit"
        assert body["target_profit_value"] == 103.0
        assert body["target_profit_is_pct"] is False
        assert body["right"] == "CE"
        assert result == expected
