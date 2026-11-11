import { snapSwingPrice } from '../../../../shared/swingOrderPrice'
import type { Instrument, ListedContract, OrderKind, OrderPreview, PendingOrder, Portfolio, Position, Side } from './swingTypes'

/**
 * The rules of the swing order ticket, the same as the website's panel (`shared/SwingPortfolioPanel.tsx`) and the server:
 * no market orders, entries are LIMIT or TARGET and exits are LIMIT or STOPLOSS, equity and options are long only, futures
 * go both ways, capital-% sizing and every futures order are previewed first, and a request id names one set of instructions.
 */

export interface Draft {
  symbol: string
  instrument: Instrument
  right: 'CE' | 'PE'
  strike: string
  expiry: string
  side: Side
  type: OrderKind
  /** Shares for equity; lots for options and futures. */
  quantity: string
  price: string
  sizing: 'quantity' | 'capital_pct'
  capitalPct: string
}

export function newDraft(symbol = 'HDFCBANK', instrument: Instrument = 'equity'): Draft {
  return { symbol, instrument, right: 'CE', strike: '', expiry: '', side: 'BUY', type: 'LIMIT', quantity: '1', price: '', sizing: 'quantity', capitalPct: '10' }
}

const sameContract = (position: { symbol: string; instrument_type?: string; expiry?: string | null; right?: string | null; strike?: number | null }, draft: Draft) =>
  position.symbol === draft.symbol && (position.instrument_type ?? 'equity') === draft.instrument &&
  (draft.instrument === 'equity' || position.expiry === draft.expiry) &&
  (draft.instrument !== 'options' || (position.right === draft.right && Number(position.strike) === Number(draft.strike)))

/** The open position in the contract the ticket names, if any. */
export function heldPosition(positions: Position[] | undefined, draft: Draft): Position | undefined {
  return positions?.find(position => position.quantity > 0 && sameContract(position, draft))
}

/** Quantity already promised to open exit orders in this contract (a new exit may only use the rest). */
export function outstandingExit(orders: PendingOrder[] | undefined, draft: Draft, held: Position | undefined): number {
  if (!held) return 0
  const exitSide: Side = held.side === 'SHORT' ? 'BUY' : 'SELL'
  return (orders ?? [])
    .filter(order => order.side === exitSide && sameContract({ ...order, instrument_type: order.instrument_type }, draft))
    .reduce((total, order) => total + Math.max(0, order.quantity - (order.broker_filled_quantity ?? order.filled_quantity ?? 0)), 0)
}

/**
 * Is this order an exit of what is held? Equity and options can only be sold to exit. A future is an exit when it goes
 * against the open position (SELL a long, BUY a short); otherwise it opens or adds to a position.
 */
export function isExit(draft: Draft, positions: Position[] | undefined): boolean {
  if (draft.instrument !== 'futures') return draft.side === 'SELL'
  const held = heldPosition(positions, draft)
  return Boolean(held && ((held.side === 'LONG' && draft.side === 'SELL') || (held.side === 'SHORT' && draft.side === 'BUY')))
}

export function allowedTypes(exit: boolean): OrderKind[] {
  return exit ? ['LIMIT', 'STOPLOSS'] : ['LIMIT', 'TARGET']
}

/** Order kind that is valid for the current intent (switching to an exit turns a TARGET into a LIMIT, and back). */
export function fixType(draft: Draft, positions: Position[] | undefined): Draft {
  const exit = isExit(draft, positions)
  // Capital-% sizing is for entries only; an exit is always sized by quantity.
  const sized = exit && draft.sizing !== 'quantity' ? { ...draft, sizing: 'quantity' as const } : draft
  return allowedTypes(exit).includes(sized.type) ? sized : { ...sized, type: 'LIMIT' }
}

/** Plain wording for what this order does. */
export function intentLabel(draft: Draft, positions: Position[] | undefined): string {
  const exit = isExit(draft, positions)
  if (draft.instrument !== 'futures') return exit ? 'Sell (exit)' : 'Buy (enter)'
  const held = heldPosition(positions, draft)
  if (exit) return held?.side === 'SHORT' ? 'Buy to cover' : 'Sell to exit'
  return draft.side === 'SELL' ? 'Sell to open a short' : 'Buy to open a long'
}

export const needsPreview = (draft: Draft, positions: Position[] | undefined): boolean =>
  draft.instrument === 'futures' || (draft.sizing === 'capital_pct' && !isExit(draft, positions))

export const contractLabel = (draft: Draft): string =>
  draft.instrument === 'options' ? `${draft.symbol} ${draft.expiry} ${draft.strike} ${draft.right}`
    : draft.instrument === 'futures' ? `${draft.symbol} FUT ${draft.expiry}`
      : draft.symbol

export function findContract(contracts: ListedContract[], draft: Draft): ListedContract | undefined {
  return contracts.find(contract => contract.expiry === draft.expiry &&
    (draft.instrument === 'futures' || (contract.right === draft.right && Number(contract.strike) === Number(draft.strike))))
}

/** Units of the order: lots times the lot size for options and futures. */
export function orderQuantity(draft: Draft, contract: ListedContract | undefined, preview: OrderPreview | null): number {
  if (needsPreviewQuantity(draft) && preview) return preview.quantity
  const entered = Number(draft.quantity)
  return draft.instrument === 'equity' ? entered : entered * (contract?.lot_size ?? 1)
}
const needsPreviewQuantity = (draft: Draft) => draft.sizing === 'capital_pct'

export function snapPrice(draft: Draft, contract: ListedContract | undefined): string {
  const price = Number(draft.price)
  if (!(price > 0)) return draft.price
  return String(snapSwingPrice(price, contract?.tick_size ?? 0.05))
}

export interface TicketContext {
  portfolio: Portfolio | null
  positions: Position[] | undefined
  openOrders: PendingOrder[] | undefined
  contract: ListedContract | undefined
  preview: OrderPreview | null
}

/** Reasons the ticket cannot be sent yet (empty = ready). Shown inline, never as a blocking pop-up. */
export function problems(draft: Draft, context: TicketContext): string[] {
  const found: string[] = []
  const { portfolio } = context
  if (!portfolio) return ['Start a portfolio first.']
  if (portfolio.state !== 'running') found.push('The portfolio is not running.')
  const exit = isExit(draft, context.positions)
  if (!exit && portfolio.entries_paused) found.push('Entries are paused. Resume them to enter.')
  if (draft.instrument !== 'equity' && !draft.expiry) found.push('Choose an expiry.')
  if (draft.instrument === 'options' && !(Number(draft.strike) > 0)) found.push('Choose a strike.')
  if (draft.instrument !== 'equity' && draft.expiry && !context.contract) found.push('That contract is not listed.')
  const price = Number(draft.price)
  if (!(price > 0)) found.push('Enter a price. There are no market orders.')
  else if (context.contract?.tick_size && Math.abs(price - snapSwingPrice(price, context.contract.tick_size)) > 1e-9) found.push(`The price must be a multiple of ${context.contract.tick_size}.`)
  if (draft.sizing === 'capital_pct' && !exit) {
    const pct = Number(draft.capitalPct)
    if (!(pct > 0 && pct <= 100)) found.push('Capital % must be between 0 and 100.')
    else if (needsPreview(draft, context.positions) && !context.preview) found.push('Waiting for the size estimate.')
    else if (context.preview && !(context.preview.quantity > 0)) found.push('That share of capital is too small for one lot.')
  } else {
    const entered = Number(draft.quantity)
    if (!(entered > 0) || !Number.isInteger(entered)) found.push(draft.instrument === 'equity' ? 'Enter a whole number of shares.' : 'Enter a whole number of lots.')
    if (draft.instrument === 'futures' && !context.preview) found.push('Waiting for the margin estimate.')
  }
  if (exit && draft.instrument !== 'futures') {
    const held = heldPosition(context.positions, draft)
    if (!held) found.push('You hold none of this to sell.')
    else {
      const free = held.quantity - outstandingExit(context.openOrders, draft, held)
      const units = orderQuantity(draft, context.contract, context.preview)
      if (units > free) found.push(`Only ${Math.max(0, free)} can still be sold (${held.quantity} held, the rest is in open exit orders).`)
    }
  }
  if (draft.instrument === 'futures' && context.preview && context.preview.execution_enabled === false) found.push('Futures orders are not enabled on this server.')
  return found
}

export function previewBody(draft: Draft, portfolio: Portfolio, contract: ListedContract | undefined): Record<string, unknown> {
  const percentage = draft.sizing === 'capital_pct'
  return {
    symbol: draft.symbol,
    instrument_type: draft.instrument,
    side: draft.instrument === 'futures' ? draft.side : 'BUY',
    order_type: draft.type,
    price: Number(draft.price),
    quantity: percentage ? 1 : orderQuantity(draft, contract, null),
    ...(percentage ? { capital_pct: Number(draft.capitalPct) / 100 } : {}),
    capital_revision: portfolio.guardrail_epoch,
    request_id: 'preview',
    client: 'phone',
    ...(draft.instrument === 'options' ? { right: draft.right, strike: Number(draft.strike), expiry: draft.expiry } : draft.instrument === 'futures' ? { expiry: draft.expiry } : {}),
  }
}

export function orderBody(draft: Draft, contract: ListedContract | undefined, preview: OrderPreview | null, requestId: string): Record<string, unknown> {
  const percentage = draft.sizing === 'capital_pct'
  return {
    symbol: draft.symbol,
    instrument_type: draft.instrument,
    side: draft.side,
    order_type: draft.type,
    client: 'phone',
    quantity: orderQuantity(draft, contract, preview),
    ...(percentage ? { capital_pct: Number(draft.capitalPct) / 100, capital_revision: preview?.capital_revision } : {}),
    ...(draft.instrument === 'futures' ? { expiry: draft.expiry, approved_budget: preview?.budget, fee_hash: preview?.fee_hash, capital_revision: preview?.capital_revision } : {}),
    price: Number(draft.price),
    request_id: requestId,
    ...(draft.instrument === 'options' ? { right: draft.right, strike: Number(draft.strike), expiry: draft.expiry } : {}),
  }
}

/** Identity of the instructions: any change to it is a different order and gets a new request id. */
export function instructionKey(draft: Draft, preview: OrderPreview | null): string {
  return JSON.stringify([draft.symbol, draft.instrument, draft.right, draft.strike, draft.expiry, draft.side, draft.type, draft.quantity, draft.price, draft.sizing, draft.capitalPct, preview?.quantity ?? null, preview?.fee_hash ?? null])
}

/**
 * One request id per set of instructions. Sending the same instructions again (after "no answer" or a broker problem)
 * reuses the id, so the server returns the first order instead of placing a second one; changing anything starts over.
 */
export class RequestIdentity {
  private key: string | null = null
  private id: string | null = null
  constructor(private make: () => string = () => crypto.randomUUID()) {}
  idFor(key: string): string {
    if (this.key !== key || this.id === null) { this.key = key; this.id = this.make() }
    return this.id
  }
  /** The order was accepted: the next one is a new order. */
  done(): void { this.key = null; this.id = null }
}

export function estimatedValue(draft: Draft, contract: ListedContract | undefined, preview: OrderPreview | null): number | null {
  const price = Number(draft.price)
  const units = orderQuantity(draft, contract, preview)
  return price > 0 && units > 0 ? Math.round(price * units * 100) / 100 : null
}
