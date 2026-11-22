import type { PatternAnnotation, PatternChartMeta, TopPatterns } from '../../../shared/analysis/api'
import { patternIdentity } from '../../../shared/analysis/patternMarkers'
import { savedStrikes } from '../../../frontend/src/patternStrikes'
import type { SaveChartBody } from '../patternsClient'

export { TOOL_OPTIONS, toggleAnnotation, type ToolOption } from '../../../shared/deepdive/marking'
export { STRIKE_INTERVALS, resolveStrikes, type OptionStrikes, type StrikeLookup } from '../../../shared/deepdive/strikes'

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
