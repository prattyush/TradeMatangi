import assert from 'node:assert/strict'
import test from 'node:test'
import { exitOrderLineLabel } from './orderLineLabel.ts'

const long = { side: 'LONG', quantity: 100, avg_entry_price: 100, entry_commission: 0 }

test('shows order, whole-position and session P&L in percent mode', () => {
  // order 40 @ 95: -200 (-1.0%); position 100 @ 95: -500 (-2.5%); session = 1000 + 100*(95-110) - exit fees = -500 - ~13 fees
  const label = exitOrderLineLabel('SL', 95, 40, long, true, 20000, 1000, 110, 0)
  const [head, ...rest] = label.split(' ')
  const [order, position, session] = rest.join(' ').split(' | ')
  assert.equal(head, 'SL')
  assert.equal(order, '-1.0%')
  assert.equal(position, '-2.5%')
  assert.equal(session, '-2.6%')
})

test('value mode and missing session inputs', () => {
  assert.equal(exitOrderLineLabel('L', 110, 100, long, false, 20000), 'L +1000 | +1000')
  assert.equal(exitOrderLineLabel('SL', 95, 500, long, false, 0), 'SL -500 | -500')
})

test('short position moves the other way', () => {
  const short = { side: 'SHORT', quantity: 50, avg_entry_price: 100, entry_commission: 0 }
  assert.equal(exitOrderLineLabel('SL', 110, 25, short, true, 10000), 'SL -2.5% | -5.0%')
})
