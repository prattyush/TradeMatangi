import json
import logging
import pytest
from unittest.mock import MagicMock
from app.services import kotak_service as ks, kotak_cancel_audit as audit, protection_journal as journal


def loop():
    result = MagicMock()
    result.call_soon_threadsafe.side_effect = lambda fn, *args: fn(*args)
    return result


def event(status, **fields):
    return {'type': 'order', 'data': {'nOrdNo': 'K', 'ordSt': status, **fields}}


def test_cancelled_status_reason_preserved_and_not_rejected():
    service = ks.KotakNeoService()
    cancelled, rejected = [], []
    service.register_cancel_callback('K', lambda kid, data: cancelled.append(data), loop())
    service.register_reject_callback('K', lambda *args: rejected.append(args), loop())
    service._on_message(event('cancelled', rjRsn='--'))
    assert len(cancelled) == 1 and rejected == []
    assert cancelled[0]['status'] == 'cancelled'
    assert cancelled[0]['raw_reason'] == '--' and cancelled[0]['reason'] is None


def test_partial_fill_applied_before_terminal_cancel():
    service = ks.KotakNeoService()
    events = []
    service.register_fill_callback('K', lambda *args: events.append(('fill', args[2])), loop())
    service.register_cancel_callback('K', lambda *args: events.append(('cancel', None)), loop())
    service._on_message(event('cancelled', fldQty=65, qty=130, avgPrc='40', trnsTp='S'))
    assert events == [('fill', 65), ('cancel', None)]


def test_early_cancel_dispatched_to_cancel_callback_only():
    service = ks.KotakNeoService()
    received = []
    service._on_message(event('cancelled', rejRsn='RMS policy'))
    service.register_fill_callback('K', lambda *args: None, loop())
    service.register_cancel_callback('K', lambda kid, metadata: received.append(metadata), loop())
    rejected = MagicMock()
    service.register_reject_callback('K', rejected, loop())
    assert received[0]['raw_reason'] == 'RMS policy'
    rejected.assert_not_called()


def test_duplicate_or_invalid_rows_do_not_trigger_unbound_status(caplog):
    service = ks.KotakNeoService()
    received = []
    service.register_cancel_callback('K', lambda *args: received.append(args), loop())
    service._on_message(event('cancelled'))
    service._on_message(event('cancelled'))
    service._on_message({'type': 'order', 'data': [{}, 'invalid', {'nOrdNo': 'bad', 'fldQty': 'NaN'}, {'nOrdNo': 'next', 'ordSt': 'open'}]})
    assert len(received) == 1
    assert 'cannot access local variable' not in caplog.text
    assert 'message parsing error' not in caplog.text


def test_sdk_extra_reason_fields_retained():
    from neo_api_client.websocket.orderfeed.models import OrderUpdate
    service = ks.KotakNeoService()
    received = []
    service.register_cancel_callback('K', lambda kid, data: received.append(data), loop())
    service._on_message(OrderUpdate.model_validate(event('cancelled', rejectionReason='source reason', newBrokerField='extra')))
    assert received[0]['raw']['newBrokerField'] == 'extra'
    assert received[0]['raw_reason'] == 'source reason'


def test_raw_cancel_audit_preserves_placeholder_and_redacts_credentials(caplog):
    with caplog.at_level(logging.INFO, logger='kotak.cancellations'):
        audit.record({**event('cancelled', rejRsn='--', newField='evidence'), 'Authorization': 'SECRET', 'Auth': 'SECRET2'})
        audit.record({'type': 'cn', 'Authorization': 'SECRET3'})
    records = [json.loads(record.message) for record in caplog.records if record.name == 'kotak.cancellations']
    assert len(records) == 1
    payload = records[0]['payload']
    assert payload['data']['rejRsn'] == '--' and payload['data']['newField'] == 'evidence'
    assert payload['Authorization'] == '[REDACTED]' and payload['Auth'] == '[REDACTED]'
    assert 'SECRET' not in caplog.text


def test_cancel_intent_persisted_before_api_call(monkeypatch):
    service = ks.KotakNeoService()
    client = MagicMock()
    monkeypatch.setattr(service, '_get_client', lambda: client)
    monkeypatch.setattr(service, 'account_identity', lambda: 'account')
    seen = []
    def cancel(**kwargs):
        seen.append(journal.store.get(journal.cancel_key('account', 'K')))
        return {'stat': 'Ok', 'nOrdNo': 'K'}
    client.cancel_order.side_effect = cancel
    service.cancel_order('K', initiator='user', purpose='user_cancel')
    assert seen[0]['state'] == 'requested' and seen[0]['initiator'] == 'user'
    assert journal.store.get(journal.cancel_key('account', 'K'))['state'] == 'acknowledged'


def test_cancel_transport_timeout_retains_ambiguous_intent(monkeypatch):
    service = ks.KotakNeoService()
    client = MagicMock()
    client.cancel_order.side_effect = TimeoutError('no response')
    monkeypatch.setattr(service, '_get_client', lambda: client)
    monkeypatch.setattr(service, 'account_identity', lambda: 'account')
    with pytest.raises(ks.KotakError):
        service.cancel_order('K', initiator='user')
    assert journal.store.get(journal.cancel_key('account', 'K'))['state'] == 'unknown'


def test_cancel_explicit_failure_is_distinguished(monkeypatch):
    service = ks.KotakNeoService()
    client = MagicMock()
    client.cancel_order.return_value = {'stat': 'Not_Ok', 'errMsg': 'rejected'}
    monkeypatch.setattr(service, '_get_client', lambda: client)
    monkeypatch.setattr(service, 'account_identity', lambda: 'account')
    with pytest.raises(ks.KotakError):
        service.cancel_order('K')
    assert journal.store.get(journal.cancel_key('account', 'K'))['state'] == 'failed'


def test_v3_order_report_tracking_tag_alias():
    from app.services.broker_reports import normalize_order
    assert normalize_order({'GuiOrdId': 'tmr123'})['tag'] == 'tmr123'
    assert normalize_order({'guiOrderId': 'tmr456'})['tag'] == 'tmr456'


def test_secondary_reason_not_hidden_by_primary_placeholder():
    service = ks.KotakNeoService()
    received = []
    service.register_cancel_callback('K', lambda kid, data: received.append(data), loop())
    service._on_message(event('cancelled', rejRsn='--', rejectionReason='actual explanation'))
    assert received[0]['reason'] == 'actual explanation'
    assert received[0]['raw']['rejRsn'] == '--'


def test_terminal_cancel_not_lost_when_fill_quantity_is_malformed():
    service = ks.KotakNeoService()
    received = []
    service.register_cancel_callback('K', lambda kid, data: received.append(data), loop())
    service._on_message(event('cancelled', fldQty='NaN', rejRsn='--'))
    assert received[0]['status'] == 'cancelled'


def test_legacy_embedded_cancellation_authentication_is_redacted(caplog):
    nested = {**event('cancelled', rejRsn='--'), 'Authorization': 'NESTED-SECRET'}
    with caplog.at_level(logging.INFO, logger='kotak.cancellations'):
        audit.record({'type': 'order_feed', 'data': json.dumps(nested)})
    assert 'NESTED-SECRET' not in caplog.text and '[REDACTED]' in caplog.text


def test_sdk_exception_dictionary_is_an_ambiguous_acknowledgement():
    service = ks.KotakNeoService()
    with pytest.raises(ks.KotakError) as error:
        service._check_api_response({'Error': TimeoutError('no reply')})
    assert not isinstance(error.value, ks.KotakOrderRejected)


def test_server_error_cannot_justify_duplicate_placement():
    service = ks.KotakNeoService()
    with pytest.raises(ks.KotakError) as error:
        service._check_api_response({'status_code': 503, 'stat': 'Not_Ok', 'errMsg': 'Service unavailable'})
    assert not isinstance(error.value, ks.KotakOrderRejected)


def test_late_system_ack_does_not_erase_user_cancel_intent():
    system_key, system = journal.begin_cancel('account', 'K', 'system', 'position_resize')
    user_key, user = journal.begin_cancel('account', 'K', 'user', 'user_cancel')
    journal.finish_cancel(system_key, system, 'acknowledged')
    assert journal.cancellation_intent('account', 'K')['request_id'] == user['request_id']
    journal.finish_cancel(user_key, user, 'acknowledged')
    assert journal.cancellation_intent('account', 'K')['initiator'] == 'user'


def test_failed_new_user_request_does_not_hide_its_definitive_result():
    key, intent = journal.begin_cancel('account', 'K', 'user', 'user_cancel')
    journal.finish_cancel(key, intent, 'failed')
    assert journal.cancellation_intent('account', 'K')['state'] == 'failed'


def test_resume_query_excludes_cancellation_requests_and_submission_claims():
    store = journal.Journal()
    table = MagicMock()
    rows = [('cancel:account:K:request', {'session_id': 's', 'state': 'requested'}),
            ('op:submission:1:0', {'session_id': 's', 'state': 'submitting', 'order': {}}),
            ('op', {'session_id': 's', 'state': 'pending', 'parent': {}, 'root_order_id': 'parent'})]
    table.scan.return_value = {'Items': [{'id': key, 'payload': json.dumps(value)} for key, value in rows]}
    store.table = lambda: table
    assert [key for key, _ in store.for_session('s')] == ['op']
