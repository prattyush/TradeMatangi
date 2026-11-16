import { useEffect, useMemo, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { REGIME_LABEL, type Regime } from '../../engine/regime'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { createRoundSource } from '../../engine/roundSource'
import { createFrameClock } from '../../ui/frameClock'
import { GameChart } from '../../../chart/GameChart'
import { clock } from '../tick_reader/format'
import { chartFor } from '../tick_reader/View'
import type { TickAnswer } from '../tick_reader/engine'
import { PLAYBOOK_LABEL, PLAYBOOKS, regimePlan, scoreSegment, summariseRegime, type Playbook, type Previous, type Segment, type SegmentResult } from './engine'

type Phase = 'loading' | 'decide' | 'hold' | 'result'
const KEYS: Record<string, Playbook> = { f: 'follow', d: 'fade', s: 'aside', ArrowLeft: 'follow', ArrowRight: 'fade', ArrowDown: 'aside' }
const pts = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`

/** The Tick Reader chart takes long, short or skip: a playbook is one of them once the last 30 seconds' direction is known. */
const asTickAnswer = (playbook: Playbook | null, direction: 1 | -1): TickAnswer | null =>
  playbook === null ? null : playbook === 'aside' ? 'skip' : (playbook === 'follow') === (direction === 1) ? 'long' : 'short'

export default function RegimeSwitchView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const answerRef = useRef<Playbook | null>(null)
  const nextRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [segment, setSegment] = useState<Segment | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [answer, setAnswer] = useState<Playbook | null>(null)
  const [result, setResult] = useState<SegmentResult | null>(null)
  const [previous, setPrevious] = useState<Regime | null>(null)
  const [index, setIndex] = useState(0)
  const total = params.segments
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
      const seen = createSeenWindows(browserStorage(), market.userId, 'regime_switch', market.today)
      const plan = regimePlan(params, { lotSizeOf: symbol => availability.symbols[symbol]?.lot_size ?? undefined, cost: market.cost, slipMult: params.slipMult })
      const source = createRoundSource<Segment>({ rng: createRng(seed), availability, fetcher: market.data, plan, seen: seen.recent(), onUsed: id => seen.add(id) })
      const results: SegmentResult[] = []
      let before = null as Previous | null
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
        answerRef.current = null; nextRef.current = false
        setIndex(i + 1); setSegment(current); setAnswer(null); setResult(null); setElapsed(0); setPrevious(before?.regime ?? null); setPhase('decide')
        const limit = params.decisionSec * 1000
        await clk.run(limit, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limit)})` }, () => answerRef.current !== null)
        if (cancelled) return
        const chosen: Playbook | 'timeout' = answerRef.current ?? 'timeout'
        setAnswer(chosen === 'timeout' ? null : chosen); setPhase('hold')
        await clk.run((current.round.holdSec * 1000) / params.replaySpeed, ms => setElapsed((ms / 1000) * params.replaySpeed))
        if (cancelled) return
        const scored = scoreSegment(current, chosen, before)
        results.push(scored)
        if (chosen !== 'timeout') before = { regime: current.regime.regime, playbook: chosen }
        else before = { regime: current.regime.regime, playbook: before?.playbook ?? 'aside' }
        setResult(scored); setPhase('result')
        await clk.run(120_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish(summariseRegime(results, latest.current.level))
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const choose = (playbook: Playbook) => { if (phase === 'decide' && answerRef.current === null) answerRef.current = playbook }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const playbook = KEYS[event.key] ?? KEYS[event.key.toLowerCase()]
    if (phase === 'decide' && playbook) { event.preventDefault(); event.stopPropagation(); choose(playbook) }
    else if (phase === 'result' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }

  const chart = useMemo(() => (segment ? chartFor(segment.round, phase === 'decide' || phase === 'loading' ? 'decide' : phase === 'hold' ? 'hold' : 'flash', elapsed, asTickAnswer(answer, segment.direction)) : null), [segment, phase, elapsed, answer])
  const label = segment ? `Price chart of the last ${segment.round.lookbackSec} seconds, shown from the latest price at zero. The last 30 seconds went ${segment.direction === 1 ? 'up' : 'down'}.` : 'Loading'
  const hint = params.hint >= 1 && previous ? `Last segment was: ${REGIME_LABEL[previous]}` : ''

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Segment ${index} of ${total}${hint ? ` · ${hint}` : ''}`}</p>
      {chart && segment ? <GameChart data={chart} label={label} width={720} height={300} /> : <div className="games-chart-placeholder" aria-busy="true" />}
      {segment && <p className="games-sniper-setup" role="status">Last 30 seconds: <strong>{segment.direction === 1 ? 'UP' : 'DOWN'}</strong>. FOLLOW goes with it, FADE goes against it.</p>}
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'decide'}><div ref={bar} /></div>
      <div className="games-market-pad">
        {PLAYBOOKS.map(playbook => (
          <button key={playbook} onClick={() => choose(playbook)} disabled={phase !== 'decide'}>{PLAYBOOK_LABEL[playbook]} <kbd>{playbook === 'follow' ? 'F' : playbook === 'fade' ? 'D' : 'S'}</kbd></button>
        ))}
      </div>
      {phase === 'hold' && <p className="games-meta" role="status">Holding for {segment?.round.holdSec}s…</p>}
      {phase === 'result' && segment && result && (
        <div className="games-market-flash" role="status">
          <p>This was a <strong>{REGIME_LABEL[result.regime]}</strong> segment{result.changed ? ` (the one before was ${REGIME_LABEL[result.previous!]})` : ''}. {result.playbook === 'timeout' ? 'Time ran out: no score.' : `You chose ${PLAYBOOK_LABEL[result.playbook]}: ${Math.round(result.roundScore * 100)}%.`}</p>
          <p className="games-meta">{PLAYBOOKS.map(p => `${PLAYBOOK_LABEL[p]} ${pts(segment.outcomes[p])}${p === result.best ? ' (best)' : ''}`).join(' · ')} option points after costs</p>
          {result.perseveration && <p>You repeated the playbook that had worked before the regime changed: −25%.</p>}
          <p className="games-meta">{segment.round.symbol} · {segment.round.date} · {clock(segment.round.decisionSec)} · Press Space for the next segment</p>
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
      {phase === 'decide' && <p className="games-hint">F or ← follow, D or → fade, S or ↓ stand aside.</p>}
    </div>
  )
}
