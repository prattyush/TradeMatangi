"""
Video links service — saved YouTube links for Trading Video Maker videos (Phase 24, Y3).

Table
  VideoLinks  PK session_id, SK video_id   one row per (trading session, uploaded video)

A video that covers several sessions is saved once per session, so every session
shows it. The table holds only the link and a few labels, never the video or any
YouTube credential. The link is always rebuilt from the video id here; a client can
never store an arbitrary address.

Created lazily like BehaviorMarks, so deployments that never use the tool never get
the table. Deleting a session deletes its links (session_cleanup_service).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

TABLE = "VideoLinks"
PRIVACIES = ("private", "unlisted", "public")
TITLE_MAX_CHARS = 100
CHAPTERS_MAX_BYTES = 5000
MAX_LINKS_PER_SESSION = 50
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

_ENSURED = False


def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def ensure_table() -> None:
    global _ENSURED
    if _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_client
        if TABLE not in set(_resource().meta.client.list_tables()["TableNames"]):
            client = get_dynamodb_client()
            client.create_table(
                TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                KeySchema=[
                    {"AttributeName": "session_id", "KeyType": "HASH"},
                    {"AttributeName": "video_id", "KeyType": "RANGE"},
                ],
                AttributeDefinitions=[
                    {"AttributeName": "session_id", "AttributeType": "S"},
                    {"AttributeName": "video_id", "AttributeType": "S"},
                ],
            )
            client.get_waiter("table_exists").wait(TableName=TABLE)
            logger.info("Created %s table", TABLE)
        _ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", TABLE)


def _table():
    ensure_table()
    return _resource().Table(TABLE)


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _serialize(row: dict) -> dict:
    return {
        "session_id": row["session_id"],
        "video_id": row["video_id"],
        "url": watch_url(row["video_id"]),
        "title": row.get("title", ""),
        "privacy": row.get("privacy", "private"),
        "chapters": row.get("chapters", ""),
        "uploaded_at": row.get("uploaded_at", ""),
    }


def list_links(session_id: str) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    rows: list[dict] = []
    params = {"KeyConditionExpression": Key("session_id").eq(session_id), "ConsistentRead": True}
    table = _table()
    while True:
        page = table.query(**params)
        rows.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    # Newest upload first.
    return sorted((_serialize(r) for r in rows), key=lambda r: r["uploaded_at"], reverse=True)


def save_link(user_id: str, session_id: str, video_id: str, title: str, privacy: str, chapters: str = "") -> dict:
    """Store or update the link. Saving the same video again replaces its labels."""
    if not _VIDEO_ID.match(video_id or ""):
        raise ValueError("That is not a YouTube video id")
    cleaned_title = " ".join((title or "").split())
    if not cleaned_title:
        raise ValueError("The title must not be empty")
    if len(cleaned_title) > TITLE_MAX_CHARS:
        raise ValueError(f"The title must be at most {TITLE_MAX_CHARS} characters")
    if privacy not in PRIVACIES:
        raise ValueError("Visibility must be private, unlisted or public")
    chapters = chapters or ""
    if len(chapters.encode("utf-8")) > CHAPTERS_MAX_BYTES:
        raise ValueError(f"The chapter text must be at most {CHAPTERS_MAX_BYTES} bytes")
    existing = list_links(session_id)
    if len(existing) >= MAX_LINKS_PER_SESSION and not any(r["video_id"] == video_id for r in existing):
        raise ValueError(f"At most {MAX_LINKS_PER_SESSION} saved videos per session; remove one first")
    uploaded_at = next((r["uploaded_at"] for r in existing if r["video_id"] == video_id), "") or datetime.now(timezone.utc).isoformat()
    item = {
        "session_id": session_id,
        "video_id": video_id,
        "user_id": user_id,
        "title": cleaned_title,
        "privacy": privacy,
        "chapters": chapters,
        "uploaded_at": uploaded_at,
    }
    _table().put_item(Item=item)
    return _serialize(item)


def delete_link(session_id: str, video_id: str) -> None:
    """Remove the saved link only. The video on YouTube is not touched."""
    row = _table().get_item(Key={"session_id": session_id, "video_id": video_id}, ConsistentRead=True).get("Item")
    if not row:
        raise LookupError("Saved video not found")
    _table().delete_item(Key={"session_id": session_id, "video_id": video_id})
