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

export function useMultiSSE(sessionIds: string[], onMessage: SSECallback, onReconnect?: (sessionId: string) => void) {
  const onMessageRef = useRef(onMessage)
  const onReconnectRef = useRef(onReconnect)
  const connectionsRef = useRef<Map<string, {
    es: EventSource | null
    retryTimeout: ReturnType<typeof setTimeout> | null
    retryDelay: number
    lastEventId: string | null
    hasOpened: boolean
  }>>(new Map())
  const idsKey = sessionIds.join('|')

  onMessageRef.current = onMessage
  onReconnectRef.current = onReconnect

  const closeConnection = useCallback((sessionId: string) => {
    const conn = connectionsRef.current.get(sessionId)
    if (!conn) return
    conn.es?.close()
    if (conn.retryTimeout) clearTimeout(conn.retryTimeout)
    connectionsRef.current.delete(sessionId)
  }, [])

  const connectOne = useCallback((sessionId: string) => {
    const existing = connectionsRef.current.get(sessionId)
    if (existing?.es) return

    const conn = existing ?? {
      es: null,
      retryTimeout: null,
      retryDelay: 1000,
      lastEventId: null,
      hasOpened: false,
    }
    if (conn.retryTimeout) {
      clearTimeout(conn.retryTimeout)
      conn.retryTimeout = null
    }

    const es = new EventSource(api.getSSEUrl(sessionId, conn.lastEventId))
    conn.es = es
    connectionsRef.current.set(sessionId, conn)

    es.onopen = () => {
      conn.retryDelay = 1000
      if (conn.hasOpened) onReconnectRef.current?.(sessionId)
      conn.hasOpened = true
    }

    es.onmessage = (e) => {
      try {
        if (e.lastEventId) conn.lastEventId = e.lastEventId
        const data = JSON.parse(e.data) as Record<string, unknown>
        onMessageRef.current(data)
        conn.retryDelay = 1000
      } catch {
        // ignore malformed events
      }
    }

    es.onerror = () => {
      es.close()
      conn.es = null
      conn.retryTimeout = setTimeout(() => {
        conn.retryDelay = Math.min(conn.retryDelay * 2, 30000)
        connectOne(sessionId)
      }, conn.retryDelay)
    }
  }, [])

  useEffect(() => {
    const desired = new Set(sessionIds.filter(Boolean))
    for (const id of Array.from(connectionsRef.current.keys())) {
      if (!desired.has(id)) closeConnection(id)
    }
    for (const id of desired) connectOne(id)
    return () => {}
  }, [idsKey, connectOne, closeConnection]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      for (const id of sessionIds) {
        const conn = connectionsRef.current.get(id)
        if (conn) conn.retryDelay = 1000
        if (!conn?.es) connectOne(id)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [idsKey, connectOne]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      for (const id of Array.from(connectionsRef.current.keys())) closeConnection(id)
    }
  }, [closeConnection])
}
