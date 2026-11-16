import { useEffect, useMemo, useRef, useState } from 'react'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import type { Candle, ChartData, Level, Marker } from '../../../chart/chartModel'
import { NO_TRADE_DAY } from '../../config/difficulty.market'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { aggregate, sliceBars, type Bars } from '../../engine/series'
import { createFrameClock } from '../../ui/frameClock'
import { clock } from '../tick_reader/format'
import { clampRule, createSegmentSim, createSegmentSource, RULE_KEYS, RULE_LABEL, ruleCount, scoreSegment, summariseNoTrade, VIOLATION_TEXT, type Rules, type RuleKey, type Segment, type SegmentResult, type SegmentSim } from './engine'

type Phase = 'loading' | 'rules' | 'play' | 'result'
const r = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} R`

/** The revealed part of the segment as 5 second candles (relative seconds), the open stop, and the entries and exits so far. */
export function segmentChart(segment: Segment, sim: SegmentSim | null, reveal: number): ChartData {
  const shown = sliceBars(segment.bars, segment.startSec, segment.startSec + Math.max(1, reveal))
  const five: Bars = aggregate(shown, 5)
  const candles: Candle[] = five.t.map((t, i) => ({ t: t - segment.startSec, o: five.o[i], h: five.h[i], l: five.l[i], c: five.c[i] }))
  const markers: Marker[] = []
  const levels: Level[] = []
  if (sim) {
    for (const t of sim.trades) {
      const entry = segment.bars.c[Math.min(segment.bars.c.length - 1, Math.max(0, t.entrySec))]
      markers.push({ t: t.entrySec, y: entry, kind: t.direction === 1 ? 'long' : 'short', label: t.violations.length || t.revenge ? '!' : String(t.lots) })
      markers.push({ t: t.exitSec, y: segment.bars.c[Math.min(segment.bars.c.length - 1, Math.max(0, t.exitSec))], kind: 'exit', label: r(t.r) })
    }
    const p = sim.position
    if (p) {
      const entry = segment.bars.c[Math.min(segment.bars.c.length - 1, Math.max(0, p.entrySec))]
      markers.push({ t: p.entrySec, y: entry, kind: p.direction === 1 ? 'long' : 'short', label: `${p.lots}` })
      levels.push({ y: entry - p.direction * segment.riskPts, label: 'stop (1 R)', colour: '#D55E00' })
    }
  }
  const data: ChartData = { candles, xRange: [0, segment.seconds] }
  if (markers.length) data.markers = markers
  if (levels.length) data.levels = levels
  return data
}

export default function NoTradeDayView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const startRef = useRef(false)
  const nextRef = useRef(false)
  const simRef = useRef<SegmentSim | null>(null)
  const secRef = useRef(0)
  const lotsRef = useRef(1)
  const rulesRef = useRef<Rules>({})
  const [phase, setPhase] = useState<Phase>('loading')
  const [segment, setSegment] = useState<Segment | null>(null)
  const [rules, setRules] = useState<Rules>({})
  const [lots, setLots] = useState(1)
  const [tick, setTick] = useState(0)
  const [notice, setNotice] = useState('')
  const [result, setResult] = useState<SegmentResult | null>(null)
  const [index, setIndex] = useState(0)
  const total = NO_TRADE_DAY.segments
  const latest = useRef({ onFinish, onAbort, level })
  latest.current = { onFinish, onAbort, level }

  useEffect(() => { if (phase !== 'rules') root.current?.focus() }, [phase])
  const setRule = (key: RuleKey, value: number | undefined) => {
    const next = { ...rulesRef.current }
    if (value === undefined) delete next[key]; else next[key] = clampRule(key, value)
    rulesRef.current = next; setRules(next)
  }

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
      const seen = createSeenWindows(browserStorage(), market.userId, 'no_trade_day', market.today)
      const source = createSegmentSource({ rng: createRng(seed), availability, data: market.data, seen: seen.recent(), onUsed: id => seen.add(id), ctx: { lotSizeOf: symbol => availability.symbols[symbol]?.lot_size ?? undefined, cost: market.cost, slipMult: params.slipMult } })
      const fetchNext = () => source.next({ segMin: params.segMin, stopMult: params.stopMult, targetEr: params.targetEr, slipMult: params.slipMult }, abort.signal)
      const results: SegmentResult[] = []
      let pending = fetchNext()
      for (let i = 0; i < total && !cancelled; i++) {
        const next = await pending
        if (cancelled) return
        if (!next.ok) {
          if (next.reason === 'cancelled') return
          if (results.length >= 2) break
          latest.current.onAbort('Market data for the games could not be loaded. Nothing was recorded.')
          return
        }
        const current = next.segment
        if (i + 1 < total) pending = fetchNext()
        startRef.current = false; nextRef.current = false; secRef.current = 0; simRef.current = null; setNotice('')
        setIndex(i + 1); setSegment(current); setResult(null); setTick(0); setPhase('rules')

        // Pre-commit: wait for enough rules and Start (no clock runs).
        while (!cancelled) {
          await clk.run(3_600_000, () => undefined, () => startRef.current)
          if (cancelled) return
          startRef.current = false
          if (ruleCount(rulesRef.current) >= params.minRules) break
          setNotice(`Choose at least ${params.minRules} rule${params.minRules === 1 ? '' : 's'} before you start.`)
        }
        setNotice('')
        const committed: Rules = { ...rulesRef.current }
        const sim = createSegmentSim(current, committed, { tilt: params.tilt >= 1 })
        simRef.current = sim; lotsRef.current = 1; setLots(1); setPhase('play')

        const speed = params.segMin / params.playMin
        const playMs = params.playMin * 60 * 1000
        await clk.run(playMs, ms => {
          secRef.current = Math.min(current.seconds, (ms / 1000) * speed)
          sim.advance(secRef.current)
          if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / playMs)})`
          setTick(t => t + 1)
        }, () => sim.ended !== null)
        if (cancelled) return
        sim.advance(current.seconds)
        const scored = scoreSegment(current, committed, sim.finish())
        results.push(scored); setResult(scored); setTick(t => t + 1); setPhase('result')
        await clk.run(300_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish(summariseNoTrade(results, latest.current.level))
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const trade = (direction: 1 | -1) => {
    const sim = simRef.current
    if (phase !== 'play' || !sim) return
    const out = sim.enter(direction, lotsRef.current, Math.floor(secRef.current))
    if (out.ok && params.warnings >= 1 && (out.violations.length || out.revenge)) setNotice(`Rule broken: ${out.revenge ? 'a revenge trade (soon after a loss, same or more lots)' : ''}${out.revenge && out.violations.length ? '; ' : ''}${out.violations.map(v => VIOLATION_TEXT[v]).join('; ')}.`)
    else if (out.ok) setNotice('')
    setTick(t => t + 1)
  }
  const leave = () => { const sim = simRef.current; if (phase === 'play' && sim) { sim.exit(Math.floor(secRef.current)); setNotice(''); setTick(t => t + 1) } }
  const chooseLots = (n: number) => { lotsRef.current = n; setLots(n) }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    const key = event.key.toLowerCase()
    if (phase === 'rules') { if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') { event.preventDefault(); event.stopPropagation(); startRef.current = true } return }
    if (phase === 'play') {
      if (key === 'l' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); trade(1) }
      else if (key === 's' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); trade(-1) }
      else if (key === 'e' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); leave() }
      else if (/^[1-3]$/.test(event.key)) { event.preventDefault(); event.stopPropagation(); chooseLots(Number(event.key)) }
    } else if (phase === 'result' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }

  const sim = simRef.current
  const data = useMemo(() => (segment ? segmentChart(segment, phase === 'play' || phase === 'result' ? simRef.current : null, phase === 'result' ? segment.seconds : secRef.current) : null), [segment, phase, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const warn = phase === 'play' && sim && params.warnings >= 1 && !sim.position ? sim.preview(lots, Math.floor(secRef.current)) : null
  const since = sim && phase === 'play' ? sim.sinceLoss(Math.floor(secRef.current)) : null

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => { if (phase !== 'rules') root.current?.focus() }}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Segment ${index} of ${total}`}</p>
      {phase === 'rules' && (
        <section className="games-rules" aria-label="Commit to your rules">
          <p className="games-sniper-setup">Commit to your rules before the segment starts. {params.minRules > 0 ? `Choose at least ${params.minRules}.` : 'Each one is optional.'} The game will not stop you from breaking them; it records it and takes points off.</p>
          {RULE_KEYS.map(key => {
            const lim = NO_TRADE_DAY.limits[key]
            return (
              <label key={key} className="games-rule-row">
                <input type="checkbox" checked={rules[key] !== undefined} onChange={event => setRule(key, event.target.checked ? lim.default : undefined)} />
                {RULE_LABEL[key]}
                <input type="number" min={lim.min} max={lim.max} value={rules[key] ?? lim.default} disabled={rules[key] === undefined} onChange={event => setRule(key, Number(event.target.value))} style={{ width: 64 }} aria-label={`${RULE_LABEL[key]} limit`} />
              </label>
            )
          })}
          {notice && <p role="alert" className="games-hotkey-message">{notice}</p>}
          <div className="games-market-pad"><button onClick={() => { startRef.current = true }}>Start the segment <kbd>Enter</kbd></button></div>
          <p className="games-hint">{ruleCount(rules)} rule{ruleCount(rules) === 1 ? '' : 's'} chosen. About {Math.round(params.playMin * 10) / 10} minutes of play, a {params.segMin} minute stretch of the market.</p>
        </section>
      )}
      {(phase === 'play' || phase === 'result') && segment && data && (
        <>
          <GameChart data={data} width={720} height={300} label="Price chart of the segment so far, from the starting price at zero" />
          <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'play'}><div ref={bar} /></div>
        </>
      )}
      {phase === 'play' && sim && (
        <>
          <p className="games-sniper-setup" role="status">Net {r(sim.netR)} · {sim.tradeCount} trade{sim.tradeCount === 1 ? '' : 's'} · {sim.violations} rule break{sim.violations === 1 ? '' : 's'}{sim.revenge ? ` · ${sim.revenge} revenge` : ''}{sim.position ? ` · in a ${sim.position.direction === 1 ? 'long' : 'short'} of ${sim.position.lots}: ${r(sim.position.openR)}` : ''}{since !== null && since <= (rules.cooldownSec ?? NO_TRADE_DAY.revengeSec) ? ` · ${Math.max(0, (rules.cooldownSec ?? NO_TRADE_DAY.revengeSec) - since)} s since a loss` : ''}</p>
          <div className="games-market-pad">
            <button onClick={() => trade(1)} disabled={!!sim.position}>LONG <kbd>L</kbd></button>
            <button onClick={() => trade(-1)} disabled={!!sim.position}>SHORT <kbd>S</kbd></button>
            <button onClick={leave} disabled={!sim.position}>EXIT <kbd>E</kbd></button>
            <span className="games-hotkey-lots">Lots {[1, 2, 3].map(n => <button key={n} onClick={() => chooseLots(n)} aria-pressed={lots === n}>{n}</button>)}</span>
          </div>
          <p className="games-hotkey-message" role="status">{notice || (warn && (warn.violations.length || warn.revenge) ? `Entering now would break a rule: ${warn.revenge ? 'revenge trade; ' : ''}${warn.violations.map(v => VIOLATION_TEXT[v]).join('; ')}.` : ' ')}</p>
          {sim.forcedLoss < 0 && <p className="games-meta" role="status">An earlier position was stopped out: −1.00 R.</p>}
        </>
      )}
      {phase === 'result' && segment && result && (
        <div className="games-market-flash" role="status">
          <p>Net <strong>{r(result.netR)}</strong> in {result.tradeCount} trade{result.tradeCount === 1 ? '' : 's'}; the best in hindsight with your trade limit was {r(result.opportunity)}. Rule breaks: {result.violations}, revenge trades: {result.revenge}.{result.ended === 'loss_limit' ? ' The segment ended at your loss limit.' : ''}</p>
          <p className="games-meta">Performance {Math.round(result.perf * 100)}%{result.standAside ? ' (a quiet segment and you stood aside: credit)' : ''} · discipline {Math.round(result.discipline * 100)}% · round score {Math.round(result.roundScore * 100)}%</p>
          {simRef.current?.trades.map((t, i) => <p key={i} className="games-meta">Trade {i + 1}: {t.direction === 1 ? 'long' : 'short'} {t.lots} at {clock(segment.startSec + t.entrySec)}, {r(t.r)} ({t.how === 'stop' ? 'stopped out' : t.how === 'exit' ? 'exited' : 'closed at the end'}){t.revenge ? ' · revenge trade' : ''}{t.violations.length ? ` · broke: ${t.violations.map(v => VIOLATION_TEXT[v]).join(', ')}` : ''}</p>)}
          <p className="games-meta">{segment.symbol} · {segment.date} · {clock(segment.startSec)} · Space for the next segment</p>
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
    </div>
  )
}
