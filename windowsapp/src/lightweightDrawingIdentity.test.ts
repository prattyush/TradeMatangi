import { describe, expect, it } from 'vitest'
import { chartDrawingInstrument } from '../../frontend/src/components/chartDrawingInstrument'
import { analysisDrawingInstrument } from '../../shared/charts/klineDrawingModel'
import { canonicalDrawingKey, drawingIdentity } from '../../shared/charts/drawingIdentity'

// The Lightweight trading chart (Day, Swing, Browse) and the Analysis charts must find the same saved drawings as the KLine chart.
const writeKey = (instrument: Record<string, unknown>) => canonicalDrawingKey(drawingIdentity(instrument, undefined, undefined, true).writeInstrument)

describe('drawing identity of the trading chart and the Analysis charts', () => {
  it('is the same for an option contract', () => {
    const option = { symbol: 'NIFTY', right: 'CE', strike: 24500, expiry: '2026-11-26' }
    expect(writeKey(chartDrawingInstrument({ paneType: 'options', ...option }))).toBe(writeKey(analysisDrawingInstrument(option)))
  })
  it('is the same for an underlying, whatever the catalogue calls it', () => {
    for (const kind of ['index', 'equity']) {
      expect(writeKey(chartDrawingInstrument({ paneType: 'equity', symbol: 'NIFTY', catalogueKind: kind })))
        .toBe(writeKey(analysisDrawingInstrument({ symbol: 'NIFTY', kind, exchange: 'NSE' })))
    }
  })
  it('puts a swing chart on the same records as the Day chart of its contract', () => {
    const swing = chartDrawingInstrument({ paneType: 'options', symbol: 'BSESEN', swingChart: true, right: 'PE', strike: 80000, expiry: '2026-11-26' })
    const day = chartDrawingInstrument({ paneType: 'options', symbol: 'BSESEN', right: 'PE', strike: 80000, expiry: '2026-11-26' })
    expect(writeKey(swing)).toBe(writeKey(day))
  })
})
