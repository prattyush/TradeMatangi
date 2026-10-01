"""Access follows the stored email for either login method; broker APIs are unused."""
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from app.routers import admin, kotak
from app.models.schemas import WhitelistAddRequest
from app.services import user_service
from app.dependencies import require_real_trading_access


@pytest.mark.asyncio
@pytest.mark.parametrize("login_method", ["password", "google_new", "google_existing"])
async def test_admin_grant_and_revoke_work_for_each_login_method(login_method):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1",
                                  aws_access_key_id="testing", aws_secret_access_key="testing")
        users = resource.create_table(TableName="Users",
            KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                                  {"AttributeName": "email", "AttributeType": "S"}],
            GlobalSecondaryIndexes=[{"IndexName": "EmailIndex",
                "KeySchema": [{"AttributeName": "email", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"}}], BillingMode="PAY_PER_REQUEST")
        users.put_item(Item={"user_id": "admin", "email": "admin@example.com", "is_admin": True})
        users.put_item(Item={"user_id": "unrelated", "email": "unrelated@example.com"})
        response = MagicMock(status_code=200)
        response.json.return_value = {"aud": "google-client", "sub": "google-sub",
                                      "email": "TRADER@EXAMPLE.COM", "name": "Trader"}
        with patch("app.services.db.get_dynamodb_resource", return_value=resource), \
             patch("app.services.db.get_dynamodb_client", return_value=resource.meta.client), \
             patch.object(user_service, "_get_google_client_ids", return_value=["google-client"]), \
             patch.object(user_service.httpx, "get", return_value=response):
            registered = None
            if login_method != "google_new":
                registered = user_service.register_user("trader@example.com", "test-password")
            if login_method == "password":
                logged_in = user_service.login_user("TRADER@EXAMPLE.COM", "test-password")
            else:
                logged_in = user_service.google_auth("mock-token", account_name="Trader")
            assert logged_in["email"] == "trader@example.com"
            if registered:
                assert logged_in["user_id"] == registered["user_id"]
            user_id = logged_in["user_id"]
            assert await kotak.check_real_trading_access(user_id) == {"has_access": False}
            admin_id = admin._require_admin("admin")
            grant = await admin.add_real_trading_whitelist(
                WhitelistAddRequest(email="  TRADER@EXAMPLE.COM  "), user_id=admin_id)
            assert grant.email == "trader@example.com"
            assert await kotak.check_real_trading_access(user_id) == {"has_access": True}
            assert require_real_trading_access(user_id) == user_id
            assert await kotak.check_real_trading_access("unrelated") == {"has_access": False}
            await admin.remove_real_trading_whitelist("trader@example.com", user_id=admin_id)
            assert await kotak.check_real_trading_access(user_id) == {"has_access": False}
