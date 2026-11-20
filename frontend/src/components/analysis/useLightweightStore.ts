import { useEffect, useMemo, useState } from 'react'
import { useOptionalAnalysisEnvironment } from '../../../../shared/analysis/environment'
import { analysisDrawingInstrument } from '../../../../shared/charts/klineDrawingModel'
import { rendererAccountKey } from '../../services/websiteChartPreferences'
import { lightweightDrawingKey, type LwStore } from './lightweightDrawings'

/**
 * Where a Lightweight chart's drawings are saved: the environment's drawings service and the same instrument identity the KLine charts
 * use for this symbol (option or underlying), so both chart types share the records. Null while the symbol's kind is being looked up,
 * when the symbol cannot be resolved, or when there is no drawings service: the drawings then stay on the chart only.
 */
export function useLightweightStore(args: { symbol: string; right?: string; strike?: number; expiry?: string }): LwStore | null {
  const environment = useOptionalAnalysisEnvironment()
  const resolve = environment?.resolveSymbolInstrument
  const request = environment?.drawingRequest
  // undefined = looking up, null = no resolver (the defaults), false = the lookup failed
  const [info, setInfo] = useState<{ kind: string; exchange: string } | null | false | undefined>(undefined)
  useEffect(() => {
    let live = true
    setInfo(undefined)
    if (!resolve) { setInfo(null); return }
    void resolve(args.symbol).then(value => { if (live) setInfo(value ?? null) }).catch(error => {
      if (live) { setInfo(false); environment?.reportError?.(String(error), 'Drawings') }
    })
    return () => { live = false }
  }, [args.symbol, resolve])
  return useMemo(() => {
    if (!request || info === undefined || info === false) return null
    return {
      request,
      instrument: analysisDrawingInstrument({ symbol: args.symbol, right: args.right, strike: args.strike, expiry: args.expiry, kind: info?.kind, exchange: info?.exchange }),
      legacyBase: lightweightDrawingKey(rendererAccountKey(), args.symbol, args.right, args.strike, args.expiry),
    }
  }, [request, info, args.symbol, args.right, args.strike, args.expiry])
}
