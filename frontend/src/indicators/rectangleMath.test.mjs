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
