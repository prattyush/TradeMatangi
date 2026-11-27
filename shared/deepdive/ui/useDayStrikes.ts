import { useCallback, useEffect, useRef, useState } from 'react'
import { readableError } from '../../analysis/behavior/types'
import type { DiveSetup, SetupFields } from '../types'
import { useDeepDiveHost } from './host'
import { needsStrikes, optionEligible, strikeModeFor } from './inDepthModel'

export type DayStrikes =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; ce: number; pe: number; expiry: string }

/**
 * The option strikes of one marked day. A day that already has strikes keeps them (a deep dive must not move its option
 * chart under the user); a new day gets them from the account's strike setting (OTM from the 09:15 price, or Max Price at
 * 09:30) and they are saved with it. It waits until the settings have been read, so it never resolves with the defaults.
 */
export function useDayStrikes(
  setup: DiveSetup, canEdit: boolean, save: (fields: SetupFields) => void,
): DayStrikes & { repick: (offset: number) => Promise<void> } {
  const host = useDeepDiveHost()
  const { settings } = host
  const eligible = optionEligible(setup.symbol)
  const [strikes, setStrikes] = useState<DayStrikes>(eligible ? { state: 'loading' } : { state: 'none' })
  const saveRef = useRef(save)
  saveRef.current = save
  const saved = useRef({ ce: setup.strike_ce, pe: setup.strike_pe })

  useEffect(() => {
    if (!eligible || settings.loaded === false) return
    let cancelled = false
    void (async () => {
      try {
        const expiry = await host.expiry(setup.symbol, setup.date)
        let ce = saved.current.ce, pe = saved.current.pe
        if (needsStrikes({ strike_ce: ce, strike_pe: pe })) {
          const resolved = await host.resolveStrikes(setup.symbol, setup.date, 0, settings)
          ce = resolved.ce; pe = resolved.pe
          if (canEdit) saveRef.current({ strike_ce: ce, strike_pe: pe, strike_mode: strikeModeFor(setup.symbol, settings) })
        }
        if (!cancelled) setStrikes({ state: 'ready', ce: ce as number, pe: pe as number, expiry })
      } catch (error) { if (!cancelled) setStrikes({ state: 'error', error: readableError(error) }) }
    })()
    return () => { cancelled = true }
  }, [host, eligible, setup.symbol, setup.date, settings, canEdit])

  const repick = useCallback(async (offset: number) => {
    setStrikes({ state: 'loading' })
    try {
      const resolved = await host.resolveStrikes(setup.symbol, setup.date, offset, settings)
      saved.current = { ce: resolved.ce, pe: resolved.pe }
      saveRef.current({ strike_ce: resolved.ce, strike_pe: resolved.pe, strike_mode: strikeModeFor(setup.symbol, settings) })
      setStrikes({ state: 'ready', ce: resolved.ce, pe: resolved.pe, expiry: resolved.expiry })
    } catch (error) { setStrikes({ state: 'error', error: readableError(error) }) }
  }, [host, setup.symbol, setup.date, settings])

  return { ...strikes, repick }
}
