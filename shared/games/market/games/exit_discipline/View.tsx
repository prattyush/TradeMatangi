import { useEffect, useMemo, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import type { Candle, ChartData, Level, Marker } from '../../../chart/chartModel'
import { EXIT_DISCIPLINE } from '../../config/difficulty.market'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { createRoundSource } from '../../engine/roundSource'
import { aggregate, sliceBars, type Bars } from '../../engine/series'
import { openTrade, type OpenTrade, type TradeOutcome } from '../../engine/tradeSim'
import { createFrameClock } from '../../ui/frameClock'
import { clock } from '../tick_reader/format'
import { exitPlan, scoreExit, suggestedPlan, summariseExit, validatePlan, type ExitResult, type ExitRound, type Plan } from './engine'

type Phase = 'loading' | 'plan' | 'run' | 'result'
const BAR_SEC = 5

const candles = (bars: Bars): Candle[] => bars.t.map((t, i) => ({ t, o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] }))

export interface RunState { shown: number; stopPrice: number | null; targetPrice: number | null; outcome: TradeOutcome | null; startedAt: number | null }

/** The chart for one moment: the minute before the entry, the path up to `shown` seconds, the live stop and target, and the exit. */
export function exitChart(round: ExitRound, phase: Phase, run: RunState): ChartData {
  const rel = (bars: Bars): Bars => ({ ...bars, t: bars.t.map(t => t - round.startSec) })
  const shown = phase === 'plan' || phase === 'loading' ? 0 : phase === 'result' ? round.horizonSec : run.shown
  const path = rel(sliceBars(round.path, round.startSec, round.startSec + Math.max(0, shown)))
  const context = rel(round.context)
  const bars: Bars = { t: [...context.t, ...path.t], o: [...context.o, ...path.o], h: [...context.h, ...path.h], l: [...context.l, ...path.l], c: [...context.c, ...path.c] }
  const data: ChartData = { candles: candles(aggregate(bars, BAR_SEC)), line: bars.t.map((t, i) => ({ t, v: bars.c[i] })), xRange: [-60, round.horizonSec] }
  const levels: Level[] = [{ y: 0, label: 'entry', colour: '#8b949e' }]
  if (run.stopPrice !== null) levels.push({ y: run.stopPrice, label: 'stop', colour: '#D55E00' })
  if (run.targetPrice !== null) levels.push({ y: run.targetPrice, label: 'target', colour: '#009E73' })
  data.levels = levels
  const markers: Marker[] = [{ t: 0, y: 0, kind: round.direction === 1 ? 'long' : 'short', label: 'IN' }]
  if (run.outcome) markers.push({ t: run.outcome.exitSec - (round.startSec - 1), y: run.outcome.exitPrice, kind: 'exit', label: 'out' })
  data.markers = markers
  return data
}

const r = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} R`
const EXIT_TEXT: Record<TradeOutcome['kind'], string> = { stop: 'stopped out', target: 'hit the target', horizon: 'held to the end', manual: 'exited by you' }

export function regretLines(result: ExitResult): string[] {
  const lines = [`Your trade ${EXIT_TEXT[result.outcome]}: ${r(result.userR)} after costs. Holding the plan untouched would have been ${r(result.planR)}. The best the window offered was ${r(result.mfeR)}.`]
  if (result.overrode) lines.push(result.worse ? 'You overrode your plan and ended worse than leaving it alone.' : result.better ? 'You overrode your plan and ended better than the plan. The plan was not the problem, but be sure that was not luck.' : 'You overrode your plan and ended the same as the plan.')
  else lines.push('You left the plan alone.')
  if (result.gaveBack) lines.push('The trade was well in profit and a good part of it was given back.')
  if (result.mfeR <= 0 && result.capture === 1) lines.push('The trade was never in profit, so being stopped out was the right result and counts as full capture.')
  lines.push(`Capture ${Math.round(result.capture * 100)}% of what was available.${result.worse ? ' Overriding to a worse result costs 0.2.' : ''}`)
  return lines
}

export default function ExitDisciplineView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const planRef = useRef<{ stop: string; target: string }>({ stop: '', target: '' })
  const startRef = useRef(false)
  const nextRef = useRef(false)
  const tradeRef = useRef<OpenTrade | null>(null)
  const exitRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [round, setRound] = useState<ExitRound | null>(null)
  const [stopText, setStopText] = useState('')
  const [targetText, setTargetText] = useState('')
  const [planError, setPlanError] = useState('')
  const [run, setRun] = useState<RunState>({ shown: 0, stopPrice: null, targetPrice: null, outcome: null, startedAt: null })
  const [openR, setOpenR] = useState(0)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<ExitResult | null>(null)
  const [index, setIndex] = useState(0)
  const total = params.rounds
  const latest = useRef({ onFinish, onAbort, level })
  latest.current = { onFinish, onAbort, level }

  useEffect(() => { if (phase !== 'plan') root.current?.focus() }, [phase])

  useEffect(() => {
    if (!market) { latest.current.onAbort('Market data is not available in this window.'); return }
    let cancelled = false
    const abort = new AbortController()
    const clk = createFrameClock({ suspended: () => suspendedRef.current })
    ;(async () => {
      let availability
      try { availability = await market.data.availability(abort.signal) } catch {
        if (!cancelled) latest.current.onAbort('The server could not be reached for market data.')
        return
      }
      if (cancelled) return
      if (availability.index_missing || !Object.values(availability.symbols).some(entry => entry.dates?.length)) {
        latest.current.onAbort('This server has no market data for the games yet (the index has not been built).')
        return
      }
      const seen = createSeenWindows(browserStorage(), market.userId, 'exit_discipline', market.today)
      const plan = exitPlan(params, { lotSizeOf: symbol => availability.symbols[symbol]?.lot_size ?? undefined, cost: market.cost, slipMult: params.slipMult })
      const source = createRoundSource<ExitRound>({ rng: createRng(seed), availability, fetcher: market.data, plan, seen: seen.recent(), onUsed: id => seen.add(id) })
      const results: ExitResult[] = []
      let pending = source.next(abort.signal)
      for (let i = 0; i < total && !cancelled; i++) {
        const next = await pending
        if (cancelled) return
        if (!next.ok) {
          if (next.reason === 'cancelled') return
          if (results.length >= Math.max(3, Math.ceil(total / 2))) break
          latest.current.onAbort('Market data for the games could not be loaded. Nothing was recorded.')
          return
        }
        const current = next.round
        if (i + 1 < total) pending = source.next(abort.signal)
        const suggested = suggestedPlan(current)
        const prefilled = params.prefilled >= 1
        planRef.current = { stop: prefilled ? String(suggested.stop) : '', target: prefilled ? String(suggested.target) : '' }
        startRef.current = false; nextRef.current = false; exitRef.current = false; tradeRef.current = null
        setIndex(i + 1); setRound(current); setStopText(planRef.current.stop); setTargetText(planRef.current.target); setPlanError(''); setMessage('')
        setRun({ shown: 0, stopPrice: null, targetPrice: null, outcome: null, startedAt: null }); setOpenR(0); setResult(null); setPhase('plan')

        // Plan: wait for a valid plan and Start. (No time limit: the clock only runs once the trade does.)
        let accepted: Plan | null = null
        while (!accepted && !cancelled) {
          await clk.run(3_600_000, () => undefined, () => startRef.current)
          if (cancelled) return
          startRef.current = false
          const candidate = { stop: Number(planRef.current.stop), target: Number(planRef.current.target) }
          const problem = validatePlan(current, candidate)
          if (problem) setPlanError(problem); else accepted = candidate
        }
        if (!accepted || cancelled) return
        setPlanError('')

        // Run: the replay advances `speed` market seconds per real second; the stop and the target are enforced on every second.
        const trade = openTrade({ direction: current.direction, entryPrice: 0, stop: accepted.stop, target: accepted.target })
        tradeRef.current = trade
        const stopOf = () => trade.stopPrice
        setRun({ shown: 0, stopPrice: stopOf(), targetPrice: trade.targetPrice, outcome: null, startedAt: 0 }); setPhase('run')
        let outcome: TradeOutcome | null = null
        let nextIndex = 0
        const horizonMs = (current.horizonSec / params.speed) * 1000
        await clk.run(horizonMs, ms => {
          const reveal = Math.min(current.horizonSec, Math.floor((ms / 1000) * params.speed))
          while (!outcome && nextIndex < current.path.t.length && current.path.t[nextIndex] - current.startSec < reveal) {
            const k = nextIndex++
            outcome = trade.step({ t: current.path.t[k], h: current.path.h[k], l: current.path.l[k], c: current.path.c[k] })
          }
          if (!outcome && exitRef.current) outcome = trade.exit(current.startSec + reveal)
          setOpenR(trade.openR)
          setRun({ shown: reveal, stopPrice: stopOf(), targetPrice: trade.targetPrice, outcome, startedAt: 0 })
        }, () => outcome !== null)
        if (cancelled) return
        const final: TradeOutcome = outcome ?? trade.expire(current.startSec + current.horizonSec - 1) ?? { kind: 'horizon', exitSec: current.startSec + current.horizonSec, exitPrice: 0, r: 0, mfeR: 0, maeR: 0 }
        const scored = scoreExit(current, accepted, final, trade.overrides)
        results.push(scored)
        setRun({ shown: current.horizonSec, stopPrice: stopOf(), targetPrice: trade.targetPrice, outcome: final, startedAt: 0 }); setResult(scored); setPhase('result')
        await clk.run(120_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish(summariseExit(results, latest.current.level))
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const start = () => { if (phase === 'plan') { planRef.current = { stop: stopText, target: targetText }; startRef.current = true } }
  const trail = () => { if (phase === 'run' && tradeRef.current) setMessage(tradeRef.current.trailToCost() ? 'Stop moved to your entry.' : 'Trail to cost works only while the trade is in profit and the stop is still behind the entry.') }
  const lock = () => { if (phase === 'run' && tradeRef.current) setMessage(tradeRef.current.lock(EXIT_DISCIPLINE.lockFraction) ? `Stop moved to lock ${Math.round(EXIT_DISCIPLINE.lockFraction * 100)}% of the open profit.` : 'Lock works only while the trade is in profit and when it improves the stop.') }
  const leave = () => { if (phase === 'run') exitRef.current = true }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toLowerCase()
    if (phase === 'plan') return // typing in the plan fields; Enter there starts the run (handled on the inputs)
    if (key === 'e') { event.preventDefault(); event.stopPropagation(); leave() }
    else if (key === 't') { event.preventDefault(); event.stopPropagation(); trail() }
    else if (key === 'l') { event.preventDefault(); event.stopPropagation(); lock() }
    else if ((event.key === ' ' || event.key === 'Enter') && phase === 'result') { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }
  const onPlanKey = (event: React.KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); start() } }

  const chart = useMemo(() => (round ? exitChart(round, phase, run) : null), [round, phase, run])
  const arrow = round?.direction === 1 ? 'LONG' : 'SHORT'
  const label = round ? `Price chart of an open ${arrow.toLowerCase()} trade, shown from the entry price at zero. ${phase === 'result' && result ? regretLines(result).join(' ') : ''}` : 'Loading'

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => { if (phase !== 'plan') root.current?.focus() }}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Round ${index} of ${total}`}</p>
      {round && <p className="games-sniper-setup" role="status"><strong>{arrow}</strong> is on, entered at zero. Suggested stop {round.suggestedStop.toFixed(2)} pts, target {round.suggestedTarget.toFixed(2)} pts (2 R).{phase === 'run' ? ` Open ${r(openR)}.` : ''}</p>}
      {chart && round ? <GameChart data={chart} label={label} width={720} height={300} /> : <div className="games-chart-placeholder" aria-busy="true" />}
      {phase === 'plan' && (
        <div className="games-exit-plan">
          <label>Stop distance (points) <input inputMode="decimal" value={stopText} onChange={event => { setStopText(event.target.value); planRef.current.stop = event.target.value }} onKeyDown={onPlanKey} aria-label="Stop distance in points" /></label>
          <label>Target distance (points) <input inputMode="decimal" value={targetText} onChange={event => { setTargetText(event.target.value); planRef.current.target = event.target.value }} onKeyDown={onPlanKey} aria-label="Target distance in points" /></label>
          <button onClick={start}>Start the replay <kbd>Enter</kbd></button>
          {planError && <p role="alert" className="games-hotkey-message">{planError}</p>}
          <p className="games-hint">Set your plan before the replay. The stop and the target are enforced for you. 1 R is your stop distance.</p>
        </div>
      )}
      {phase === 'run' && (
        <>
          <div className="games-market-pad">
            <button onClick={leave}>EXIT <kbd>E</kbd></button>
            <button onClick={trail}>TRAIL TO COST <kbd>T</kbd></button>
            <button onClick={lock}>LOCK {Math.round(EXIT_DISCIPLINE.lockFraction * 100)}% <kbd>L</kbd></button>
          </div>
          <p className="games-hint" role="status">{message || 'The replay runs on its own. Leave it alone to follow your plan.'}</p>
        </>
      )}
      {phase === 'result' && round && result && (
        <div className="games-market-flash" role="status">
          {regretLines(result).map(line => <p key={line}>{line}</p>)}
          <p className="games-meta">{round.symbol} · {round.date} · {clock(round.startSec)} · Press Space for the next round</p>
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
    </div>
  )
}
