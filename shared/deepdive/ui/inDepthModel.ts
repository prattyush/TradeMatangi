/** Pure helpers of the in-depth step: which charts a day needs, which mark tools it offers, what must be saved again. */
import type { SetupFields, DeepDiveSetup, Side } from '../types'
import { optionRight } from '../model'
import { patternStrikeRule, type PatternStrikeSettings } from '../../../frontend/src/patternStrikes'
import { STRIKE_INTERVALS } from '../strikes'
import { TOOL_OPTIONS, type ToolOption } from '../marking'

/** The Pattern symbols all have option chains and a strike gap, so each gets an option chart (Max Price is for the indices only). */
export const optionEligible = (symbol: string) => symbol in STRIKE_INTERVALS

/**
 * The strikes the Mark days chart shows when you look at the CE or the PE of a day: the Max Price pick at 09:30 with a premium cap of 75
 * for both sides, whatever the account's strike setting is (it is only there to get an idea of the option chart; nothing is saved, and
 * no setup's strikes change). The stocks keep an ATM strike, as everywhere (`patternStrikeRule`).
 */
export const PREVIEW_STRIKE_CAP = 75
export const previewStrikeSettings = { mode: 'threshold', ceCap: PREVIEW_STRIKE_CAP, peCap: PREVIEW_STRIKE_CAP } as const

/** Mark days' chart choices: the underlying (the default) or the CE or PE of the day. */
export type MarkView = 'underlying' | 'CE' | 'PE'
export const MARK_VIEWS: ReadonlyArray<{ view: MarkView; label: string }> = [
  { view: 'underlying', label: 'Underlying' }, { view: 'CE', label: 'CE' }, { view: 'PE', label: 'PE' },
]

/** How the in-depth step lays its two charts out. */
export type ChartLayout = 'stacked' | 'side'

export const needsStrikes = (setup: Pick<DeepDiveSetup, 'strike_ce' | 'strike_pe'>) => setup.strike_ce == null || setup.strike_pe == null

export const strikeModeFor = (symbol: string, settings: PatternStrikeSettings): 'max_price' | 'otm' => patternStrikeRule(symbol, settings).mode

/** The strike of the chart a side is traded on: a Buy setup on its CE, a Sell setup on its PE. */
export const strikeForSide = (side: Side, strikes: { ce: number; pe: number }) => (side === 'buy' ? strikes.ce : strikes.pe)

/** Entry and exit tools for the underlying and, when the day has an option chart, for that side's option. */
export function toolsFor(side: Side, hasOptionChart: boolean): ToolOption[] {
  const right = optionRight(side)
  return TOOL_OPTIONS.filter(tool => tool.instrument === 'underlying' || (hasOptionChart && tool.instrument === right))
}

export const markCount = (setup: Pick<DeepDiveSetup, 'annotations'>, instrument: string) => setup.annotations.filter(a => a.instrument === instrument).length

/** Everything a day stores outside its tag marks, for "Retry" after a failed save (saving it again is harmless). */
export function fullFields(setup: DeepDiveSetup): SetupFields {
  return {
    annotations: setup.annotations, outcome: setup.outcome, strength: setup.strength ?? null, notes: setup.notes, interval_minutes: setup.interval_minutes,
    strike_ce: setup.strike_ce, strike_pe: setup.strike_pe, strike_mode: setup.strike_mode,
  }
}
