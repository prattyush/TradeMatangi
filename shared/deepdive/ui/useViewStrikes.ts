import { useEffect, useState } from 'react'
import { readableError } from '../../analysis/behavior/types'
import type { DeepDiveSetup } from '../types'
import { useDeepDiveHost } from './host'
import { previewStrikeSettings } from './inDepthModel'

export type ViewStrikes =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; ce: number; pe: number; expiry: string; source: 'saved' | 'preview' }

const cache = new Map<string, { ce: number; pe: number; expiry: string; source: 'saved' | 'preview' }>()

/**
 * The strikes of a marked day for a read-only look (Compare). A day that has saved strikes uses them (it is the same option chart
 * the in-depth step showed); a day that has none gets the Mark days preview pick (Max Price at 09:30, premium at most 75). Nothing
 * is ever saved from here.
 */
export function useViewStrikes(setup: Pick<DeepDiveSetup, 'symbol' | 'date' | 'strike_ce' | 'strike_pe'> | null, enabled: boolean): ViewStrikes {
  const host = useDeepDiveHost()
  const key = setup ? `${setup.symbol}|${setup.date}|${setup.strike_ce ?? ''}|${setup.strike_pe ?? ''}` : ''
  const [held, setHeld] = useState<{ key: string; value: ViewStrikes }>(() => { const hit = cache.get(key); return { key, value: hit ? { state: 'ready', ...hit } : { state: 'loading' } } })
  const setState = (value: ViewStrikes, forKey = key) => setHeld({ key: forKey, value })
  useEffect(() => {
    if (!setup || !enabled) return
    const hit = cache.get(key)
    if (hit) { setState({ state: 'ready', ...hit }, key); return }
    let cancelled = false
    setState({ state: 'loading' }, key)
    void (async () => {
      try {
        const expiry = await host.expiry(setup.symbol, setup.date)
        const saved = setup.strike_ce != null && setup.strike_pe != null
        const strikes = saved ? { ce: setup.strike_ce as number, pe: setup.strike_pe as number } : await host.resolveStrikes(setup.symbol, setup.date, 0, { ...host.settings, ...previewStrikeSettings })
        const value = { ce: strikes.ce, pe: strikes.pe, expiry, source: saved ? 'saved' as const : 'preview' as const }
        cache.set(key, value)
        if (!cancelled) setState({ state: 'ready', ...value }, key)
      } catch (error) { if (!cancelled) setState({ state: 'error', error: readableError(error) }, key) }
    })()
    return () => { cancelled = true }
  }, [host, key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  // A result for the previous day is never shown for the new one.
  return held.key === key ? held.value : { state: 'loading' }
}
