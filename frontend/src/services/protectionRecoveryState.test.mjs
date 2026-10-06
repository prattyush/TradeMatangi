import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRecoveryEvent, pruneRecoveryNotices } from './protectionRecoveryState.ts'
const event = (fields = {}) => ({ type: 'protection_recovery', operation_id: 'op', symbol: 'NIFTY', right: 'CE', strike: 25000, expiry: '2026-10-08', state: 'pending', message: 'Checking', ...fields })

test('updates in place by contract rather than accumulating messages', () => {
  let notices = {}
  for (let i = 0; i < 1000; i++) notices = applyRecoveryEvent(notices, event({ message: String(i) }))
  assert.equal(Object.keys(notices).length, 1)
  assert.equal(Object.values(notices)[0].message, '999')
})

test('late closure of an older operation cannot clear a newer warning', () => {
  const notices = applyRecoveryEvent({}, event({ operation_id: 'new', state: 'needs_attention' }))
  assert.equal(applyRecoveryEvent(notices, event({ operation_id: 'old', state: 'cleared' })), notices)
  assert.deepEqual(applyRecoveryEvent(notices, event({ operation_id: '', state: 'cleared' })), {})
})

test('rights and contracts are independent and confirmed snapshots remove closed positions', () => {
  let notices = applyRecoveryEvent({}, event())
  notices = applyRecoveryEvent(notices, event({ right: 'PE', operation_id: 'pe' }))
  assert.equal(Object.keys(notices).length, 2)
  notices = pruneRecoveryNotices(notices, 'NIFTY', [{ right: 'PE', strike: 25000, expiry: '2026-10-08', side: 'LONG', quantity: 65 }])
  assert.equal(Object.keys(notices).length, 1)
  assert.equal(Object.values(notices)[0].operationId, 'pe')
})
