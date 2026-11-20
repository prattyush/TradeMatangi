import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GameChart } from './GameChart'
import { candleGeometry, candleStep, computeView, dataRanges, limitPoints, MAX_POINTS, priceTicks, type ChartData } from './chartModel'
import { DARK_THEME, drawChart, LIGHT_THEME, type Painter } from './drawChart'

const candles = Array.from({ length: 20 }, (_, i) => ({ t: i * 5, o: i, h: i + 3, l: i - 2, c: i + (i % 2 ? -1 : 1) }))
const size = { width: 400, height: 200 }

/** A Painter that records what was drawn. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = []
  const target: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'middle' }
  for (const name of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'fillText', 'setLineDash', 'clearRect']) target[name] = (...args: unknown[]) => { calls.push([name, ...args]) }
  return { painter: target as unknown as Painter, calls }
}

describe('chart model', () => {
  it('maps times and prices into the plot, higher prices drawing higher', () => {
    const view = computeView({ candles }, size)
    expect(view.x(view.xRange[0])).toBeCloseTo(view.plot.left, 6); expect(view.x(view.xRange[1])).toBeCloseTo(view.plot.left + view.plot.width, 6)
    expect(view.y(view.yRange[1])).toBeCloseTo(view.plot.top, 6); expect(view.y(view.yRange[0])).toBeCloseTo(view.plot.top + view.plot.height, 6)
    expect(view.y(10)).toBeLessThan(view.y(5)); expect(view.bodyWidth).toBeGreaterThan(0); expect(view.bodyWidth).toBeLessThanOrEqual(14)
  })
  it('honours fixed ranges and copes with empty or flat data', () => {
    const fixed = computeView({ candles, xRange: [-50, 100], yRange: [-10, 10] }, size)
    expect(fixed.xRange).toEqual([-50, 100]); expect(fixed.yRange).toEqual([-10, 10])
    for (const data of [{}, { line: [{ t: 1, v: 5 }] }, { candles: [{ t: 1, o: 5, h: 5, l: 5, c: 5 }] }] as ChartData[]) {
      const view = computeView(data, size)
      expect(Number.isFinite(view.x(1))).toBe(true); expect(Number.isFinite(view.y(5))).toBe(true); expect(view.yRange[1]).toBeGreaterThan(view.yRange[0]); expect(view.xRange[1]).toBeGreaterThan(view.xRange[0])
    }
    expect(computeView({ candles }, { width: 10, height: 10 }).plot.width).toBeGreaterThanOrEqual(1)
  })
  it('range covers levels, zones, markers and the clock; candle step is the median spacing', () => {
    const r = dataRanges({ levels: [{ y: 50 }], zones: [{ y1: -9, y2: 2 }], markers: [{ t: 99, y: 1, kind: 'entry' }], clock: -7 })
    expect(r.y).toEqual([-9, 50]); expect(r.x).toEqual([-7, 99])
    expect(candleStep(candles)).toBe(5); expect(candleStep([])).toBe(1)
    expect(dataRanges({ line: [{ t: 0, v: Number.NaN }, { t: 1, v: 2 }] }).y).toEqual([2, 2])
  })
  it('candle geometry puts the body between open and close inside the wicks and centres it in its slot', () => {
    const view = computeView({ candles }, size)
    const up = candleGeometry({ t: 10, o: 1, h: 5, l: 0, c: 4 }, view), down = candleGeometry({ t: 10, o: 4, h: 5, l: 0, c: 1 }, view)
    expect(up.up).toBe(true); expect(down.up).toBe(false)
    for (const g of [up, down]) { expect(g.wickTop).toBeLessThanOrEqual(g.bodyTop); expect(g.wickBottom).toBeGreaterThanOrEqual(g.bodyBottom); expect(g.x).toBeCloseTo(view.x(10 + view.step / 2), 6) }
  })
  it('price ticks are round numbers inside the range', () => {
    const ticks = priceTicks([-3.7, 11.2]); expect(ticks.length).toBeGreaterThan(2); expect(ticks.every(t => t >= -3.7 && t <= 11.2)).toBe(true)
    expect(priceTicks([5, 5])).toEqual([5]); expect(priceTicks([0, 1000])).toContain(200)
  })
  it('keeps at most 20,000 points, the newest ones', () => {
    const many = Array.from({ length: MAX_POINTS + 50 }, (_, i) => ({ t: i, v: i }))
    const cut = limitPoints(many)!; expect(cut.length).toBe(MAX_POINTS); expect(cut[0].t).toBe(50); expect(limitPoints(undefined)).toBeUndefined()
  })
})

describe('drawChart', () => {
  const full: ChartData = {
    candles, line: candles.map(c => ({ t: c.t, v: c.c })), levels: [{ y: 5, label: 'entry' }, { y: 8, dash: false }], zones: [{ y1: 2, y2: 4 }],
    markers: [{ t: 10, y: 5, kind: 'long', label: 'CE' }, { t: 20, y: 6, kind: 'short' }, { t: 30, y: 7, kind: 'exit' }], clock: 40,
  }
  it('paints the background first, every candle, the line, levels, zone, clock and markers', () => {
    const { painter, calls } = recorder()
    const view = drawChart(painter, full, size)
    expect(calls[0][0]).toBe('clearRect'); expect(calls[1]).toEqual(['fillRect', 0, 0, 400, 200])
    const names = calls.map(c => c[0])
    expect(names.filter(n => n === 'strokeRect').length).toBe(candles.filter(c => c.c >= c.o).length) // hollow bodies are the up candles
    expect(names.filter(n => n === 'fill').length).toBe(3) // one triangle or diamond per marker
    expect(calls.filter(c => c[0] === 'fillText').map(c => c[1])).toEqual(expect.arrayContaining(['entry', 'CE']))
    expect(view.plot.width).toBeGreaterThan(0)
  })
  it('draws nothing but the frame for empty data, and never throws on odd values', () => {
    const { painter, calls } = recorder()
    expect(() => drawChart(painter, {}, size)).not.toThrow(); expect(calls.some(c => c[0] === 'strokeRect')).toBe(false)
    expect(() => drawChart(recorder().painter, { candles: [{ t: 0, o: Number.NaN, h: 1, l: 0, c: 1 }], line: [{ t: Number.NaN, v: 1 }] }, size)).not.toThrow()
  })
  it('has a dark and a light theme with distinct colours for up and down', () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) expect(theme.up).not.toBe(theme.down)
    const { painter } = recorder(); drawChart(painter, full, size, LIGHT_THEME); expect(painter.font).toBe(LIGHT_THEME.font)
  })
})

describe('GameChart component', () => {
  it('renders one labelled canvas of the requested size', () => {
    const html = renderToStaticMarkup(createElement(GameChart, { data: { candles }, label: 'Price chart', width: 500, height: 250 }))
    expect(html).toContain('<canvas'); expect(html).toContain('role="img"'); expect(html).toContain('aria-label="Price chart"'); expect(html).toContain('width="500"'); expect(html).toContain('height="250"')
  })
})
