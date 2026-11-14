import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbort } from '../api/transport'

export interface LoadState<T> {
  data: T | null
  error: unknown
  loading: boolean
  /** Run the loader again (keeps the old data on screen until the new data arrives). */
  reload(): void
}

/**
 * Load something when `deps` change. The previous request is abandoned (its result is ignored), a failed load keeps
 * the error for a retry button, and a cancelled request is never reported as an error.
 */
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): LoadState<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  const latest = useRef(loader)
  latest.current = loader

  useEffect(() => {
    const controller = new AbortController()
    setState(current => ({ data: tick === 0 ? null : current.data, error: null, loading: true }))
    latest.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ data, error: null, loading: false }) },
      error => { if (!controller.signal.aborted && !isAbort(error)) setState(current => ({ data: current.data, error, loading: false })) },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick(value => value + 1), [])
  return { ...state, reload }
}
