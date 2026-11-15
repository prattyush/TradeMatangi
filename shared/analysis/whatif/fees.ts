/**
 * The platform's per-order charge formula in TypeScript. It must match `compute_commission` in
 * `backend/app/services/trading.py` (checked by the golden test in `windowsapp/src/whatIfModel.test.ts`, whose values
 * `scripts/generate-whatif-golden.py` takes from the backend):
 *   exchange transaction charge 0.03553% and SEBI turnover fee 0.0001% of the turnover, GST 18% on (brokerage +
 *   transaction + SEBI), stamp duty 0.003% on a buy or STT 0.15% on a sell, plus the flat brokerage per order.
 */
export type TradeSide = 'BUY' | 'SELL'

const TXN = 0.03553 / 100
const SEBI = 0.0001 / 100
const GST = 0.18
const STAMP = 0.003 / 100
const STT = 0.15 / 100
const round4 = (value: number) => Math.round(value * 10_000) / 10_000

export function computeCommission(side: TradeSide, price: number, quantity: number, brokerage = 1): number {
  const total = price * quantity
  const txn = total * TXN
  const sebi = total * SEBI
  const gst = GST * (brokerage + txn + sebi)
  const statutory = total * (side === 'BUY' ? STAMP : STT)
  return round4(statutory + txn + sebi + gst + brokerage)
}

/**
 * The flat brokerage per order that produced a recorded charge (the formula is linear in it):
 * charge = rest + 1.18 x brokerage, so brokerage = (charge - rest) / 1.18. Null when the fill cannot say (no value, or a charge
 * below the statutory part, as a broker's own figure can be).
 */
export function inferBrokerage(side: TradeSide, price: number, quantity: number, commission: number): number | null {
  if (!(price > 0) || !(quantity > 0) || !Number.isFinite(commission)) return null
  const rest = computeCommission(side, price, quantity, 0)
  const brokerage = (commission - rest) / (1 + GST)
  return brokerage >= -0.005 ? Math.max(0, brokerage) : null
}

/** The day's brokerage per order: the middle of what its fills imply, rounded to paise; 1.0 (the platform default) when none can say. */
export function inferDayBrokerage(fills: Array<{ side: TradeSide; price: number; quantity: number; commission: number }>): number {
  const values = fills.map(fill => inferBrokerage(fill.side, fill.price, fill.quantity, fill.commission)).filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (!values.length) return 1
  const middle = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
  return Math.round(middle * 100) / 100
}
