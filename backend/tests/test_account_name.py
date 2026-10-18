"""Account name backfill: confirmed write result and actionable failures."""
from unittest.mock import MagicMock, patch
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from app.main import app
from app.services.user_service import set_account_name

USER = {"user_id": "owner", "email": "owner@example.com", "account_name": "Tablet"}


def test_returns_atomic_write_result_without_stale_profile_read():
    table = MagicMock()
    table.update_item.return_value = {"Attributes": USER}
    resource = MagicMock()
    resource.Table.return_value = table
    with patch("app.services.db.get_dynamodb_resource", return_value=resource), patch("app.services.user_service.get_user_info") as read:
        assert set_account_name("owner", "Tablet")["account_name"] == "Tablet"
    read.assert_not_called()
    write = table.update_item.call_args.kwargs
    assert write["ReturnValues"] == "ALL_NEW"
    assert write["ConditionExpression"] == "attribute_exists(user_id)"
    assert write["Key"] == {"user_id": "owner"}


@pytest.mark.parametrize("code,missing", [("ConditionalCheckFailedException", True), ("ProvisionedThroughputExceededException", False)])
def test_missing_user_differs_from_database_failure(code, missing):
    resource = MagicMock()
    resource.Table.return_value.update_item.side_effect = ClientError({"Error": {"Code": code}}, "UpdateItem")
    with patch("app.services.db.get_dynamodb_resource", return_value=resource):
        if missing:
            assert set_account_name("owner", "Tablet") is None
        else:
            with pytest.raises(RuntimeError, match="Could not save account name"):
                set_account_name("owner", "Tablet")


def test_connection_failure_reports_save_error():
    with patch("app.services.db.get_dynamodb_resource", side_effect=OSError("offline")):
        with pytest.raises(RuntimeError, match="Could not save account name"):
            set_account_name("owner", "Tablet")


def test_endpoint_trims_and_returns_confirmed_name():
    with patch("app.routers.auth.set_account_name", return_value=USER) as write:
        response = TestClient(app).post("/api/auth/account-name", headers={"X-User-Id": "owner"}, json={"account_name": " Tablet "})
    assert response.status_code == 200
    assert response.json()["account_name"] == "Tablet"
    write.assert_called_once_with("owner", "Tablet")


@pytest.mark.parametrize("result,status,message", [(None,404,"User not found"), (RuntimeError("Could not save account name. Please retry."),500,"Could not save account name")])
def test_endpoint_failures_are_actionable(result,status,message):
    with patch("app.routers.auth.set_account_name") as write:
        if isinstance(result, Exception):
            write.side_effect = result
        else:
            write.return_value = result
        response = TestClient(app).post("/api/auth/account-name", headers={"X-User-Id":"owner"}, json={"account_name":"Tablet"})
    assert response.status_code == status
    assert message in response.json()["detail"]


def test_empty_name_is_rejected_without_write():
    with patch("app.routers.auth.set_account_name") as write:
        response = TestClient(app).post("/api/auth/account-name", headers={"X-User-Id":"owner"}, json={"account_name":"   "})
    assert response.status_code == 400
    write.assert_not_called()


@pytest.mark.parametrize("email", [USER["email"], None])
def test_save_against_dynamodb_engine(email):
    """Exercise real DynamoDB expressions instead of mocking update_item."""
    import boto3
    from moto import mock_aws
    with mock_aws():
        database = boto3.resource("dynamodb", region_name="ap-south-1")
        table = database.create_table(
            TableName="Users",
            KeySchema=[{"AttributeName":"user_id", "KeyType":"HASH"}],
            AttributeDefinitions=[{"AttributeName":"user_id", "AttributeType":"S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        item = {"user_id":"owner"}
        if email is not None:
            item["email"] = email
        table.put_item(Item=item)
        with patch("app.services.db.get_dynamodb_resource", return_value=database):
            client = TestClient(app)
            before = client.get("/api/auth/me", headers={"X-User-Id":"owner"})
            assert before.status_code == 200, before.text
            assert before.json()["email"] == (email or "")
            response = client.post("/api/auth/account-name", headers={"X-User-Id":"owner"}, json={"account_name":" Tablet "})
            after = client.get("/api/auth/me", headers={"X-User-Id":"owner"})
            assert after.status_code == 200, after.text
            assert after.json()["account_name"] == "Tablet"
        assert response.status_code == 200, response.text
        assert response.json()["account_name"] == "Tablet"
        assert table.get_item(Key={"user_id":"owner"}, ConsistentRead=True)["Item"]["account_name"] == "Tablet"
