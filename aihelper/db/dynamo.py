"""
DynamoDB client factory — mirrors the backend pattern.
Uses DynamoDB Local for development; set USE_DYNAMODB_LOCAL=false for real AWS.
"""
import boto3
from boto3.resources.base import ServiceResource

from config import (
    USE_DYNAMODB_LOCAL,
    DYNAMODB_LOCAL_ENDPOINT,
    DYNAMODB_REGION,
)


def _build_kwargs() -> dict:
    kwargs: dict = {"region_name": DYNAMODB_REGION}
    if USE_DYNAMODB_LOCAL:
        kwargs["endpoint_url"] = DYNAMODB_LOCAL_ENDPOINT
        kwargs["aws_access_key_id"] = "fakeKey"
        kwargs["aws_secret_access_key"] = "fakeSecret"
    return kwargs


def get_dynamodb_resource() -> ServiceResource:
    return boto3.resource("dynamodb", **_build_kwargs())


def get_dynamodb_client():
    return boto3.client("dynamodb", **_build_kwargs())
