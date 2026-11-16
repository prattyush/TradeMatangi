import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReviewRow } from '../../../core/trial'
import { levelRow } from '../../review'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { GameChart } from '../../../chart/GameChart'
import type { Candle, ChartData, Level, Marker } from '../../../chart/chartModel'
import { browserStorage, createSeenWindows } from '../../data/seenWindows'
import { LEVEL_LABEL, type LevelKind } from '../../engine/levels'
import { aggregate, type Bars } from '../../engine/series'
import { createFrameClock } from '../../ui/frameClock'
import { clock } from '../tick_reader/format'
import { Ladder, type LadderLine } from './Ladder'
import { createLevelSource, isSequenceRound, scoreLevels, scoreSequence, sequenceTruth, summariseLevels, type LevelRound, type RoundResult } from './engine'

type Phase = 'loading' | 'study' | 'recall' | 'result'
const FIVE_MIN = 300
const SESSION_OPEN = 33_300

const minutesFrom = (bars: Bars, shift: number): Candle[] => { const five = aggregate(bars, FIVE_MIN); return five.t.map((t, i) => ({ t: (t - SESSION_OPEN) / 60 + shift, o: five.o[i], h: five.h[i], l: five.l[i], c: five.c[i] })) }

/** The study picture: yesterday and today so far as 5 minute candles, with the levels (and swing points) drawn on it. */
export function studyChart(round: LevelRound): ChartData {
  const candles = [...minutesFrom(round.prior, -450), ...minutesFrom(round.today, 0)]
  const levels: Level[] = round.levels.map(l => ({ y: l.value, label: LEVEL_LABEL[l.kind], colour: l.asked ? '#F0E442' : '#8b949e' }))
  const markers: Marker[] = round.swings.map((s, i) => ({ t: (s.t < 0 ? s.t + 86_400 - SESSION_OPEN : s.t - SESSION_OPEN) / 60 + (s.t < 0 ? -450 : 0), y: s.price, kind: s.type === 'high' ? 'short' : 'long', label: String(i + 1) }))
  const end = (round.roundSec - SESSION_OPEN) / 60
  const data: ChartData = { candles, xRange: [-455, end + 8] }
  if (levels.length) data.levels = levels
  if (markers.length) data.markers = markers
  return data
}

const fmt = (value: number): string => value.toFixed(2)

export default function LevelRecallView({ level, params, seed, suspended, market, onFinish, onAbort }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const skipRef = useRef(false)
  const submitRef = useRef(false)
  const nextRef = useRef(false)
  const placedRef = useRef<Partial<Record<LevelKind, number>>>({})
  const answersRef = useRef<Array<boolean | null>>([])
  const [phase, setPhase] = useState<Phase>('loading')
  const [round, setRound] = useState<LevelRound | null>(null)
  const [placed, setPlaced] = useState<Partial<Record<LevelKind, number>>>({})
  const [answers, setAnswers] = useState<Array<boolean | null>>([])
  const [cursor, setCursor] = useState(0)
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
      const seen = createSeenWindows(browserStorage(), market.userId, 'level_recall', market.today)
      const source = createLevelSource({ rng: createRng(seed), availability, data: market.data, seen: seen.recent(), onUsed: id => seen.add(id) })
      const results: RoundResult[] = []
      const rows: ReviewRow[] = []
      const ask = (i: number) => source.next({ levelCount: params.levelCount, distractors: params.distractors, mode: isSequenceRound(i, params.sequence) ? 'sequence' : 'levels' }, abort.signal)
      let pending = ask(0)
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
        if (i + 1 < total) pending = ask(i + 1)
        skipRef.current = false; submitRef.current = false; nextRef.current = false; placedRef.current = {}; answersRef.current = current.mode === 'sequence' ? Array(5).fill(null) : []
        setIndex(i + 1); setRound(current); setPlaced({}); setAnswers(answersRef.current.slice()); setCursor(0); setResult(null); setPhase('study')

        const studyMs = params.studySec * 1000
        await clk.run(studyMs, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / studyMs)})` }, () => skipRef.current)
        if (cancelled) return
        setPhase('recall')
        const recallMs = params.recallSec * 1000
        await clk.run(recallMs, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / recallMs)})` }, () => submitRef.current)
        if (cancelled) return

        let scored: RoundResult
        if (current.mode === 'sequence') {
          const s = scoreSequence(current.swings, answersRef.current)
          scored = { mode: 'sequence', roundScore: s.roundScore, errors: [], sequence: { correct: s.correct, total: s.total } }
        } else {
          const s = scoreLevels(current, placedRef.current, params.tolMult)
          scored = { mode: 'levels', roundScore: s.roundScore, errors: s.errors }
        }
        results.push(scored); rows.push(levelRow(rows.length + 1, current, scored))
        setResult(scored); setPhase('result')
        await clk.run(180_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish({ ...summariseLevels(results, latest.current.level), review: rows })
    })()
    return () => { cancelled = true; abort.abort(); clk.cancel() }
  }, [market, params, seed, total])

  const place = (price: number) => {
    if (phase !== 'recall' || !round || round.mode !== 'levels') return
    const kind = round.prompts[Math.min(cursor, round.prompts.length - 1)]
    placedRef.current = { ...placedRef.current, [kind]: price }
    setPlaced(placedRef.current)
    setCursor(c => Math.min(round.prompts.length, c + 1))
  }
  const undo = () => {
    if (phase !== 'recall' || !round || round.mode !== 'levels') return
    const target = Math.max(0, cursor - 1)
    const kind = round.prompts[target]
    const { [kind]: _removed, ...rest } = placedRef.current
    placedRef.current = rest; setPlaced(rest); setCursor(target)
  }
  const answer = (value: boolean) => {
    if (phase !== 'recall' || !round || round.mode !== 'sequence') return
    const k = answersRef.current.findIndex(v => v === null)
    if (k < 0) return
    answersRef.current = answersRef.current.map((v, i) => (i === k ? value : v)); setAnswers(answersRef.current.slice())
    if (k === answersRef.current.length - 1) submitRef.current = true
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (phase === 'study' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); skipRef.current = true }
    else if (phase === 'recall' && round?.mode === 'levels' && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submitRef.current = true }
    else if (phase === 'recall' && round?.mode === 'levels' && event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); undo() }
    else if (phase === 'recall' && round?.mode === 'sequence' && event.key.toLowerCase() === 'h') { event.preventDefault(); event.stopPropagation(); answer(true) }
    else if (phase === 'recall' && round?.mode === 'sequence' && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); answer(false) }
    else if (phase === 'result' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }

  const chart = useMemo(() => (round ? studyChart(round) : null), [round])
  const prompt = round && round.mode === 'levels' && cursor < round.prompts.length ? round.prompts[cursor] : null
  const lines: LadderLine[] = useMemo(() => {
    if (!round) return []
    const out: LadderLine[] = [{ label: `now ${fmt(round.price)}`, value: round.price, tone: 'now' }]
    for (const kind of round.prompts) { const v = placed[kind]; if (v !== undefined) out.push({ label: LEVEL_LABEL[kind], value: v, tone: 'placed' }) }
    if (phase === 'result') for (const l of round.levels.filter(x => x.asked)) out.push({ label: `${LEVEL_LABEL[l.kind]} (true ${fmt(l.value)})`, value: l.value, tone: 'truth' })
    return out
  }, [round, placed, phase])

  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Loading market data…' : `Round ${index} of ${total}${round?.mode === 'sequence' ? ' · swing sequence' : ''}`}</p>
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'study' || phase === 'recall'}><div ref={bar} /></div>
      {phase === 'study' && round && chart && (
        <>
          <p className="games-sniper-setup" role="status">{round.mode === 'levels' ? 'Memorise the levels. Yellow lines are the ones you will place; grey lines are not asked.' : 'Study the six swing points in order. You will say whether each was higher or lower than the one before.'}</p>
          <GameChart data={chart} label={`Chart of yesterday and today so far with ${round.levels.length} labelled levels`} width={720} height={340} />
          <div className="games-market-pad"><button onClick={() => { skipRef.current = true }}>I am ready <kbd>Enter</kbd></button></div>
        </>
      )}
      {phase === 'recall' && round?.mode === 'levels' && (
        <>
          <p className="games-sniper-setup" role="status">{prompt ? <>Click where <strong>{LEVEL_LABEL[prompt]}</strong> is ({round.prompts.length - cursor} to place).</> : 'All placed. Press Enter to submit, or click to change the last one.'}</p>
          <Ladder lo={round.axis.lo} hi={round.axis.hi} lines={lines} onPlace={place} label="Blank price ladder: click to place the named level" />
          <div className="games-market-pad"><button onClick={undo} disabled={cursor === 0}>Undo <kbd>Backspace</kbd></button><button onClick={() => { submitRef.current = true }}>Submit <kbd>Enter</kbd></button></div>
        </>
      )}
      {phase === 'recall' && round?.mode === 'sequence' && (
        <>
          {(() => {
            const k = answers.findIndex(v => v === null)
            return <p className="games-sniper-setup" role="status">{k >= 0 ? <>Swing <strong>{k + 2}</strong> compared with swing <strong>{k + 1}</strong>: higher or lower?</> : 'Done.'}</p>
          })()}
          <div className="games-market-pad"><button onClick={() => answer(true)}>Higher <kbd>H</kbd></button><button onClick={() => answer(false)}>Lower <kbd>L</kbd></button></div>
          <p className="games-hint">{answers.map(v => (v === null ? '·' : v ? '↑' : '↓')).join(' ')}</p>
        </>
      )}
      {phase === 'result' && round && result && (
        <div className="games-market-flash" role="status">
          {result.mode === 'levels' ? (
            <>
              <p>{Math.round(result.roundScore * 100)}% for this round (error scored against {fmt(params.tolMult * round.volDay)} points).</p>
              <table className="games-strike-table" aria-label="Your levels against the true ones">
                <thead><tr><th>Level</th><th>You</th><th>True</th><th>Error</th></tr></thead>
                <tbody>{result.errors.map(e => <tr key={e.kind}><th scope="row">{LEVEL_LABEL[e.kind]}</th><td>{e.placed === null ? '—' : fmt(e.placed)}</td><td>{fmt(e.truth)}</td><td>{e.errorPts === null ? 'not placed' : `${fmt(e.errorPts)} pts (${(e.errorUnits ?? 0).toFixed(2)} units)`}</td></tr>)}</tbody>
              </table>
              <Ladder lo={round.axis.lo} hi={round.axis.hi} lines={lines} disabled label="Your levels (yellow) against the true levels (blue)" />
            </>
          ) : (
            <p>{result.sequence?.correct} of {result.sequence?.total} right. The truth was: {sequenceTruth(round.swings).map(v => (v ? 'higher' : 'lower')).join(', ')}.</p>
          )}
          <p className="games-meta">{round.symbol} · {round.date} (yesterday {round.priorDate}) · {clock(round.roundSec)} · Press Space for the next round</p>
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
    </div>
  )
}
