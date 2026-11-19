import { useEffect, useState } from 'react'
import { readableError } from '../../analysis/behavior/types'
import { useDeepDiveHost } from './host'
import { previewStrikeSettings } from './inDepthModel'

export type PreviewStrikes =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; ce: number; pe: number; expiry: string }

/** Strikes already picked this session (a day is looked at again and again while marking), by symbol and day. */
const cache = new Map<string, { ce: number; pe: number; expiry: string }>()

/**
 * The CE and PE strikes of a day for the Mark days option view: the Max Price pick at 09:30 with a cap of 75 (`previewStrikeSettings`),
 * not the account's setting, and never saved: it is only there to give an idea of the option charts.
 */
export function usePreviewStrikes(symbol: string, date: string): PreviewStrikes {
  const host = useDeepDiveHost()
  const key = `${symbol}|${date}`
  const [state, setState] = useState<PreviewStrikes>(() => { const hit = cache.get(key); return hit ? { state: 'ready', ...hit } : { state: 'loading' } })
  useEffect(() => {
    const hit = cache.get(key)
    if (hit) { setState({ state: 'ready', ...hit }); return }
    let cancelled = false
    setState({ state: 'loading' })
    host.resolveStrikes(symbol, date, 0, { ...host.settings, ...previewStrikeSettings })
      .then(resolved => {
        const value = { ce: resolved.ce, pe: resolved.pe, expiry: resolved.expiry }
        cache.set(key, value)
        if (!cancelled) setState({ state: 'ready', ...value })
      })
      .catch(error => { if (!cancelled) setState({ state: 'error', error: readableError(error) }) })
    return () => { cancelled = true }
  }, [host, symbol, date, key])
  return state
}
