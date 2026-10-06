import { recordPerformance } from './performanceDiagnostics.ts'
import type { Trade, TickEvent } from './api'

/** Fills since the most recent flat position, independently for each contract. */
export function openPositionTrades(trades: Trade[]): Trade[] {
  const cycles = new Map<string, { quantity: number; trades: Trade[] }>()
  const contractKey = (trade: Trade) => JSON.stringify([trade.session_id, trade.symbol, trade.right ?? '', trade.strike ?? ''])
  const knownExpiries = new Map<string, Set<string>>()
  for (const trade of trades) {
    if (!trade.expiry) continue
    const key = contractKey(trade)
    const expiries = knownExpiries.get(key) ?? new Set<string>()
    expiries.add(trade.expiry)
    knownExpiries.set(key, expiries)
  }
  for (const trade of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
    const contract = contractKey(trade)
    const known = knownExpiries.get(contract)
    // Legacy fills omit expiry. Infer only when this contract has one known expiry.
    const expiry = trade.expiry ?? (known?.size === 1 ? [...known][0] : '')
    const key = JSON.stringify([contract, expiry])
    const cycle = cycles.get(key) ?? { quantity: 0, trades: [] }
    const next = cycle.quantity + (trade.side === 'BUY' ? trade.quantity : -trade.quantity)
    if (next === 0) cycle.trades = []
    else if (cycle.quantity !== 0 && Math.sign(next) !== Math.sign(cycle.quantity)) cycle.trades = [trade]
    else cycle.trades.push(trade)
    cycle.quantity = next
    cycles.set(key, cycle)
  }
  const visible = new Set([...cycles.values()].flatMap(cycle => cycle.trades))
  return trades.filter(trade => visible.has(trade))
}

/** Incremental time-ordered cache. Reject stale ticks before they change chart state. */
export class RecentLiveTicks {
  private ticks = new Map<number, TickEvent>()
  private latestTime = -Infinity
  clear(): void { this.ticks.clear(); this.latestTime = -Infinity }
  append(tick: TickEvent): boolean {
    if (tick.time < this.latestTime) return false
    this.latestTime = tick.time
    this.ticks.set(tick.time, tick)
    const cutoff = tick.time - 15 * 60
    for (const time of this.ticks.keys()) {
      if (time >= cutoff) break
      this.ticks.delete(time)
    }
    return true
  }
  values(): TickEvent[] { return [...this.ticks.values()] }
}

/** Coalesce auxiliary loads and fence results after context/selection changes. */
export class IndicatorHistoryRequests {
  private context = ''
  private wanted = new Set<string>()
  private pending = new Map<string, object>()
  private retryAt = new Map<string, number>()
  clear(): void { this.pending.clear(); this.retryAt.clear() }
  configure(context: string, wanted: Set<string>): void {
    if (context !== this.context) this.clear()
    this.context = context
    this.wanted = wanted
    for (const key of this.pending.keys()) if (!wanted.has(key)) this.pending.delete(key)
    for (const key of this.retryAt.keys()) if (!wanted.has(key)) this.retryAt.delete(key)
  }
  begin(key: string, now = Date.now()): { current: () => boolean; finish: (now?: number) => void } | null {
    if (!this.wanted.has(key) || this.pending.has(key) || now < (this.retryAt.get(key) ?? 0)) return null
    const token = {}, context = this.context
    this.pending.set(key, token)
    const current = () => this.context === context && this.wanted.has(key) && this.pending.get(key) === token
    return { current, finish: (completedAt = Date.now()) => {
      if (!current()) return
      this.pending.delete(key)
      this.retryAt.set(key, completedAt + 5000)
    } }
  }
}

/** Retain chart objects until their identity or displayed inputs change. */
export function reconcileChartObjects<T, Input>(
  objects: Map<string, { object: T; signature: string }>,
  inputs: { id: string; signature: string; input: Input }[],
  create: (input: Input) => T,
  update: (object: T, input: Input) => void,
  remove: (object: T) => void,
): void {
  const wanted = new Set(inputs.map(item => item.id))
  for (const [id, entry] of objects) {
    if (!wanted.has(id)) { remove(entry.object); objects.delete(id); recordPerformance('chart-object-remove') }
  }
  for (const { id, signature, input } of inputs) {
    const entry = objects.get(id)
    if (!entry) { objects.set(id, { object: create(input), signature }); recordPerformance('chart-object-create') }
    else if (entry.signature !== signature) {
      update(entry.object, input)
      entry.signature = signature
      recordPerformance('chart-object-update')
    }
  }
}
