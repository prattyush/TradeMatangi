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
  it('ignores provider status older than the accepted cursor', () => {
    const current = snapshot(5)
    const event = { version: 1, stream_id: 'stream-1', event_id: 4, timestamp: 10,
      type: 'feed_status', tile_id: 'screen', payload: { connection: 'reconnecting' } }
    expect(applyLiveStreamPayloadToSnapshot(current, event)).toBe(current)
    expect(applyLiveStreamPayloadToSnapshot(current, { ...event, event_id: 6 })?.feed?.connection).toBe('reconnecting')
  })
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

describe('live snapshot recovery', () => {
  it('keeps fetched history and replays events received during the request', async () => {
    const { LiveEventJournal } = await import('./liveStreamState')
    const journal = new LiveEventJournal()
    const event = { version: 1, stream_id: 'stream-1', event_id: 6, timestamp: 20, type: 'candle', tile_id: 'tile-1', payload: candle(20, 120) }
    let finish!: (value: LiveSnapshot) => void
    const request = new Promise<LiveSnapshot>(resolve => { finish = resolve })
    journal.record(event)
    const current = applyLiveStreamPayloadToSnapshot(snapshot(5), event)
    const history = [candle(1, 90)]
    finish({ ...snapshot(5), tiles: [{ ...snapshot(5).tiles[0], candles: history }] })
    const recovered = journal.reconcile(current, await request)
    expect(recovered.tiles[0].candles).toEqual(history)
    expect(recovered.tiles[0].latest_tick?.close).toBe(120)
    expect(recovered.event_id).toBe(6)
  })

  it('does not apply another stream events to a snapshot', async () => {
    const { LiveEventJournal } = await import('./liveStreamState')
    const journal = new LiveEventJournal()
    journal.record({ version: 1, stream_id: 'old-stream', event_id: 100, timestamp: 20, type: 'candle', tile_id: 'tile-1', payload: candle(20, 999) })
    expect(journal.reconcile(null, snapshot(2))).toEqual(snapshot(2))
  })

  it('replays native batches while preserving a newer feed status', async () => {
    const { LiveEventJournal } = await import('./liveStreamState')
    const journal = new LiveEventJournal()
    journal.record({ type: 'batch', events: [
      { version: 1, stream_id: 'stream-1', event_id: 7, timestamp: 20, type: 'candle', tile_id: 'tile-1', payload: candle(20, 130) },
      { version: 1, stream_id: 'stream-1', event_id: 8, timestamp: 20, type: 'feed_status', tile_id: 'screen', payload: { connection: 'reconnecting' } },
    ] })
    const recovered = journal.reconcile(snapshot(8), snapshot(5))
    expect(recovered.tiles[0].latest_tick?.close).toBe(130)
    expect(recovered.feed?.connection).toBe('reconnecting')
    expect(recovered.event_id).toBe(8)
  })
})
