export type TicketSizingMode = 'quantity' | 'fundsRatio' | 'riskRatio'
type Tiers = { l: number; m: number; h: number }
export type TicketSizeKey = 'l' | 'm' | 'h'

/** Arguments of the ticket's onSubmit after the order: [quantity, fundsRatioPct, riskRatioPct, targetProfitPct]. */
export type TicketSizeArgs = [number | null, number?, number?, number?]

export const TICKET_SIZING_CHOICES: ReadonlyArray<readonly [TicketSizingMode, string, string]> = [
  ['quantity', 'Qty', 'Use fixed quantity for this order'],
  ['fundsRatio', 'Capital %', 'Use Capital % for this order'],
  ['riskRatio', 'Risk %', 'Use Risk % for this order'],
]

/** Maps a Low/Medium/High press to the submit arguments for the chosen sizing mode. Funds go out as a 0-1 fraction, risk in percentage points. */
export function ticketSizeArgs(
  isTarget: boolean,
  mode: TicketSizingMode,
  key: TicketSizeKey,
  tiers: { quantity: Tiers; funds: Tiers; risk: Tiers },
): TicketSizeArgs {
  if (isTarget) return [null, undefined, undefined, tiers.risk[key]]
  if (mode === 'quantity') return [tiers.quantity[key]]
  if (mode === 'fundsRatio') return [null, tiers.funds[key] / 100, undefined]
  return [null, undefined, tiers.risk[key]]
}

/** Text of a Low/Medium/High button, so the value behind each button is visible. */
export function ticketSizeLabel(isTarget: boolean, mode: TicketSizingMode, value: number): string {
  if (isTarget) return `Target ${value}%`
  if (mode === 'quantity') return `Qty ${value}`
  return `${mode === 'riskRatio' ? 'Risk' : 'Capital'} ${value}%`
}
