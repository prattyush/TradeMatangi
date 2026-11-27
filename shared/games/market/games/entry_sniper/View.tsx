import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewRow } from '../../../core/trial'
import { sniperRow } from '../../review'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import type { Candle, ChartData, Level, Marker } from '../../../chart/chartModel'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { createRoundSource } from '../../engine/roundSource'
import { aggregate, sliceBars, type Bars } from '../../engine/series'
import { createFrameClock } from '../../ui/frameClock'
import { clock } from '../tick_reader/format'
import { scoreSniper, sniperPlan, summariseSniper, type SniperAnswer, type SniperResult, type SniperRound } from './engine'

type Phase = 'loading' | 'window' | 'trade' | 'result'
const BAR_SEC = 5
const MAX_ATTEMPTS = 3

const candles = (bars: Bars, startSec: number): Candle[] => bars.t.map((t, i) => ({ t: t - startSec, o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] }))

/** Everything the chart shows now: the minute before, the window up to `revealSec`, then (after an entry) the trade up to `tradeSec`. */
export function sniperChart(round: SniperRound, phase: Phase, revealSec: number, entryOffset: number | null, tradeSec: number, full: boolean): ChartData {
  const shownTo = full ? round.windowSec + round.horizonSec : phase === 'trade' && entryOffset !== null ? Math.max(entryOffset, 0) + 1 + tradeSec : revealSec + 1
  const pathShown = sliceBars(round.path, round.startSec, round.startSec + Math.max(0, shownTo))
  const bars: Bars = { t: [...round.context.t, ...pathShown.t], o: [...round.context.o, ...pathShown.o], h: [...round.context.h, ...pathShown.h], l: [...round.context.l, ...pathShown.l], c: [...round.context.c, ...pathShown.c] }
  const data: ChartData = {
    candles: candles(aggregate(bars, BAR_SEC), round.startSec),
    line: bars.t.map((t, i) => ({ t: t - round.startSec, v: bars.c[i] })),
    xRange: [-60, round.windowSec + round.horizonSec],
  }
  const levels: Level[] = [], markers: Marker[] = []
  const entry = entryOffset !== null ? round.path.c[round.path.t.indexOf(round.startSec + entryOffset)] : undefined
  if (entry !== undefined && entryOffset !== null) {
    levels.push({ y: entry - round.direction * round.stop, label: 'stop', colour: '#D55E00' }, { y: entry + round.direction * round.target, label: 'target', colour: '#009E73' })
    markers.push({ t: entryOffset, y: entry, kind: round.direction === 1 ? 'long' : 'short', label: 'IN' })
    const out = round.outcomeByOffset[entryOffset]
    if (out && (full || (phase === 'result'))) markers.push({ t: out.exitSec - round.startSec, y: out.exitPrice - round.base, kind: 'exit', label: 'out' })
  }
  if (full && round.bestOffset !== null && round.bestOffset !== entryOffset) {
    const bestY = round.path.c[round.path.t.indexOf(round.startSec + round.bestOffset)]
    if (bestY !== undefined) markers.push({ t: round.bestOffset, y: bestY, kind: 'entry', label: 'best' })
  }
  if (levels.length) data.levels = levels
  if (markers.length) data.markers = markers
  return data
}

function describe(round: SniperRound, result: SniperResult): string[] {
  const r = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} R`
  const best = round.bestOffset !== null ? `The best entry was at +${round.bestOffset} s, worth ${r(round.bestR)}.` : 'No entry was possible in this window.'
  if (result.kind === 'enter') {
    const how = result.exit === 'stop' ? 'The stop was hit.' : result.exit === 'target' ? 'The target was hit.' : 'The time ran out and the trade was marked to market.'
    return [`You entered at +${result.offset} s: ${r(result.userR)} after costs. ${how}${result.early ? ' That was chasing: an entry in the first two seconds.' : ''}`, best, round.trap ? 'This was a trap: no entry in the window was worth taking, passing was right.' : '']
  }
  if (result.kind === 'timeout') return ['The window ran out, counted as a pass.', best, round.trap ? 'It was a trap round, so a pass was right.' : 'There was an entry worth taking.']
  return ['You passed.', best, round.trap ? 'It was a trap round: no entry in the window was worth taking. Good pass.' : 'There was an entry worth taking.']
}

export default function EntrySniperView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const answerRef = useRef<SniperAnswer | null>(null)
  const revealRef = useRef(0)
  const nextRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [round, setRound] = useState<SniperRound | null>(null)
  const [reveal, setReveal] = useState(0)
  const [entryOffset, setEntryOffset] = useState<number | null>(null)
  const [tradeSec, setTradeSec] = useState(0)
  const [result, setResult] = useState<SniperResult | null>(null)
  const [index, setIndex] = useState(0)
  const total = params.rounds
  const latest = useRef({ onFinish, onAbort, level })
  latest.current = { onFinish, onAbort, level }

  useEffect(() => { root.current?.focus() }, [phase])

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
      const seen = createSeenWindows(browserStorage(), market.userId, 'entry_sniper', market.today)
      const plan = sniperPlan(params, { lotSizeOf: symbol => availability.symbols[symbol]?.lot_size ?? undefined, cost: market.cost, slipMult: params.slipMult })
      const source = createRoundSource<SniperRound>({ rng: createRng(seed), availability, fetcher: market.data, plan, seen: seen.recent(), onUsed: id => seen.add(id), maxCandidates: MAX_ATTEMPTS })
      const results: SniperResult[] = []
      const rows: ReviewRow[] = []
      let pending = source.next(abort.signal)
      for (let i = 0; i < total && !cancelled; i++) {
        const next = await pending
        if (cancelled) return
        if (!next.ok) {
          if (next.reason === 'cancelled') return
          if (results.length >= Math.max(4, Math.ceil(total / 2))) break
          latest.current.onAbort('Market data for the games could not be loaded. Nothing was recorded.')
          return
        }
        const current = next.round
        if (i + 1 < total) pending = source.next(abort.signal)
        answerRef.current = null; revealRef.current = 0; nextRef.current = false
        setIndex(i + 1); setRound(current); setReveal(0); setEntryOffset(null); setTradeSec(0); setResult(null); setPhase('window')

        // The window plays at `windowSpeed` market seconds per real second; ENTER or PASS ends it early.
        const windowMs = (current.windowSec / params.windowSpeed) * 1000
        await clk.run(windowMs, ms => {
          const offset = Math.min(current.windowSec - 1, Math.floor((ms / 1000) * params.windowSpeed))
          revealRef.current = offset
          setReveal(offset)
          if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / windowMs)})`
        }, () => answerRef.current !== null)
        if (cancelled) return
        const answer: SniperAnswer = answerRef.current ?? { kind: 'timeout' }
        const scored = scoreSniper(current, answer)
        if (scored.kind === 'enter' && scored.offset !== null) {
          const outcome = current.outcomeByOffset[scored.offset]
          setEntryOffset(scored.offset); setPhase('trade')
          const runSec = outcome ? Math.max(0, outcome.exitSec - (current.startSec + scored.offset)) : 0
          await clk.run((runSec / params.replaySpeed) * 1000, ms => setTradeSec(Math.floor((ms / 1000) * params.replaySpeed)))
          if (cancelled) return
        }
        results.push(scored); rows.push(sniperRow(rows.length + 1, current, scored))
        setResult(scored); setPhase('result')
        await clk.run(60_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish({ ...summariseSniper(results, latest.current.level), review: rows })
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const act = (answer: SniperAnswer) => {
    if (phase !== 'window' || answerRef.current !== null || !round) return
    if (answer.kind === 'enter') {
      // The price on screen is the last revealed second that has a price.
      let k = revealRef.current
      while (k > 0 && round.netByOffset[k] === null) k -= 1
      answerRef.current = { kind: 'enter', offset: k }
    } else answerRef.current = answer
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation()
      if (phase === 'window') act({ kind: 'enter', offset: 0 }); else if (phase === 'result') nextRef.current = true
    } else if (event.key.toLowerCase() === 'p' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); act({ kind: 'pass' }) }
  }

  const chart = useMemo(() => (round ? sniperChart(round, phase, reveal, entryOffset, tradeSec, phase === 'result') : null), [round, phase, reveal, entryOffset, tradeSec])
  const label = round ? `Price chart, ${round.direction === 1 ? 'long' : 'short'} setup, shown from the price before the window. ${phase === 'result' && result ? describe(round, result).join(' ') : ''}` : 'Loading'
  const arrow = round?.direction === 1 ? 'LONG' : 'SHORT'

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Round ${index} of ${total}`}</p>
      {round && <p className="games-sniper-setup" role="status"><strong>{arrow}</strong> · stop {round.stop.toFixed(2)} pts · target {round.target.toFixed(2)} pts ({(round.target / round.stop).toFixed(1)} R)</p>}
      {chart && round ? <GameChart data={chart} label={label} width={720} height={300} /> : <div className="games-chart-placeholder" aria-busy="true" />}
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'window'}><div ref={bar} /></div>
      <div className="games-market-pad">
        <button onClick={() => act({ kind: 'enter', offset: 0 })} disabled={phase !== 'window'}>ENTER now <kbd>Enter</kbd></button>
        <button onClick={() => act({ kind: 'pass' })} disabled={phase !== 'window'}>PASS <kbd>P</kbd></button>
        {phase === 'result' && <button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button>}
      </div>
      {phase === 'trade' && <p className="games-meta" role="status">In the trade…</p>}
      {phase === 'result' && round && result && (
        <div className="games-market-flash" role="status">
          {describe(round, result).filter(Boolean).map(line => <p key={line}>{line}</p>)}
          <p className="games-meta">{round.symbol} · {round.date} · {clock(round.startSec)}</p>
        </div>
      )}
      {phase === 'window' && <p className="games-hint">Press Enter to take the entry at the current price, or P to pass. The window plays on its own and a late answer is a pass.</p>}
    </div>
  )
}
