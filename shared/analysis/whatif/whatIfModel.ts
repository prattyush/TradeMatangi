import type { PerformanceCycle } from '../performance'
import { tripKey, type LabeledRoundTrip } from '../labeling/model'
import { computeCommission, inferDayBrokerage, type TradeSide } from './fees'
import type { WhatIfEdit, WhatIfSummary } from './scenarios'

/** One fill of a round trip: the unit What If edits (price and quantity). */
export interface WhatIfFill {
  /** The execution (or trade) id; with the role it identifies the fill inside its round trip. */
  id: string
  role: 'entry' | 'exit'
  side: TradeSide
  time: number
  quantity: number
  price: number
  commission: number
}

export interface WhatIfTrip {
  key: string
  sessionId: string
  cycleId: string
  /** The round trip number (its label index): what a saved scenario calls it. */
  roundTrip: number
  contract: string
  /** The option side and strike (null for equity), so a marker lands on the right chart. */
  right: string | null
  strike: number | null
  direction: 'LONG' | 'SHORT'
  capital: number | null
  /** Capital used per unit of value: 0.2 for equity intraday, 1 otherwise. */
  marginRate: number
  /** What the server says the trade made, net of charges. */
  netPnl: number
  sessionType: string
  fills: WhatIfFill[]
}

export const legKey = (fill: Pick<WhatIfFill, 'role' | 'id'>) => `${fill.role}:${fill.id}`

/** A changed price and quantity for one fill. A quantity of 0 removes the fill. */
export interface LegEdit { price: number; quantity: number }
/** The edits of one round trip, by `legKey`. */
export type TripEdits = Map<string, LegEdit>
/** The edits of the whole day, by round trip key. */
export type DayEdits = Map<string, TripEdits>

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * The round trips that can be edited: each completed one that the server also sent a cycle for (the cycle holds the fills).
 * `sessionTypes` maps session id to its type (real sessions' charges are scaled, not recomputed).
 */
export function buildWhatIfTrips(trips: LabeledRoundTrip[], cycles: PerformanceCycle[], sessionTypes: Map<string, string>): WhatIfTrip[] {
  const byCycle = new Map(cycles.map(cycle => [`${cycle.session_id}#${cycle.cycle_id}`, cycle]))
  const out: WhatIfTrip[] = []
  for (const trip of trips) {
    const cycle = trip.cycle_id ? byCycle.get(`${trip.session_id}#${trip.cycle_id}`) : undefined
    if (!cycle || cycle.state !== 'closed') continue
    const direction = cycle.direction?.toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG'
    const fills: WhatIfFill[] = (cycle.executions ?? []).map(row => ({
      id: String(row.execution_id ?? row.trade_id),
      role: row.role === 'exit' ? 'exit' as const : 'entry' as const,
      side: (row.side === 'SELL' ? 'SELL' : 'BUY') as TradeSide,
      time: row.timestamp,
      quantity: row.quantity,
      price: row.price,
      commission: row.commission ?? 0,
    }))
    out.push({
      key: tripKey(trip), sessionId: trip.session_id, cycleId: cycle.cycle_id, roundTrip: trip.index,
      contract: cycle.right ? [cycle.right, cycle.strike].filter(value => value != null).join(' ') : 'EQ',
      right: cycle.right ?? null, strike: num(cycle.strike), direction, capital: num(cycle.capital) && Number(cycle.capital) > 0 ? Number(cycle.capital) : null,
      marginRate: num(cycle.entries?.[0]?.analytics?.margin_rate) || 1,
      netPnl: cycle.net_pnl, sessionType: sessionTypes.get(trip.session_id) ?? 'sim', fills,
    })
  }
  return out
}

/** The brokerage per order the day's own fills imply (paper, replay and stepwise charges follow the formula exactly). */
export function dayBrokerage(trips: WhatIfTrip[]): number {
  return inferDayBrokerage(trips.flatMap(trip => trip.sessionType === 'real' ? [] : trip.fills))
}

export interface LegResult {
  fill: WhatIfFill
  price: number
  quantity: number
  removed: boolean
  changed: boolean
  fee: number
  /** The capital this fill uses (quantity x price x margin) as % of the session capital; null without the capital. */
  capitalPct: number | null
  /** The same for the real fill, so the change can be shown. */
  originalCapitalPct: number | null
}

export interface TripResult {
  trip: WhatIfTrip
  legs: LegResult[]
  edited: boolean
  actualPnl: number
  pnl: number
  delta: number
  actualPnlPct: number | null
  pnlPct: number | null
  actualPeakCapitalPct: number | null
  peakCapitalPct: number | null
  entryQuantity: number
  exitQuantity: number
  warnings: string[]
}

const proceeds = (legs: Array<{ side: TradeSide; price: number; quantity: number; fee: number }>) =>
  legs.reduce((sum, leg) => sum + (leg.side === 'SELL' ? 1 : -1) * leg.price * leg.quantity - leg.fee, 0)

/** The most capital the trade had in use at once: open lots at cost (first in, first out), after each entry. */
function peakExposure(legs: Array<{ role: 'entry' | 'exit'; time: number; price: number; quantity: number }>, marginRate: number): number {
  const lots: Array<{ quantity: number; price: number }> = []
  let peak = 0
  const ordered = legs.map((leg, order) => ({ leg, order })).sort((a, b) => a.leg.time - b.leg.time || a.order - b.order)
  for (const { leg } of ordered) {
    if (leg.quantity <= 0) continue
    if (leg.role === 'entry') {
      lots.push({ quantity: leg.quantity, price: leg.price })
      peak = Math.max(peak, lots.reduce((sum, lot) => sum + lot.quantity * lot.price * marginRate, 0))
    } else {
      let remaining = leg.quantity
      while (remaining > 0 && lots.length) {
        const lot = lots[0]
        const used = Math.min(remaining, lot.quantity)
        lot.quantity -= used
        remaining -= used
        if (lot.quantity === 0) lots.shift()
      }
    }
  }
  return peak
}

/** The trade with its edits applied: P&L (cash flow net of charges), capital, and warnings. Unedited, it equals the server's figure. */
export function evaluateTrip(trip: WhatIfTrip, edits: TripEdits | undefined, brokerage: number): TripResult {
  const real = trip.sessionType === 'real'
  const percent = (value: number) => (trip.capital ? (100 * value) / trip.capital : null)
  const legs: LegResult[] = trip.fills.map(fill => {
    const edit = edits?.get(legKey(fill))
    const price = edit && Number.isFinite(edit.price) && edit.price > 0 ? edit.price : fill.price
    const quantity = edit && Number.isFinite(edit.quantity) ? Math.max(0, Math.round(edit.quantity)) : fill.quantity
    const changed = price !== fill.price || quantity !== fill.quantity
    let fee = fill.commission
    if (quantity === 0) fee = 0
    else if (changed) {
      // A real session's charges came from the broker: keep their shape and scale them by the traded value.
      fee = real ? (fill.price * fill.quantity > 0 ? fill.commission * (price * quantity) / (fill.price * fill.quantity) : fill.commission)
        : computeCommission(fill.side, price, quantity, brokerage)
    }
    return {
      fill, price, quantity, removed: quantity === 0, changed, fee,
      capitalPct: percent(quantity * price * trip.marginRate), originalCapitalPct: percent(fill.quantity * fill.price * trip.marginRate),
    }
  })
  const original = proceeds(trip.fills.map(fill => ({ side: fill.side, price: fill.price, quantity: fill.quantity, fee: fill.commission })))
  const edited = proceeds(legs.map(leg => ({ side: leg.fill.side, price: leg.price, quantity: leg.quantity, fee: leg.fee })))
  const pnl = trip.netPnl + (edited - original)
  const entryQuantity = legs.filter(leg => leg.fill.role === 'entry').reduce((sum, leg) => sum + leg.quantity, 0)
  const exitQuantity = legs.filter(leg => leg.fill.role === 'exit').reduce((sum, leg) => sum + leg.quantity, 0)
  const warnings: string[] = []
  if (legs.every(leg => leg.removed)) warnings.push('Every entry and exit of this trade is removed.')
  else if (entryQuantity !== exitQuantity) warnings.push(`Entries add up to ${entryQuantity} but exits to ${exitQuantity}: the P&L is uneven because part of the trade is left unmatched.`)
  const anyChange = legs.some(leg => leg.changed)
  return {
    trip, legs, edited: anyChange,
    actualPnl: trip.netPnl, pnl: anyChange ? pnl : trip.netPnl, delta: anyChange ? pnl - trip.netPnl : 0,
    actualPnlPct: percent(trip.netPnl), pnlPct: percent(anyChange ? pnl : trip.netPnl),
    actualPeakCapitalPct: percent(peakExposure(trip.fills, trip.marginRate)),
    peakCapitalPct: percent(peakExposure(legs.map(leg => ({ role: leg.fill.role, time: leg.fill.time, price: leg.price, quantity: leg.quantity })), trip.marginRate)),
    entryQuantity, exitQuantity, warnings,
  }
}

export interface DayResult {
  actual: number
  whatif: number
  delta: number
  /** The session capital (the average over the day's sessions); null when any is unknown. */
  capital: number | null
  actualPct: number | null
  whatifPct: number | null
  deltaPct: number | null
  tripsEdited: number
  /** Trades that carry a warning. */
  warnings: number
}

/** Every editable trade of the day with its edits applied, and the day's total: actual against what-if. */
export function evaluateDay(trips: WhatIfTrip[], edits: DayEdits, capitals: Map<string, number>, brokerage: number): { results: Map<string, TripResult>; day: DayResult } {
  const results = new Map<string, TripResult>()
  for (const trip of trips) results.set(trip.key, evaluateTrip(trip, edits.get(trip.key), brokerage))
  const list = [...results.values()]
  const actual = list.reduce((sum, result) => sum + result.actualPnl, 0)
  const whatif = list.reduce((sum, result) => sum + result.pnl, 0)
  const sessions = [...new Set(trips.map(trip => trip.sessionId))]
  const amounts = sessions.map(id => capitals.get(id))
  const capital = amounts.length && amounts.every(value => value != null && Number.isFinite(value) && value > 0)
    ? amounts.reduce<number>((sum, value) => sum + value!, 0) / amounts.length : null
  const pct = (value: number) => (capital ? (100 * value) / capital : null)
  return {
    results,
    day: {
      actual: round2(actual), whatif: round2(whatif), delta: round2(whatif - actual), capital,
      actualPct: pct(actual), whatifPct: pct(whatif), deltaPct: pct(whatif - actual),
      tripsEdited: list.filter(result => result.edited).length, warnings: list.filter(result => result.warnings.length > 0).length,
    },
  }
}

export const summaryOf = (day: DayResult): WhatIfSummary => ({
  actual_pnl: day.actual, whatif_pnl: day.whatif, delta: day.delta,
  delta_pct: day.deltaPct === null ? null : Math.round(day.deltaPct * 10_000) / 10_000,
  trips_edited: day.tripsEdited, warnings: day.warnings,
})

/** The edits worth saving: only fills whose price or quantity differs from the real one. */
export function toSavedEdits(trips: WhatIfTrip[], edits: DayEdits, sessionId: string): WhatIfEdit[] {
  const saved: WhatIfEdit[] = []
  for (const trip of trips) {
    if (trip.sessionId !== sessionId) continue
    for (const fill of trip.fills) {
      const edit = edits.get(trip.key)?.get(legKey(fill))
      if (edit && Number.isFinite(edit.price) && edit.price > 0 && (edit.price !== fill.price || edit.quantity !== fill.quantity)) {
        saved.push({ round_trip: trip.roundTrip, leg_id: fill.id, role: fill.role, price: edit.price, quantity: Math.max(0, Math.round(edit.quantity)) })
      }
    }
  }
  return saved
}

/** Saved edits turned back into the day's edits; `missing` counts those whose fill is not in the day any more. */
export function fromSavedEdits(trips: WhatIfTrip[], saved: WhatIfEdit[], sessionId: string): { edits: DayEdits; missing: number } {
  const edits: DayEdits = new Map()
  let missing = 0
  for (const edit of saved) {
    const trip = trips.find(candidate => candidate.sessionId === sessionId && candidate.roundTrip === edit.round_trip && candidate.fills.some(fill => fill.id === edit.leg_id && fill.role === edit.role))
    if (!trip) { missing++; continue }
    const tripEdits = edits.get(trip.key) ?? new Map<string, LegEdit>()
    tripEdits.set(`${edit.role}:${edit.leg_id}`, { price: edit.price, quantity: edit.quantity })
    edits.set(trip.key, tripEdits)
  }
  return { edits, missing }
}

/** A what-if leg drawn on a chart beside the real markers: where the edited fill would have been. */
export interface WhatIfMarker {
  key: string
  time: number
  price: number
  side: TradeSide
  /** "B75" / "S40", or "✕" for a removed leg (drawn where the real fill was). */
  text: string
  removed: boolean
  right: string | null
  strike: number | null
}

/** The changed legs of one trade as chart markers. Unchanged legs are the real markers already on the chart. */
export function whatIfMarkers(result: TripResult): WhatIfMarker[] {
  return result.legs.filter(leg => leg.changed).map(leg => ({
    key: `${result.trip.key}:${legKey(leg.fill)}`,
    time: leg.fill.time, price: leg.removed ? leg.fill.price : leg.price, side: leg.fill.side,
    text: leg.removed ? '✕' : `${leg.fill.side === 'BUY' ? 'B' : 'S'}${leg.quantity}`,
    removed: leg.removed, right: result.trip.right, strike: result.trip.strike,
  }))
}
