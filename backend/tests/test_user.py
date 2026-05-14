"""
Unit tests for user_service.
"""
import pytest
from unittest.mock import patch, MagicMock
from app.services import user_service as svc
from app.config import FIXED_USER_ID


class TestGetUserId:
    def test_returns_fixed_uuid(self):
        assert svc.get_user_id() == FIXED_USER_ID

    def test_uuid_format(self):
        uid = svc.get_user_id()
        parts = uid.split("-")
        assert len(parts) == 5


class TestSeedUser:
    def test_seed_writes_to_db(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # no "Item" key → triggers put_item
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table

        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            svc.seed_user()

        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args[1]["Item"]
        assert call_args["user_id"] == FIXED_USER_ID
        assert call_args["email"] == "admin@tradematangi.com"
        assert "password_hash" in call_args

    def test_seed_swallows_db_error(self):
        """seed_user must not raise even if DynamoDB is unavailable."""
        with patch("app.services.db.get_dynamodb_resource", side_effect=Exception("DB down")):
            svc.seed_user()  # should not raise
