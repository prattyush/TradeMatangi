import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReselectBody, strikeRuleFromStart } from './strikeRule.ts'

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
