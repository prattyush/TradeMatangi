"""FIFO cost basis and fee repair, independent of broker day-average fields."""
from types import SimpleNamespace
import pytest
from app.services import fifo_positions as fifo, broker_reports as reports, trading
from app.models.schemas import TradeSide

SESSION = SimpleNamespace(symbol='NIFTY', instrument_type='options', date='2026-10-06', brokerage_per_order=1)


def execution(identifier, side, price, qty=65, order=None, time='10:00:00', strike=25000, right='CE', product='MIS'):
    return reports.normalize_execution(dict(flId=identifier, nOrdNo=order or identifier, fldQty=qty,
        flPrc=price, trnsTp=side[0], trdSym=f'NIFTY26O08{strike}{right}', exSeg='nse_fo', prod=product,
        flDt='06-Oct-2026', flTm=time))


def test_scale_in_partial_exit_keeps_only_remaining_entry():
    rows = [execution('1', 'BUY', 40), execution('2', 'BUY', 60, time='10:01:00'), execution('3', 'SELL', 50, time='10:02:00')]
    position = fifo.positions(SESSION, rows)[0]
    assert position['quantity'] == 65 and position['avg_entry_price'] == 60
    assert position['entry_commission'] == pytest.approx(trading.compute_commission(TradeSide.BUY, 60, 65, 1))


def test_closed_cycle_does_not_dilute_new_entry():
    rows = [execution('1', 'BUY', 40), execution('2', 'SELL', 45, time='10:01:00'), execution('3', 'BUY', 60, time='10:02:00')]
    assert fifo.positions(SESSION, rows)[0]['avg_entry_price'] == 60


def test_interleaved_partial_fills_of_same_order_use_execution_sequence():
    rows = [execution('1', 'BUY', 40, order='entry'), execution('2', 'SELL', 45, time='10:01:00'),
            execution('3', 'BUY', 60, order='entry', time='10:02:00')]
    position = fifo.positions(SESSION, rows)[0]
    assert position['quantity'] == 65 and position['avg_entry_price'] == 60
    total = trading.compute_commission(TradeSide.BUY, 50, 130, 1)
    assert position['entry_commission'] == pytest.approx((total - 1) * .6 + .5)


def test_fractional_timestamp_preserves_fifo_order_within_a_second():
    rows = [execution('3', 'BUY', 60, time='10:00:00.900'), execution('2', 'SELL', 45, time='10:00:00.500'),
            execution('1', 'BUY', 40, time='10:00:00.100')]
    assert len({row['timestamp'] for row in rows}) == 1
    assert fifo.positions(SESSION, rows)[0]['avg_entry_price'] == 60


def test_partial_consumption_apportions_remaining_entry_fees():
    buy = execution('1', 'BUY', 40, qty=130)
    position = fifo.positions(SESSION, [buy, execution('2', 'SELL', 45, time='10:01:00')])[0]
    assert position['entry_commission'] == pytest.approx(trading.compute_commission(TradeSide.BUY, 40, 130, 1) / 2)


def test_short_lots_and_reversal():
    rows = [execution('1', 'SELL', 40), execution('2', 'SELL', 60, time='10:01:00'), execution('3', 'BUY', 45, time='10:02:00')]
    assert fifo.positions(SESSION, rows)[0]['avg_entry_price'] == 60
    rows.append(execution('4', 'BUY', 55, qty=130, time='10:03:00'))
    position = fifo.positions(SESSION, rows)[0]
    assert position['side'] == 'LONG' and position['quantity'] == 65 and position['avg_entry_price'] == 55


def test_contract_and_product_scopes_are_independent():
    rows = [execution('1', 'BUY', 40), execution('2', 'BUY', 60, right='PE'),
            execution('3', 'BUY', 70, strike=25100), execution('4', 'BUY', 80, product='NRML')]
    assert {p['avg_entry_price'] for p in fifo.positions(SESSION, rows)} == {40, 60, 70, 80}


def test_duplicate_execution_does_not_change_quantity_or_charge_brokerage_twice():
    row = execution('1', 'BUY', 40)
    assert fifo.positions(SESSION, [row, row]) == fifo.positions(SESSION, [row])
    with pytest.raises(ValueError, match='Conflicting duplicate'):
        fifo.positions(SESSION, [row, {**row, 'price': 50}])


def test_verified_quantity_blocks_incomplete_history():
    raw = dict(symbol='NIFTY', right='CE', strike=25000, expiry='2026-10-08', product='MIS',
        broker_exchange='nse_fo', quantity=130, side='LONG', avg_entry_price=50)
    with pytest.raises(ValueError, match='incomplete'):
        fifo.verified_positions(SESSION, [execution('1', 'BUY', 40)], [raw])
    raw['quantity'] = 65
    rebuilt = fifo.verified_positions(SESSION, [execution('1', 'BUY', 40)], [raw])[0]
    assert rebuilt['avg_entry_price'] == 40 and rebuilt['broker_avg_entry_price'] == 50


def test_monthly_expiry_is_resolved_once_and_survives_persisted_ledger():
    from decimal import Decimal
    row = {**execution('1', 'BUY', 40), 'symbol': 'NIFTY26OCT25000CE'}
    master = [{'symbol': row['symbol'], 'expiry': '2026-10-27'}]
    ledger = fifo.unique_executions(SESSION, [row], master)
    assert ledger[0]['expiry'] == '2026-10-27'
    persisted = [{**ledger[0], 'price': Decimal('40'), 'quantity': Decimal('65')}]
    assert fifo.positions(SESSION, persisted)[0]['avg_entry_price'] == 40
