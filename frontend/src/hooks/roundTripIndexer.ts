/**
 * Round-trip numbering for in-session labels.
 *
 * The backend numbers a round trip when it OPENS (first fill of a contract from flat), in the order trades
 * arrive — `performance_service.build_cycles` uses `index = len(cycles)`. Labels, and Phase 23 behavior marks,
 * are keyed by that number, so the client must assign the same one: when CE and PE are open together and the
 * second-opened leg closes first, numbering at close time would put its labels on the wrong trade.
 */
export type Leg = 'eq' | 'ce' | 'pe'
export interface IndexState {
  /** Number the next opened round trip gets. */
  counter: number
  /** Number given to each leg that is currently open. */
  open: Partial<Record<Leg, number>>
}
export const emptyIndexState = (): IndexState => ({ counter: 0, open: {} })
export const legOf = (right: string | null | undefined): Leg => (right === 'CE' ? 'ce' : right === 'PE' ? 'pe' : 'eq')

/**
 * Applies one leg's net-quantity change. `closed` is the round-trip number of a leg that just went flat; `opened` that of
 * a leg that just left flat. A reversal through zero (long to short in one fill) closes the old trip and opens a new one,
 * as the backend splits such a cycle.
 */
export function stepLeg(state: IndexState, leg: Leg, prevQty: number, curQty: number): { state: IndexState; opened?: number; closed?: number } {
  if (prevQty !== 0 && curQty !== 0 && Math.sign(prevQty) !== Math.sign(curQty)) {
    const closing = stepLeg(state, leg, prevQty, 0)
    const opening = stepLeg(closing.state, leg, 0, curQty)
    return { state: opening.state, closed: closing.closed, opened: opening.opened }
  }
  if (curQty !== 0 && prevQty === 0) {
    return { state: { counter: state.counter + 1, open: { ...state.open, [leg]: state.counter } }, opened: state.counter }
  }
  if (prevQty !== 0 && curQty === 0) {
    const { [leg]: assigned, ...rest } = state.open
    // A leg that was already open when tracking began (e.g. a resumed session) takes the next free number.
    const closed = assigned ?? state.counter
    return { state: { counter: assigned === undefined ? state.counter + 1 : state.counter, open: rest }, closed }
  }
  return { state }
}

/** Number an open leg's entry label is saved under; the next number if the open was never observed. */
export const openIndex = (state: IndexState, leg: Leg): number => state.open[leg] ?? state.counter

export interface TradeLike { side: 'BUY' | 'SELL'; quantity: number; right?: string | null; timestamp?: number }
export interface Seed { state: IndexState; qty: Record<Leg, number> }

/**
 * Rebuilds the numbering from a session's existing trades (page reload or resumed session), so round trips opened and
 * closed before this point keep the numbers the backend gave them and an open leg keeps its own number.
 */
export function seedFromTrades(trades: TradeLike[]): Seed {
  let state = emptyIndexState()
  const qty: Record<Leg, number> = { eq: 0, ce: 0, pe: 0 }
  const ordered = trades.map((trade, order) => ({ trade, order })).sort((a, b) => (a.trade.timestamp ?? 0) - (b.trade.timestamp ?? 0) || a.order - b.order)
  for (const { trade } of ordered) {
    const leg = legOf(trade.right)
    const before = qty[leg]
    qty[leg] = before + (trade.side === 'BUY' ? 1 : -1) * trade.quantity
    state = stepLeg(state, leg, before, qty[leg]).state
  }
  return { state, qty }
}

/** Label tracking restarts when a different session becomes active — not when the same one is paused and resumed. */
export const shouldResetLabelTracking = (trackedSessionId: string | null, sessionId: string | null): boolean =>
  Boolean(sessionId) && trackedSessionId !== sessionId
