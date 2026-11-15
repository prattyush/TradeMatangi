import { snapSwingPrice } from '../../../../shared/swingOrderPrice'
import { newDraft, type Draft } from './orderTicket'
import type { Position } from './swingTypes'
import type { TicketPreset } from './TicketSheet'
import type { PositionAction } from './PositionSheet'

/** A stoploss is offered this far from the last price (the user edits it before reviewing). */
export const STOPLOSS_DISTANCE = 0.03

/** The ticket for one of the three actions on a position. Nothing is sent from here: the ticket still reviews and confirms. */
export function presetFor(position: Position, action: PositionAction): TicketPreset {
  const short = position.side === 'SHORT'
  const base: Draft = {
    ...newDraft(position.symbol, position.instrument_type),
    right: position.right ?? 'CE',
    strike: position.strike != null ? String(position.strike) : '',
    expiry: position.expiry ?? '',
  }
  const mark = position.mark_price && position.mark_price > 0 ? position.mark_price : null
  const exitSide = short ? 'BUY' : 'SELL'
  if (action === 'buy_more') return { draft: { ...base, side: short ? 'SELL' : 'BUY', price: mark ? String(snapSwingPrice(mark)) : '' }, lastPrice: mark }
  if (action === 'exit') return { draft: { ...base, side: exitSide, type: 'LIMIT', price: mark ? String(snapSwingPrice(mark)) : '' }, exitAll: true, lastPrice: mark }
  // Stoploss: below the price for a long, above it for a short (a buy stop that covers).
  const trigger = mark ? snapSwingPrice(mark * (short ? 1 + STOPLOSS_DISTANCE : 1 - STOPLOSS_DISTANCE)) : null
  return { draft: { ...base, side: exitSide, type: 'STOPLOSS', price: trigger ? String(trigger) : '' }, exitAll: true, lastPrice: mark }
}
