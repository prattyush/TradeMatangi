import { describe, expect, it } from 'vitest'
import { replaySnapshotFromStream } from './replayStreamState'

const snapshot = (event_id: number, run_id = 'run') => ({ run_id, event_id, cursor: 100, tile_states: [] })

describe('replay snapshot delivery', () => {
  it('keeps the reconnect marker when newer chart snapshots share its batch', () => {
    const result = replaySnapshotFromStream({ type: 'batch', events: [{ ...snapshot(1), stream_reconnected: true }, snapshot(2)] })
    expect(result?.event_id).toBe(2)
    expect(result?.stream_reconnected).toBe(true)
  })
  it('does not transfer a reconnect marker from another run', () => {
    const result = replaySnapshotFromStream({ type: 'batch', events: [{ ...snapshot(1, 'old'), stream_reconnected: true }, snapshot(2)] })
    expect(result?.stream_reconnected).toBeUndefined()
  })
  it('accepts wrapped snapshots and ignores heartbeat or empty payloads', () => {
    expect(replaySnapshotFromStream({ payload: snapshot(3) })?.event_id).toBe(3)
    expect(replaySnapshotFromStream({ type: 'batch', events: [] })).toBeNull()
    expect(replaySnapshotFromStream(null)).toBeNull()
  })
})
