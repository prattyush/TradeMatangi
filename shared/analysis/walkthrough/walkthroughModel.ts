import type { PerformanceCycle } from '../performance'
import { sessionJourney, type JourneyCurve } from '../dayJourney'
import { contractName, tripKey, type LabeledRoundTrip } from '../labeling/model'
import { entryMethodInfo, exitMethodInfo, type MethodInfo } from './exitMethods'

/** One entry or exit of a round trip, as the Walkthrough shows it. `null` means the server did not send the figure. */
export interface WalkthroughLeg {
  role: 'entry' | 'exit'
  side: 'BUY' | 'SELL'
  time: number
  quantity: number
  price: number
  /** Capital this fill uses (qty x price x margin rate) as % of the session capital. */
  capitalPct: number | null
  /** Initial risk as % of the session capital (entries with a valid stop only). */
  riskPct: number | null
  /** How the order was placed (entries) or how the exit happened (exits). */
  method: MethodInfo
  /** The rest, for a "More info" view: label and text. */
  details: Array<[string, string]>
}

/** The day's realised P&L (net of charges) at a moment: money and % of the session capital. */
export interface DayPnl { pnl: number; pnlPct: number | null }

export interface WalkthroughTrip {
  key: string
  cycleId: string | null
  contract: string
  direction: 'LONG' | 'SHORT' | null
  state: string
  entries: WalkthroughLeg[]
  exits: WalkthroughLeg[]
  /** Most capital in use at once, % of session capital. */
  peakCapitalPct: number | null
  pnl: number
  pnlPct: number | null
  fees: number | null
  feeSource: string | null
  holdingSeconds: number | null
  /** The day's realised P&L just before this trade closed, and just after. */
  before: DayPnl | null
  after: DayPnl | null
  /** True when other trades closed in the same second, so the order within that second is not known. */
  sameSecond: boolean
  /** False when the server sent no cycle for this round trip (older server): only times, sizes and prices are known. */
  detailed: boolean
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const fixed = (value: number | null, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits)
const sideOf = (side: string | undefined): 'BUY' | 'SELL' => ((side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY')

function capitalPct(quantity: number, price: number, marginRate: number | null, capital: number | null): number | null {
  if (!capital || capital <= 0 || !(quantity > 0) || !(price > 0)) return null
  return (100 * quantity * price * (marginRate ?? 1)) / capital
}

/** A cycle's legs. Entries come with their sizing analytics, exits with the confirmed controller. */
function cycleLegs(cycle: PerformanceCycle): { entries: WalkthroughLeg[]; exits: WalkthroughLeg[] } {
  const direction = cycle.direction?.toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG'
  const entrySide = direction === 'LONG' ? 'BUY' : 'SELL'
  const exitSide = direction === 'LONG' ? 'SELL' : 'BUY'
  const capital = num(cycle.capital)
  const margin = num(cycle.entries?.[0]?.analytics?.margin_rate)
  const entries = (cycle.entries ?? []).map((entry): WalkthroughLeg => {
    const a = entry.analytics ?? {}
    const allocation = num(a.effective_allocation_pct)
    const details: Array<[string, string]> = []
    if (entry.sizing_method && entry.sizing_method !== 'UNKNOWN') details.push(['Sizing', entry.requested_pct != null ? `${entry.sizing_method.replace(/_/g, ' ').toLowerCase()} ${entry.requested_pct}%` : entry.sizing_method.replace(/_/g, ' ').toLowerCase()])
    if (num(a.initial_stop) !== null) details.push(['Initial stop', String(a.initial_stop)])
    if (num(a.requested_budget) !== null) details.push(['Budget', `₹${Number(a.requested_budget).toLocaleString('en-IN')}`])
    if (a.budget_exceeded) details.push(['Budget', 'exceeded'])
    if (entry.r_multiple != null) details.push(['R multiple', `${fixed(entry.r_multiple)}`])
    if (entry.client) details.push(['Placed from', entry.client])
    return {
      role: 'entry', side: entrySide, time: entry.timestamp, quantity: entry.quantity, price: entry.average_price,
      capitalPct: fixed(allocation ?? capitalPct(entry.quantity, entry.average_price, margin, capital)),
      riskPct: fixed(num(a.effective_risk_pct)),
      method: entryMethodInfo(entry.entry_method, entrySide),
      details,
    }
  })
  const exits = (cycle.exits ?? []).map((exit): WalkthroughLeg => {
    const details: Array<[string, string]> = []
    if (exit.analytics?.requested_size) details.push(['Requested', String(exit.analytics.requested_size)])
    return {
      role: 'exit', side: exitSide, time: exit.timestamp, quantity: exit.quantity, price: exit.price,
      capitalPct: fixed(capitalPct(exit.quantity, exit.price, margin, capital)), riskPct: null,
      method: exitMethodInfo(exit.exit_method, exitSide), details,
    }
  })
  return { entries, exits }
}

/** Fallback when the server sent no cycle: the legs of the round trip, without methods or capital figures. */
function tripLegs(trip: LabeledRoundTrip): { entries: WalkthroughLeg[]; exits: WalkthroughLeg[] } {
  const unknown = exitMethodInfo(null)
  const map = (role: 'entry' | 'exit') => (leg: LabeledRoundTrip['entry_trades'][number]): WalkthroughLeg => ({
    role, side: sideOf(leg.side), time: leg.timestamp, quantity: leg.quantity, price: leg.price, capitalPct: null, riskPct: null, method: unknown, details: [],
  })
  return { entries: trip.entry_trades.map(map('entry')), exits: trip.exit_trades.map(map('exit')) }
}

/**
 * Everything the Walkthrough shows, per round trip (keyed by `tripKey`). `cycles` are the day's cycles (`SessionDetail.cycles` of
 * every session in the group) and give the entry and exit details; `capitals` maps session id to session capital. The day P&L
 * before and after each trade comes from the day journey (realised P&L by exit time, net of charges).
 */
export function buildWalkthrough(trips: LabeledRoundTrip[], cycles: PerformanceCycle[], capitals: Map<string, number>): Map<string, WalkthroughTrip> {
  const journey: JourneyCurve = sessionJourney(cycles, capitals)
  const capital = journey.capital
  const story = new Map<string, { before: DayPnl; after: DayPnl; sameSecond: boolean }>()
  let balance = 0
  const at = (value: number): DayPnl => ({ pnl: fixed(value) as number, pnlPct: capital ? fixed((100 * value) / capital) : null })
  for (const point of journey.points) {
    // Members of a same-second batch are walked in the journey's own order: the exact order inside one second is not known.
    for (const member of point.members) {
      const before = balance
      balance += member.delta
      story.set(`${member.session_id}#${member.cycle_id}`, { before: at(before), after: at(balance), sameSecond: point.grouped })
    }
  }
  const byCycle = new Map(cycles.map(cycle => [`${cycle.session_id}#${cycle.cycle_id}`, cycle]))
  const result = new Map<string, WalkthroughTrip>()
  for (const trip of trips) {
    const cycle = trip.cycle_id ? byCycle.get(`${trip.session_id}#${trip.cycle_id}`) : undefined
    const legs = cycle ? cycleLegs(cycle) : tripLegs(trip)
    const known = cycle ? story.get(`${cycle.session_id}#${cycle.cycle_id}`) : undefined
    const direction = cycle ? (cycle.direction?.toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') : (trip.entry_trades[0] ? (sideOf(trip.entry_trades[0].side) === 'SELL' ? 'SHORT' : 'LONG') : null)
    const entryTime = legs.entries[0]?.time ?? null
    const exitTime = legs.exits.length ? legs.exits[legs.exits.length - 1].time : null
    result.set(tripKey(trip), {
      key: tripKey(trip),
      cycleId: trip.cycle_id ?? null,
      // The cycle knows the strike; a round trip's legs may not.
      contract: cycle ? (cycle.right ? [cycle.right, cycle.strike].filter(value => value != null).join(' ') : 'EQ') : contractName(trip),
      direction,
      state: cycle?.state ?? trip.state ?? 'closed',
      entries: legs.entries,
      exits: legs.exits,
      peakCapitalPct: fixed(num(cycle?.peak_capital_pct) ?? num(trip.max_capital_pct)),
      pnl: trip.pnl,
      pnlPct: fixed(num(cycle?.pnl_pct) ?? num(trip.pnl_pct)),
      fees: cycle ? fixed(num(cycle.fees)) : null,
      feeSource: cycle?.fee_source ?? null,
      holdingSeconds: num(cycle?.holding_seconds) ?? (entryTime !== null && exitTime !== null ? exitTime - entryTime : null),
      before: known?.before ?? null,
      after: known?.after ?? null,
      sameSecond: known?.sameSecond ?? false,
      detailed: Boolean(cycle),
    })
  }
  return result
}

/** "10:05" / "15:10": a fill's clock time (the server stores India wall-clock time as UTC seconds). */
export function clock24(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

/** "1h 05m", "12m 30s", "40s": how long a trade was held. */
export function holdingText(seconds: number | null): string {
  if (seconds === null || !(seconds >= 0)) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`
  return `${r}s`
}

/** "+₹1,240.50" / "−₹300.00": signed money; "—" when unknown. */
export function signedMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const text = Math.abs(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${value < 0 ? '−' : '+'}₹${text}`
}

/** "+0.25%" / "−0.06%": signed percent; "—" when unknown. */
export function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}%`
}
