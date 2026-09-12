import { useEffect, useRef, useCallback } from 'react'
import api from '../services/api'

type SSECallback = (event: Record<string, unknown>) => void

export function useSSE(sessionId: string | null, onMessage: SSECallback, onReconnect?: () => void) {
  const esRef = useRef<EventSource | null>(null)
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1000)
  const connectRef = useRef<() => void>(() => {})
  const lastEventIdRef = useRef<string | null>(null)
  const hasOpenedRef = useRef(false)

  const connect = useCallback(() => {
    if (!sessionId) return

    // Close any existing connection first
    esRef.current?.close()
    esRef.current = null
    if (retryTimeout.current) {
      clearTimeout(retryTimeout.current)
      retryTimeout.current = null
    }

    const es = new EventSource(api.getSSEUrl(sessionId, lastEventIdRef.current))
    esRef.current = es

    es.onopen = () => {
      retryDelay.current = 1000
      if (hasOpenedRef.current) onReconnect?.()
      hasOpenedRef.current = true
    }

    es.onmessage = (e) => {
      try {
        if (e.lastEventId) lastEventIdRef.current = e.lastEventId
        const data = JSON.parse(e.data) as Record<string, unknown>
        onMessage(data)
        retryDelay.current = 1000 // reset backoff on success
      } catch {
        // ignore malformed events
      }
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
      retryTimeout.current = setTimeout(() => {
        retryDelay.current = Math.min(retryDelay.current * 2, 30000)
        connectRef.current()
      }, retryDelay.current)
    }
  }, [sessionId, onMessage, onReconnect])

  // Keep connectRef in sync so the visibility handler always calls the latest
  connectRef.current = connect

  // ── Page Visibility: reconnect instantly when the tab becomes visible ──────
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && sessionId) {
        retryDelay.current = 1000  // reset backoff
        connectRef.current()       // immediate reconnect
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [sessionId])

  useEffect(() => {
    lastEventIdRef.current = null
    hasOpenedRef.current = false
  }, [sessionId])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (retryTimeout.current) clearTimeout(retryTimeout.current)
    }
  }, [connect])
}
