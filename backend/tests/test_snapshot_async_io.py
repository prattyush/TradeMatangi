import asyncio
import threading
import pytest
from app.routers import snapshots


@pytest.mark.asyncio
async def test_snapshot_save_runs_off_loop(monkeypatch):
    started, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    threads = []
    def save(session_id, data):
        threads.append(threading.get_ident())
        started.set()
        assert release.wait(2)
        return data['event_id']
    monkeypatch.setattr(snapshots.snapshot_service, 'save_snapshot', save)
    task = asyncio.create_task(snapshots.store_snapshot(snapshots.SnapshotPayload(event_id='e', session_id='s')))
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(.001)
        assert started.is_set() and not task.done()
        assert threads != [loop_thread]
    finally:
        release.set()
        result = await task
    assert result['status'] == 'stored'
