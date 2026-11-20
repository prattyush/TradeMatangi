/**
 * The instrument a trading chart's drawings belong to. One function for the KLine chart (`WebsiteKLineChart`) and the Lightweight chart
 * (`Chart.tsx`), so a drawing made in one chart type is found by the other: the backend matches the exact identity.
 * Pure (no chart, no catalogue lookup): the catalogue kind of an underlying is passed in.
 */
export interface ChartDrawingInstrumentInput {
  paneType?: string
  symbol: string
  right?: string
  strike?: number
  expiry?: string
  /** A Swing chart: its option drawings carry the feed venue (NFO / BFO). */
  swingChart?: boolean
  /** The kind given by the screen, if any (a futures or index chart). */
  chartKind?: string
  /** The kind of the underlying in the symbol catalogue (`chart_type`), once it has been read. */
  catalogueKind?: string
}

export function chartDrawingInstrument(input: ChartDrawingInstrumentInput): Record<string, unknown> {
  const bse = input.symbol === 'BSESEN'
  if (input.paneType === 'options') {
    return {
      kind: 'option',
      underlying: input.symbol,
      exchange: input.swingChart ? (bse ? 'BFO' : 'NFO') : (bse ? 'BSE' : 'NSE'),
      right: input.right,
      strike: input.strike,
      expiry: input.expiry,
    }
  }
  if (input.paneType === 'futures') {
    return { kind: 'future', underlying: input.symbol, exchange: bse ? 'BFO' : 'NFO', expiry: input.expiry }
  }
  return { kind: input.chartKind ?? input.catalogueKind ?? 'equity', symbol: input.symbol, exchange: bse ? 'BSE' : 'NSE' }
}
