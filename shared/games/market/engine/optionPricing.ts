/**
 * Black-Scholes pricing and Greeks for the Strike Picker (spec 5.8). Pure, no market data. European options on an index, a
 * continuous risk-free rate `r` and no dividend. Time is in YEARS, volatility is a decimal (0.14 = 14 %).
 *
 *  - `delta`: change of the premium per 1 point of the underlying.
 *  - `gamma`: change of the delta per 1 point.
 *  - `theta`: change of the premium per DAY (calendar), negative for a long option.
 *  - `vega`: change of the premium per 1 percentage point of volatility.
 */
export type Right = 'CE' | 'PE'

export interface Greeks { price: number; delta: number; gamma: number; theta: number; vega: number }

export const RISK_FREE = 0.065

/** Standard normal density. */
export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)

/** Standard normal CDF: Hart's algorithm (West 2005), accurate to about 1e-15, so put-call parity holds to rounding. */
export function normCdf(x: number): number {
  const z = Math.abs(x)
  let cdf: number
  if (z > 37) cdf = 0
  else {
    const e = Math.exp(-0.5 * z * z)
    if (z < 7.07106781186547) {
      let n = 0.0352624965998911 * z + 0.700383064443688
      n = n * z + 6.37396220353165
      n = n * z + 33.912866078383
      n = n * z + 112.079291497871
      n = n * z + 221.213596169931
      n = n * z + 220.206867912376
      let d = 0.0883883476483184 * z + 1.75566716318264
      d = d * z + 16.064177579207
      d = d * z + 86.7807322029461
      d = d * z + 296.564248779674
      d = d * z + 637.333633378831
      d = d * z + 793.826512519948
      d = d * z + 440.413735824752
      cdf = (e * n) / d
    } else {
      let b = z + 0.65
      b = z + 4 / b
      b = z + 3 / b
      b = z + 2 / b
      b = z + 1 / b
      cdf = e / b / 2.506628274631
    }
  }
  return x > 0 ? 1 - cdf : cdf
}

const intrinsic = (spot: number, strike: number, right: Right): number => Math.max(0, right === 'CE' ? spot - strike : strike - spot)

/**
 * Price and Greeks. At expiry (`years <= 0`) or with no volatility the premium is the intrinsic value, the delta is 1, -1 or 0, and the
 * other Greeks are 0 (a clean limit the game can show, never NaN).
 */
export function blackScholes(spot: number, strike: number, years: number, vol: number, right: Right, rate = RISK_FREE): Greeks {
  if (!(spot > 0) || !(strike > 0)) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 }
  if (!(years > 1e-9) || !(vol > 1e-9)) {
    const itm = right === 'CE' ? spot > strike : spot < strike
    return { price: intrinsic(spot, strike, right), delta: itm ? (right === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 }
  }
  const root = Math.sqrt(years)
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * root)
  const d2 = d1 - vol * root
  const discount = Math.exp(-rate * years)
  const call = spot * normCdf(d1) - strike * discount * normCdf(d2)
  const put = strike * discount * normCdf(-d2) - spot * normCdf(-d1)
  const pdf = normPdf(d1)
  const thetaCallYear = -(spot * pdf * vol) / (2 * root) - rate * strike * discount * normCdf(d2)
  const thetaPutYear = -(spot * pdf * vol) / (2 * root) + rate * strike * discount * normCdf(-d2)
  return {
    price: right === 'CE' ? call : put,
    delta: right === 'CE' ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (spot * vol * root),
    theta: (right === 'CE' ? thetaCallYear : thetaPutYear) / 365,
    vega: (spot * pdf * root) / 100,
  }
}

/** Days to years on the calendar (the market quotes expiry in calendar days). */
export const daysToYears = (days: number): number => days / 365
