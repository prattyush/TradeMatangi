import { useEffect, useRef, useCallback } from 'react'

type SSECallback = (event: Record<string, unknown>) => void

export function useSSE(url: string | null, onMessage: SSECallback) {
  const esRef = useRef<EventSource | null>(null)
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = useRef(1000)

  const connect = useCallback(() => {
    if (!url) return

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
        connect()
      }, retryDelay.current)
    }
  }, [url, onMessage])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (retryTimeout.current) clearTimeout(retryTimeout.current)
    }
  }, [connect])
}
