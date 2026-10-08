import { describe, expect, it } from 'vitest'
import { compactLayout, retainedPanes, type PreparedSession } from './sessionPreparation'
const tile = { id: 'a', kind: 'spot', symbol: 'NIFTY', interval: '3', tradingDate: '2026-10-08', expiry: '', strike: '', right: 'CE' } as const
const result = (...statuses: Array<'available' | 'waiting' | 'unavailable' | 'error'>): PreparedSession => ({ version: 1, date: tile.tradingDate, reference_time: '09:15:00', panes: statuses.map((availability, index) => ({ pane: { ...tile, id: String(index) }, availability, reason: availability, premium: null })) })
describe('staged session changes', () => {
  it('keeps late-first-price panes but excludes confirmed invalid panes', () => expect(retainedPanes(result('available', 'waiting', 'unavailable')).map(tile => tile.id)).toEqual(['0', '1']))
  it('blocks transient failure and empty/all invalid responses', () => {
    expect(() => retainedPanes(result('available', 'error'))).toThrow('error')
    expect(() => retainedPanes(result('unavailable'))).toThrow('unavailable')
    expect(() => retainedPanes({} as PreparedSession)).toThrow('Update the backend')
  })
  it('maps all five supported pane counts', () => expect([1, 2, 3, 4, 5].map(compactLayout)).toEqual(['1', '2-side', '3-wide-top', '4-grid', '5-equal']))
})
