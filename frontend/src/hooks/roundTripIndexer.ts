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

/** Applies one leg's net-quantity change. `closed` is the round-trip number of a leg that just went flat. */
export function stepLeg(state: IndexState, leg: Leg, prevQty: number, curQty: number): { state: IndexState; opened?: number; closed?: number } {
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
