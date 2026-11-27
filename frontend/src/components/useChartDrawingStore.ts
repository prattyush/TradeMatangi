import { useEffect, useMemo, useState } from 'react'
import { desktopDrawingRequest, resolveSymbolInstrument } from '../services/desktopDrawingRequest'
import { chartDrawingInstrument } from './chartDrawingInstrument'
import type { LwStore } from './analysis/lightweightDrawings'

/**
 * Where the Lightweight trading chart (Day, Swing, Browse) saves its drawings: the same records the KLine chart uses for the same instrument
 * (`chartDrawingInstrument` is the one identity both build). `null` while the underlying's catalogue kind is looked up, when the lookup fails
 * or when `enabled` is false (the KLine renderer is showing): the chart then keeps its drawings on the chart only.
 */
export function useChartDrawingStore(args: {
  enabled: boolean
  paneType?: string
  symbol: string
  right?: string
  strike?: number
  expiry?: string
  swingChart?: boolean
  chartKind?: string
  /** The browser-only key the chart kept its drawings under before (Browse and Swing add the candle interval to it). */
  drawingStorageKey?: string
  /** A Swing chart's old private scope, still read. */
  legacyDrawingScope?: string
}): LwStore | null {
  const underlying = args.paneType !== 'options' && args.paneType !== 'futures'
  const needsCatalogue = args.enabled && underlying && !args.chartKind
  // undefined = looking up, false = the lookup failed
  const [kind, setKind] = useState<string | false | undefined>(undefined)
  useEffect(() => {
    if (!needsCatalogue) return
    let live = true
    setKind(undefined)
    void resolveSymbolInstrument(args.symbol).then(info => { if (live) setKind(info?.kind ?? 'equity') }).catch(() => { if (live) setKind(false) })
    return () => { live = false }
  }, [needsCatalogue, args.symbol])
  const catalogueKind = needsCatalogue ? kind : undefined
  return useMemo(() => {
    if (!args.enabled || catalogueKind === undefined && needsCatalogue || catalogueKind === false) return null
    return {
      request: desktopDrawingRequest,
      instrument: chartDrawingInstrument({
        paneType: args.paneType, symbol: args.symbol, right: args.right, strike: args.strike, expiry: args.expiry,
        swingChart: args.swingChart, chartKind: args.chartKind, catalogueKind: catalogueKind || undefined,
      }),
      // Browse and Swing saved per candle interval (`...:5` or `...:15m`): the controller copies every interval's drawings up under this base.
      legacyBase: args.drawingStorageKey ? args.drawingStorageKey.replace(/:\d+[mhD]?$/, '') : 'analysis-lw-no-local-drawings',
      legacyScope: args.legacyDrawingScope,
    }
  }, [args.enabled, needsCatalogue, catalogueKind, args.paneType, args.symbol, args.right, args.strike, args.expiry, args.swingChart, args.chartKind, args.drawingStorageKey, args.legacyDrawingScope])
}
