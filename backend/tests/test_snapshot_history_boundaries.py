from unittest.mock import MagicMock, patch
import pytest
from app.services import snapshot_service


def test_reads_all_pages_and_sorts_by_capture_time():
    table=MagicMock()
    table.query.side_effect=[{'Items':[{'session_id':'s','event_id':'later','timestamp':20,'event_json':'{}','snapshot_json':'{}'}],'LastEvaluatedKey':{'session_id':'s','event_id':'later'}},{'Items':[{'session_id':'s','event_id':'earlier','timestamp':10,'event_json':'{}','snapshot_json':'{}'}]}]
    with patch.object(snapshot_service,'_table',return_value=table):
        rows=snapshot_service.get_snapshots('s')
    assert [r['event_id'] for r in rows]==['earlier','later']
    assert table.query.call_args_list[1].kwargs['ExclusiveStartKey']['event_id']=='later'


def test_read_failure_is_not_a_successful_empty_history():
    table=MagicMock();table.query.side_effect=RuntimeError('offline')
    with patch.object(snapshot_service,'_table',return_value=table),pytest.raises(RuntimeError,match='could not be read'):
        snapshot_service.get_snapshots('s')


def test_delete_retries_unprocessed_rows_and_does_not_claim_success():
    table=MagicMock();table.query.return_value={'Items':[{'session_id':'s','event_id':'e'}]}
    client=MagicMock();pending={'EventSnapshots':[{'DeleteRequest':{'Key':{'session_id':{'S':'s'},'event_id':{'S':'e'}}}}]}
    client.batch_write_item.return_value={'UnprocessedItems':pending}
    with patch.object(snapshot_service,'_table',return_value=table),patch('app.services.db.get_dynamodb_client',return_value=client),pytest.raises(RuntimeError,match='not fully deleted'):
        snapshot_service.delete_snapshots('s')
    assert client.batch_write_item.call_count==4
    client.reset_mock();client.batch_write_item.side_effect=[{'UnprocessedItems':pending},{}]
    with patch.object(snapshot_service,'_table',return_value=table),patch('app.services.db.get_dynamodb_client',return_value=client):
        assert snapshot_service.delete_snapshots('s')==1
    assert client.batch_write_item.call_count==2
