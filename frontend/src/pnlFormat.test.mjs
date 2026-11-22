import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPnl, formatPnlDisplay, pnlDisplayColor } from './pnlFormat.ts'
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

const display = (mode) => ({ mode, maxWinPct: 9, maxLossPct: 6 })

test('Milestones shows the day level whatever number the caller passes', () => {
  assert.equal(formatPnlDisplay(123, display('milestones'), 100000, 3000), 'Win 1/3')
  assert.equal(formatPnlDisplay(-50000, display('milestones'), 100000, 6000), 'Win 2/3')
  assert.equal(formatPnlDisplay(5, display('milestones'), 100000, -6000), 'Max loss')
  assert.equal(formatPnlDisplay(5, display('milestones'), 100000, 100), '—')
  assert.equal(formatPnlDisplay(5, display('milestones'), 100000, 9000, false), '—')
  assert.equal(formatPnlDisplay(5, display('milestones'), 0, 9000), '—')
})

test('the other modes keep their format', () => {
  assert.equal(formatPnlDisplay(1200, display('currency'), 18000, 0), '+1200.00')
  assert.equal(formatPnlDisplay(1200, display('percent'), 18000, 0), '+6.67%')
})

test('colour follows the day level in Milestones and the sign otherwise', () => {
  assert.equal(pnlDisplayColor(-1, display('milestones'), 100000, 3000), '#26a641')
  assert.equal(pnlDisplayColor(1, display('milestones'), 100000, -3000), '#f85149')
  assert.equal(pnlDisplayColor(1, display('milestones'), 100000, 10), '#8b949e')
  assert.equal(pnlDisplayColor(-5, display('currency'), 100000, 99999), '#f85149')
})
