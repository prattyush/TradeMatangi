"""Conditional durable-store behavior without AWS/network access."""
from copy import deepcopy
import threading


class MemoryJournal:
    def __init__(self):
        self.rows = {}
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            return deepcopy(self.rows.get(key))

    def put(self, key, value):
        with self.lock:
            self.rows[key] = deepcopy(value)

    def claim(self, key, value):
        with self.lock:
            if key in self.rows:
                return False
            self.rows[key] = deepcopy(value)
            return True

    def put_latest(self, key, value):
        with self.lock:
            previous = self.rows.get(key)
            if previous is None or previous['requested_at'] <= value['requested_at']:
                self.rows[key] = deepcopy(value)

    def for_session(self, session_id):
        with self.lock:
            return [(key, deepcopy(row)) for key, row in self.rows.items()
                    if row.get('session_id') == session_id and 'parent' in row and 'root_order_id' in row]
