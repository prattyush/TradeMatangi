"""Exercise the website historical options runner and its replayable stream clock."""
import asyncio
import json
import time
import threading
import pytest
from app.models.schemas import SimulationState
from app.services import simulation, order_service


@pytest.mark.parametrize('right',[None,'CE'])
def test_nifty_replay_ticks_advance_and_pause_resume_stop(monkeypatch,right):
    session=simulation.SimulationSession(session_id='nifty-clock',symbol='NIFTY',date='2026-10-07',
        start_time='09:15:00',speed=.01,instrument_type='options',strike=25000,strike_ce=25000,
        strike_pe=24950,expiry='2026-10-08',right=right)
    session.resume_event.set()
    session.paper_base_contracts={}
    ts=1791364500
    main_thread=threading.get_ident()
    loader_threads=[]
    def ticks(*args):
        loader_threads.append(threading.get_ident())
        if right is None:
            time.sleep(.08)  # a cold provider cache must not block the event loop
        price=25000 if len(args)==3 else 100 if args[4]=='CE' else 120
        return iter([dict(type='tick',time=ts+i,open=price+i,high=price+i+1,low=price+i-1,close=price+i) for i in range(10)])
    monkeypatch.setattr(simulation,'iter_ticks',ticks)
    monkeypatch.setattr('app.services.options_service.options_iter_ticks',ticks)
    monkeypatch.setattr('app.services.strategy_service.on_tick',lambda *args,**kwargs:None)
    order_service.clear_session(session.session_id)
    async def run():
        task=asyncio.create_task(simulation._run_session(session))
        await asyncio.sleep(.02)
        if right is None:
            assert not task.done()
            assert session.current_time is None  # loading continues in worker threads
        cursor=0
        received=[]
        async def next_tick():
            nonlocal cursor
            while True:
                cursor,payload=await asyncio.wait_for(session.queue.get_after(cursor),2)
                event=json.loads(payload)
                if event['type']=='tick':
                    received.append(event)
                    return event
        first=await next_tick()
        while (await next_tick())['time']==first['time']:
            pass
        assert int(session.current_time)>ts
        session.resume_event.clear()
        session.state=SimulationState.PAUSED
        await asyncio.sleep(.03)
        paused_time=session.current_time
        await asyncio.sleep(.03)
        assert session.current_time==paused_time
        session.state=SimulationState.RUNNING
        session.resume_event.set()
        for _ in range(8):
            if (await next_tick())['time']>int(paused_time):
                break
        assert int(session.current_time)>int(paused_time)
        if right is None:
            assert {t.get('right') for t in received}=={None,'CE','PE'}
            assert all(t!=main_thread for t in loader_threads)
            assert session.last_price_ce>100 and session.last_price_pe>120
        task.cancel()
        await task
        assert session.state==SimulationState.ENDED
        remaining=[]
        while cursor<session.queue.latest_id():
            cursor,payload=await session.queue.get_after(cursor)
            remaining.append(json.loads(payload))
        assert remaining[-1]['type']=='session_ended'
    asyncio.run(run())
