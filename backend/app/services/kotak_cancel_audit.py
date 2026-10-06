"""Cancellation evidence captured before SDK model conversion; no auth frames."""
import json
import logging
from logging.handlers import TimedRotatingFileHandler
import threading
import sys
from datetime import datetime, timezone

_lock = threading.Lock()
_logger = logging.getLogger('kotak.cancellations')


def redact(value):
    if isinstance(value, dict):
        return {key: '[REDACTED]' if (key.lower() in ('auth', 'sid') or any(secret in key.lower() for secret in
                ('authorization', 'token', 'password', 'mpin', 'secret', 'consumer_key', 'access_key')))
                and key.lower() not in ('tok', 'instrument_token', 'instrumenttoken') else redact(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str) and value.lstrip().startswith(('{', '[')):
        try:
            return json.dumps(redact(json.loads(value)))
        except (ValueError, TypeError):
            pass
    return value


def record(frame, *, stage='wire'):
    try:
        if isinstance(frame, (bytes, bytearray)):
            frame = frame.decode('utf-8')
        if isinstance(frame, str):
            frame = json.loads(frame)
        if not isinstance(frame, dict) or frame.get('type') not in ('order', 'order_feed'):
            return
        envelope = frame
        if frame.get('type') == 'order_feed':
            envelope = frame.get('data')
            if isinstance(envelope, str):
                envelope = json.loads(envelope)
        if not isinstance(envelope, dict):
            return
        rows = envelope.get('data', {})
        rows = rows if isinstance(rows, list) else [rows]
        cancelled = [row for row in rows if isinstance(row, dict) and str(row.get('ordSt') or row.get('stat') or row.get('status') or '').strip().lower().replace('_', ' ') in ('cancelled', 'canceled', 'cancel pending')]
        if not cancelled:
            return
        with _lock:
            if not _logger.handlers and 'pytest' not in sys.modules:
                from app.config import LOG_DIR
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                handler = TimedRotatingFileHandler(LOG_DIR / 'kotak-cancellations.ndjson', when='midnight', backupCount=30, encoding='utf-8')
                handler.setFormatter(logging.Formatter('%(message)s'))
                _logger.addHandler(handler)
                _logger.setLevel(logging.INFO)
                _logger.propagate = False
        _logger.setLevel(logging.INFO)
        _logger.info(json.dumps({'received_at': datetime.now(timezone.utc).isoformat(), 'stage': stage,
                                'order_ids': [str(row.get('nOrdNo') or '') for row in cancelled],
                                'payload': redact(frame)}, default=str))
    except Exception:
        logging.getLogger(__name__).exception('kotak_cancel_raw_audit_failed stage=%s', stage)


_event_logger = logging.getLogger('kotak.events')


def record_event(frame, *, stage='wire'):
    """Capture raw order/position evidence with rotation and existing secret redaction."""
    try:
        if isinstance(frame, (bytes, bytearray)):
            frame = frame.decode('utf-8')
        if isinstance(frame, str):
            frame = json.loads(frame)
        if not isinstance(frame, dict) or frame.get('type') not in ('order', 'order_feed', 'position'):
            return
        with _lock:
            if not _event_logger.handlers and 'pytest' not in sys.modules:
                from app.config import LOG_DIR
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                handler = TimedRotatingFileHandler(LOG_DIR / 'kotak-events.ndjson', when='midnight', backupCount=30, encoding='utf-8')
                handler.setFormatter(logging.Formatter('%(message)s'))
                _event_logger.addHandler(handler)
                _event_logger.propagate = False
            _event_logger.setLevel(logging.INFO)
        _event_logger.info(json.dumps({'received_at': datetime.now(timezone.utc).isoformat(),
                                      'stage': stage, 'payload': redact(frame)}, default=str))
    except Exception:
        logging.getLogger(__name__).exception('kotak_event_raw_audit_failed stage=%s', stage)
