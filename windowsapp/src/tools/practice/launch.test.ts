import { describe, expect, it } from 'vitest'
import { REPLAY_SPEEDS, launchFrom, practiceTiles } from './launch'
import type { PracticePlan } from '../../../../shared/practice/types'

const plan = (extra: Partial<PracticePlan> = {}): PracticePlan => ({
  symbol: 'NIFTY', date: '2026-10-08', start_time: '09:33:00', interval_minutes: 3, instrument_type: 'options', strike_ce: 24500, strike_pe: 24400,
  expiry: '2026-10-13', practice: { category: 'Breakout', strategy: 'Opening range', start_offset_min: 12 }, days_available: 3, repeated: false, ...extra,
})
const config = (extra = {}) => ({ symbol: 'NIFTY', date: '2026-10-08', instrument_type: 'options' as const, strike: 24500, expiry: '2026-10-13', strike_ce: 24500, strike_pe: 24400, underlyingPrice: 0, ...extra })
const ids = () => { let n = 0; return () => `t${++n}` }

describe('a practice launch', () => {
  it('carries the day, start, contracts, speed and marker, and nothing of the recorded answer', () => {
    const launch = launchFrom(7, plan(), config(), 2)
    expect(launch).toEqual({ id: 7, symbol: 'NIFTY', date: '2026-10-08', start_time: '09:33:00', interval_minutes: 3, instrument_type: 'options',
      strike_ce: 24500, strike_pe: 24400, expiry: '2026-10-13', speed: 2, practice: { category: 'Breakout', strategy: 'Opening range', start_offset_min: 12 } })
    expect(JSON.stringify(launch)).not.toMatch(/side|annotation|recorded/)
  })

  it('opens the underlying with the CE and PE the day was marked on, on the chart interval', () => {
    const tiles = practiceTiles(launchFrom(1, plan({ interval_minutes: 5 }), config(), 1), ids())
    expect(tiles.map(t => [t.id, t.kind, t.right, t.strike, t.expiry, t.interval, t.tradingDate, t.selection_mode])).toEqual([
      ['t1', 'spot', 'CE', '', '', '5', '2026-10-08', undefined],
      ['t2', 'option', 'CE', '24500', '2026-10-13', '5', '2026-10-08', 'manual'],
      ['t3', 'option', 'PE', '24400', '2026-10-13', '5', '2026-10-08', 'manual'],
    ])
    expect(tiles.every(t => t.symbol === 'NIFTY')).toBe(true)
  })

  it('is the underlying alone for an equity day, or when a strike or the expiry is missing', () => {
    expect(practiceTiles(launchFrom(1, plan({ instrument_type: 'equity' }), config({ instrument_type: 'equity', strike_ce: undefined, strike_pe: undefined, expiry: undefined }), 1), ids())).toHaveLength(1)
    expect(practiceTiles(launchFrom(1, plan(), config({ strike_pe: undefined }), 1), ids())).toHaveLength(1)
    expect(practiceTiles(launchFrom(1, plan(), config({ expiry: undefined }), 1), ids())).toHaveLength(1)
  })

  it('gives every screen fresh tile ids', () => {
    const launch = launchFrom(1, plan(), config(), 1)
    const a = practiceTiles(launch), b = practiceTiles(launch)
    expect(new Set([...a, ...b].map(t => t.id)).size).toBe(6)
  })

  it('offers the speeds of the desktop Speed list', () => {
    expect([...REPLAY_SPEEDS]).toEqual([0.25, 0.5, 1, 1.1, 1.25, 1.5, 2, 5, 10])
  })
})
