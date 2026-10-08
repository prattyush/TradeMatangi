import asyncio
from unittest.mock import AsyncMock, Mock
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services import kotak_automation_policy as policy, kotak_protection as manager
from app.services import protection_recovery as recovery, kotak_reports, entry_sl_watcher, order_service
from tests.test_shared_desktop_settings import store
from tests.test_kotak_protection_recovery import env as recovery_env
from tests.test_kotak_entry_manager import env, entry

ORIGINAL_CHECK = policy.check


def test_switch_is_backend_saved_and_shared_by_both_clients(store):
    records, _ = store
    client = TestClient(app)
    headers = {'X-User-Id': 'switch-user'}
    assert client.get('/api/users/settings', headers=headers).json()['kotak_automated_protection_enabled'] is True
    result = client.put('/api/desktop/v1/trading/settings/current', headers=headers,
        json={'settings': {'kotak_automated_protection_enabled': False}})
    assert result.status_code == 200
    assert records['switch-user']['kotak_automated_protection_enabled'] is False
    assert not policy.enabled('switch-user')
    assert policy.enabled('other-user')
    assert client.get('/api/users/settings', headers=headers).json()['kotak_automated_protection_enabled'] is False
    assert client.put('/api/users/settings', headers=headers, json={'kotak_automated_protection_enabled': True}).status_code == 200
    assert policy.enabled('switch-user')


@pytest.mark.asyncio
async def test_old_read_cannot_override_live_disable(monkeypatch):
    gate = asyncio.Event()
    async def delayed(fn, *args, **kwargs):
        await gate.wait()
        return {'kotak_automated_protection_enabled': True}
    monkeypatch.setattr(asyncio, 'to_thread', delayed)
    task = asyncio.create_task(ORIGINAL_CHECK('user'))
    await asyncio.sleep(0)
    policy.apply('user', False)
    gate.set()
    assert await task is False


@pytest.mark.asyncio
async def test_settings_read_error_stops_automatic_work(monkeypatch):
    monkeypatch.setattr('app.services.user_settings_service.get_settings', Mock(side_effect=RuntimeError('offline')))
    assert await ORIGINAL_CHECK('user') is False


@pytest.mark.asyncio
async def test_disabled_manager_does_not_fetch_reports_or_place_sl(env, monkeypatch):
    s, broker, _ = env
    order = entry(s, 'a', 20)
    policy.apply(s.user_id, False)
    await manager.audit(s, broker)
    request = Mock()
    monkeypatch.setattr(manager, 'request', request)
    entry_sl_watcher.on_entry_filled(order, s)
    entry_sl_watcher._place_real_protection(order, s)
    broker.get_positions.assert_not_called()
    broker.place_options_sl_order.assert_not_called()
    request.assert_not_called()


@pytest.mark.asyncio
async def test_disable_before_submission_preserves_intent_without_sending(recovery_env, monkeypatch):
    s, parent, broker, _, _, job = recovery_env
    check = AsyncMock(side_effect=[True, False])
    monkeypatch.setattr(policy, 'check', check)
    with pytest.raises(recovery.Deferred, match='disabled'):
        await recovery._attempt(s, parent, 'operation', job, broker)
    broker.place_options_sl_order.assert_not_called()
    assert job['children'][0]['state'] == 'failed'


def test_disabled_legacy_cancel_recovery_does_not_start(recovery_env):
    s, parent, _, _, _, _ = recovery_env
    policy.apply(s.user_id, False)
    recovery.note_cancel(s, parent, {'raw': {}})
    assert not recovery._tasks


@pytest.mark.asyncio
async def test_queued_background_reports_stop_but_explicit_refresh_still_works(env):
    s, broker, _ = env
    account = kotak_reports.state(broker)
    account.foreground = 1
    task = asyncio.create_task(kotak_reports.fetch(broker, background=True, user_id=s.user_id))
    await asyncio.sleep(.01)
    policy.apply(s.user_id, False)
    account.foreground = 0
    with pytest.raises(RuntimeError, match='disabled'):
        await task
    broker.get_positions.assert_not_called()
    await kotak_reports.fetch(broker)
    broker.get_positions.assert_called_once()


@pytest.mark.asyncio
async def test_history_refresh_keeps_disabled_state_and_does_not_restart_manager(env, monkeypatch):
    from app.services import real_broker_state
    s, broker, _ = env
    entry(s, 'a', 20)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda *args, **kwargs: {'kotak_automated_protection_enabled': False})
    monkeypatch.setattr(policy, 'check', ORIGINAL_CHECK)
    result = await real_broker_state.refresh(s, broker)
    assert result['positions'] == []
    assert not policy.enabled(s.user_id)
    assert not manager._pending
    broker.place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_manual_reductions_still_record_intent_when_disabled(env, isolated_protection_journal):
    from tests.test_kotak_entry_manager import exit_order
    s, _, _ = env
    entry(s, 'a', 40)
    stop = exit_order(s, 'sl', 40, owner='a')
    policy.apply(s.user_id, False)
    await manager.suppress(s, stop, 20)
    saved = isolated_protection_journal.get(f'entry-exclusions:{s.session_id}')
    assert saved['sl']['allocations'] == {'a': 20}


@pytest.mark.asyncio
async def test_disabled_refresh_can_resolve_already_sent_orders_without_new_submission(recovery_env):
    s, parent, broker, rows, _, job = recovery_env
    job['parent'] = parent.model_dump(mode='json')
    place = broker.place_options_sl_order.side_effect
    def timeout(**kwargs):
        place(**kwargs)
        raise TimeoutError('accepted but response lost')
    broker.place_options_sl_order.side_effect = timeout
    with pytest.raises(recovery.Deferred):
        await recovery._attempt(s, parent, 'operation', job, broker)
    policy.apply(s.user_id, False)
    await manager.reconcile_sent_orders(s, broker, rows)
    broker.place_options_sl_order.assert_called_once()
    assert all(o.recovery_state != 'unknown' for o in order_service.get_open_orders(s.session_id))
