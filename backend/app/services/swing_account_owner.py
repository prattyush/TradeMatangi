"""Compatibility facade for broker/account/style ownership, never whole-account ownership."""
from app.services.real_session_slots import read, claim, close_action, adopt  # noqa: F401
