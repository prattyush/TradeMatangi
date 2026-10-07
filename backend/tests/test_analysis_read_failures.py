"""Storage outages cannot become empty analytic evidence; metadata consumes all pages."""
from unittest.mock import MagicMock, patch
import pytest
from app.services import trade_label_service as labels, pattern_logger_service as patterns


def test_round_trip_read_failure_is_explicit():
    with patch('app.services.analysis_service.get_trades_for_session',side_effect=RuntimeError('storage offline')):
        with pytest.raises(RuntimeError,match='could not be read'):
            labels.compute_round_trips_for_session('session')


def test_label_read_failure_is_explicit():
    table=MagicMock();table.query.side_effect=RuntimeError('storage offline')
    with patch.object(labels,'_table',return_value=table),pytest.raises(RuntimeError,match='could not be read'):
        labels.get_labels_for_session('session')


@pytest.mark.parametrize('kind',['entry','exit'])
def test_custom_tags_read_every_page_and_surface_errors(kind):
    table=MagicMock();table.query.side_effect=[{'Items':[{kind+'_tag':'FIRST'}],'LastEvaluatedKey':{'session_id':'one'}},{'Items':[{kind+'_tag':'SECOND'}]}]
    read=getattr(labels,'list_'+kind+'_tags')
    with patch.object(labels,'_table',return_value=table):assert read('owner')==['FIRST','SECOND']
    assert table.query.call_args_list[1].kwargs['ExclusiveStartKey']=={'session_id':'one'}
    table.query.side_effect=RuntimeError('storage offline')
    with patch.object(labels,'_table',return_value=table),pytest.raises(RuntimeError,match='could not be read'):read('owner')


def test_pattern_metadata_pages_and_failure_are_explicit():
    table=MagicMock();table.query.side_effect=[{'Items':[{'chart_id':'one'}],'LastEvaluatedKey':{'chart_id':'one'}},{'Items':[{'chart_id':'two'}]}]
    with patch.object(patterns,'_table',return_value=table):assert len(patterns._query_charts_for_owner('owner'))==2
    table.query.side_effect=RuntimeError('storage offline')
    with patch.object(patterns,'_table',return_value=table),pytest.raises(RuntimeError,match='could not be read'):patterns._query_charts_for_owner('owner')
