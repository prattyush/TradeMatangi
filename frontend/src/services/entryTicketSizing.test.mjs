import assert from 'node:assert/strict'
import test from 'node:test'
import { ticketSizeArgs, ticketSizeLabel } from './entryTicketSizing.ts'

const tiers = { quantity: { l: 1, m: 2, h: 5 }, funds: { l: 3, m: 6, h: 12 }, risk: { l: 1, m: 2, h: 4 } }

test('each sizing mode maps a preset to the field the backend expects', () => {
  assert.deepEqual(ticketSizeArgs(false, 'quantity', 'h', tiers), [5])
  assert.deepEqual(ticketSizeArgs(false, 'fundsRatio', 'm', tiers), [null, 0.06, undefined])
  assert.deepEqual(ticketSizeArgs(false, 'riskRatio', 'l', tiers), [null, undefined, 1])
})

test('Target % always uses the risk presets whatever the sizing mode is', () => {
  for (const mode of ['quantity', 'fundsRatio', 'riskRatio']) {
    assert.deepEqual(ticketSizeArgs(true, mode, 'h', tiers), [null, undefined, undefined, 4])
  }
})

test('button labels show the value behind each preset', () => {
  assert.equal(ticketSizeLabel(false, 'quantity', 5), 'Qty 5')
  assert.equal(ticketSizeLabel(false, 'fundsRatio', 12), 'Capital 12%')
  assert.equal(ticketSizeLabel(false, 'riskRatio', 2), 'Risk 2%')
  assert.equal(ticketSizeLabel(true, 'quantity', 4), 'Target 4%')
})
