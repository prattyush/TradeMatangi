import { useCallback, useEffect, useRef, useState } from 'react'
import type { OHLCCandle } from '../../services/api'
import { browseApi, loadOlderPage } from '../../services/browseApi'
import type { BrowsePane } from '../../services/browseWorkspace'
import { acceptCursor } from '../../../../shared/browse/browseModel'

/** Days of context an option pane loads before its day: about three days in all, as Browse always showed. */
export const OPTION_CONTEXT_DAYS = 2
const SPOT_CONTEXT_DAYS = 2

export interface BrowseCandles {
  candles: OHLCCandle[]
  loading: boolean
  message: string
  /** Index and equity only: older pages of whole trading days, back to a year or more. Undefined for options. */
  loadOlder: ((before: number) => Promise<{ candles: Array<OHLCCandle & { timestamp: number }>; more: boolean }>) | undefined
}

const byTime = (rows: OHLCCandle[]): OHLCCandle[] => {
  const map = new Map<number, OHLCCandle>()
  for (const row of rows) map.set(row.time, row)
  return [...map.values()].sort((a, b) => a.time - b.time)
}

/**
 * The candles of one Browse pane, read-only and from minute data: the pane's day and a few days before it, then older pages
 * on scroll-back (index and equity). Both chart renderers take the same series (`externalCandles` / `externalLoadOlder`), so
 * Browse follows the Trading Chart setting without a second data path.
 */
export function useBrowseCandles(pane: BrowsePane, interval: number, ready: boolean): BrowseCandles {
  // The state says which pane and interval it holds (`key`): the render that carries a new interval must not hand the chart the old
  // interval's candles, because the chart starts scrolling back from their oldest one (see `acceptCursor`).
  const [state, setState] = useState<{ key: string; candles: OHLCCandle[]; loading: boolean; message: string }>({ key: '', candles: [], loading: true, message: '' })
  const more = useRef(true)
  const version = useRef(0)
  const spot = pane.kind === 'spot'
  const key = `${pane.symbol}:${pane.kind}:${pane.strike}:${pane.expiry}:${pane.date}:${interval}`
  const held = useRef(state)
  held.current = state
  const inFlight = useRef<{ key: string; before: number; promise: Promise<{ candles: Array<OHLCCandle & { timestamp: number }>; more: boolean }> } | null>(null)

  useEffect(() => {
    const owner = ++version.current
    more.current = spot
    inFlight.current = null
    if (!ready) { setState({ key, candles: [], loading: false, message: '' }); return }
    setState({ key, candles: [], loading: true, message: '' })
    void (async () => {
      try {
        let rows: OHLCCandle[]
        if (spot) {
          const [history, day] = await Promise.all([
            browseApi.getHistorical(pane.symbol, pane.date, interval, SPOT_CONTEXT_DAYS),
            browseApi.getPreSession(pane.symbol, pane.date, '15:30:00', interval),
          ])
          rows = [...history.candles, ...day]
        } else {
          rows = (await browseApi.getOptionsHistorical(pane.symbol, pane.date, pane.strike!, pane.expiry!, pane.kind, interval, OPTION_CONTEXT_DAYS)).candles
        }
        if (owner === version.current) setState({ key, candles: byTime(rows), loading: false, message: rows.length ? '' : 'No candles for this day.' })
      } catch (error) {
        if (owner === version.current) setState({ key, candles: [], loading: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { version.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  const loadOlder = useCallback(async (before: number) => {
    const none = { candles: [] as Array<OHLCCandle & { timestamp: number }>, more: true }
    if (!more.current) return { candles: [], more: false }
    // A cursor from another interval (or from before the first load has arrived) is not answered: nothing is fetched or merged.
    if (!acceptCursor(held.current.key, key, held.current.candles[0]?.time, before)) return none
    // The same page asked again while it is on its way (a second scroll event) shares the one request.
    if (inFlight.current && inFlight.current.key === key && inFlight.current.before === before) return inFlight.current.promise
    const owner = version.current
    const promise = (async () => {
      try {
        const page = await loadOlderPage(pane.symbol, interval, pane.date, before)
        if (owner !== version.current) return { candles: [], more: false }
        more.current = page.more
        const older = page.candles.filter(row => row.time < before)
        if (held.current.key === key) {
          // Updated at once (not at the next render) so a chart that scrolls on straight away asks from the new oldest candle.
          const next = { ...held.current, candles: byTime([...older, ...held.current.candles]) }
          held.current = next
          setState(next)
        }
        return { candles: older.map(row => ({ ...row, timestamp: row.time })), more: page.more }
      } finally {
        if (inFlight.current?.key === key && inFlight.current.before === before) inFlight.current = null
      }
    })()
    inFlight.current = { key, before, promise }
    return promise
  }, [pane.symbol, pane.date, interval, key])

  const current = state.key === key ? state : { candles: [] as OHLCCandle[], loading: ready, message: '' }
  return { candles: current.candles, loading: current.loading, message: current.message, loadOlder: spot ? loadOlder : undefined }
}
