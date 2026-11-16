/**
 * No-Trade Day (spec 5.10): following rules you set yourself, not overtrading, not taking revenge, and standing aside in a poor segment.
 *
 * A segment is 15 to 25 minutes of one second bars played faster than real time. Before it starts the player commits to rules; the game never blocks a
 * click, it records a violation and penalises it. Trades are long or short in 1 to 3 lots with a stop of 1 R (a fixed distance from the volUnit); a trade
 * ends at its stop or when the player exits. Everything is computed here from the bars; the View only moves a clock and presses keys.
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import { hashSeed, type Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { NO_TRADE_DAY } from '../../config/difficulty.market'
import { costPoints, type CostSettings } from '../../engine/costModel'
import { swingPoints } from '../../engine/levels'
import { aggregate, barsFromWindow, closeAtOrBefore, coverage, efficiencyRatio, sliceBars, type Bars, type WindowData } from '../../engine/series'
import { costInR, openTrade, type Direction, type OpenTrade } from '../../engine/tradeSim'
import { pickWindow, type Availability } from '../../engine/windows'
import type { MarketData } from '../../data/marketData'
import { volUnit, VOL_WINDOW_SEC } from '../../engine/volUnit'

export type RuleKey = 'maxTrades' | 'maxLossR' | 'stopAfterLosses' | 'cooldownSec' | 'maxLots'
export const RULE_KEYS: readonly RuleKey[] = ['maxTrades', 'maxLossR', 'stopAfterLosses', 'cooldownSec', 'maxLots']
export const RULE_LABEL: Record<RuleKey, string> = {
  maxTrades: 'Maximum trades', maxLossR: 'Stop for the segment at a loss of (R)', stopAfterLosses: 'Stop after consecutive losses', cooldownSec: 'Cooldown after a loss (seconds)', maxLots: 'Maximum lots',
}
/** The rules the player chose, each with its limit; a missing key is a rule not chosen. */
export type Rules = Partial<Record<RuleKey, number>>

/** The limit of a rule kept inside its allowed range (a typed value out of range is pulled in). */
export function clampRule(key: RuleKey, value: number): number {
  const { min, max } = NO_TRADE_DAY.limits[key]
  return Number.isFinite(value) ? clamp(Math.round(value), min, max) : NO_TRADE_DAY.limits[key].default
}
export const ruleCount = (rules: Rules): number => RULE_KEYS.filter(k => rules[k] !== undefined).length

export interface Segment {
  id: string
  symbol: string
  date: string
  startSec: number
  /** Seconds of the segment and the bars of it, one second each, in points from the first price. */
  seconds: number
  bars: Bars
  base: number
  /** 1 R in points, and the cost of a trade of one lot in R. */
  riskPts: number
  costR: number
  volUnit: number
  er: number
}

export interface SegmentSpec { id: string; symbol: string; date: string; startSec: number; segMin: number; stopMult: number }
export interface SegmentContext { lotSizeOf(symbol: string): number | undefined; cost: CostSettings; slipMult: number }

export const SEGMENT_PRE_SEC = VOL_WINDOW_SEC

export function buildSegment(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: SegmentSpec, ctx: SegmentContext): Segment | null {
  const all = barsFromWindow(window)
  const seconds = Math.round(spec.segMin * 60)
  const base = closeAtOrBefore(all, spec.startSec - 1)
  if (base === undefined || !(base > 0)) return null
  const during = sliceBars(all, spec.startSec, spec.startSec + seconds)
  if (coverage(all, spec.startSec, spec.startSec + seconds) < NO_TRADE_DAY.minCoverage || during.t.length < 10) return null
  const vol = volUnit(all, spec.startSec, base)
  const riskPts = spec.stopMult * vol * Math.sqrt(60 / 5)
  const costPts = costPoints(ctx.cost, ctx.lotSizeOf(spec.symbol), ctx.slipMult)
  const shifted: Bars = { t: during.t, o: during.o.map(v => v - base), h: during.h.map(v => v - base), l: during.l.map(v => v - base), c: during.c.map(v => v - base) }
  return { id: spec.id, symbol: spec.symbol, date: spec.date, startSec: spec.startSec, seconds, bars: shifted, base, riskPts, costR: costInR(costPts, NO_TRADE_DAY.deltaProxy, riskPts), volUnit: vol, er: efficiencyRatio(aggregate(during, 5).c) }
}

/**
 * The best net R of at most `maxTrades` non-overlapping trades, in hindsight (spec 5.10 "opportunity"): the legs of a zig-zag of the segment (each leg
 * is one possible trade, they never overlap), each worth its move in R less the cost, the biggest `maxTrades` that are positive, summed; never below 0.
 */
export function opportunity(segment: Segment, maxTrades: number): { r: number; positiveLegs: number } {
  const five = aggregate(segment.bars, 5)
  const swings = swingPoints(five, NO_TRADE_DAY.legThresholdR * segment.riskPts)
  const points = [{ price: segment.bars.o[0] }, ...swings, { price: segment.bars.c[segment.bars.c.length - 1] }]
  const legs = points.slice(1).map((p, i) => Math.abs(p.price - points[i].price) / segment.riskPts - segment.costR).filter(v => v > 0).sort((a, b) => b - a)
  return { r: Math.max(0, legs.slice(0, Math.max(1, maxTrades)).reduce((s, v) => s + v, 0)), positiveLegs: legs.length }
}

export type ViolationKind = 'max_trades' | 'after_losses' | 'cooldown' | 'max_lots'
export const VIOLATION_TEXT: Record<ViolationKind, string> = {
  max_trades: 'more trades than your limit', after_losses: 'a trade after your losing streak limit', cooldown: 'a trade inside your cooldown after a loss', max_lots: 'more lots than your limit',
}

export interface TradeRecord { entrySec: number; exitSec: number; direction: Direction; lots: number; r: number; how: 'stop' | 'exit' | 'end'; violations: ViolationKind[]; revenge: boolean }

export interface SegmentSim {
  readonly seconds: number
  readonly trades: TradeRecord[]
  readonly netR: number
  readonly tradeCount: number
  readonly violations: number
  readonly revenge: number
  readonly ended: 'time' | 'loss_limit' | null
  readonly position: { direction: Direction; lots: number; entrySec: number; openR: number } | null
  /** Seconds since the last loss, or null. */
  sinceLoss(sec: number): number | null
  /** What entering now would break, without entering (for the on-screen warning). */
  preview(lots: number, sec: number): { violations: ViolationKind[]; revenge: boolean }
  /** Move the replay to `sec` (seconds into the segment): bars are fed in order, stops are enforced, the tilt event and the loss limit fire. */
  advance(sec: number): void
  enter(direction: Direction, lots: number, sec: number): { ok: boolean; violations: ViolationKind[]; revenge: boolean }
  exit(sec: number): TradeRecord | null
  /** Close anything open at the end and return every trade; the forced tilt loss is in `forced`. */
  finish(): { trades: TradeRecord[]; forced: number; netR: number; violations: number; revenge: number; tradeCount: number; ended: 'time' | 'loss_limit' }
  readonly forcedLoss: number
}

export function createSegmentSim(segment: Segment, rules: Rules, options: { tilt: boolean }): SegmentSim {
  const trades: TradeRecord[] = []
  let open: { trade: OpenTrade; direction: Direction; lots: number; entrySec: number; violations: ViolationKind[]; revenge: boolean } | null = null
  let cursor = 0
  let lastClose = 0
  let lastSec = 0
  let lastLoss: { sec: number; lots: number } | null = null
  let streak = 0
  let ended: 'time' | 'loss_limit' | null = null
  let forced = 0
  const tiltSec = options.tilt ? Math.round(segment.seconds * NO_TRADE_DAY.tiltAt) : -1
  let tilted = false

  const netR = (): number => trades.reduce((s, t) => s + t.r, 0) + forced
  const noteLoss = (sec: number, lots: number) => { lastLoss = { sec, lots }; streak += 1 }
  const close = (how: TradeRecord['how'], exitSec: number, exitPrice: number): TradeRecord | null => {
    if (!open) return null
    const gross = (open.direction * (exitPrice - open.trade.entryPrice)) / segment.riskPts
    const r = (gross - segment.costR) * open.lots
    const record: TradeRecord = { entrySec: open.entrySec, exitSec, direction: open.direction, lots: open.lots, r, how, violations: open.violations, revenge: open.revenge }
    trades.push(record)
    if (r < 0) noteLoss(exitSec, open.lots); else streak = 0
    open = null
    return record
  }
  const checkLimit = () => {
    if (ended === null && rules.maxLossR !== undefined && netR() <= -rules.maxLossR) {
      if (open) close('end', lastSec, lastClose)
      ended = 'loss_limit'
    }
  }
  const preview = (lots: number, sec: number) => {
    const violations: ViolationKind[] = []
    const count = trades.length + (open ? 1 : 0)
    const since = lastLoss ? sec - lastLoss.sec : null
    const revengeWindow = rules.cooldownSec ?? NO_TRADE_DAY.revengeSec
    const revenge = lastLoss !== null && since !== null && since <= revengeWindow && lots >= lastLoss.lots
    if (rules.maxTrades !== undefined && count + 1 > rules.maxTrades) violations.push('max_trades')
    if (rules.stopAfterLosses !== undefined && streak >= rules.stopAfterLosses) violations.push('after_losses')
    if (rules.maxLots !== undefined && lots > rules.maxLots) violations.push('max_lots')
    // A cooldown entry that is also a revenge trade is counted once, as a revenge trade.
    if (rules.cooldownSec !== undefined && since !== null && since <= rules.cooldownSec && !revenge) violations.push('cooldown')
    return { violations, revenge }
  }

  const sim: SegmentSim = {
    seconds: segment.seconds,
    trades,
    get netR() { return netR() },
    get tradeCount() { return trades.length + (open ? 1 : 0) },
    get violations() { return trades.reduce((s, t) => s + t.violations.length, 0) + (open?.violations.length ?? 0) },
    get revenge() { return trades.filter(t => t.revenge).length + (open?.revenge ? 1 : 0) },
    get ended() { return ended },
    get forcedLoss() { return forced },
    get position() { return open ? { direction: open.direction, lots: open.lots, entrySec: open.entrySec, openR: open.trade.openR * open.lots } : null },
    sinceLoss: sec => (lastLoss ? sec - lastLoss.sec : null),
    preview,
    advance(sec) {
      if (ended) return
      const until = Math.min(sec, segment.seconds)
      while (cursor < segment.bars.t.length && segment.bars.t[cursor] - segment.startSec < until) {
        const rel = segment.bars.t[cursor] - segment.startSec
        lastSec = rel; lastClose = segment.bars.c[cursor]
        if (tiltSec >= 0 && !tilted && rel >= tiltSec) { tilted = true; forced = -1; noteLoss(rel, 1); checkLimit(); if (ended) return }
        if (open) {
          const out = open.trade.step({ t: rel, h: segment.bars.h[cursor], l: segment.bars.l[cursor], c: segment.bars.c[cursor] })
          if (out) { close('stop', rel, out.exitPrice); checkLimit(); if (ended) return }
        }
        cursor += 1
      }
      if (sec >= segment.seconds && !ended) { if (open) close('end', lastSec, lastClose); ended = 'time' }
    },
    enter(direction, lots, sec) {
      if (ended || open) return { ok: false, violations: [], revenge: false }
      const l = clamp(Math.round(lots), 1, NO_TRADE_DAY.lotsMax)
      const { violations, revenge } = preview(l, sec)
      const price = lastClose
      open = { trade: openTrade({ direction, entryPrice: price, stop: segment.riskPts, target: null }), direction, lots: l, entrySec: sec, violations, revenge }
      return { ok: true, violations, revenge }
    },
    exit(sec) {
      if (!open) return null
      const record = close('exit', sec, lastClose)
      checkLimit()
      return record
    },
    finish() {
      if (open) close('end', lastSec, lastClose)
      return { trades: trades.slice(), forced, netR: netR(), violations: sim.violations, revenge: sim.revenge, tradeCount: trades.length, ended: ended ?? 'time' }
    },
  }
  return sim
}

export interface SegmentResult {
  netR: number
  tradeCount: number
  violations: number
  revenge: number
  opportunity: number
  positiveLegs: number
  perf: number
  discipline: number
  roundScore: number
  standAside: boolean
  quiet: boolean
  entries: number
  cleanEntries: number
  ended: 'time' | 'loss_limit'
  rules: number
}

/**
 * `perf = clamp(R_user / max(opportunity, 0.5), -1, 1)`; `discipline = 1 - min(1, 0.25 x violations + 0.25 x revenge)`; in a quiet segment (opportunity below
 * 0.5) with at most one trade `perf` is at least 0.6; `roundScore = 0.5 x (perf + 1) / 2 + 0.5 x discipline`.
 */
export function scoreSegment(segment: Segment, rules: Rules, sim: ReturnType<SegmentSim['finish']>): SegmentResult {
  const opp = opportunity(segment, rules.maxTrades ?? NO_TRADE_DAY.defaultOpportunityTrades)
  let perf = clamp(sim.netR / Math.max(opp.r, NO_TRADE_DAY.quietBelowR), -1, 1)
  const quiet = opp.r < NO_TRADE_DAY.quietBelowR
  const standAside = quiet && sim.tradeCount <= 1
  if (standAside) perf = Math.max(perf, NO_TRADE_DAY.standAsidePerf)
  const discipline = 1 - Math.min(1, NO_TRADE_DAY.violationPenalty * sim.violations + NO_TRADE_DAY.revengePenalty * sim.revenge)
  const entries = sim.trades.length
  return {
    netR: sim.netR, tradeCount: sim.tradeCount, violations: sim.violations, revenge: sim.revenge, opportunity: opp.r, positiveLegs: opp.positiveLegs, perf, discipline,
    roundScore: 0.5 * ((perf + 1) / 2) + 0.5 * discipline, standAside, quiet, entries, cleanEntries: sim.trades.filter(t => t.violations.length === 0 && !t.revenge).length, ended: sim.ended, rules: ruleCount(rules),
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100
const share = (count: number, of: number): number => (of ? round2((count / of) * 100) : 0)

/** `SessionScore = 100 x mean(roundScore)`. Stats: rule adherence, revenge trades, overtrade ratio, net R and stand-aside accuracy. */
export function summariseNoTrade(results: SegmentResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((s, r) => s + r.roundScore, 0) / n : 0
  const entries = results.reduce((s, r) => s + r.entries, 0)
  const quiet = results.filter(r => r.quiet)
  return {
    score: toSessionScore(100 * mean),
    stats: {
      segments: n,
      rule_adherence: entries ? share(results.reduce((s, r) => s + r.cleanEntries, 0), entries) : 100,
      revenge_trades: results.reduce((s, r) => s + r.revenge, 0),
      overtrade_ratio: round2(results.reduce((s, r) => s + r.tradeCount, 0) / Math.max(1, results.reduce((s, r) => s + Math.max(1, r.positiveLegs), 0))),
      mean_net_r: n ? round2(results.reduce((s, r) => s + r.netR, 0) / n) : 0,
      violations: results.reduce((s, r) => s + r.violations, 0),
      stand_aside_accuracy: quiet.length ? share(quiet.filter(r => r.standAside).length, quiet.length) : 0,
      loss_limit_hits: results.filter(r => r.ended === 'loss_limit').length,
    },
  }
}

/** The 1 second windows a segment needs: the minutes of volUnit history before it and the segment itself, in requests of at most 900 seconds (the route's limit). */
export function segmentFetches(segMin: number): Array<{ offset: number; seconds: number }> {
  const total = SEGMENT_PRE_SEC + Math.round(segMin * 60)
  const out: Array<{ offset: number; seconds: number }> = []
  for (let offset = 0; offset < total; offset += 900) out.push({ offset, seconds: Math.min(900, total - offset) })
  return out
}

export interface SegmentParams { segMin: number; stopMult: number; targetEr: number; slipMult: number }
export type NextSegment = { ok: true; segment: Segment } | { ok: false; reason: 'no_data' | 'cancelled' }

/**
 * Hands out segments: picks a window, fetches it in as many requests as it needs, builds the segment, and keeps the one of up to two candidates whose
 * choppiness (the efficiency ratio of its 5 second closes) is closest to what the level wants (more chop means more bait).
 */
export function createSegmentSource(deps: {
  rng: Rng
  availability: Availability
  data: Pick<MarketData, 'window'>
  seen: ReadonlySet<string>
  ctx: SegmentContext
  onUsed?: (id: string) => void
  maxCandidates?: number
  maxFailures?: number
}): { next(params: SegmentParams, signal?: AbortSignal): Promise<NextSegment> } {
  const used = new Set<string>()
  const maxCandidates = deps.maxCandidates ?? 2
  const maxFailures = deps.maxFailures ?? 3
  return {
    async next(params, signal) {
      const rules = { preSec: SEGMENT_PRE_SEC, postSec: Math.round(params.segMin * 60) }
      let best: { segment: Segment; misfit: number } | null = null
      let failures = 0, tried = 0
      while (tried < maxCandidates && failures < maxFailures) {
        if (signal?.aborted) return { ok: false, reason: 'cancelled' }
        const pick = pickWindow(deps.rng, deps.availability, rules, deps.seen, used)
        if (!pick) { failures += 1; break }
        used.add(pick.id)
        try {
          const start = pick.decisionSec - SEGMENT_PRE_SEC
          const parts: WindowData[] = []
          for (const chunk of segmentFetches(params.segMin)) parts.push(await deps.data.window({ symbol: pick.symbol, date: pick.date, startSec: start + chunk.offset, durationSec: chunk.seconds }, signal))
          const merged = { t: parts.flatMap(p => Array.from(p.t)), o: parts.flatMap(p => Array.from(p.o)), h: parts.flatMap(p => Array.from(p.h)), l: parts.flatMap(p => Array.from(p.l)), c: parts.flatMap(p => Array.from(p.c)) }
          const segment = buildSegment(merged, { id: pick.id, symbol: pick.symbol, date: pick.date, startSec: pick.decisionSec, segMin: params.segMin, stopMult: params.stopMult }, { ...deps.ctx, slipMult: params.slipMult })
          if (!segment) { failures += 1; continue }
          tried += 1; failures = 0
          const misfit = Math.abs(segment.er - params.targetEr)
          if (!best || misfit < best.misfit) best = { segment, misfit }
          if (misfit < 0.05) break
        } catch (error) {
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return { ok: false, reason: 'cancelled' }
          failures += 1
        }
      }
      if (!best) return { ok: false, reason: 'no_data' }
      deps.onUsed?.(best.segment.id)
      return { ok: true, segment: best.segment }
    },
  }
}

/** A stable shuffle seed of a segment id (used by tests and for the tilt jitter if any). */
export const segmentSeed = (id: string): number => hashSeed(`no_trade|${id}`)
export type { Rng }
