"""
FastAPI shared dependencies.
"""
from fastapi import Header
from app.config import FIXED_USER_ID


def get_request_user_id(x_user_id: str = Header(default=FIXED_USER_ID)) -> str:
    """
    Read the logged-in user's ID from the X-User-Id request header.
    Falls back to FIXED_USER_ID when the header is absent (tests, dev without auth).
    """
    return x_user_id or FIXED_USER_ID
