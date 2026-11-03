import { describe, expect, it } from 'vitest'
import { canonicalDrawingKey, drawingIdentity } from '../../shared/charts/drawingIdentity'
import { analysisDrawingInstrument, drawingPoints, overlayName, overlayPointsToStored, toolStyle, defaultDrawingStyle } from '../../shared/charts/klineDrawingModel'

// Instrument literals copied from the trading charts (windowsapp/src/App.tsx:158 and WebsiteKLineChart.tsx:202).
const dayOption = { kind: 'option', exchange: 'NSE', underlying: 'NIFTY', expiry: '2026-11-10', strike: 24500, right: 'CE' }
const dayIndex = { kind: 'index', exchange: 'NSE', symbol: 'NIFTY' }

describe('Analysis drawing instrument', () => {
  it('matches the Day option instrument so drawings are shared', () => {
    const analysis = analysisDrawingInstrument({ symbol: 'NIFTY', right: 'CE', strike: 24500, expiry: '2026-11-10', kind: 'index', exchange: 'NSE' })
    expect(canonicalDrawingKey(analysis)).toBe(canonicalDrawingKey(dayOption))
    expect(drawingIdentity(analysis, undefined, undefined, true).writeInstrument).toEqual(dayOption)
  })
  it('matches the Day underlying instrument using catalogue kind', () => {
    expect(canonicalDrawingKey(analysisDrawingInstrument({ symbol: 'NIFTY', kind: 'index', exchange: 'NSE' }))).toBe(canonicalDrawingKey(dayIndex))
  })
  it('falls back to equity/NSE and BSE for BSESEN like the website chart', () => {
    expect(analysisDrawingInstrument({ symbol: 'TCS' })).toEqual({ kind: 'equity', exchange: 'NSE', symbol: 'TCS' })
    expect(analysisDrawingInstrument({ symbol: 'BSESEN' })).toMatchObject({ exchange: 'BSE' })
  })
  it('normalises feed-venue option exchanges to the canonical Day key', () => {
    const swing = { ...dayOption, exchange: 'NFO' }
    expect(drawingIdentity(swing, undefined, undefined, true).writeInstrument).toEqual(dayOption)
  })
})

describe('KLine drawing model', () => {
  it('maps catalogue tools to klinecharts overlay names', () => {
    expect(overlayName('Trend')).toBe('segment')
    expect(overlayName('Horizontal')).toBe('horizontalStraightLine')
    expect(overlayName('Fib Retracement')).toBe('fibonacciLine')
    expect(overlayName('rect')).toBe('rect')
  })
  it('round-trips points between stored seconds and chart milliseconds', () => {
    const stored = [{ timestamp: 1_746_522_900, price: 23_100.5 }]
    const overlay = drawingPoints({ tool: 'Trend', points: stored })
    expect(overlay).toEqual([{ timestamp: 1_746_522_900_000, value: 23_100.5 }])
    expect(overlayPointsToStored(overlay)).toEqual(stored)
  })
  it('uses per-tool line settings', () => {
    expect(toolStyle('Horizontal', defaultDrawingStyle).color).toBe(defaultDrawingStyle.horizontalLineColor)
    expect(toolStyle('Trend', defaultDrawingStyle).width).toBe(defaultDrawingStyle.trendLineWidth)
    expect(toolStyle('rect', defaultDrawingStyle).color).toBe(defaultDrawingStyle.drawingLineColor)
  })
})
