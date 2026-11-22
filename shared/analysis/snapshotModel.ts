import type { EventSnapshot } from './api'

/**
 * Chronological order of captured events: same tick, then wall-clock capture time, then capture sequence
 * (this matches the backend's order). Shared by every host's snapshot viewer.
 */
export function sortSnapshots(snapshots: EventSnapshot[]): EventSnapshot[] {
  return snapshots.length > 0
    ? [...snapshots].sort((a, b) =>
        a.timestamp - b.timestamp
        || (a.snapshot.event_timestamp ?? 0) - (b.snapshot.event_timestamp ?? 0)
        || (a.snapshot.seq ?? 0) - (b.snapshot.seq ?? 0))
    : snapshots
}

/** Case-insensitive search over the event description and type; `*` is a wildcard. An empty query keeps everything. */
export function filterSnapshots(sorted: EventSnapshot[], query: string): EventSnapshot[] {
  const q = query.trim().toLowerCase()
  if (!q) return sorted
  const pattern = q.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return sorted.filter(snapshot => {
    const target = `${snapshot.event.description} ${snapshot.event.type}`.toLowerCase()
    try { return new RegExp(pattern).test(target) } catch { return target.includes(q) }
  })
}

export function eventIcon(type: string): string {
  if (type === 'order_placed') return '🆕'
  if (type === 'order_edited') return '✏️'
  if (type === 'order_converted') return '🔄'
  if (type === 'order_filled') return '✅'
  return '📌'
}
