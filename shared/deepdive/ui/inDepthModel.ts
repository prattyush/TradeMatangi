/** Pure helpers of the in-depth step: which charts a day needs, which mark tools it offers, what must be saved again. */
import type { SetupFields, DeepDiveSetup, Side } from '../types'
import { optionRight } from '../model'
import { patternStrikeRule, type PatternStrikeSettings } from '../../../frontend/src/patternStrikes'
import { STRIKE_INTERVALS } from '../strikes'
import { TOOL_OPTIONS, type ToolOption } from '../marking'

/** The Pattern symbols all have option chains and a strike gap, so each gets an option chart (Max Price is for the indices only). */
export const optionEligible = (symbol: string) => symbol in STRIKE_INTERVALS

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
