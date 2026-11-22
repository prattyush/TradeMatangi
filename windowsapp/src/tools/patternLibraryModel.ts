import type { PatternAnnotation, PatternChartMeta, TopPatterns } from '../../../shared/analysis/api'
import { patternIdentity } from '../../../shared/analysis/patternMarkers'
import { otmStrikes, patternStrikeRule, roundToStrike, PATTERN_ATM_TIME, PATTERN_MAX_PRICE_TIME, savedStrikes } from '../../../frontend/src/patternStrikes'
import type { PatternsClient, SaveChartBody } from '../patternsClient'

/** Strike spacing per symbol (the website page's table; indices only matter for Max Price and OTM picks). */
export const STRIKE_INTERVALS: Record<string, number> = { NIFTY: 50, BSESEN: 100 }

export const TOOL_OPTIONS = [
  { key: 'entry-underlying', label: '▲ Entry UL', type: 'entry', instrument: 'underlying' },
  { key: 'exit-underlying', label: '▼ Exit UL', type: 'exit', instrument: 'underlying' },
  { key: 'entry-CE', label: '▲ Entry CE', type: 'entry', instrument: 'CE' },
  { key: 'exit-CE', label: '▼ Exit CE', type: 'exit', instrument: 'CE' },
  { key: 'entry-PE', label: '▲ Entry PE', type: 'entry', instrument: 'PE' },
  { key: 'exit-PE', label: '▼ Exit PE', type: 'exit', instrument: 'PE' },
] as const
export type ToolOption = (typeof TOOL_OPTIONS)[number]

/**
 * Click on a pane with a tool: a second click with the same tool, bar, strategy and category removes the mark
 * (the website's behaviour), otherwise it is added.
 */
export function toggleAnnotation(
  annotations: PatternAnnotation[], tool: ToolOption, time: number, price: number, strategy: string, category: string, id: string,
): PatternAnnotation[] {
  const duplicate = annotations.find(a => a.time === time && a.instrument === tool.instrument && a.strategy_name === strategy && a.category === category && a.type === tool.type)
  if (duplicate) return annotations.filter(a => a.id !== duplicate.id)
  return [...annotations, { id, time, price, type: tool.type, instrument: tool.instrument, strategy_name: strategy, category, text: `${category} — ${strategy} (${tool.type} ${tool.instrument})` }]
}

export interface OptionStrikes { ce: number; pe: number; atm: number | null; expiry: string }

/** Settings -> option strikes for a day: OTM from the 09:15 price, or the Max Price pick at 09:30 (indices only). */
export async function resolveStrikes(
  client: PatternsClient, symbol: string, date: string, offset: number,
  settings: { mode: string; ceCap: number; peCap: number },
): Promise<OptionStrikes> {
  const rule = patternStrikeRule(symbol, settings)
  const interval = STRIKE_INTERVALS[symbol] ?? 50
  const { expiry } = await client.getExpiry(symbol, date)
  if (rule.mode === 'max_price') {
    const [ce, pe, price] = await Promise.all([
      client.findStrikeByPrice(symbol, date, expiry, 'CE', rule.ceCap, PATTERN_MAX_PRICE_TIME),
      client.findStrikeByPrice(symbol, date, expiry, 'PE', rule.peCap, PATTERN_MAX_PRICE_TIME),
      client.getPriceAt(symbol, date, PATTERN_ATM_TIME).catch(() => null),
    ])
    return { ce: ce.strike, pe: pe.strike, atm: price ? roundToStrike(price.price, interval) : null, expiry }
  }
  const price = await client.getPriceAt(symbol, date, PATTERN_ATM_TIME)
  const atm = roundToStrike(price.price, interval)
  return { ...otmStrikes(atm, offset, interval), atm, expiry }
}

/** Strikes saved with a chart (CE in `strike`, PE in `strike_pe`, older charts one strike for both). */
export const strikesOf = (chart: Pick<PatternChartMeta, 'strike' | 'strike_pe'>) => {
  const { ce, pe } = savedStrikes(chart)
  return ce === undefined ? null : { ce, pe: pe ?? ce }
}

export function buildSaveBody(input: {
  symbol: string; date: string; instrumentType: 'equity' | 'options'; annotations: PatternAnnotation[]; notes: string
  intervalMinutes: number; strikes: { ce: number; pe: number } | null
}): SaveChartBody {
  return {
    symbol: input.symbol, date: input.date, instrument_type: input.instrumentType, annotations: input.annotations, notes: input.notes,
    right: input.strikes ? 'CE' : undefined, strike: input.strikes?.ce, strike_pe: input.strikes?.pe, interval_minutes: input.intervalMinutes,
  }
}

/** Latest weekday on or before today, as the website page does for its default date. */
export function defaultPatternDate(now = new Date()): string {
  const d = new Date(now)
  if (d.getDay() === 0) d.setDate(d.getDate() - 2)
  if (d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

export type Rank = 'top_1' | 'top_2' | 'bottom_1'
export const RANKS: Array<{ rank: Rank; label: string }> = [
  { rank: 'top_1', label: '🥇 Top 1' }, { rank: 'top_2', label: '🥈 Top 2' }, { rank: 'bottom_1', label: '❌ Bottom 1' },
]

/** Distinct category/strategy pairs among the marks: the choices for the Top Patterns ranking. */
export function uniquePatterns(annotations: PatternAnnotation[]): Array<{ identity: string; strategy_name: string; category: string }> {
  const seen = new Set<string>()
  const result: Array<{ identity: string; strategy_name: string; category: string }> = []
  for (const a of annotations) {
    const identity = patternIdentity(a)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({ identity, strategy_name: a.strategy_name, category: a.category || '' })
  }
  return result
}

/** Put a pattern in a rank slot (empty identity clears it). */
export function setRank(top: TopPatterns, rank: Rank, identity: string): TopPatterns {
  const next = { ...top }
  if (!identity) { delete next[rank]; return next }
  const [strategy_name, category = ''] = identity.split('::')
  next[rank] = { strategy_name, category }
  return next
}

/** R:R is stored per `category::strategy`; an empty value removes the entry. */
export const riskRewardKey = (category: string, strategy: string) => `${category}::${strategy}`
export function setRiskReward(ratios: Record<string, string>, key: string, value: string): Record<string, string> {
  const next = { ...ratios }
  if (!value.trim()) delete next[key]; else next[key] = value
  return next
}

export interface ExtraPane { id: number; right: 'CE' | 'PE'; strike: number }

/** The strike saved with a chart: the first CE pane for `strike`, the first PE pane for `strike_pe`. */
export function savedStrikePair(panes: ExtraPane[]): { ce: number; pe: number } | null {
  const ce = panes.find(p => p.right === 'CE'); const pe = panes.find(p => p.right === 'PE')
  if (!ce && !pe) return null
  return { ce: (ce ?? pe)!.strike, pe: (pe ?? ce)!.strike }
}
