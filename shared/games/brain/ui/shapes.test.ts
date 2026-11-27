import { describe, expect, it } from 'vitest'
import { hasMirrorSymmetry, POLYGONS, polygonPath } from './shapes'

describe('Quick Match polygons', () => {
  it('has five polygons, each with no mirror symmetry (so a mirror image really differs)', () => {
    expect(POLYGONS.length).toBe(6)
    for (let i = 1; i < POLYGONS.length; i++) expect(hasMirrorSymmetry(POLYGONS[i]), `polygon ${i}`).toBe(false)
  })
  it('the symmetry check recognises symmetric shapes (it can fail)', () => {
    expect(hasMirrorSymmetry([[-40, -40], [40, -40], [40, 40], [-40, 40]])).toBe(true) // square
    expect(hasMirrorSymmetry([[0, -40], [40, 30], [-40, 30]])).toBe(true) // isosceles triangle
    expect(hasMirrorSymmetry([[0, -40], [30, -10], [0, 40], [-30, -10]])).toBe(true) // kite
  })
  it('the polygons stay inside the 100 x 100 box and are valid paths', () => {
    for (const points of POLYGONS.slice(1)) {
      for (const [x, y] of points) expect(Math.abs(x) <= 50 && Math.abs(y) <= 50).toBe(true)
      expect(polygonPath(points)).toMatch(/^M-?\d+ -?\d+( L-?\d+ -?\d+)+ Z$/)
    }
  })
})
