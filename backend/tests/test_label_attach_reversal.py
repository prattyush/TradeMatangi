"""A label saved without a cycle id (a sim / paper label, or one saved while the trade was open) must still reach its trade when a
fill crossed flat: the legacy view has one trip with the whole exit quantity, the cycles split it. Otherwise the trade shows as
labelled in Analysis but the day score says it is not (found in real trading)."""
from tests.test_real_analysis_fees import db, seed, USER  # noqa: F401  (the moto fixture and the seeded real session)
from app.services import performance_service as perf


def put_label(db, index, stable=None):
    db.Table('TradeLabels').put_item(Item={'session_id': 'nifty', 'round_trip_index': index, 'user_id': USER, 'expected_category': 'c', 'expected_strategy': 'S',
                                           'actual_category': 'c', 'actual_strategy': 'S', 'analytics_cycle_id': stable, 'session_type': 'real'})


def test_unstable_label_reaches_the_closed_cycle_of_a_reversal(db):
    session = seed(db)
    db.Table('Trades').update_item(Key={'session_id': 'nifty', 'trade_id': 'nifty-SELL'}, UpdateExpression='SET quantity=:q', ExpressionAttributeValues={':q': 15})
    put_label(db, 0)
    cycles = perf.load_session_cycles(session)
    assert [(c['state'], bool(c.get('label'))) for c in cycles] == [('closed', True), ('open', False)]
    assert cycles[0]['label_index'] == 0


def test_unstable_label_still_reaches_a_plain_cycle_and_a_wrong_index_does_not(db):
    session = seed(db)
    put_label(db, 0)
    assert [bool(c.get('label')) for c in perf.load_session_cycles(session)] == [True]
    db.Table('TradeLabels').delete_item(Key={'session_id': 'nifty', 'round_trip_index': 0})
    put_label(db, 5)  # a label of some other trip is never moved onto this one
    assert [bool(c.get('label')) for c in perf.load_session_cycles(session)] == [False]
