import { useEffect, useRef } from 'react'
import api from '../services/api'
import { SessionStream } from '../services/sessionStream'

type SSECallback = (event: Record<string, unknown>) => void

export function useSSE(sessionId: string | null, onMessage: SSECallback, onReconnect?: () => void, onUnavailable?: () => void) {
  const callbacks = useRef({ onMessage, onReconnect, onUnavailable })
  callbacks.current = { onMessage, onReconnect, onUnavailable }
  useEffect(() => {
    if (!sessionId) return
    const stream = new SessionStream({
      sessionId, url: cursor => api.getSSEUrl(sessionId, cursor), probe: () => api.getActiveSimulation(sessionId),
      onMessage: event => callbacks.current.onMessage(event),
      onReconnect: () => callbacks.current.onReconnect?.(),
      onUnavailable: () => callbacks.current.onUnavailable?.(),
    })
    stream.connect()
    const visible = () => { if (document.visibilityState === 'visible') stream.connect(true) }
    document.addEventListener('visibilitychange', visible)
    return () => { stream.close(); document.removeEventListener('visibilitychange', visible) }
  }, [sessionId])
}

export function useMultiSSE(sessionIds: string[], onMessage: SSECallback, onReconnect?: (sessionId: string) => void, onUnavailable?: (sessionId: string) => void) {
  const streams = useRef(new Map<string, SessionStream>())
  const callbacks = useRef({ onMessage, onReconnect, onUnavailable })
  callbacks.current = { onMessage, onReconnect, onUnavailable }
  const idsKey = sessionIds.join('|')
  useEffect(() => {
    const desired = new Set(sessionIds.filter(Boolean))
    for (const [id, stream] of streams.current) {
      if (!desired.has(id)) { stream.close(); streams.current.delete(id) }
    }
    for (const id of desired) {
      if (streams.current.has(id)) continue
      const stream = new SessionStream({
        sessionId: id, url: cursor => api.getSSEUrl(id, cursor), probe: () => api.getActiveSimulation(id),
        onMessage: event => callbacks.current.onMessage(event),
        onReconnect: () => callbacks.current.onReconnect?.(id),
        onUnavailable: () => callbacks.current.onUnavailable?.(id),
      })
      streams.current.set(id, stream)
      stream.connect()
    }
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== 'visible') return
      for (const stream of streams.current.values()) if (!stream.connected) stream.connect(true)
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      document.removeEventListener('visibilitychange', visible)
      for (const stream of streams.current.values()) stream.close()
      streams.current.clear()
    }
  }, [])
}
