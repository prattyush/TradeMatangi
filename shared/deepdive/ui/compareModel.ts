/** Pure helpers of the Compare tab: which deep dives can be compared, which days and charts a pane offers. */
import type { DeepDiveSetup, DiveRef, DiveSummary } from '../types'
import { optionRight, orderSetups, sideLabel } from '../model'
import { optionEligible } from './inDepthModel'

/** One chart of a pane: the underlying, or the CE or PE of the day. */
export type CompareLeg = 'underlying' | 'CE' | 'PE'

/** Only strategies with marked days can be compared (an empty deep dive has nothing to look at), in name order. */
export function comparableDives(dives: readonly DiveSummary[]): DiveSummary[] {
  return dives.filter(dive => dive.days > 0).sort((a, b) => a.category.localeCompare(b.category) || a.strategy.localeCompare(b.strategy) || Number(b.can_edit) - Number(a.can_edit))
}

export const diveKey = (dive: DiveRef & { owner_id: string }) => `${dive.owner_id}|${dive.category}|${dive.strategy}`
export const dayKey = (setup: Pick<DeepDiveSetup, 'date' | 'symbol' | 'side'>) => `${setup.date}|${setup.symbol}|${setup.side}`

/** A deep dive's days newest first, for the day picker: the day to compare is usually a recent one. */
export const daysNewestFirst = <T extends Pick<DeepDiveSetup, 'date' | 'symbol' | 'side'>>(setups: readonly T[]): T[] => orderSetups(setups).reverse()

/** The charts a day can show: the underlying always; the CE and PE when the symbol has an option chain. */
export const legsFor = (symbol: string): CompareLeg[] => (optionEligible(symbol) ? ['underlying', 'CE', 'PE'] : ['underlying'])

/** A leg the day does not have (an index-only pane after changing to a symbol without options) falls back to the underlying. */
export const legOrUnderlying = (leg: CompareLeg, symbol: string): CompareLeg => (legsFor(symbol).includes(leg) ? leg : 'underlying')

/** The leg a day's own side is traded on, for a hint ("Buy: CE"). */
export const sideLeg = (setup: Pick<DeepDiveSetup, 'side'>): CompareLeg => optionRight(setup.side)

/** `6 Oct 2026 · Buy · NIFTY · 3 marks` */
export function dayOptionLabel(setup: Pick<DeepDiveSetup, 'date' | 'symbol' | 'side' | 'annotations'>, formatDay: (date: string) => string): string {
  return `${formatDay(setup.date)} · ${sideLabel(setup.side)} · ${setup.symbol} · ${setup.annotations.length} ${setup.annotations.length === 1 ? 'mark' : 'marks'}`
}
