import assert from 'node:assert/strict'
import test from 'node:test'
import {
  otmStrikes, patternStrikeRule, roundToStrike, savedStrikes,
} from './patternStrikes.ts'

const threshold = { mode: 'threshold', ceCap: 60, peCap: 45 }

test('an index with the Max Price setting uses Max Price with the per-side caps', () => {
  assert.deepEqual(patternStrikeRule('NIFTY', threshold), { mode: 'max_price', ceCap: 60, peCap: 45 })
  assert.deepEqual(patternStrikeRule('BSESEN', threshold), { mode: 'max_price', ceCap: 60, peCap: 45 })
})

test('the OTM setting, and any stock, stay OTM', () => {
  assert.deepEqual(patternStrikeRule('NIFTY', { ...threshold, mode: 'otm' }), { mode: 'otm' })
  for (const stock of ['RELIND', 'TATMOT', 'TATPOW']) assert.deepEqual(patternStrikeRule(stock, threshold), { mode: 'otm' })
})

test('a missing or non-positive cap falls back to OTM instead of a wrong pick', () => {
  assert.deepEqual(patternStrikeRule('NIFTY', { ...threshold, ceCap: 0 }), { mode: 'otm' })
  assert.deepEqual(patternStrikeRule('NIFTY', { ...threshold, peCap: Number.NaN }), { mode: 'otm' })
})

test('the legacy value max_price is accepted like threshold', () => {
  assert.equal(patternStrikeRule('NIFTY', { ...threshold, mode: 'max_price' }).mode, 'max_price')
})

test('OTM strikes move away from ATM on both sides and a negative offset goes in', () => {
  assert.equal(roundToStrike(24512, 50), 24500)
  assert.deepEqual(otmStrikes(24500, 2, 50), { ce: 24600, pe: 24400 })
  assert.deepEqual(otmStrikes(24500, -1, 50), { ce: 24450, pe: 24550 })
  assert.deepEqual(otmStrikes(24500, 0, 50), { ce: 24500, pe: 24500 })
})

test('a saved chart gives its own PE strike, and older charts reuse the CE strike', () => {
  assert.deepEqual(savedStrikes({ strike: 24600, strike_pe: 24400 }), { ce: 24600, pe: 24400 })
  assert.deepEqual(savedStrikes({ strike: 24500 }), { ce: 24500, pe: 24500 })
  assert.deepEqual(savedStrikes({ strike: 24500, strike_pe: null }), { ce: 24500, pe: 24500 })
  assert.deepEqual(savedStrikes({}), { ce: undefined, pe: undefined })
})
