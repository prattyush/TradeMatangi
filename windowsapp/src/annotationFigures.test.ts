import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { annotationFigures, ARROW_HEIGHT, MARK_GAP, MARK_TEXT_STYLE } from '../../shared/analysis/kline/annotationFigures'

const entry = { color: '#3b82f6', text: 'Break/ORB', position: 'belowBar' as const, shape: 'arrowUp' as const }
const exit = { color: '#f97316', text: 'Break/ORB', position: 'aboveBar' as const, shape: 'arrowDown' as const }

describe('KLine pattern marks (like the Lightweight markers)', () => {
  it('draws an Entry as an up arrow under the candle with its text below the arrow', () => {
    const [arrow, text] = annotationFigures({ x: 100, y: 200 }, entry) as any[]
    expect(arrow.type).toBe('polygon')
    const ys = arrow.attrs.coordinates.map((c: any) => c.y)
    expect(Math.min(...ys)).toBe(200 + MARK_GAP) // the tip just under the low
    expect(Math.max(...ys)).toBe(200 + MARK_GAP + ARROW_HEIGHT)
    expect(arrow.attrs.coordinates[0]).toEqual({ x: 100, y: 200 + MARK_GAP }) // tip first, pointing at the candle
    expect(text.type).toBe('text')
    expect(text.attrs.y).toBeGreaterThan(200 + MARK_GAP + ARROW_HEIGHT) // text beyond the arrow
    expect(text.attrs.baseline).toBe('top')
  })
  it('draws an Exit as a down arrow over the candle with its text above the arrow', () => {
    const [arrow, text] = annotationFigures({ x: 100, y: 200 }, exit) as any[]
    const ys = arrow.attrs.coordinates.map((c: any) => c.y)
    expect(Math.max(...ys)).toBe(200 - MARK_GAP)
    expect(Math.min(...ys)).toBe(200 - MARK_GAP - ARROW_HEIGHT)
    expect(text.attrs.y).toBeLessThan(200 - MARK_GAP - ARROW_HEIGHT)
    expect(text.attrs.baseline).toBe('bottom')
  })
  it('has no box behind the text, and draws only the arrow when the text is empty (a dimmed mark)', () => {
    const [, text] = annotationFigures({ x: 0, y: 0 }, entry) as any[]
    expect(text.styles).toMatchObject({ backgroundColor: 'transparent', borderSize: 0, color: entry.color })
    expect(MARK_TEXT_STYLE.backgroundColor).toBe('transparent')
    expect(annotationFigures({ x: 0, y: 0 }, { ...entry, text: '' })).toHaveLength(1)
  })
})

describe('KLine buy / sell execution markers have no blue box either', () => {
  // klinecharts paints a blue box behind every text figure unless the style says otherwise; the execution markers (Analysis, trading charts,
  // What If) build their text figures inline, so the style is checked in their source.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('draws the Analysis execution and What If marker text with the shared no-box style', () => {
    const source = read('../../shared/analysis/kline/AnalysisChart.tsx')
    expect(source.match(/\.\.\.MARK_TEXT_STYLE,color:marker\.color/g)?.length).toBe(2)
  })
  it('draws the trading chart marker text with the shared no-box style', () => {
    const source = read('../../shared/charts/KLineChart.tsx')
    expect(source).toMatch(/name: "desktopTradeMarker"[\s\S]*?\.\.\.MARK_TEXT_STYLE/)
  })
})
