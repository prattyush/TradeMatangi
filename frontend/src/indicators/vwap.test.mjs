import assert from 'node:assert/strict'
import test from 'node:test'
import { candlesHaveVolume, computeVwap, nextVwap, volumeHistogram, vwapBeforeLast } from './vwap.ts'

const DAY = 86400
const bar = (time, high, low, close, volume, open = close) => ({ time, open, high, low, close, volume })

test('VWAP weights the typical price by volume and accumulates', () => {
  const { points } = computeVwap([bar(1000, 12, 8, 10, 100), bar(1060, 24, 16, 20, 300)])
  assert.equal(points[0].value, 10)
  // (10*100 + 20*300) / 400 = 17.5
  assert.equal(points[1].value, 17.5)
})

test('VWAP restarts on a new trading day (IST date under the IST-as-UTC timestamps)', () => {
  const { points } = computeVwap([bar(DAY * 5 + 33300, 12, 8, 10, 100), bar(DAY * 6 + 33300, 24, 16, 20, 50)])
  assert.equal(points[1].value, 20)
})

test('zero cumulative volume shows the typical price, not 0', () => {
  const { points } = computeVwap([bar(1000, 12, 8, 10, 0), bar(1060, 15, 9, 12, undefined)])
  assert.deepEqual(points.map(point => point.value), [10, 12])
})

test('a forming bar re-applied to the same base does not accumulate twice', () => {
  const done = [bar(1000, 12, 8, 10, 100)]
  const base = computeVwap(done).state
  const first = nextVwap(base, bar(1060, 24, 16, 20, 100))
  const second = nextVwap(base, bar(1060, 24, 16, 20, 300))
  assert.equal(first.value, 15)
  assert.equal(second.value, 17.5)
  assert.equal(base.cumVolume, 100)
})

test('vwapBeforeLast is the base for the last bar', () => {
  const candles = [bar(1000, 12, 8, 10, 100), bar(1060, 24, 16, 20, 300)]
  assert.deepEqual(vwapBeforeLast(candles), computeVwap(candles.slice(0, 1)).state)
  assert.equal(vwapBeforeLast([]), null)
})

test('candlesHaveVolume is false for an index (null or absent) and true if any bar has volume', () => {
  assert.equal(candlesHaveVolume([{ volume: null }, {}]), false)
  assert.equal(candlesHaveVolume([{}, { volume: 0 }]), true)
})

test('volume histogram colours rising and falling bars and treats missing volume as 0', () => {
  const points = volumeHistogram([bar(1000, 12, 8, 11, 5, 10), bar(1060, 12, 8, 9, undefined, 10)])
  assert.equal(points[0].value, 5)
  assert.notEqual(points[0].color, points[1].color)
  assert.equal(points[1].value, 0)
})
