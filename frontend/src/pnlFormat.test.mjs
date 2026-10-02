import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPnl } from './pnlFormat.ts'
import { refreshedSessionCapital } from './brokerSnapshot.ts'

test('day and previous-session P&L use the selected units and opening capital', () => {
  assert.equal(formatPnl(1200, true, 18000), '+6.67%')
  assert.equal(formatPnl(-1200, true, 18000), '-6.67%')
  assert.equal(formatPnl(0, true, 18000), '+0.00%')
  assert.equal(formatPnl(1200, false, 18000), '+1200.00')
  assert.equal(formatPnl(-600, true, 18000), '-3.33%')
})

test('unavailable capital retains currency without invalid percentages', () => {
  for (const capital of [0, -1, NaN, Infinity]) {
    assert.equal(formatPnl(1200, true, capital), '+1200.00')
  }
})

test('wallet and broker refreshes update only the matching session capital', () => {
  assert.equal(refreshedSessionCapital('a', 'a', 19200, 18000), 18000)
  assert.equal(refreshedSessionCapital('b', 'a', 12000, 18000), 12000)
  assert.equal(refreshedSessionCapital(null, 'a', 0, 18000), 0)
  for (const invalid of [undefined, null, NaN, Infinity]) {
    assert.equal(refreshedSessionCapital('a', 'a', 18000, invalid), 18000)
  }
  assert.equal(refreshedSessionCapital('a', 'a', 18000, 0), 0)
})
