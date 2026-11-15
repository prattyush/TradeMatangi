import { useEffect, useMemo, useRef, useState } from 'react'
import type { OHLCCandle } from '../../../../../frontend/src/services/api'
import type { Candle } from '../../../../../windowsapp/src/contracts'
import { appendLiveTick } from '../../../../../windowsapp/src/liveCandles'
import { applyLiveStreamPayloadToSnapshot, type LiveSnapshot } from '../../../../../windowsapp/src/liveStreamState'
import { ApiError, describeError } from '../../../api/errors'
import { isAbort } from '../../../api/transport'
import { useServices } from '../../../app/AppContext'
import { LIVE_TILE_ID, SseDecoder, describeTile, liveCandles, ticksIn, type LiveInstrument, type LivePhase } from './liveModel'

const BASE = '/api/desktop/v1/live'
const HEALTH_MS = 15_000
const PROVIDER_RETRY_MS = 30_000

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

function useForeground(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

export interface LiveBrowse {
  phase: LivePhase
  message: string
  /** The candles to draw; empty while loading; undefined when Live is off. */
  candles: OHLCCandle[] | undefined
  /** Start again after an error. */
  retry(): void
}

/**
 * Live ticks for one chart, the desktop's flow: start a chart-only live stream on the server, read its events over
 * SSE (reconnecting with the last event id), and build candles from the history baseline plus the received seconds.
 * Read-only: it places no orders. The stream is stopped when Live is turned off, the instrument changes or the app
 * leaves the foreground (and started again on return), so nothing keeps a feed subscription open in the background.
 */
export function useLiveBrowse({ enabled, instrument, intervalMinutes }: { enabled: boolean; instrument: LiveInstrument | null; intervalMinutes: number }): LiveBrowse {
  const { client } = useServices()
  const foreground = useForeground()
  const active = enabled && instrument !== null && foreground
  const instrumentKey = JSON.stringify(instrument)
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [ticks, setTicks] = useState<Candle[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const intervalRef = useRef(intervalMinutes)
  intervalRef.current = intervalMinutes
  const requestedInterval = useRef<number | null>(null)

  // The stream: start, read events, keep healthy, stop.
  useEffect(() => {
    if (!active || !instrument) { setSnapshot(null); setTicks([]); setError(null); return }
    const controller = new AbortController()
    const { signal } = controller
    let streamId: string | null = null
    setSnapshot(null); setTicks([]); setError(null)
    requestedInterval.current = intervalRef.current

    const restart = () => setAttempt(value => value + 1)

    async function readEvents(id: string, firstCursor: number) {
      let cursor = firstCursor
      let backoff = 1_000
      while (!signal.aborted) {
        try {
          const response = await client.stream(`${BASE}/${id}/events`, { query: { last_event_id: cursor }, signal })
          const reader = response.body!.getReader()
          const decoder = new SseDecoder((payload, eventId) => {
            if (typeof eventId === 'number') cursor = Math.max(cursor, eventId)
            const fresh = ticksIn(payload, LIVE_TILE_ID)
            if (fresh.length) setTicks(current => fresh.reduce(appendLiveTick, current))
            setSnapshot(current => applyLiveStreamPayloadToSnapshot(current, payload) ?? current)
          })
          backoff = 1_000
          try { for (;;) { const { done, value } = await reader.read(); if (done || signal.aborted) break; decoder.push(value) } }
          finally { await reader.cancel().catch(() => undefined) }
        } catch (caught) {
          if (signal.aborted || isAbort(caught)) return
          if (caught instanceof ApiError && caught.kind === 'http' && caught.status === 404) { restart(); return } // the server forgot the stream
          if (caught instanceof ApiError && caught.kind === 'auth') { setError(describeError(caught)); return }
        }
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    async function keepHealthy(id: string) {
      let lastRetry = 0
      while (!signal.aborted) {
        await sleep(HEALTH_MS, signal)
        if (signal.aborted) return
        try {
          let current = await client.get<LiveSnapshot>(`${BASE}/${id}/snapshot`, undefined, { signal, retries: 0 })
          if (current.tiles.some(tile => tile.availability === 'provider_error') && Date.now() - lastRetry >= PROVIDER_RETRY_MS) {
            lastRetry = Date.now()
            current = await client.post<LiveSnapshot>(`${BASE}/${id}/refresh`, {}, { signal })
          }
          if (!signal.aborted) setSnapshot(previous => (previous && previous.event_id > current.event_id ? previous : current))
        } catch (caught) {
          if (signal.aborted || isAbort(caught)) return
          if (caught instanceof ApiError && caught.kind === 'http' && caught.status === 404) { restart(); return }
          // A missed health check is not an error: the event stream carries the data.
        }
      }
    }

    void (async () => {
      try {
        const started = await client.post<LiveSnapshot>(`${BASE}/start`, { tiles: [{ tile_id: LIVE_TILE_ID, instrument, interval_minutes: intervalRef.current }] }, { signal })
        if (signal.aborted) { void client.post(`${BASE}/${started.stream_id}/stop`, {}, { retries: 0 }).catch(() => undefined); return }
        streamId = started.stream_id
        setSnapshot(started)
        void keepHealthy(streamId)
        await readEvents(streamId, started.event_id)
      } catch (caught) {
        if (!signal.aborted && !isAbort(caught)) setError(describeError(caught))
      }
    })()

    return () => {
      controller.abort()
      if (streamId) void client.post(`${BASE}/${streamId}/stop`, {}, { retries: 0 }).catch(() => undefined)
    }
    // The instrument is compared by value (instrumentKey), not by object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active, instrumentKey, attempt])

  // A new candle interval: the server reloads this tile's baseline at it; the received seconds stay.
  const streamId = snapshot?.stream_id
  const tile = snapshot?.tiles.find(item => item.tile_id === LIVE_TILE_ID)
  useEffect(() => {
    if (!active || !instrument || !streamId || requestedInterval.current === intervalMinutes) return
    requestedInterval.current = intervalMinutes
    const controller = new AbortController()
    client.put<LiveSnapshot>(`${BASE}/${streamId}/tiles/${LIVE_TILE_ID}`, { tile: { tile_id: LIVE_TILE_ID, instrument, interval_minutes: intervalMinutes } }, { signal: controller.signal })
      .then(next => setSnapshot(previous => (previous && previous.stream_id === next.stream_id && previous.event_id > next.event_id ? { ...previous, tiles: next.tiles } : next)))
      .catch(caught => { if (!isAbort(caught)) setError(describeError(caught)) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active, intervalMinutes, streamId])

  const candles = useMemo(() => (active ? liveCandles(tile, ticks, intervalMinutes) : undefined), [active, tile, ticks, intervalMinutes])
  if (!enabled) return { phase: 'off', message: '', candles: undefined, retry: () => undefined }
  if (!foreground) return { phase: 'waiting', message: 'Paused while the app is in the background', candles: undefined, retry: () => setAttempt(value => value + 1) }
  if (error) return { phase: 'error', message: error, candles: candles ?? [], retry: () => setAttempt(value => value + 1) }
  const state = describeTile(tile, ticks.length > 0)
  return { ...state, candles: candles ?? [], retry: () => setAttempt(value => value + 1) }
}
