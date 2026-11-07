import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_RECT_STYLE, formatAxisTime, hexToRgba, normalizeRect, normalizeRectStyle } from './rectangleMath.ts'

test('hexToRgba handles 6- and 3-digit hex and clamps alpha', () => {
  assert.equal(hexToRgba('#60a5fa', 0.16), 'rgba(96, 165, 250, 0.16)')
  assert.equal(hexToRgba('#fff', 2), 'rgba(255, 255, 255, 1)')
  assert.equal(hexToRgba('not-a-color', 0.5), 'rgba(96, 165, 250, 0.5)')
})

test('normalizeRectStyle validates colour and clamps opacity', () => {
  assert.deepEqual(normalizeRectStyle(undefined), DEFAULT_RECT_STYLE)
  assert.deepEqual(normalizeRectStyle({ drawingFillColor: '#ff0000', drawingFillOpacity: 0.3 }),
    { fillColor: '#ff0000', opacity: 0.3 })
  assert.deepEqual(normalizeRectStyle({ drawingFillColor: 'red', drawingFillOpacity: 5 }),
    { fillColor: DEFAULT_RECT_STYLE.fillColor, opacity: 1 })
  assert.equal(normalizeRectStyle({ drawingFillOpacity: 0 }).opacity, 0.02)
})

test('normalizeRect orders corners regardless of click order', () => {
  assert.deepEqual(
    normalizeRect({ time: 200, price: 10 }, { time: 100, price: 30 }),
    { timeMin: 100, timeMax: 200, priceMin: 10, priceMax: 30 })
})

test('formatAxisTime shows IST wall-clock from IST-as-UTC seconds', () => {
  assert.equal(formatAxisTime(Date.UTC(2026, 10, 3, 9, 15) / 1000), '09:15')
})

import { extrapolateTimeX, mergeRectSettings } from './rectangleMath.ts'

// Candles every 60 s starting at t=1000, drawn 10 px apart from x=100: x = 100 + (t - 1000) / 60 * 10
const TIMES = [1000, 1060, 1120, 1180]
const SPACING = 10
const coordinateOf = t => (TIMES.includes(t) ? 100 + ((t - 1000) / 60) * SPACING : null)

test('a corner past the last candle is extrapolated from the bar spacing, never dropped', () => {
  assert.equal(extrapolateTimeX(1180 + 120, TIMES, SPACING, coordinateOf), 130 + 2 * SPACING)
})

test('a corner before the first candle is extrapolated to the left', () => {
  assert.equal(extrapolateTimeX(1000 - 60, TIMES, SPACING, coordinateOf), 100 - SPACING)
})

test('a corner in a gap snaps to the nearest candle', () => {
  assert.equal(extrapolateTimeX(1075, TIMES, SPACING, coordinateOf), coordinateOf(1060))
  assert.equal(extrapolateTimeX(1100, TIMES, SPACING, coordinateOf), coordinateOf(1120))
})

test('extrapolation gives up cleanly when there is nothing to measure against', () => {
  assert.equal(extrapolateTimeX(1500, [1000], SPACING, coordinateOf), null)
  assert.equal(extrapolateTimeX(1500, [], SPACING, coordinateOf), null)
  assert.equal(extrapolateTimeX(1500, [1000, 1000], SPACING, coordinateOf), null)   // zero spacing
  assert.equal(extrapolateTimeX(1500, TIMES, SPACING, () => null), null)             // chart cannot place the edge candle
})

test('saving the fill keeps every other chart setting and does not mutate the stored record', () => {
  const stored = { theme: 'dark', chartType: 'candles', drawingFillColor: '#000000', drawingFillOpacity: 0.9 }
  const merged = mergeRectSettings(stored, { fillColor: '#ff0000', opacity: 0.3 })
  assert.deepEqual(merged, { theme: 'dark', chartType: 'candles', drawingFillColor: '#ff0000', drawingFillOpacity: 0.3 })
  assert.equal(stored.drawingFillColor, '#000000')
})

test('saving sanitises a bad colour and an out-of-range opacity, and copes with an empty record', () => {
  assert.deepEqual(mergeRectSettings(undefined, { fillColor: 'red', opacity: 7 }), { drawingFillColor: DEFAULT_RECT_STYLE.fillColor, drawingFillOpacity: 1 })
  assert.deepEqual(mergeRectSettings(null, { fillColor: '#abc', opacity: 0 }), { drawingFillColor: '#abc', drawingFillOpacity: 0.02 })
})
