import assert from 'node:assert/strict'
import test from 'node:test'
import { distToSegment, hitBox, hitHorizontal, hitRect, hitSegments, markerBox, nearest, textBox } from './lightweightHit.ts'

test('distance to a segment is to its nearest point, and to an end beyond it', () => {
  assert.equal(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3)
  assert.equal(distToSegment({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5)
  assert.equal(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5) // a zero-length segment is a point
})

test('segments are hit within the tolerance only, the nearest one is reported', () => {
  const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  const b = [{ x: 0, y: 10 }, { x: 100, y: 10 }]
  assert.equal(hitSegments({ x: 50, y: 4 }, [a, b]), 4)
  assert.equal(hitSegments({ x: 50, y: 7 }, [a, b]), 3)
  assert.equal(hitSegments({ x: 50, y: 30 }, [a, b]), null)
  assert.equal(hitSegments({ x: 150, y: 0 }, [a]), null) // a trend line does not run past its ends
})

test('a horizontal line is hit at any x within the tolerance', () => {
  assert.equal(hitHorizontal({ x: 999, y: 52 }, 50), 2)
  assert.equal(hitHorizontal({ x: 0, y: 70 }, 50), null)
})

test('a rectangle is hit on its border and inside (inside is the lowest priority), not outside', () => {
  const a = { x: 10, y: 10 }
  const b = { x: 110, y: 60 }
  assert.equal(hitRect({ x: 12, y: 30 }, a, b), 2)
  assert.equal(hitRect({ x: 60, y: 35 }, a, b), 7) // the middle: tolerance, so a line across it is nearer
  assert.equal(hitRect({ x: 60, y: 100 }, a, b), null)
  assert.equal(hitRect({ x: 60, y: 64 }, a, b), 4) // just outside the border
})

test('a text box and a marker box are hit anywhere inside them', () => {
  const box = textBox({ x: 100, y: 50 }, 60)
  assert.equal(hitBox({ x: 130, y: 52 }, box), 0)
  assert.equal(hitBox({ x: 98, y: 52 }, box), null) // left of the text, on the point itself
  assert.equal(hitBox({ x: 130, y: 70 }, box), null)
  assert.equal(hitBox({ x: 100, y: 70 }, markerBox({ x: 100, y: 50 }, true)), 0) // a buy arrow is below its point
  assert.equal(hitBox({ x: 100, y: 70 }, markerBox({ x: 100, y: 50 }, false)), null)
})

test('the nearest drawing wins and the one drawn last wins a tie; none gives null', () => {
  assert.equal(nearest([{ index: 0, distance: 3 }, { index: 1, distance: 1 }]), 1)
  assert.equal(nearest([{ index: 0, distance: 2 }, { index: 1, distance: 2 }]), 1)
  assert.equal(nearest([{ index: 0, distance: null }, { index: 1, distance: null }]), null)
  assert.equal(nearest([]), null)
})
