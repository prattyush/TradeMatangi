import { useEffect, useRef, useState } from 'react'
import { MAX_PRICE_REFERENCE_TIME, keepStrike, strikeLadder } from '../../../../shared/browse/browseModel.ts'
import { browseApi, findMaxPriceStrike, optionMetadata } from '../../services/browseApi'
import type { BrowsePane } from '../../services/browseWorkspace'

export interface PaneContract {
  loading: boolean
  error: string | null
  /** Strikes to choose from, around the money at the reference time. */
  ladder: number[]
  /** Max price search in progress / its message. */
  searching: boolean
  note: string | null
}

/**
 * What an option pane needs to show a contract: the day's expiry and strike ladder (from the server's option metadata and the
 * underlying's price at the reference time) and, in Max price mode, the strike found for the cap. Fills the pane's expiry and
 * strike through `patch`; spot panes need none of it.
 */
export function usePaneContract(pane: BrowsePane, strikeInterval: number | undefined, patch: (change: Partial<BrowsePane>) => void): PaneContract {
  const option = pane.kind !== 'spot'
  const [state, setState] = useState<{ key: string; loading: boolean; error: string | null; ladder: number[] }>({ key: '', loading: false, error: null, ladder: [] })
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const latest = useRef(pane)
  latest.current = pane
  const key = `${pane.symbol}:${pane.date}`

  useEffect(() => {
    if (!option) { setState({ key: '', loading: false, error: null, ladder: [] }); return }
    const controller = new AbortController()
    setState({ key, loading: true, error: null, ladder: [] })
    void (async () => {
      try {
        const metadata = await optionMetadata(pane.symbol, pane.date)
        if (controller.signal.aborted) return
        if (!metadata.available || !metadata.expiries.length) { setState({ key, loading: false, error: metadata.unavailable_reason ?? 'No option contracts are listed for this day.', ladder: [] }); return }
        const underlying = await browseApi.getPreSession(pane.symbol, pane.date, MAX_PRICE_REFERENCE_TIME, 1)
        if (controller.signal.aborted) return
        const price = underlying[underlying.length - 1]?.close ?? 0
        const ladder = strikeLadder(price, metadata.strike_interval || strikeInterval || 0)
        setState({ key, loading: false, error: ladder.length ? null : 'No underlying price is available to choose strikes around.', ladder })
        const current = latest.current
        const strike = current.pick.mode === 'manual' ? keepStrike(current.strike, ladder) : current.strike
        if (current.expiry !== metadata.expiries[0] || strike !== current.strike) patch({ expiry: metadata.expiries[0], strike })
      } catch (error) {
        if (!controller.signal.aborted) setState({ key, loading: false, error: error instanceof Error ? error.message : String(error), ladder: [] })
      }
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, key, pane.kind === 'spot' ? '' : 'o'])

  // Max price: the first strike at or below the cap, searched on the server (one request per symbol, day, side and cap).
  const wantsSearch = option && pane.pick.mode === 'max_price' && pane.pick.cap !== null && pane.strike === null && Boolean(pane.expiry)
  useEffect(() => {
    if (!wantsSearch) return
    const controller = new AbortController()
    setSearching(true); setNote(null)
    findMaxPriceStrike(pane.symbol, pane.date, pane.expiry!, pane.kind as 'CE' | 'PE', pane.pick.cap!)
      .then(found => { if (!controller.signal.aborted) { setNote(found.premium != null ? `Strike ${found.strike} at about ₹${found.premium}` : null); patch({ strike: found.strike }) } })
      .catch(error => { if (!controller.signal.aborted) setNote(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsSearch, pane.symbol, pane.date, pane.expiry, pane.kind, pane.pick.cap])

  return { loading: state.loading, error: state.error, ladder: state.ladder, searching, note }
}
