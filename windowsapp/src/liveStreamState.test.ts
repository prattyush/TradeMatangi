import { describe, expect, it } from 'vitest'
import { applyLiveStreamPayloadToSnapshot, type LiveSnapshot } from './liveStreamState'

const candle = (timestamp: number, close: number) => ({ timestamp, open: close, high: close, low: close, close })

const snapshot = (eventId = 1): LiveSnapshot => ({
  stream_id: 'stream-1',
  event_id: eventId,
  tiles: [
    { tile_id: 'tile-1', availability: 'available', latest_tick: candle(1, 100) },
    { tile_id: 'tile-2', availability: 'provider_error', reason: 'stale quote' },
  ],
})

describe('desktop live stream state', () => {
  it('accepts a full snapshot as authoritative state', () => {
    const next = snapshot(4)
    expect(applyLiveStreamPayloadToSnapshot(null, next)).toBe(next)
  })

  it('applies a candle event to only its tile', () => {
    const current = snapshot(4)
    const next = applyLiveStreamPayloadToSnapshot(current, {
      version: 1,
      stream_id: 'stream-1',
      event_id: 5,
      timestamp: 10,
      type: 'candle',
      tile_id: 'tile-2',
      payload: candle(10, 105),
    })

    expect(next?.event_id).toBe(5)
    expect(next?.tiles[0]).toBe(current.tiles[0])
    expect(next?.tiles[1]).toMatchObject({ tile_id: 'tile-2', availability: 'available', latest_tick: candle(10, 105) })
    expect(next?.tiles[1].reason).toBeUndefined()
  })

  it('ignores stale repeated events', () => {
    const current = snapshot(5)
    const next = applyLiveStreamPayloadToSnapshot(current, {
      version: 1,
      stream_id: 'stream-1',
      event_id: 5,
      timestamp: 10,
      type: 'candle',
      tile_id: 'tile-1',
      payload: candle(10, 105),
    })

    expect(next).toBe(current)
  })

  it('accepts a snapshot event wrapper as a resync', () => {
    const current = snapshot(5)
    const resync = snapshot(8)
    const next = applyLiveStreamPayloadToSnapshot(current, {
      version: 1,
      stream_id: 'stream-1',
      event_id: 8,
      timestamp: 10,
      type: 'snapshot',
      tile_id: 'screen',
      payload: resync,
    })

    expect(next).toBe(resync)
  })
})
