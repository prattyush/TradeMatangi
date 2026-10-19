import assert from 'node:assert/strict'
import test from 'node:test'
import { isBrokerSnapshot, brokerSnapshotSessionId } from './brokerSnapshot.ts'

test('accepts a snapshot only for the currently selected session', () => {
  const event = { session_id: 'real-a' }
  assert.equal(brokerSnapshotSessionId(event, 'real-a'), 'real-a')
  assert.equal(brokerSnapshotSessionId(event, 'real-b'), null)
  assert.equal(brokerSnapshotSessionId(event, null), null)
})

test('does not assign an unidentified snapshot to the active session', () => {
  for (const session_id of [undefined, null, '', 123]) {
    assert.equal(brokerSnapshotSessionId({ session_id }, 'real-a'), null)
  }
})


test('rejects closure reports and malformed refreshes before replacing trading state', () => {
  const full = { orders: [], trades: [], application_orders: [], open_orders: [], positions: [] }
  assert.equal(isBrokerSnapshot(full), true)
  for (const value of [null, {}, {positions: [], verified_flat: true}, {...full, trades: undefined}, {...full, orders: {}}]) {
    assert.equal(isBrokerSnapshot(value), false)
  }
})
