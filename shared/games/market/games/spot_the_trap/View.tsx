import { useEffect, useMemo, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import { computeView, type Candle, type ChartData, type Level, type Marker } from '../../../chart/chartModel'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { PATTERN_HELP, PATTERN_LABEL } from '../../engine/patterns'
import { createRoundSource } from '../../engine/roundSource'
import type { Bars } from '../../engine/series'
import { createFrameClock } from '../../ui/frameClock'
import { clock } from '../tick_reader/format'
import { breakoutPlan, huntPlan, modeOf, scoreBreakout, scoreHunt, summariseSpot, type BreakoutRound, type HuntRound, type SpotResult, type Verdict } from './engine'

type Phase = 'loading' | 'play' | 'result'
const WIDTH = 720, HEIGHT = 320

const candles = (bars: Bars, offset = 0): Candle[] => bars.t.map((_, i) => ({ t: i + offset, o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i] }))

/** Mode A: the bars up to the breakout (the last one), the level at 0, and after the call the minute that followed with the two thresholds. */
export function breakoutChart(round: BreakoutRound, revealed: boolean): ChartData {
  const n = round.shown.t.length
  const all = revealed ? { t: [...round.shown.t, ...round.after.t], o: [...round.shown.o, ...round.after.o], h: [...round.shown.h, ...round.after.h], l: [...round.shown.l, ...round.after.l], c: [...round.shown.c, ...round.after.c] } : round.shown
  const levels: Level[] = [{ y: 0, label: 'level', colour: '#F0E442' }]
  if (revealed) levels.push({ y: round.direction * round.ext, label: 'real if it gets here first', colour: '#009E73' }, { y: -round.direction * round.ret, label: 'fake if it falls back to here', colour: '#D55E00' })
  return {
    candles: candles(all), levels,
    markers: [{ t: n - 1, y: round.shown.c[n - 1], kind: round.direction === 1 ? 'long' : 'short', label: 'breakout' }],
    xRange: [0, n + 12],
  }
}

/** Mode B: the 60 bars, the clicks, and after submitting the true occurrences and the near misses. */
export function huntChart(round: HuntRound, clicks: number[], revealed: boolean): ChartData {
  const markers: Marker[] = clicks.map(i => ({ t: i + 0.5, y: round.bars.h[i], kind: 'entry', label: 'you' }))
  if (revealed) {
    for (const i of round.truth) markers.push({ t: i + 0.5, y: round.bars.l[i], kind: 'long', label: 'yes' })
    for (const i of round.near) markers.push({ t: i + 0.5, y: round.bars.l[i], kind: 'exit', label: 'near' })
  }
  return { candles: candles(round.bars), markers, xRange: [0, round.bars.t.length] }
}

export default function SpotTheTrapView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const verdictRef = useRef<Verdict | null>(null)
  const submitRef = useRef(false)
  const nextRef = useRef(false)
  const clicksRef = useRef<number[]>([])
  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<'breakout' | 'hunt'>('breakout')
  const [breakout, setBreakout] = useState<BreakoutRound | null>(null)
  const [hunt, setHunt] = useState<HuntRound | null>(null)
  const [clicks, setClicks] = useState<number[]>([])
  const [result, setResult] = useState<SpotResult | null>(null)
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
      const rng = createRng(seed)
      const seenA = createSeenWindows(browserStorage(), market.userId, 'spot_the_trap', market.today)
      const fetcher = market.data
      const sourceA = createRoundSource<BreakoutRound>({ rng, availability, fetcher, plan: breakoutPlan(params), seen: seenA.recent(), onUsed: id => seenA.add(id) })
      const sourceB = createRoundSource<HuntRound>({ rng, availability, fetcher, plan: huntPlan(params), seen: seenA.recent(), onUsed: id => seenA.add(id) })
      const results: SpotResult[] = []
      const ask = (i: number) => (modeOf(i, params.modeB) === 'breakout' ? sourceA.next(abort.signal) : sourceB.next(abort.signal))
      let pending = ask(0)
      for (let i = 0; i < total && !cancelled; i++) {
        const next = await pending
        if (cancelled) return
        if (!next.ok) {
          if (next.reason === 'cancelled') return
          if (results.length >= Math.max(4, Math.ceil(total / 2))) break
          latest.current.onAbort('Market data for the games could not be loaded. Nothing was recorded.')
          return
        }
        if (i + 1 < total) pending = ask(i + 1)
        verdictRef.current = null; submitRef.current = false; nextRef.current = false; clicksRef.current = []
        const kind = modeOf(i, params.modeB)
        setIndex(i + 1); setMode(kind); setClicks([]); setResult(null)
        if (kind === 'breakout') {
          const round = next.round as BreakoutRound
          setBreakout(round); setHunt(null); setPhase('play')
          const limit = params.decisionSec * 1000
          await clk.run(limit, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limit)})` }, () => verdictRef.current !== null)
          if (cancelled) return
          const scored = scoreBreakout(round, verdictRef.current ?? 'timeout')
          results.push(scored); setResult(scored)
        } else {
          const round = next.round as HuntRound
          setHunt(round); setBreakout(null); setPhase('play')
          const limit = params.huntSec * 1000
          await clk.run(limit, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limit)})` }, () => submitRef.current)
          if (cancelled) return
          const scored = scoreHunt(round, clicksRef.current, !submitRef.current)
          results.push(scored); setResult(scored)
        }
        setPhase('result')
        await clk.run(180_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish(summariseSpot(results, latest.current.level))
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const call = (verdict: Verdict) => { if (phase === 'play' && mode === 'breakout' && verdictRef.current === null) verdictRef.current = verdict }
  const toggle = (i: number) => {
    if (phase !== 'play' || mode !== 'hunt' || !hunt) return
    const k = Math.max(0, Math.min(hunt.bars.t.length - 1, i))
    clicksRef.current = clicksRef.current.includes(k) ? clicksRef.current.filter(v => v !== k) : [...clicksRef.current, k]
    setClicks(clicksRef.current)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toLowerCase()
    if (phase === 'play' && mode === 'breakout' && (key === 'r' || event.key === 'ArrowLeft')) { event.preventDefault(); event.stopPropagation(); call('real') }
    else if (phase === 'play' && mode === 'breakout' && (key === 'f' || event.key === 'ArrowRight')) { event.preventDefault(); event.stopPropagation(); call('fake') }
    else if (phase === 'play' && mode === 'hunt' && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submitRef.current = true }
    else if (phase === 'play' && mode === 'hunt' && event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); clicksRef.current = clicksRef.current.slice(0, -1); setClicks(clicksRef.current) }
    else if (phase === 'result' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }

  const data = useMemo(() => (breakout && mode === 'breakout' ? breakoutChart(breakout, phase === 'result') : hunt && mode === 'hunt' ? huntChart(hunt, clicks, phase === 'result') : null), [breakout, hunt, mode, clicks, phase])
  const onChartClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!data || mode !== 'hunt') return
    const rect = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH
    toggle(Math.floor(computeView(data, { width: WIDTH, height: HEIGHT }).timeAt(px)))
  }

  const r = result
  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Round ${index} of ${total} · ${mode === 'breakout' ? 'breakout verdict' : 'pattern hunt'}`}</p>
      {mode === 'hunt' && hunt && <p className="games-sniper-setup" role="status"><strong>{PATTERN_LABEL[hunt.pattern]}</strong>: {PATTERN_HELP[hunt.pattern]}{phase === 'play' ? ` Clicks so far: ${clicks.length}.` : ''}</p>}
      {mode === 'breakout' && breakout && <p className="games-sniper-setup" role="status">The price has just closed {breakout.direction === 1 ? 'above' : 'below'} the {breakout.direction === 1 ? 'highest high' : 'lowest low'} of the last 24 bars (the yellow level). Real or fake?</p>}
      {data ? (
        <div className={mode === 'hunt' && phase === 'play' ? 'games-click-chart' : undefined} onClick={onChartClick}>
          <GameChart data={data} width={WIDTH} height={HEIGHT} label={mode === 'breakout' ? 'Five second candles up to a breakout of the level at zero' : `Sixty five second candles; find every ${hunt ? PATTERN_LABEL[hunt.pattern] : 'pattern'}`} />
        </div>
      ) : <div className="games-chart-placeholder" aria-busy="true" />}
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'play'}><div ref={bar} /></div>
      {mode === 'breakout' && <div className="games-market-pad"><button onClick={() => call('real')} disabled={phase !== 'play'}>REAL <kbd>R</kbd></button><button onClick={() => call('fake')} disabled={phase !== 'play'}>FAKE <kbd>F</kbd></button></div>}
      {mode === 'hunt' && phase === 'play' && <div className="games-market-pad"><button onClick={() => { clicksRef.current = clicksRef.current.slice(0, -1); setClicks(clicksRef.current) }} disabled={!clicks.length}>Undo <kbd>Backspace</kbd></button><button onClick={() => { submitRef.current = true }}>Done <kbd>Enter</kbd></button></div>}
      {phase === 'result' && r && (
        <div className="games-market-flash" role="status">
          {r.kind === 'breakout' && breakout && <>
            <p>{r.verdict === 'timeout' ? 'Time ran out: no score.' : r.correct ? 'Correct.' : 'Not this time.'} It was a <strong>{r.real ? 'REAL' : 'FAKE'}</strong> breakout: {r.real ? `the price reached ${breakout.ext.toFixed(2)} points beyond the level before coming back` : breakout.extendedAt < 0 ? `it never got ${breakout.ext.toFixed(2)} points beyond the level (the furthest was ${breakout.maxExtension.toFixed(2)})` : `it fell back ${breakout.ret.toFixed(2)} points inside the level before it got there`}.</p>
            <p className="games-meta">{breakout.symbol} · {breakout.date} · {clock(breakout.breakoutSec)} · Space for the next round</p>
          </>}
          {r.kind === 'hunt' && hunt && <>
            <p>{Math.round(r.roundScore * 100)}%: you clicked {r.clicks}, and there {r.truth === 1 ? 'was 1' : `were ${r.truth}`} ({Math.round(r.recall * 100)}% found, {Math.round(r.precision * 100)}% of your clicks right). Marked: "you" is a click of yours, "yes" a true occurrence, "near" a bar that almost qualifies and does not count.</p>
            <p className="games-meta">{hunt.symbol} · {hunt.date} · {clock(hunt.startSec)} · Space for the next round</p>
          </>}
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
      {phase === 'play' && mode === 'breakout' && <p className="games-hint">R or ← real, F or → fake.</p>}
      {phase === 'play' && mode === 'hunt' && <p className="games-hint">Click a bar to mark it (click again to remove). Enter when you are done.</p>}
    </div>
  )
}
