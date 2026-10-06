"""Durable cancellation/submission intents, independent of broker snapshot partitions."""
import json
import threading
import time
import uuid
from botocore.exceptions import ClientError

_lock = threading.Lock()
_ready = False
TABLE = 'BrokerProtectionRecovery'


class Journal:
    def table(self):
        global _ready
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table(TABLE)
        with _lock:
            if not _ready:
                try:
                    table.load()
                except ClientError as exc:
                    if exc.response['Error']['Code'] != 'ResourceNotFoundException':
                        raise
                    try:
                        table.meta.client.create_table(TableName=TABLE,
                            KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
                            AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')
                    except ClientError as creation:
                        if creation.response['Error']['Code'] != 'ResourceInUseException':
                            raise
                    table.meta.client.get_waiter('table_exists').wait(TableName=TABLE)
                _ready = True
        return table

    def get(self, key):
        row = self.table().get_item(Key={'id': key}, ConsistentRead=True).get('Item')
        return json.loads(row['payload']) if row else None

    def put(self, key, value):
        self.table().put_item(Item={'id': key, 'payload': json.dumps(value), 'updated_at': int(time.time()), **({'session_id': value['session_id']} if value.get('session_id') else {})})

    def claim(self, key, value):
        try:
            self.table().put_item(Item={'id': key, 'payload': json.dumps(value), 'updated_at': int(time.time()), **({'session_id': value['session_id']} if value.get('session_id') else {})},
                                  ConditionExpression='attribute_not_exists(id)')
            return True
        except ClientError as exc:
            if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return False
            raise

    def put_latest(self, key, value):
        stamp = int(value['requested_at'] * 1_000_000)
        try:
            self.table().put_item(Item={'id': key, 'payload': json.dumps(value), 'updated_at': int(time.time()), 'requested_us': stamp},
                ConditionExpression='attribute_not_exists(id) OR requested_us <= :stamp',
                ExpressionAttributeValues={':stamp': stamp})
        except ClientError as exc:
            if exc.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise

    def for_session(self, session_id):
        from boto3.dynamodb.conditions import Attr
        table = self.table()
        rows, params = [], {'FilterExpression': Attr('session_id').eq(session_id)}
        while True:
            page = table.scan(**params)
            rows.extend(page.get('Items', []))
            if not page.get('LastEvaluatedKey'):
                decoded = [(row['id'], json.loads(row['payload'])) for row in rows]
                return [(key, payload) for key, payload in decoded if 'parent' in payload and 'root_order_id' in payload]
            params['ExclusiveStartKey'] = page['LastEvaluatedKey']


store = Journal()


def cancel_key(account, broker_id):
    return f'cancel:{account}:{broker_id}'


def begin_cancel(account, broker_id, initiator='system', purpose='legacy', context=None):
    key = cancel_key(account, broker_id)
    intent = {'request_id': str(uuid.uuid4()), 'broker_id': broker_id, 'initiator': initiator,
              'purpose': purpose, 'state': 'requested', 'requested_at': time.time(), **(context or {})}
    request_key = key + ':' + intent['request_id']
    store.put(request_key, intent)
    store.put_latest(key, intent)
    if initiator == 'user':
        store.put_latest(key + ':user', intent)
    return request_key, intent


def finish_cancel(key, intent, state, error=None):
    completed = {**intent, 'state': state, 'completed_at': time.time(), 'error': error}
    store.put(key, completed)
    pointer = key.rsplit(':', 1)[0]
    store.put_latest(pointer, completed)
    if intent['initiator'] == 'user':
        store.put_latest(pointer + ':user', completed)


def cancellation_intent(account, broker_id):
    pointer = cancel_key(account, broker_id)
    user = store.get(pointer + ':user')
    if user:
        user = store.get(pointer + ':' + user['request_id']) or user
        if user['state'] != 'failed':
            return user
    latest = store.get(pointer)
    return (store.get(pointer + ':' + latest['request_id']) or latest) if latest else None
