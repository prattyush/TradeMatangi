import type { Candle } from './contracts'

export interface ReplaySnapshot {
  run_id: string
  event_id: number
  cursor: number
  state: string
  mode: string
  bar_index: number
  interval_seconds: number
  tile_states: Array<{ tile_id: string; availability: string; interval_minutes?: number; candle?: Candle }>
  stream_reconnected?: boolean
}

export function replaySnapshotFromStream(value: unknown): ReplaySnapshot | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.type === 'batch' && Array.isArray(item.events)) {
    const snapshots = item.events.map(replaySnapshotFromStream).filter((snapshot): snapshot is ReplaySnapshot => Boolean(snapshot))
    const latest = snapshots[snapshots.length - 1]
    if (!latest) return null
    // A reconnect snapshot can precede newer chart snapshots in the same IPC batch.
    return snapshots.some(snapshot => snapshot.run_id === latest.run_id && snapshot.stream_reconnected)
      ? { ...latest, stream_reconnected: true } : latest
  }
  if (typeof item.run_id === 'string' && typeof item.cursor === 'number' && Array.isArray(item.tile_states)) return item as unknown as ReplaySnapshot
  return replaySnapshotFromStream(item.payload)
}
