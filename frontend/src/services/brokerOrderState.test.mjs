import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmedOrderUpdate, mergeOpenOrders } from './brokerOrderState.ts'
const old = {order_id:'o',status:'PENDING',order_type:'LIMIT',broker_conversion:{state:'modifying',updated_at:1}}
const confirmed = {...old,order_type:'STOPLOSS',broker_conversion:{state:'confirmed',updated_at:2}}

test('late HTTP acknowledgement cannot overwrite broker-confirmed SSE state', () => {
  assert.equal(confirmedOrderUpdate(confirmed, old), confirmed)
  assert.equal(mergeOpenOrders([confirmed], [old], true)[0].order_type, 'STOPLOSS')
})
test('confirmation replaces pending state and bulk removes cancelled originals', () => {
  assert.equal(mergeOpenOrders([old], [confirmed])[0].order_type, 'STOPLOSS')
  const cancelled = {...confirmed,status:'CANCELLED',broker_conversion:{state:'confirmed',updated_at:3}}
  assert.deepEqual(mergeOpenOrders([confirmed],[cancelled]), [])
})
test('new authoritative refresh may correct the type and filled replacements stay closed', () => {
  assert.equal(mergeOpenOrders([confirmed], [{...confirmed,order_type:'LIMIT'}], true)[0].order_type,'LIMIT')
  assert.deepEqual(mergeOpenOrders([], [{...confirmed,status:'FILLED'}]), [])
})
