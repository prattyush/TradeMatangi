import { otmStrikes, patternStrikeRule, roundToStrike, PATTERN_ATM_TIME, PATTERN_MAX_PRICE_TIME } from '../../frontend/src/patternStrikes'

/** Strike spacing per Pattern symbol (the website Pattern Library page's table, which matches the backend's). */
export const STRIKE_INTERVALS: Record<string, number> = { NIFTY: 50, BSESEN: 100, RELIND: 5, TATMOT: 5, TATPOW: 5 }

/** What a strike pick needs from a host: the website API and the desktop patterns client both have these three. */
export interface StrikeLookup {
  getExpiry(symbol: string, date: string): Promise<{ expiry: string }>
  getPriceAt(symbol: string, date: string, time: string): Promise<{ price: number }>
  findStrikeByPrice(symbol: string, date: string, expiry: string, right: 'CE' | 'PE', maxPrice: number, referenceTime: string): Promise<{ strike: number; price: number }>
}

export interface OptionStrikes { ce: number; pe: number; atm: number | null; expiry: string }

/** Settings -> option strikes for a day: OTM from the 09:15 price, or the Max Price pick at 09:30 (indices only). */
export async function resolveStrikes(
  client: StrikeLookup, symbol: string, date: string, offset: number,
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
