/** Pure logic of the traded-patterns screens: what to draw for a trade, and how to word it. */
import type { PatternAnnotation } from '../analysis/api'
import { optionRight, sideLabel } from '../deepdive/model'
import type { TradedStrategy, TradedTrade } from './types'

/** A traded mark lands on the 3-minute bar the order happened in, like the marks the server saves. */
export const TRADED_BAR_SECONDS = 180

/** The instrument a trade was on: its option's own leg, or the underlying. */
export const tradeInstrument = (trade: Pick<TradedTrade, 'right'>): 'CE' | 'PE' | 'underlying' => (trade.right === 'CE' || trade.right === 'PE' ? trade.right : 'underlying')

/** The trade's entry and exit as display marks (`source: 'traded'`). They are never sent anywhere: saving is the server's own copy. */
export function tradedMarks(trade: TradedTrade, ref: { category: string; strategy: string }): PatternAnnotation[] {
  const instrument = tradeInstrument(trade)
  const opposite = trade.action === 'BUY' ? 'SELL' : 'BUY'
  const legs: Array<['entry' | 'exit', TradedTrade['entry'] | null, 'BUY' | 'SELL']> = [['entry', trade.entry, trade.action], ['exit', trade.exit, opposite]]
  return legs.flatMap(([type, leg, action]) => leg ? [{
    id: `traded:${trade.session_id}:${trade.round_trip_index}:${type}`, time: leg.time - (leg.time % TRADED_BAR_SECONDS), price: leg.price, type,
    instrument, strategy_name: ref.strategy, category: ref.category, text: `${action} ${leg.quantity} @ ${leg.price}`, source: 'traded' as const, action,
  }] : [])
}

/** `09:21` from an epoch in the chart's clock (IST wall time written as UTC). */
export const clock = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(11, 16)

/** `NIFTY` or `NIFTY CE 24500`. */
export const instrumentName = (trade: Pick<TradedTrade, 'symbol' | 'right' | 'strike'>) => (trade.right ? `${trade.symbol} ${trade.right}${trade.strike ? ` ${trade.strike}` : ''}` : trade.symbol)

export const timeRange = (trade: Pick<TradedTrade, 'entry' | 'exit'>) => `${clock(trade.entry.time)} → ${trade.exit ? clock(trade.exit.time) : 'open'}`

export const pnlText = (pnl: number) => `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`

/** How the trade carries the strategy: as the one expected at entry, the one it turned out to be, or both. */
export const matchedText = (matched: TradedTrade['matched_as']) => (matched === 'both' ? 'Expected and actual' : matched === 'expected' ? 'Expected' : 'Actual')

/** `Bought` / `Sold`, then the side it profits from: "Bought · Buy setup". */
export const directionText = (trade: Pick<TradedTrade, 'action' | 'side'>) => `${trade.action === 'BUY' ? 'Bought' : 'Sold'}${trade.side ? ` · ${sideLabel(trade.side)} setup` : ''}`

/** The option chart a trade needs, or null for an underlying trade. */
export const contractFor = (trade: TradedTrade) => (trade.right && trade.strike && trade.expiry ? { right: trade.right, strike: trade.strike, expiry: trade.expiry } : null)

export function filterStrategies(list: readonly TradedStrategy[], text: string): TradedStrategy[] {
  const needle = text.trim().toLowerCase()
  return needle ? list.filter(item => `${item.category} ${item.strategy}`.toLowerCase().includes(needle)) : [...list]
}

/** The option leg a Buy or Sell setup is traded on, for the legend: Buy on the CE, Sell on the PE. */
export const setupLeg = optionRight

export const saveText = (result: { merged: boolean; added: number }) =>
  result.merged ? `Added ${result.added} ${result.added === 1 ? 'mark' : 'marks'} to the day's pattern chart` : `Saved as a new pattern chart with ${result.added} ${result.added === 1 ? 'mark' : 'marks'}`
