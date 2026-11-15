import { describe, expect, it } from 'vitest'
import { eventIcon, filterSnapshots, sortSnapshots } from '../../shared/analysis/snapshotModel'
import type { EventSnapshot } from '../../shared/analysis/api'

const snap = (id: string, timestamp: number, description: string, type = 'order_placed', extra: { event_timestamp?: number; seq?: number } = {}) =>
  ({ event_id: id, session_id: 's', timestamp, event: { type, description, details: {} }, snapshot: { ...extra } }) as unknown as EventSnapshot

describe('snapshot model (shared by the website, the desktop and the phone)', () => {
  it('orders by tick, then capture time, then sequence', () => {
    const rows = [snap('c', 100, 'c', 'x', { event_timestamp: 5, seq: 2 }), snap('b', 100, 'b', 'x', { event_timestamp: 5, seq: 1 }), snap('a', 100, 'a', 'x', { event_timestamp: 4, seq: 9 }), snap('z', 50, 'z')]
    expect(sortSnapshots(rows).map(row => row.event_id)).toEqual(['z', 'a', 'b', 'c'])
    expect(rows[0].event_id).toBe('c') // the input is not modified
    expect(sortSnapshots([])).toEqual([])
  })
  it('searches description and type, case-insensitively, with * as a wildcard', () => {
    const rows = [snap('1', 1, 'BUY LIMIT placed @ 120', 'order_placed'), snap('2', 2, 'BUY order filled @ 120', 'order_filled'), snap('3', 3, 'Stoploss edited to 110', 'order_edited')]
    expect(filterSnapshots(rows, '').length).toBe(3)
    expect(filterSnapshots(rows, 'FILLED').map(r => r.event_id)).toEqual(['2'])
    expect(filterSnapshots(rows, 'buy*120').map(r => r.event_id)).toEqual(['1', '2'])
    expect(filterSnapshots(rows, 'order_edited').map(r => r.event_id)).toEqual(['3'])
    expect(filterSnapshots(rows, '(').length).toBe(0) // regex characters are plain text
    expect(filterSnapshots(rows, 'nothing')).toEqual([])
  })
  it('has an icon per event type and a default', () => {
    expect(eventIcon('order_filled')).toBe('✅')
    expect(eventIcon('order_placed')).toBe('🆕')
    expect(eventIcon('something_else')).toBe('📌')
  })
})
