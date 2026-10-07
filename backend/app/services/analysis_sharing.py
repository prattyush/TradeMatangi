"""Owner-authorised, real-history-only read grants stored on existing Users rows.

Reverse source references discover owners; the owner's consistent grant record is
always authoritative. No grant permits trading, labeling or snapshot deletion.
"""
import re
from botocore.exceptions import ClientError
from boto3.dynamodb.types import TypeSerializer


def _user(user_id):
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table('Users').get_item(Key={'user_id':user_id}, ConsistentRead=True).get('Item')


def sources(viewer):
    user = _user(viewer)
    if not user:
        return []
    result = []
    for owner_id in sorted(user.get('real_history_sources', [])):
        owner = _user(owner_id)
        if owner and any(grant['user_id'] == viewer for grant in owner.get('real_history_sharing', [])):
            result.append({'user_id':owner_id,'email':owner.get('email',''),'account_name':owner.get('account_name','')})
    return result


def can_read(session, viewer):
    if not session:
        return False
    if session.get('user_id') == viewer:
        return True
    if session.get('session_type') != 'real':
        return False
    try:
        return any(source['user_id'] == session.get('user_id') for source in sources(viewer))
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ResourceNotFoundException':
            return False
        raise


def settings(owner):
    user = _user(owner)
    if not user:
        raise ValueError('Account not found')
    return {'emails':[grant['email'] for grant in user.get('real_history_sharing',[])], 'shared_from':sources(owner)}


def save(owner_id, emails):
    from app.services.db import get_dynamodb_resource, get_dynamodb_client
    from boto3.dynamodb.conditions import Key
    emails = sorted(set(email.strip().lower() for email in emails))
    if len(emails) > 20:
        raise ValueError('Choose at most 20 email addresses')
    owner = _user(owner_id)
    if not owner:
        raise ValueError('Account not found')
    recipients = []
    table = get_dynamodb_resource().Table('Users')
    for email in emails:
        if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):
            raise ValueError(f'Invalid email address: {email}')
        rows = table.query(IndexName='EmailIndex', KeyConditionExpression=Key('email').eq(email)).get('Items',[])
        if len(rows) != 1:
            raise ValueError(f'No registered account for {email}')
        target = rows[0]
        if target['user_id'] == owner_id:
            raise ValueError('Choose another account; your own history is already available')
        recipients.append({'user_id':target['user_id'],'email':email})
    serialize = TypeSerializer().serialize
    old = {grant['user_id']:grant for grant in owner.get('real_history_sharing',[])}
    new = {grant['user_id']:grant for grant in recipients}
    version = int(owner.get('real_history_share_revision',0))
    actions = [{'Update':{
        'TableName':'Users','Key':{'user_id':serialize(owner_id)},
        'UpdateExpression':'SET real_history_sharing = :grants, real_history_share_revision = :next',
        'ConditionExpression':'attribute_exists(user_id) AND (attribute_not_exists(real_history_share_revision) OR real_history_share_revision = :version)',
        'ExpressionAttributeValues':{':grants':serialize(recipients),':next':serialize(version+1),':version':serialize(version)},
    }}]
    for recipient in sorted(set(old)|set(new)):
        target = _user(recipient)
        if not target:
            if recipient in new:
                raise ValueError('A selected account was removed; refresh and retry')
            continue
        add = recipient in new
        actions.append({'Update':{
            'TableName':'Users','Key':{'user_id':serialize(recipient)},
            'UpdateExpression':('ADD' if add else 'DELETE')+' real_history_sources :source',
            'ConditionExpression':'attribute_exists(user_id) AND email = :email',
            'ExpressionAttributeValues':{':source':serialize({owner_id}),':email':serialize(target['email'])},
        }})
    get_dynamodb_client().transact_write_items(TransactItems=actions)
    return settings(owner_id)


def annotate(session, viewer):
    return {**session,'shared':session.get('user_id') != viewer}


def visible_sessions(viewer, **filters):
    from app.services.analysis_service import get_sessions_for_user
    own = get_sessions_for_user(viewer, **filters)
    result = [annotate(s,viewer) for s in own]
    # A Paper-only query must not pull another user's Paper/Replay sessions.
    if filters.get('session_type') not in (None,'','real'):
        return result
    for source in sources(viewer):
        for session in get_sessions_for_user(source['user_id'],**{**filters,'session_type':'real'}):
            result.append({**annotate(session,viewer),'owner_email':source['email']})
    return sorted(result,key=lambda s:(s.get('date',''),s['session_id']),reverse=True)
