import { describe, expect, it } from 'vitest'
import { SseDecoder, describeTile, liveCandles, marketDate, optionInstrument, spotInstrument, ticksIn, toOhlc } from './liveModel'

const candle = (timestamp: number, price: number, volume?: number) => ({ timestamp, open: price, high: price + 1, low: price - 1, close: price, ...(volume !== undefined ? { volume } : {}) })
const day = Date.UTC(2026, 10, 10) / 1000
const at = (h: number, m: number, s = 0) => day + h * 3600 + m * 60 + s

describe('marketDate', () => {
  it('is the date in India whatever the phone time zone is', () => {
    expect(marketDate(new Date('2026-11-10T20:00:00Z'))).toBe('2026-11-11') // 01:30 next day in India
    expect(marketDate(new Date('2026-11-10T03:00:00Z'))).toBe('2026-11-10')
    expect(marketDate(new Date('2026-11-09T18:29:00Z'))).toBe('2026-11-09') // 23:59 in India
    expect(marketDate(new Date('2026-11-09T18:31:00Z'))).toBe('2026-11-10')
  })
})

describe('instruments', () => {
  it('builds the same shapes the desktop sends', () => {
    expect(spotInstrument('NIFTY', 'NSE', 'index')).toEqual({ kind: 'index', exchange: 'NSE', symbol: 'NIFTY' })
    expect(spotInstrument('RELIND', undefined, undefined)).toEqual({ kind: 'equity', exchange: 'NSE', symbol: 'RELIND' })
    expect(optionInstrument('NIFTY', 'NSE', '2026-11-12', 24500, 'CE')).toEqual({ kind: 'option', exchange: 'NSE', underlying: 'NIFTY', expiry: '2026-11-12', strike: 24500, right: 'CE' })
  })
})

describe('ticksIn', () => {
  const event = (tile: string, ts: number) => ({ type: 'candle', tile_id: tile, stream_id: 's', event_id: 1, payload: candle(ts, 100) })
  it('reads a candle event for the tile, and inside a batch', () => {
    expect(ticksIn(event('browse', 5), 'browse')).toEqual([candle(5, 100)])
    expect(ticksIn({ type: 'batch', events: [event('browse', 5), event('other', 6), event('browse', 7)] }, 'browse').map(t => t.timestamp)).toEqual([5, 7])
  })
  it('ignores other events, other tiles and malformed payloads', () => {
    expect(ticksIn({ type: 'feed_status', tile_id: 'browse', payload: {} }, 'browse')).toEqual([])
    expect(ticksIn(event('other', 5), 'browse')).toEqual([])
    expect(ticksIn({ type: 'candle', tile_id: 'browse', payload: { timestamp: 'x' } }, 'browse')).toEqual([])
    expect(ticksIn(null, 'browse')).toEqual([])
    expect(ticksIn('text', 'browse')).toEqual([])
  })
})

describe('liveCandles', () => {
  const tile = { tile_id: 'browse', availability: 'available', interval_minutes: 3, candles: [candle(at(10, 54), 100, 500), candle(at(10, 57), 101, 400)] }
  it('folds the received seconds into the baseline, starting a new bar when a window begins', () => {
    const rows = liveCandles(tile, [candle(at(10, 57, 30), 105, 10), candle(at(11, 0, 2), 106, 20), candle(at(11, 0, 4), 107, 5)], 3)
    expect(rows.map(r => r.time)).toEqual([at(10, 54), at(10, 57), at(11, 0)])
    expect(rows[1]).toMatchObject({ open: 101, close: 105, high: 106 })
    expect(rows[2]).toMatchObject({ open: 106, close: 107, volume: 25 })
  })
  it('draws nothing while the baseline is for another interval (the interval was just changed)', () => {
    expect(liveCandles(tile, [candle(at(11, 0, 2), 106)], 5)).toEqual([])
    expect(liveCandles(undefined, [], 3)).toEqual([])
  })
  it('maps to the chart candle shape, keeping volume only when present', () => {
    expect(toOhlc([candle(1, 10, 3), candle(2, 11)])).toEqual([
      { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 3 },
      { time: 2, open: 11, high: 12, low: 10, close: 11 },
    ])
  })
})

describe('describeTile', () => {
  it('names each stage', () => {
    expect(describeTile(undefined, false).phase).toBe('starting')
    expect(describeTile({ tile_id: 'b', availability: 'pending_subscription' }, false)).toEqual({ phase: 'waiting', message: 'Connecting to the feed…' })
    expect(describeTile({ tile_id: 'b', availability: 'available' }, false).phase).toBe('live')
    expect(describeTile({ tile_id: 'b', availability: 'pending_subscription' }, true).phase).toBe('live') // a tick proves it
    expect(describeTile({ tile_id: 'b', availability: 'provider_error', reason: 'Breeze disconnected' }, false)).toEqual({ phase: 'error', message: 'Feed problem: Breeze disconnected' })
    expect(describeTile({ tile_id: 'b', availability: 'unavailable', reason: 'Not subscribed' }, false)).toEqual({ phase: 'error', message: 'Not subscribed' })
  })
})

describe('SseDecoder', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const collect = () => {
    const events: Array<[unknown, number | undefined]> = []
    let invalid = 0
    const decoder = new SseDecoder((payload, id) => events.push([payload, id]), () => { invalid++ })
    return { decoder, events, invalid: () => invalid }
  }
  it('decodes frames split across chunks, CRLF line ends and multi-byte text', () => {
    const { decoder, events } = collect()
    decoder.push(bytes('id: 4\r\nevent: candle\r\ndata: {"a":"₹"'))
    expect(events).toEqual([])
    decoder.push(bytes('}\r\n\r\nid: 5\ndata: {"b":2}\n\n'))
    expect(events).toEqual([[{ a: '₹' }, 4], [{ b: 2 }, 5]])
    const split = bytes('data: {"c":"₹"}\n\n') // cut inside the 3-byte character
    decoder.push(split.slice(0, 11)); decoder.push(split.slice(11))
    expect(events[events.length - 1]).toEqual([{ c: "₹" }, undefined])
  })
  it('ignores heartbeats and reports invalid JSON without stopping', () => {
    const { decoder, events, invalid } = collect()
    decoder.push(bytes(': heartbeat\n\ndata: not json\n\nid: 9\ndata: {"ok":true}\n\n'))
    expect(invalid()).toBe(1)
    expect(events).toEqual([[{ ok: true }, 9]])
  })
})
