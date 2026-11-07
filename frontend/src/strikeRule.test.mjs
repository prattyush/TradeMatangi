import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReselectBody, paneStrikeErrorMessage, strikeRuleFromStart } from './strikeRule.ts'

const fb = { storedMode: 'otm', storedThresholdCE: 40, storedThresholdPE: 45, offset: 3, isIndex: true }

test('start-time OTM rule is reused', () => {
  const rule = strikeRuleFromStart(true, 'otm', 6, 50, 50)
  assert.deepEqual(buildReselectBody('CE', rule, fb), { right: 'CE', mode: 'otm', otm_offset: 6 })
})

test('start-time Max Price rule uses per-side caps', () => {
  const rule = strikeRuleFromStart(true, 'threshold', 0, 50, 60)
  assert.deepEqual(buildReselectBody('CE', rule, fb), { right: 'CE', mode: 'max_price', max_price: 50 })
  assert.deepEqual(buildReselectBody('PE', rule, fb), { right: 'PE', mode: 'max_price', max_price: 60 })
})

test('Max Price falls back to OTM for non-index symbols', () => {
  const rule = strikeRuleFromStart(false, 'threshold', 2, 50, 50)
  assert.deepEqual(buildReselectBody('PE', rule, { ...fb, isIndex: false }), { right: 'PE', mode: 'otm', otm_offset: 2 })
})

test('no start rule uses current settings', () => {
  assert.deepEqual(buildReselectBody('PE', null, fb), { right: 'PE', mode: 'otm', otm_offset: 3 })
  assert.deepEqual(
    buildReselectBody('PE', null, { ...fb, storedMode: 'threshold' }),
    { right: 'PE', mode: 'max_price', max_price: 45 })
})

import { reselectOutcome } from './strikeRule.ts'

const current = { ce: 24300, pe: 24100 }

test('an unchanged strike only shows a notice and leaves the layout alone', () => {
  const outcome = reselectOutcome({ strike: 24300, changed: false }, 'CE', current, false)
  assert.deepEqual(outcome, { notice: 'Strike 24300 is still the best match', ce: 24300, pe: 24100, skipKey: null })
})

test('a changed CE strike moves only CE and tells the layout effect to skip that exact change', () => {
  assert.deepEqual(reselectOutcome({ strike: 24500, changed: true }, 'CE', current, false),
    { notice: null, ce: 24500, pe: 24100, skipKey: '24500:24100' })
})

test('a changed PE strike moves only PE', () => {
  assert.deepEqual(reselectOutcome({ strike: 23900, changed: true }, 'PE', current, false),
    { notice: null, ce: 24300, pe: 23900, skipKey: '24300:23900' })
})

test('paper options sessions never set a skip key (their layout effect already returns early)', () => {
  assert.equal(reselectOutcome({ strike: 24500, changed: true }, 'CE', current, true).skipKey, null)
})

test('a side without a known strike keeps its unknown value instead of inventing one', () => {
  const outcome = reselectOutcome({ strike: 24500, changed: true }, 'CE', { ce: null, pe: undefined }, false)
  assert.equal(outcome.ce, 24500)
  assert.equal(outcome.pe, undefined)
  assert.equal(outcome.skipKey, '24500:undefined')   // matches the template the App effect compares against
})

test('pane strike errors carry the server reason for add-pane and restore', () => {
  const refused = new Error('Close the open PE 24100 position before streaming PE 24000')
  assert.equal(paneStrikeErrorMessage(refused, 'PE', 'add'),
    'PE pane not added: Close the open PE 24100 position before streaming PE 24000')
  assert.equal(paneStrikeErrorMessage(refused, 'PE', 'restore'),
    'Could not restore live PE contract: Close the open PE 24100 position before streaming PE 24000')
})

test('pane strike errors tolerate non-Error values and an empty reason', () => {
  assert.equal(paneStrikeErrorMessage('Error: boom', 'CE', 'add'), 'CE pane not added: boom')
  assert.equal(paneStrikeErrorMessage(undefined, 'CE', 'restore'),
    'Could not restore live CE contract: Unable to stream the selected option contract')
  assert.equal(paneStrikeErrorMessage(new Error('  '), 'CE', 'add'),
    'CE pane not added: Unable to stream the selected option contract')
})
