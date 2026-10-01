import { describe, expect, it, vi } from 'vitest'
import { PositionPnlPrimitive } from '../../frontend/src/indicators/positionPnlPrimitive'

const levels = [{ key: 'entry', label: 'Avg entry', price: 100, color: '#e6edf3' },
  { key: '1', label: '+1%', price: 110, color: '#22c55e' }]

function fixture() {
  const bars = { times: [100, 200, 300] }
  const scale = { y: 80, width: 500, height: 300 }
  const context = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })), fillRect: vi.fn(), fillText: vi.fn(),
  }
  const attachment = {
    chart: { timeScale: () => ({
      timeToCoordinate: (time: number) => bars.times.includes(time) ? bars.times.indexOf(time) * 50 + 100 : null,
      options: () => ({ barSpacing: 10 }),
    }) },
    series: { data: () => bars.times.map(time => ({ time })), priceToCoordinate: (price: number) => scale.y - (price - 100) },
    requestUpdate: vi.fn(),
  }
  const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: scale.width, height: scale.height } }) }
  const primitive = new PositionPnlPrimitive()
  primitive.attached(attachment as unknown as Parameters<PositionPnlPrimitive['attached']>[0])
  return { primitive, bars, scale, context, attachment, target: target as unknown as Parameters<PositionPnlPrimitive['draw']>[0] }
}

describe('website P&L chart primitive', () => {
  it('draws short segments and labels at exact prices', () => {
    const f = fixture()
    f.primitive.setLevels(levels, 200, null)
    f.primitive.draw(f.target)
    expect(f.context.moveTo.mock.calls).toEqual([[125, 80], [125, 70]])
    expect(f.context.lineTo.mock.calls).toEqual([[175, 80], [175, 70]])
    expect(f.context.fillText.mock.calls.map(call => call[0])).toEqual(['Avg entry', '+1%'])
  })

  it('draws when a fill timestamp is absent from reloaded chart history', () => {
    const f = fixture()
    f.primitive.setLevels(levels, 400, null)
    f.primitive.draw(f.target)
    expect(f.context.stroke).toHaveBeenCalledTimes(2)
    expect(f.context.moveTo).toHaveBeenCalledWith(175, 80)
    // Once the corresponding candle arrives, the original anchor is used.
    f.bars.times.push(400)
    f.primitive.draw(f.target)
    expect(f.context.moveTo).toHaveBeenCalledWith(225, 80)
  })

  it('starts drawing after asynchronous candle loading without another React update', () => {
    const f = fixture()
    f.bars.times = []
    f.primitive.setLevels(levels, 200, null)
    f.primitive.draw(f.target)
    expect(f.context.stroke).not.toHaveBeenCalled()
    f.bars.times = [100, 200, 300]
    f.primitive.draw(f.target)
    expect(f.context.stroke).toHaveBeenCalledTimes(2)
  })

  it('uses the current price scale on every repaint without a changed time range', () => {
    const f = fixture()
    f.primitive.setLevels(levels, 200, null)
    f.primitive.draw(f.target)
    f.scale.y = 140
    f.primitive.draw(f.target)
    expect(f.context.moveTo).toHaveBeenCalledWith(125, 140)
    expect(f.context.moveTo).toHaveBeenCalledWith(125, 130)
  })

  it('keeps the no-trade fallback anchored when later candles arrive', () => {
    const f = fixture()
    f.primitive.setLevels(levels, null, null)
    f.primitive.draw(f.target)
    f.bars.times.push(400)
    f.primitive.setLevels(levels, null, 400)
    f.primitive.draw(f.target)
    expect(f.context.moveTo.mock.calls.filter(call => call[1] === 80)).toEqual([[175, 80], [175, 80]])
  })

  it('clips to the actual chart pane instead of drawing over axes', () => {
    const f = fixture()
    f.scale.width = 160
    f.scale.height = 75
    f.primitive.setLevels(levels, 300, null)
    f.primitive.draw(f.target)
    expect(f.context.stroke).toHaveBeenCalledTimes(1)
    expect(f.context.lineTo).toHaveBeenCalledWith(160, 70)
  })

  it('clears disabled/flat position levels and stops drawing after detach', () => {
    const f = fixture()
    f.primitive.setLevels([], 200, null)
    f.primitive.draw(f.target)
    expect(f.context.stroke).not.toHaveBeenCalled()
    f.primitive.setLevels(levels, 200, null)
    f.primitive.detached()
    f.primitive.draw(f.target)
    expect(f.context.stroke).not.toHaveBeenCalled()
  })

  it('requests a chart repaint after updated levels and exposes one stable top view', () => {
    const f = fixture()
    f.primitive.setLevels(levels, 200, null)
    expect(f.attachment.requestUpdate).toHaveBeenCalledTimes(2)
    expect(f.primitive.paneViews()).toBe(f.primitive.paneViews())
    expect(f.primitive.paneViews()[0].zOrder?.()).toBe('top')
    expect(f.primitive.paneViews()[0].renderer()).toBe(f.primitive)
  })
})
