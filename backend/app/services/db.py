"""
DynamoDB client factory.
Reads AWS credentials from data/accesskeys.ini [aws] section on every call
so that credential updates take effect without a backend restart.
Set USE_DYNAMODB_LOCAL=false to target real AWS DynamoDB.
"""
from __future__ import annotations

import configparser
import boto3
from boto3.resources.base import ServiceResource
from botocore.client import BaseClient

from app.config import (
    DATA_DIR,
    USE_DYNAMODB_LOCAL,
    DYNAMODB_LOCAL_ENDPOINT,
    DYNAMODB_REGION,
)

_CREDENTIALS_PATH = DATA_DIR / "accesskeys.ini"


def _read_aws_credentials() -> dict[str, str] | None:
    """
    Read [aws] section from accesskeys.ini.
    Returns None when absent so the boto3 credential chain (env vars, instance
    profile) is used instead — important for real AWS deployments.
    """
    config = configparser.ConfigParser()
    config.read(_CREDENTIALS_PATH)
    if "aws" in config:
        section = config["aws"]
        return {
            "aws_access_key_id": section.get("aws_access_key_id", ""),
            "aws_secret_access_key": section.get("aws_secret_access_key", ""),
        }
    return None


def _build_kwargs() -> dict:
    kwargs: dict = {"region_name": DYNAMODB_REGION}
    if USE_DYNAMODB_LOCAL:
        # DynamoDB Local ignores credentials entirely.  Never pass real AWS keys
        # here — temporary STS keys (ASIA*) cause UnrecognizedClientException in
        # some DynamoDB Local versions even though the endpoint is local.
        kwargs["endpoint_url"] = DYNAMODB_LOCAL_ENDPOINT
        kwargs["aws_access_key_id"] = "fakeKey"
        kwargs["aws_secret_access_key"] = "fakeSecret"
    else:
        # Real AWS: only pass explicit creds if present; otherwise boto3
        # falls back to env vars / instance profile automatically.
        creds = _read_aws_credentials()
        if creds:
            kwargs.update(creds)
    return kwargs


def get_dynamodb_resource() -> ServiceResource:
    """Return a boto3 DynamoDB resource (high-level API)."""
    return boto3.resource("dynamodb", **_build_kwargs())


def get_dynamodb_client() -> BaseClient:
    """Return a boto3 DynamoDB client (low-level API)."""
    return boto3.client("dynamodb", **_build_kwargs())
