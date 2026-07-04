import { useEffect, useRef, useCallback } from 'react'

type SSECallback = (event: Record<string, unknown>) => void

export function useSSE(url: string | null, onMessage: SSECallback) {
  const esRef = useRef<EventSource | null>(null)
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1000)
  const connectRef = useRef<() => void>(() => {})

  const connect = useCallback(() => {
    if (!url) return

    // Close any existing connection first
    esRef.current?.close()
    esRef.current = null
    if (retryTimeout.current) {
      clearTimeout(retryTimeout.current)
      retryTimeout.current = null
    }

    const es = new EventSource(url)
    esRef.current = es

    es.onmessage = (e) => {
      try {
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
  }, [url, onMessage])

  // Keep connectRef in sync so the visibility handler always calls the latest
  connectRef.current = connect

  // ── Page Visibility: reconnect instantly when the tab becomes visible ──────
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && url) {
        retryDelay.current = 1000  // reset backoff
        connectRef.current()       // immediate reconnect
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [url])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (retryTimeout.current) clearTimeout(retryTimeout.current)
    }
  }, [connect])
}
