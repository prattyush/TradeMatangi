/**
 * How the Pattern Library picks its option strikes: the Settings "Option strike mode".
 *
 * OTM (default): ATM from the 09:15 price, CE = ATM + offset, PE = ATM - offset.
 * Max Price (indices only, like everywhere else): the first strike from ATM outwards whose premium at 09:30 is at or
 * below the CE cap and, separately, the PE cap. Stocks keep OTM whatever the setting says.
 */
export const PATTERN_INDEX_SYMBOLS = ['NIFTY', 'BSESEN']
/** Price the ATM strike is taken from (OTM mode). */
export const PATTERN_ATM_TIME = '09:15'
/** Time the Max Price cap is checked at, the same as Browse and Fine Structures. */
export const PATTERN_MAX_PRICE_TIME = '09:30:00'

export type PatternStrikeRule = { mode: 'otm' } | { mode: 'max_price'; ceCap: number; peCap: number }

export interface PatternStrikeSettings {
  /** `max_price_mode` from Settings: 'otm' or 'threshold' (the Max Price button). */
  mode: string
  ceCap: number
  peCap: number
}

const positive = (value: number) => Number.isFinite(value) && value > 0

export function patternStrikeRule(symbol: string, settings: PatternStrikeSettings): PatternStrikeRule {
  const wantsMaxPrice = settings.mode === 'threshold' || settings.mode === 'max_price'
  if (wantsMaxPrice && PATTERN_INDEX_SYMBOLS.includes(symbol) && positive(settings.ceCap) && positive(settings.peCap)) {
    return { mode: 'max_price', ceCap: settings.ceCap, peCap: settings.peCap }
  }
  return { mode: 'otm' }
}

export const roundToStrike = (price: number, interval: number) => Math.round(price / interval) * interval

/** OTM pair: both sides move away from ATM by the offset (a negative offset is ITM). */
export function otmStrikes(atm: number, offset: number, interval: number) {
  return { ce: atm + offset * interval, pe: atm - offset * interval }
}

/** A saved chart keeps the CE strike in `strike`; `strike_pe` exists only when it differs (Max Price) or on newer charts. */
export function savedStrikes(chart: { strike?: number | null; strike_pe?: number | null }) {
  const ce = chart.strike ?? undefined
  return { ce, pe: chart.strike_pe ?? ce }
}
