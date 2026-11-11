import { useCallback, useEffect, useRef, useState } from 'react'
import type { OHLCCandle } from '../../services/api'
import { browseApi, loadOlderPage } from '../../services/browseApi'
import type { BrowsePane } from '../../services/browseWorkspace'

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
  const [state, setState] = useState<{ candles: OHLCCandle[]; loading: boolean; message: string }>({ candles: [], loading: true, message: '' })
  const more = useRef(true)
  const version = useRef(0)
  const spot = pane.kind === 'spot'
  const key = `${pane.symbol}:${pane.kind}:${pane.strike}:${pane.expiry}:${pane.date}:${interval}`

  useEffect(() => {
    const owner = ++version.current
    more.current = spot
    if (!ready) { setState({ candles: [], loading: false, message: '' }); return }
    setState({ candles: [], loading: true, message: '' })
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
        if (owner === version.current) setState({ candles: byTime(rows), loading: false, message: rows.length ? '' : 'No candles for this day.' })
      } catch (error) {
        if (owner === version.current) setState({ candles: [], loading: false, message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { version.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  const loadOlder = useCallback(async (before: number) => {
    if (!more.current) return { candles: [], more: false }
    const owner = version.current
    const page = await loadOlderPage(pane.symbol, interval, pane.date, before)
    if (owner !== version.current) return { candles: [], more: false }
    more.current = page.more
    const older = page.candles.filter(row => row.time < before)
    setState(previous => ({ ...previous, candles: byTime([...older, ...previous.candles]) }))
    return { candles: older.map(row => ({ ...row, timestamp: row.time })), more: page.more }
  }, [pane.symbol, pane.date, interval])

  return { candles: state.candles, loading: state.loading, message: state.message, loadOlder: spot ? loadOlder : undefined }
}
