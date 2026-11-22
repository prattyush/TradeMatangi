/**
 * Picking a drawing under a click on a Lightweight chart. Lightweight gives a chart click only as pixel coordinates, so each drawing is
 * turned into pixel geometry and the click is matched to the nearest one. Pure (no chart), so the geometry is unit-tested on its own.
 */
export interface Px { x: number; y: number }
export interface Box { left: number; right: number; top: number; bottom: number }

/** How close (px) a click has to be to a line, a border or a text to pick it. */
export const HIT_PX = 7

export function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance to the nearest segment when within `tolerance`, else null. */
export function hitSegments(p: Px, segments: ReadonlyArray<readonly [Px, Px]>, tolerance = HIT_PX): number | null {
  let best: number | null = null
  for (const [a, b] of segments) {
    const d = distToSegment(p, a, b)
    if (d <= tolerance && (best === null || d < best)) best = d
  }
  return best
}

/** A full-width horizontal line at `y`. */
export function hitHorizontal(p: Px, y: number, tolerance = HIT_PX): number | null {
  const d = Math.abs(p.y - y)
  return d <= tolerance ? d : null
}

/** A rectangle given by two corners: its border within `tolerance`, or anywhere inside it (the lowest priority, so a line over it wins). */
export function hitRect(p: Px, a: Px, b: Px, tolerance = HIT_PX): number | null {
  const left = Math.min(a.x, b.x)
  const right = Math.max(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const bottom = Math.max(a.y, b.y)
  if (p.x < left - tolerance || p.x > right + tolerance || p.y < top - tolerance || p.y > bottom + tolerance) return null
  const border = Math.min(Math.abs(p.x - left), Math.abs(p.x - right), Math.abs(p.y - top), Math.abs(p.y - bottom))
  const inside = p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
  if (!inside) return Math.min(
    Math.hypot(Math.max(left - p.x, 0, p.x - right), Math.max(top - p.y, 0, p.y - bottom)),
    tolerance,
  )
  return border <= tolerance ? border : tolerance
}

/** Anywhere in a box (grown by `margin`): 0, else null. */
export function hitBox(p: Px, box: Box, margin = 3): number | null {
  return p.x >= box.left - margin && p.x <= box.right + margin && p.y >= box.top - margin && p.y <= box.bottom + margin ? 0 : null
}

/** The box a text drawing covers: from just right of its point, `width` wide, a line high. */
export function textBox(at: Px, width: number): Box {
  return { left: at.x + 6, right: at.x + 6 + width, top: at.y - 9, bottom: at.y + 9 }
}

/** The box of a Buy / Sell marker's arrow: an up arrow sits below its point, a down arrow above it. */
export function markerBox(at: Px, buy: boolean): Box {
  return buy
    ? { left: at.x - 12, right: at.x + 12, top: at.y - 4, bottom: at.y + 32 }
    : { left: at.x - 12, right: at.x + 12, top: at.y - 32, bottom: at.y + 4 }
}

/** The index of the nearest candidate; on a tie the one drawn last (on top) wins. */
export function nearest(candidates: ReadonlyArray<{ index: number; distance: number | null }>): number | null {
  let best: { index: number; distance: number } | null = null
  for (const { index, distance } of candidates) {
    if (distance === null) continue
    if (best === null || distance < best.distance || (distance === best.distance && index > best.index)) best = { index, distance }
  }
  return best ? best.index : null
}
