"""Event-second OHLC, cache-only fallback and snapshot read permissions."""
from unittest.mock import patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.snapshot_candle_service import reconstruct_candle
from tests.test_desktop_analysis import client
from tests.test_phase20_api import database, seed

DATE = '2026-10-09'
START = int(pd.Timestamp(DATE + ' 09:15:00', tz='UTC').timestamp())


def snapshot(offset=60):
    return {'event_id':'event-one','session_id':'session','symbol':'NIFTY','date':DATE,
            'timestamp': START + offset, 'instrument_type':'options',
            'snapshot':{'strike_ce':25000,'strike_pe':24950,'expiry':'2026-10-13',
                        'event_timestamp':1900000000}}


@pytest.fixture
def cached(tmp_path, monkeypatch):
    path = tmp_path / 'cache.parquet'
    from app.services import historical_data_service as history
    monkeypatch.setattr(history, '_path', lambda *args: path)
    frame = pd.DataFrame({'open':100.0,'high':102.0,'low':99.0,'close':101.0,'observed':True},
                         index=pd.date_range(DATE+' 09:15:00', periods=360, freq='1s'))
    frame.iloc[10, frame.columns.get_loc('high')] = 108
    frame.iloc[20, frame.columns.get_loc('low')] = 95
    frame.iloc[60, frame.columns.get_loc('close')] = 102
    frame.iloc[180:, frame.columns.get_loc('high')] = 900
    return path, frame


def test_event_second_aggregates_from_bar_open_and_ignores_later_prices(cached):
    path, frame = cached
    # A later second inside the SAME three-minute bar must be excluded too.
    frame.iloc[61, frame.columns.get_loc('high')] = 800
    frame.to_parquet(path)
    with patch('app.services.broker_service.fetch_historical', side_effect=AssertionError('No downloads')):
        assert reconstruct_candle(snapshot(), 'underlying') == {
            'time':START,'open':100,'high':108,'low':95,'close':102}


@pytest.mark.parametrize('offset', [0, 179, 180, 359])
def test_first_second_boundary_and_final_second(cached, offset):
    path, frame = cached
    frame.to_parquet(path)
    result = reconstruct_candle(snapshot(offset), 'underlying')
    assert result['time'] == START + offset//180*180
    window = frame.iloc[offset//180*180:offset+1]
    assert result['open'] == window.iloc[0]['open']
    assert result['high'] == window['high'].max()
    assert result['low'] == window['low'].min()
    assert result['close'] == window.iloc[-1]['close']


@pytest.mark.parametrize('damage', ['missing','minute','unobserved','unknown-provenance','nan','bad-high','duplicate','gap'])
def test_unreliable_seconds_return_null(cached, damage):
    path, frame = cached
    if damage == 'missing':
        assert reconstruct_candle(snapshot(), 'underlying') is None
        return
    if damage == 'minute': frame = frame.iloc[::60]
    if damage == 'unobserved': frame.iloc[10, frame.columns.get_loc('observed')] = False
    if damage == 'unknown-provenance': frame = frame.drop(columns='observed')
    if damage == 'nan': frame.iloc[10, frame.columns.get_loc('high')] = float('nan')
    if damage == 'bad-high': frame.iloc[10, frame.columns.get_loc('high')] = 90
    if damage == 'duplicate': frame = pd.concat([frame, frame.iloc[[10]]])
    if damage == 'gap': frame = frame.drop(frame.index[10])
    frame.to_parquet(path)
    assert reconstruct_candle(snapshot(), 'underlying') is None


@pytest.mark.parametrize('instrument,strike', [('underlying',None),('CE',25000),('PE',24950)])
def test_contract_and_date_come_from_saved_snapshot(cached, instrument, strike):
    path, frame = cached
    frame.index = frame.index.tz_localize('UTC')
    frame.to_parquet(path)
    with patch('app.services.historical_data_service._path', return_value=path) as lookup:
        assert reconstruct_candle(snapshot(), instrument)['close'] == 102
    lookup.assert_called_once_with('breeze','NIFTY',DATE,strike,'2026-10-13' if strike else None,
                                   instrument if strike else None)
    missing = snapshot()
    missing['snapshot']['strike_ce'] = None
    assert reconstruct_candle(missing,'CE') is None
    missing['timestamp'] += 86400
    assert reconstruct_candle(missing,'underlying') is None


def test_owned_desktop_endpoint_and_website_share_identical_read(cached, client, database):
    seed(database)
    path, frame = cached
    frame.to_parquet(path)
    with patch('app.services.snapshot_service.get_snapshot', return_value=snapshot()) as read:
        desktop = client.get('/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=session&instrument=CE')
        website = client.get('/api/snapshots/event-one/candle?session_id=session&instrument=CE',headers={'X-User-Id':'alice'})
        assert desktop.status_code == website.status_code == 200
        assert desktop.json() == website.json()
        assert desktop.json()['candle']['high'] == 108
        assert all(call.args == ('session','event-one') for call in read.call_args_list)
        assert client.get('/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=session&instrument=XX').status_code == 422


def test_unauthorized_session_does_not_read_snapshot(client, database):
    seed(database, user='bob', sid='other')
    with patch('app.services.snapshot_service.get_snapshot') as read:
        assert client.get('/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=other').status_code == 404
        read.assert_not_called()


def test_shared_read_still_requires_bearer_and_grant(client, database):
    seed(database, user='bob', sid='shared', mode='real')
    with patch('app.services.analysis_sharing.sources', return_value=[{'user_id':'bob'}]), \
         patch('app.services.snapshot_service.get_snapshot', return_value=snapshot()), \
         patch('app.services.snapshot_candle_service.reconstruct_candle', return_value=None):
        assert client.get('/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=shared').json() == {'candle':None}
    # The client fixture overrides desktop auth; remove it for the bearer check.
    from app.routers.desktop_analysis import get_analysis_user_id
    override = app.dependency_overrides.pop(get_analysis_user_id)
    try:
        assert TestClient(app).get('/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=shared',headers={'X-User-Id':'alice'}).status_code == 401
    finally:
        app.dependency_overrides[get_analysis_user_id] = override


def test_missing_snapshot_and_storage_failure_are_not_success(client, database, caplog):
    seed(database)
    url = '/api/desktop/v1/analysis/snapshots/event-one/candle?session_id=session'
    with patch('app.services.snapshot_service.get_snapshot', return_value=None):
        assert client.get(url).status_code == 404
    with patch('app.services.snapshot_service.get_snapshot', return_value=snapshot()), \
         patch('app.services.snapshot_candle_service.reconstruct_candle', side_effect=RuntimeError('unreadable parquet')):
        assert client.get(url).status_code == 503
    assert 'Snapshot candle read failed' in caplog.text


@pytest.mark.asyncio
async def test_reconstruction_file_read_runs_off_event_loop(monkeypatch):
    import threading
    from app.routers import snapshots
    thread = threading.get_ident()
    monkeypatch.setattr(snapshots, '_load_session', lambda sid: {'user_id':'alice'})
    monkeypatch.setattr(snapshots.snapshot_service, 'get_snapshot', lambda sid, eid: snapshot())
    threads = []
    def read(snap, instrument):
        threads.append(threading.get_ident())
        return None
    monkeypatch.setattr('app.services.snapshot_candle_service.reconstruct_candle', read)
    assert await snapshots.snapshot_candle('event-one',session_id='session',instrument='underlying',user_id='alice') == {'candle':None}
    assert threads and threads[0] != thread
