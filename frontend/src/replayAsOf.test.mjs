import assert from 'node:assert/strict'
import test from 'node:test'
import { replayAsOfTime } from './replayAsOf.ts'

const at = (date, hms) => Date.parse(`${date}T${hms}Z`) / 1000

test('gives the replay clock as HH:MM:SS on the chart date', () => {
  assert.equal(replayAsOfTime(at('2026-11-06', '09:29:30'), '2026-11-06'), '09:29:30')
  assert.equal(replayAsOfTime(at('2026-11-06', '09:15:00'), '2026-11-06'), '09:15:00')
  assert.equal(replayAsOfTime(at('2026-11-06', '15:29:59'), '2026-11-06'), '15:29:59')
})

test('ignores a clock from another date, a missing clock and bad numbers', () => {
  assert.equal(replayAsOfTime(at('2026-11-05', '09:29:30'), '2026-11-06'), null)
  for (const bad of [null, undefined, 0, -5, NaN, Infinity]) assert.equal(replayAsOfTime(bad, '2026-11-06'), null)
})
