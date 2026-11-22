import { describe, expect, it, vi } from 'vitest'
import { candleDate, classificationOf, saveMode, shortLabel, sparklinePoints, toggleValue } from './chartStructuresModel'
import { createPatternsClient } from '../patternsClient'

const at = (date: string, time: string) => Date.parse(`${date}T${time}Z`) / 1000
const candle = (date: string, time: string, close: number) => ({ time: at(date, time), open: close, high: close + 1, low: close - 1, close })

describe('chart structures model', () => {
  it('draws only the requested day, scaled into the box', () => {
    const candles = [candle('2026-10-01', '09:15:00', 100), candle('2026-10-02', '09:15:00', 500), candle('2026-10-02', '09:30:00', 510), candle('2026-10-02', '09:45:00', 505)]
    const points = sparklinePoints(candles, '2026-10-02', 200, 40).split(' ')
    expect(points).toHaveLength(3)
    expect(points[0].startsWith('0.0,')).toBe(true)
    expect(points[2].startsWith('200.0,')).toBe(true)
    expect(sparklinePoints(candles, '2026-10-01', 200, 40)).toBe('')
  })
  it('reads the trading date from IST-as-UTC candle times', () => {
    expect(candleDate(at('2026-10-02', '09:15:00'))).toBe('2026-10-02')
  })
  it('never edits a system or shared structure: it creates the user a copy', () => {
    expect(saveMode({ is_predefined: true, can_delete: false })).toBe('create')
    expect(saveMode({ is_predefined: false, can_delete: false })).toBe('create')
    expect(saveMode({ is_predefined: false, can_delete: true })).toBe('update')
  })
  it('defaults a missing classification to undefined', () => {
    expect(classificationOf(null)).toEqual({ opening_type: 'undefined', midday_type: 'undefined', closing_type: 'undefined' })
  })
  it('toggles filter values', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
    expect(shortLabel('gap_up')).toBe('Gap Up')
    expect(shortLabel('mystery')).toBe('mystery')
  })
})

describe('chart structures client', () => {
  it('joins filters with commas and omits empty ones', async () => {
    const request = vi.fn().mockResolvedValue({ structures: [] })
    await createPatternsClient(request).listStructures({ opening_types: ['gap_up', 'trend'], midday_types: [], closing_types: undefined })
    expect(request).toHaveBeenCalledWith('chart-structures/structures?opening_types=gap_up%2Ctrend', 'GET')
  })
  it('asks for the OHLC of one day with interval and days back', async () => {
    const request = vi.fn().mockResolvedValue({ candles: [], structure: null })
    await createPatternsClient(request).structureOhlc('NIFTY', '2026-10-02', 15, 1)
    expect(request).toHaveBeenCalledWith('chart-structures/ohlc/NIFTY/2026-10-02?interval_minutes=15&days_back=1', 'GET')
  })
  it('saves through POST for a new custom structure and PUT for an existing one', async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = createPatternsClient(request)
    const body = { opening_type: 'gap_up', midday_type: 'trend', closing_type: 'breakout' }
    await client.createStructure({ symbol: 'NIFTY', date: '2026-10-02', ...body })
    await client.updateStructure('abc', body)
    expect(request).toHaveBeenNthCalledWith(1, 'chart-structures/structure', 'POST', { symbol: 'NIFTY', date: '2026-10-02', ...body })
    expect(request).toHaveBeenNthCalledWith(2, 'chart-structures/structure/abc', 'PUT', body)
  })
})
