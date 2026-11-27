import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewRow } from '../../../core/trial'
import { tickRow } from '../../review'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import type { Candle, ChartData } from '../../../chart/chartModel'
import { TICK_READER } from '../../config/difficulty.market'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { createRoundSource } from '../../engine/roundSource'
import { createFrameClock } from '../../ui/frameClock'
import { aggregate, sliceBars, type Bars } from '../../engine/series'
import { scoreRound, summariseTickReader, tickReaderPlan, type RoundResult, type TickAnswer, type TickRound } from './engine'
import { clock, describeResult } from './format'


type Phase = 'loading' | 'decide' | 'hold' | 'flash'
const CHART_BAR_SEC = 5

const toCandles = (bars: Bars, decisionSec: number): Candle[] => bars.t.map((t, i) => ({ t: t - decisionSec, o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] }))

/** What is on the chart now: the lookback, then the hold up to `elapsed` seconds (0 before the hold starts). */
export function chartFor(round: TickRound, phase: Phase, elapsed: number, answer: TickAnswer | null): ChartData {
  const revealed = phase === 'decide' || phase === 'loading' ? 0 : phase === 'flash' ? round.holdSec : Math.min(round.holdSec, elapsed)
  const shownFuture = sliceBars(round.future, round.decisionSec, round.decisionSec + revealed)
  const bars: Bars = { t: [...round.lookback.t, ...shownFuture.t], o: [...round.lookback.o, ...shownFuture.o], h: [...round.lookback.h, ...shownFuture.h], l: [...round.lookback.l, ...shownFuture.l], c: [...round.lookback.c, ...shownFuture.c] }
  const data: ChartData = {
    candles: toCandles(aggregate(bars, CHART_BAR_SEC), round.decisionSec),
    line: bars.t.map((t, i) => ({ t: t - round.decisionSec, v: bars.c[i] })),
    xRange: [-round.lookbackSec, round.holdSec + CHART_BAR_SEC],
  }
  if (phase !== 'decide' && phase !== 'loading') {
    data.levels = [{ y: 0, label: 'entry' }]
    data.clock = revealed
    if (answer === 'long' || answer === 'short') {
      data.markers = [{ t: 0, y: 0, kind: answer, label: answer === 'long' ? 'CE' : 'PE' }]
      if (phase === 'flash') data.markers.push({ t: round.holdSec, y: round.move, kind: 'exit', label: 'exit' })
    }
  }
  return data
}

const KEY_ANSWER: Record<string, TickAnswer> = { ArrowLeft: 'long', ArrowRight: 'short', ArrowDown: 'skip' }

export default function TickReaderView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const answerRef = useRef<TickAnswer | null>(null)
  const decisionMsRef = useRef(0)
  const skipFlashRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [round, setRound] = useState<TickRound | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [answer, setAnswer] = useState<TickAnswer | null>(null)
  const [result, setResult] = useState<RoundResult | null>(null)
  const [index, setIndex] = useState(0)
  const total = params.rounds
  const latest = useRef({ onFinish, onAbort, level })
  latest.current = { onFinish, onAbort, level }

  useEffect(() => { root.current?.focus() }, [phase])

  useEffect(() => {
    if (!market) { latest.current.onAbort('Market data is not available in this window.'); return }
    let cancelled = false
    const abort = new AbortController()
    const clock = createFrameClock({ suspended: () => suspendedRef.current })
    const run = clock.run

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
      const seen = createSeenWindows(browserStorage(), market.userId, 'tick_reader', market.today)
      const plan = tickReaderPlan(params, { lotSizeOf: symbol => availability.symbols[symbol]?.lot_size ?? undefined, cost: market.cost, slipMult: params.slipMult })
      const source = createRoundSource<TickRound>({ rng: createRng(seed), availability, fetcher: market.data, plan, seen: seen.recent(), onUsed: id => seen.add(id) })
      const results: RoundResult[] = []
      const rows: ReviewRow[] = []
      let pending = source.next(abort.signal)
      for (let i = 0; i < total && !cancelled; i++) {
        const next = await pending
        if (cancelled) return
        if (!next.ok) {
          if (next.reason === 'cancelled') return
          // Graceful end (spec 5): keep what was played when enough rounds are done, otherwise the shell voids the session.
          if (results.length >= Math.max(5, Math.ceil(total / 2))) break
          latest.current.onAbort('Market data for the games could not be loaded. Nothing was recorded.')
          return
        }
        const current = next.round
        if (i + 1 < total) pending = source.next(abort.signal) // prefetch the next round while this one is played
        answerRef.current = null; decisionMsRef.current = 0; skipFlashRef.current = false
        setIndex(i + 1); setRound(current); setAnswer(null); setResult(null); setElapsed(0); setPhase('decide')

        const decisionMs = params.decisionSec * 1000
        await run(decisionMs, ms => {
          decisionMsRef.current = ms
          if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / decisionMs)})`
        }, () => answerRef.current !== null)
        if (cancelled) return
        const chosen: TickAnswer = answerRef.current ?? 'timeout'
        const spent = answerRef.current ? decisionMsRef.current : decisionMs
        setAnswer(chosen)

        setPhase('hold')
        await run((current.holdSec * 1000) / params.replaySpeed, ms => setElapsed((ms / 1000) * params.replaySpeed))
        if (cancelled) return

        const scored = scoreRound(current, chosen, Math.round(spent))
        results.push(scored); rows.push(tickRow(rows.length + 1, current, scored))
        setResult(scored); setPhase('flash')
        await run(TICK_READER.flashMs, () => undefined, () => skipFlashRef.current)
      }
      if (!cancelled) latest.current.onFinish({ ...summariseTickReader(results, latest.current.level), review: rows })
    })()

    return () => { cancelled = true; abort.abort(); clock.cancel() }
  }, [market, params, seed, total])

  const press = (choice: TickAnswer) => { if (phase === 'decide' && answerRef.current === null) answerRef.current = choice }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const choice = KEY_ANSWER[event.key]
    if (choice) { event.preventDefault(); event.stopPropagation(); press(choice) }
    else if ((event.key === ' ' || event.key === 'Enter') && phase === 'flash') { event.preventDefault(); event.stopPropagation(); skipFlashRef.current = true }
  }

  const chart = useMemo(() => (round ? chartFor(round, phase, elapsed, answer) : null), [round, phase, elapsed, answer])
  const label = round ? `Price chart of the last ${round.lookbackSec} seconds, shown from the entry price at zero. ${phase === 'flash' ? `Result: ${result ? describeResult(round, result) : ''}` : ''}` : 'Loading'

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Round ${index} of ${total}${phase === 'decide' ? ` · ${params.decisionSec}s to decide` : ''}`}</p>
      {chart && round ? <GameChart data={chart} label={label} width={720} height={300} /> : <div className="games-chart-placeholder" aria-busy="true" />}
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'decide'}><div ref={bar} /></div>
      <div className="games-market-pad">
        <button onClick={() => press('long')} disabled={phase !== 'decide'}>Long (CE) <kbd>←</kbd></button>
        <button onClick={() => press('skip')} disabled={phase !== 'decide'}>Skip <kbd>↓</kbd></button>
        <button onClick={() => press('short')} disabled={phase !== 'decide'}>Short (PE) <kbd>→</kbd></button>
      </div>
      {phase === 'hold' && <p className="games-meta" role="status">Holding for {round?.holdSec}s…</p>}
      {phase === 'flash' && round && result && (
        <div className="games-market-flash" role="status">
          <p>{describeResult(round, result)}</p>
          <p className="games-meta">{round.symbol} · {round.date} · {clock(round.decisionSec)} · Press Space for the next round</p>
        </div>
      )}
      {phase === 'decide' && <p className="games-hint">← long (CE), → short (PE), ↓ skip. Price is shown from the entry price (0).</p>}
    </div>
  )
}
