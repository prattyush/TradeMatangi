import type { ChartStructureItem, StructureCandle, StructureClassification } from '../patternsClient'

export const TYPE_COLORS: Record<string, string> = {
  within_yesterdays_range: '#60a5fa', within_day_before_yesterdays_range: '#93c5fd',
  gap_up: '#22c55e', gap_down: '#ef4444', big_gap_up: '#166534', big_gap_down: '#991b1b',
  trading_range: '#34d399', breakout: '#22c55e', trend: '#8b5cf6',
  reversal_breakout: '#ef4444', trend_reversal: '#ec4899', undefined: '#484f58',
}

export const SHORT_LABELS: Record<string, string> = {
  within_yesterdays_range: "Y'day Range", within_day_before_yesterdays_range: 'DBY Range',
  gap_up: 'Gap Up', gap_down: 'Gap Dn', big_gap_up: 'Big Up', big_gap_down: 'Big Dn',
  trading_range: 'Range', breakout: 'BrkOut', trend: 'Trend',
  reversal_breakout: 'Rev Brk', trend_reversal: 'Rev Trend', undefined: '—',
}
export const shortLabel = (value: string) => SHORT_LABELS[value] ?? value
export const typeColor = (value: string) => TYPE_COLORS[value] ?? '#484f58'

/** Candle times encode IST wall-clock as UTC, so the UTC date is the trading date. */
export const candleDate = (time: number) => new Date(time * 1000).toISOString().slice(0, 10)

/** Close-price line for one day, as SVG polyline points in a `width` x `height` box. Empty when there is nothing to draw. */
export function sparklinePoints(candles: StructureCandle[], date: string, width: number, height: number): string {
  const day = candles.filter(c => candleDate(c.time) === date)
  if (day.length < 2) return ''
  const prices = day.flatMap(c => [c.high, c.low])
  const lo = Math.min(...prices), hi = Math.max(...prices)
  const range = hi - lo || 1
  const step = width / (day.length - 1)
  return day.map((c, i) => `${(i * step).toFixed(1)},${(height - ((c.close - lo) / range) * (height - 2) - 1).toFixed(1)}`).join(' ')
}

/**
 * Saving rule from the website: predefined (system) and shared structures are never edited, a custom copy is created
 * for the user; the user's own structure is updated in place.
 */
export const saveMode = (structure: Pick<ChartStructureItem, 'is_predefined' | 'can_delete'>): 'create' | 'update' =>
  structure.is_predefined || !structure.can_delete ? 'create' : 'update'

export const classificationOf = (s: ChartStructureItem | null): StructureClassification => ({
  opening_type: s?.opening_type || 'undefined', midday_type: s?.midday_type || 'undefined', closing_type: s?.closing_type || 'undefined',
})

export const toggleValue = (selected: string[], value: string) =>
  selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]
