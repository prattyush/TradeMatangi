"""
Tests for session_cleanup_service (cascade delete) and wallet_service.delete_entry.
"""
import pytest
from unittest.mock import patch, MagicMock, call

from app.services.session_cleanup_service import delete_session_cascade
from app.services import wallet_service


FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"
SESSION_ID = "test-session-001"
DATE = "2026-05-06"


def _make_mock_resource():
    """Create a mock DynamoDB resource with a mock table."""
    mock_resource = MagicMock()
    mock_table = MagicMock()
    mock_resource.Table.return_value = mock_table
    mock_table.query.return_value = {"Items": []}
    return mock_resource, mock_table


def _make_mock_client():
    """Create a mock DynamoDB client."""
    mock_client = MagicMock()
    mock_client.batch_write_item.return_value = {"UnprocessedItems": {}}
    return mock_client


class TestDeleteSessionCascade:
    @patch("app.services.db.get_dynamodb_client")
    @patch("app.services.db.get_dynamodb_resource")
    @patch("app.services.snapshot_service.delete_snapshots")
    @patch("app.services.simulation.get_session", return_value=None)
    @patch("app.services.wallet_service.delete_entry")
    def test_deletes_session_record(
        self, mock_delete_entry, mock_get_session, mock_delete_snapshots,
        mock_get_resource, mock_get_client,
    ):
        mock_resource, mock_table = _make_mock_resource()
        mock_get_resource.return_value = mock_resource
        mock_get_client.return_value = _make_mock_client()

        delete_session_cascade(SESSION_ID, FIXED_USER_ID, DATE)

        mock_table.delete_item.assert_called_once_with(Key={"session_id": SESSION_ID})

    @patch("app.services.db.get_dynamodb_client")
    @patch("app.services.db.get_dynamodb_resource")
    @patch("app.services.snapshot_service.delete_snapshots")
    @patch("app.services.simulation.get_session", return_value=None)
    @patch("app.services.wallet_service.delete_entry")
    def test_deletes_wallet_entry(
        self, mock_delete_entry, mock_get_session, mock_delete_snapshots,
        mock_get_resource, mock_get_client,
    ):
        mock_resource, mock_table = _make_mock_resource()
        mock_get_resource.return_value = mock_resource
        mock_get_client.return_value = _make_mock_client()

        delete_session_cascade(SESSION_ID, FIXED_USER_ID, DATE)

        mock_delete_entry.assert_called_once_with(FIXED_USER_ID, DATE)

    @patch("app.services.db.get_dynamodb_client")
    @patch("app.services.db.get_dynamodb_resource")
    @patch("app.services.snapshot_service.delete_snapshots")
    @patch("app.services.simulation.get_session", return_value=None)
    @patch("app.services.wallet_service.delete_entry")
    def test_calls_delete_snapshots(
        self, mock_delete_entry, mock_get_session, mock_delete_snapshots,
        mock_get_resource, mock_get_client,
    ):
        mock_resource, mock_table = _make_mock_resource()
        mock_get_resource.return_value = mock_resource
        mock_get_client.return_value = _make_mock_client()

        delete_session_cascade(SESSION_ID, FIXED_USER_ID, DATE)

        mock_delete_snapshots.assert_called_once_with(SESSION_ID)

    @patch("app.services.db.get_dynamodb_client")
    @patch("app.services.db.get_dynamodb_resource")
    @patch("app.services.snapshot_service.delete_snapshots")
    @patch("app.services.simulation.get_session", return_value=None)
    @patch("app.services.wallet_service.delete_entry")
    def test_batch_deletes_trades(
        self, mock_delete_entry, mock_get_session, mock_delete_snapshots,
        mock_get_resource, mock_get_client,
    ):
        trade1 = {"session_id": SESSION_ID, "trade_id": "t1"}
        trade2 = {"session_id": SESSION_ID, "trade_id": "t2"}

        # Create separate mock tables for different tables
        tables = {}
        def get_table(name):
            if name not in tables:
                t = MagicMock()
                t.query.return_value = {"Items": []}
                tables[name] = t
            return tables[name]

        mock_resource = MagicMock()
        mock_resource.Table.side_effect = get_table
        # Set Trades table to return items
        trades_table = get_table("Trades")
        trades_table.query.return_value = {"Items": [trade1, trade2]}

        mock_get_resource.return_value = mock_resource
        mock_client = _make_mock_client()
        mock_get_client.return_value = mock_client

        delete_session_cascade(SESSION_ID, FIXED_USER_ID, DATE)

        # Verify batch_write_item was called with delete requests for Trades
        calls = mock_client.batch_write_item.call_args_list
        trades_call = None
        for c in calls:
            req_items = c[1].get("RequestItems")
            if req_items and "Trades" in req_items:
                trades_call = req_items["Trades"]
                break
        assert trades_call is not None
        assert len(trades_call) == 2


class TestWalletDeleteEntry:
    def test_removes_from_in_memory_cache(self):
        wallet_service._wallets[(FIXED_USER_ID, DATE)] = 100000.0
        mock_resource = MagicMock()
        mock_table = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            wallet_service.delete_entry(FIXED_USER_ID, DATE)

        assert (FIXED_USER_ID, DATE) not in wallet_service._wallets
        mock_table.delete_item.assert_called_once_with(
            Key={"user_id": FIXED_USER_ID, "date": DATE}
        )

    def test_handles_missing_entry_gracefully(self):
        wallet_service._wallets.pop((FIXED_USER_ID, DATE), None)
        mock_resource = MagicMock()
        mock_table = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            wallet_service.delete_entry(FIXED_USER_ID, DATE)

        mock_table.delete_item.assert_called_once()

    def test_handles_db_error_gracefully(self):
        wallet_service._wallets[(FIXED_USER_ID, DATE)] = 50000.0
        mock_resource = MagicMock()
        mock_resource.Table.side_effect = RuntimeError("DB unreachable")

        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            wallet_service.delete_entry(FIXED_USER_ID, DATE)

        # Should still remove from in-memory cache even if DB fails
        assert (FIXED_USER_ID, DATE) not in wallet_service._wallets


class TestCleanupStorageCorrectness:
    def test_paginates_preserves_numeric_keys_and_retries(self):
        from decimal import Decimal
        from app.services.session_cleanup_service import _batch_delete_composite_key
        resource, table = _make_mock_resource()
        table.query.side_effect = [
            {"Items": [{"session_id": SESSION_ID, "round_trip_index": Decimal(1)}],
             "LastEvaluatedKey": {"session_id": SESSION_ID, "round_trip_index": Decimal(1)}},
            {"Items": [{"session_id": SESSION_ID, "round_trip_index": Decimal(2)}]},
        ]
        client = _make_mock_client()
        pending = [{"DeleteRequest": {"Key": {"session_id": {"S": SESSION_ID}, "round_trip_index": {"N": "1"}}}}]
        client.batch_write_item.side_effect = [{"UnprocessedItems": {"TradeLabels": pending}}, {"UnprocessedItems": {}}]
        with patch("app.services.db.get_dynamodb_resource", return_value=resource), patch("app.services.db.get_dynamodb_client", return_value=client), patch("time.sleep"):
            assert _batch_delete_composite_key("TradeLabels", "session_id", "round_trip_index", SESSION_ID) == 2
        assert table.query.call_count == 2
        assert client.batch_write_item.call_args_list[1].kwargs["RequestItems"]["TradeLabels"] == pending
        first = client.batch_write_item.call_args_list[0].kwargs["RequestItems"]["TradeLabels"]
        assert first[1]["DeleteRequest"]["Key"]["round_trip_index"] == {"N": "2"}

    @pytest.mark.parametrize("name,index,row,expected", [
        ("Strategies", "SessionIdIndex", {"session_id": SESSION_ID, "strategy_id": "s"}, {"strategy_id": {"S": "s"}}),
        ("AICommands", "SessionCommandsIndex", {"session_id": SESSION_ID, "user_id": FIXED_USER_ID, "command_id": "c"}, {"user_id": {"S": FIXED_USER_ID}, "command_id": {"S": "c"}}),
    ])
    def test_gsi_uses_actual_table_key(self, name, index, row, expected):
        from app.services.session_cleanup_service import _batch_delete_by_query
        resource, table = _make_mock_resource()
        table.query.return_value = {"Items": [row]}
        client = _make_mock_client()
        with patch("app.services.db.get_dynamodb_resource", return_value=resource), patch("app.services.db.get_dynamodb_client", return_value=client):
            _batch_delete_by_query(name, "session_id", SESSION_ID, index)
        assert client.batch_write_item.call_args.kwargs["RequestItems"][name][0]["DeleteRequest"]["Key"] == expected

    def test_storage_failure_keeps_session_root_and_wallet(self):
        resource, table = _make_mock_resource()
        with patch("app.services.db.get_dynamodb_resource", return_value=resource), patch("app.services.simulation.get_session", return_value=None), patch("app.services.session_cleanup_service._batch_delete_composite_key", side_effect=RuntimeError("storage down")), patch("app.services.wallet_service.delete_entry") as wallet:
            with pytest.raises(RuntimeError, match="storage down"):
                delete_session_cascade(SESSION_ID, FIXED_USER_ID, DATE)
        table.delete_item.assert_not_called()
        wallet.assert_not_called()

    def test_unprocessed_items_exhaustion_raises(self):
        from app.services.session_cleanup_service import _batch_delete_composite_key
        resource, table = _make_mock_resource()
        table.query.return_value = {"Items": [{"session_id": SESSION_ID, "trade_id": "t"}]}
        client = _make_mock_client()
        client.batch_write_item.return_value = {"UnprocessedItems": {"Trades": [{"DeleteRequest": {"Key": {"session_id": {"S": SESSION_ID}, "trade_id": {"S": "t"}}}}]}}
        with patch("app.services.db.get_dynamodb_resource", return_value=resource), patch("app.services.db.get_dynamodb_client", return_value=client), patch("time.sleep"):
            with pytest.raises(RuntimeError, match="Incomplete deletion"):
                _batch_delete_composite_key("Trades", "session_id", "trade_id", SESSION_ID)
        assert client.batch_write_item.call_count == 5
