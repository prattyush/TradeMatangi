/**
 * How a pattern mark (Entry / Exit, from Deep Dive, Patterns, From your trades) is drawn on the KLine chart: the same as the Lightweight
 * chart's marker, an arrow just outside the marked candle and the text beyond it with no box. An Entry sits below the candle's low
 * (arrow up, text under it), an Exit above its high (arrow down, text over it). Pure (no klinecharts import) so it can be unit tested.
 */
export interface AnnotationMark {
  color: string
  text: string
  position: 'aboveBar' | 'belowBar'
  shape: 'arrowUp' | 'arrowDown'
}
interface Point { x: number; y: number }

/** Gap between the candle and the arrow's tip, the arrow's size, and the gap before the text (px). */
export const MARK_GAP = 5
export const ARROW_HEIGHT = 16
export const ARROW_HALF_WIDTH = 6
const TEXT_GAP = 3

/** The arrow's outline relative to its tip, pointing up (y grows downward); an arrow pointing down is the same with y flipped. */
const ARROW: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [ARROW_HALF_WIDTH, 8], [2.5, 8], [2.5, ARROW_HEIGHT], [-2.5, ARROW_HEIGHT], [-2.5, 8], [-ARROW_HALF_WIDTH, 8],
]

/** The text's style: klinecharts paints a blue box behind text unless told otherwise. */
export const MARK_TEXT_STYLE = { size: 11, weight: 'bold', backgroundColor: 'transparent', borderSize: 0, borderColor: 'transparent' } as const

export function annotationFigures(point: Point, mark: AnnotationMark) {
  const below = mark.position === 'belowBar'
  const direction = below ? 1 : -1 // down the screen below the candle, up the screen above it
  const tipY = point.y + direction * MARK_GAP
  // The tip points at the candle and the body lies away from it: an up arrow below the candle, a down arrow above it (a mark's shape
  // and position always agree: Entry is arrowUp / belowBar, Exit arrowDown / aboveBar).
  const flip = mark.shape === 'arrowUp' ? 1 : -1
  const arrow = ARROW.map(([dx, dy]) => ({ x: point.x + dx, y: tipY + flip * dy }))
  const bodyEnd = tipY + flip * ARROW_HEIGHT
  const figures: Array<Record<string, unknown>> = [
    { type: 'polygon', attrs: { coordinates: arrow }, styles: { style: 'fill', color: mark.color }, ignoreEvent: true },
  ]
  if (mark.text) {
    figures.push({
      type: 'text',
      attrs: { x: point.x, y: bodyEnd + direction * TEXT_GAP, text: mark.text, align: 'center', baseline: below ? 'top' : 'bottom' },
      styles: { ...MARK_TEXT_STYLE, color: mark.color },
      ignoreEvent: true,
    })
  }
  return figures
}
