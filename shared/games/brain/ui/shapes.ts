/**
 * Shapes drawn in code (no icon packs). Polygons 1-5 are irregular and have **no mirror symmetry**, so a mirrored copy is
 * genuinely different from the original (Quick Match's mirror trials); a test checks this with `hasMirrorSymmetry`.
 * Points are in a 100x100 box centred on 0,0.
 */
export const POLYGONS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], // 0 = circle
  [[-38, -34], [36, -42], [44, 8], [-2, 40], [-30, 22]],
  [[-40, -40], [8, -40], [8, -6], [42, -6], [42, 36], [-40, 36]],
  [[-42, 30], [-8, -42], [10, -10], [40, -34], [34, 38]],
  [[-36, -40], [30, -26], [44, 20], [-6, 12], [-40, 40]],
  [[-44, 0], [-14, -36], [22, -30], [44, 6], [6, 14], [-20, 40]],
]

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** True when some reversal of the vertex order maps the polygon onto itself, i.e. it has a mirror axis (so it is not chiral). */
export function hasMirrorSymmetry(points: ReadonlyArray<readonly [number, number]>, eps = 0.5): boolean {
  const n = points.length
  for (let c = 0; c < n; c++) {
    let same = true
    for (let i = 0; i < n && same; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(dist(points[i], points[j]) - dist(points[(c - i + n) % n], points[(c - j + n) % n])) > eps) { same = false; break }
      }
    }
    if (same) return true
  }
  return false
}

export const polygonPath = (points: ReadonlyArray<readonly [number, number]>): string =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z'
