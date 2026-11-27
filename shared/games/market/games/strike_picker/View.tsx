import { useEffect, useRef, useState } from 'react'
import type { ReviewRow } from '../../../core/trial'
import { pickRow } from '../../review'
import { createRng } from '../../../core/rng'
import type { GameViewProps } from '../../../core/types'
import { STRIKE_PICKER } from '../../config/difficulty.market'
import { createFrameClock } from '../../ui/frameClock'
import { explain, makeScenario, OBJECTIVE_TEXT, offsetLabel, priceChain, scorePick, summarisePicks, type MarketSpec, type PickResult, type Scenario, type StrikeRow } from './engine'

type Phase = 'loading' | 'pick' | 'result'
const OFFSETS = Array.from({ length: STRIKE_PICKER.strikesEachSide * 2 + 1 }, (_, i) => i - STRIKE_PICKER.strikesEachSide)

const money = (value: number): string => `${value < 0 ? '−' : ''}₹${Math.abs(Math.round(value)).toLocaleString('en-IN')}`
const num = (value: number, digits = 2): string => (Math.abs(value) < 5e-5 ? '0' : value.toFixed(digits))

export default function StrikePickerView({ level, params, seed, suspended, market, onFinish }: GameViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const pickRef = useRef<number | null | undefined>(undefined)
  const nextRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [rows, setRows] = useState<StrikeRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [result, setResult] = useState<PickResult | null>(null)
  const [index, setIndex] = useState(0)
  const total = params.scenarios
  const latest = useRef({ onFinish, level })
  latest.current = { onFinish, level }

  useEffect(() => { root.current?.focus() }, [phase])

  useEffect(() => {
    let cancelled = false
    const clk = createFrameClock({ suspended: () => suspendedRef.current })
    ;(async () => {
      // The lot size and strike step come from the server's availability (the same for every user); offline the NIFTY values are used.
      let specs: MarketSpec[] = []
      try {
        const availability = await market?.data.availability()
        specs = Object.entries(availability?.symbols ?? {}).filter(([, e]) => e.lot_size && e.strike_step && e.dates?.length)
          .map(([symbol, e]) => ({ symbol, lotSize: Number(e.lot_size), strikeStep: Number(e.strike_step) }))
      } catch { /* offline: defaults */ }
      if (cancelled) return
      const rng = createRng(seed)
      const results: PickResult[] = []
      const rows: ReviewRow[] = []
      for (let i = 0; i < total && !cancelled; i++) {
        const next = makeScenario(rng, { dteSet: params.dteSet, minutes: params.minutes, ivShiftShare: params.ivShiftShare, failShare: params.failShare, objectives: params.objectives }, specs)
        const chain = priceChain(next)
        pickRef.current = undefined; nextRef.current = false
        setScenario(next); setRows(chain); setCursor(3); setResult(null); setIndex(i + 1); setPhase('pick')
        const limit = params.decisionSec * 1000
        await clk.run(limit, ms => { if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, 1 - ms / limit)})` }, () => pickRef.current !== undefined)
        if (cancelled) return
        const scored = scorePick(chain, pickRef.current ?? null)
        results.push(scored); rows.push(pickRow(rows.length + 1, next, scored))
        setResult(scored); setPhase('result')
        await clk.run(120_000, () => undefined, () => nextRef.current)
      }
      if (!cancelled) latest.current.onFinish({ ...summarisePicks(results, latest.current.level), review: rows })
    })()
    return () => { cancelled = true; clk.cancel() }
  }, [market, params, seed, total])

  const choose = (offset: number) => { if (phase === 'pick' && pickRef.current === undefined) pickRef.current = offset }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.repeat) return
    if (phase === 'pick') {
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setCursor(c => Math.max(0, c - 1)) }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); setCursor(c => Math.min(OFFSETS.length - 1, c + 1)) }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(OFFSETS[cursor]) }
      else if (/^[1-7]$/.test(event.key)) { event.preventDefault(); event.stopPropagation(); choose(OFFSETS[Number(event.key) - 1]) }
    } else if (phase === 'result' && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); nextRef.current = true }
  }

  const s = scenario
  const best = rows.length ? rows.reduce((a, b) => (b.metric > a.metric ? b : a)) : null
  return (
    <div ref={root} className="games-market" tabIndex={0} onKeyDown={onKeyDown} onBlur={() => root.current?.focus()}>
      <p className="games-meta" role="status">{phase === 'loading' ? 'Getting ready…' : `Scenario ${index} of ${total}`}</p>
      <div className="games-countdown-bar" aria-hidden="true" data-active={phase === 'pick'}><div ref={bar} /></div>
      {s && (
        <div className="games-strike-card" role="status">
          <p><strong>{s.right === 'CE' ? 'Buy a call (CE)' : 'Buy a put (PE)'}</strong> on an index at {s.spot.toLocaleString('en-IN')}, lot {s.lotSize}, strikes {s.strikeStep} apart.</p>
          <p>{s.dte === 0 ? 'Expiry day' : `${s.dte} day${s.dte > 1 ? 's' : ''} to expiry`} · implied volatility {s.ivRegime} ({Math.round(s.iv * 100)}%) · expected move <strong>{s.expectedMove > 0 ? '+' : '−'}{Math.abs(s.expectedMove)} points</strong> in about {s.minutes} minutes.</p>
          <p><strong>{OBJECTIVE_TEXT[s.objective](s)}</strong></p>
        </div>
      )}
      {rows.length > 0 && (
        <table className="games-strike-table" aria-label={phase === 'pick' ? 'Choose a strike' : 'Result for every strike'}>
          <thead>
            <tr><th>Strike</th><th>Premium</th>{phase === 'result' && <><th>After</th><th>Delta</th><th>Gamma</th><th>Theta/day</th><th>Spread</th><th>₹ per lot</th><th>Return</th>{s?.objective === 'capital_pnl' && <th>Lots · ₹ on capital</th>}</>}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.offset} data-active={phase === 'pick' && i === cursor} data-best={phase === 'result' && best?.offset === row.offset} data-pick={phase === 'result' && result?.offset === row.offset}
                onClick={() => choose(row.offset)} onMouseEnter={() => phase === 'pick' && setCursor(i)}>
                <th scope="row"><button disabled={phase !== 'pick'} onClick={() => choose(row.offset)}>{i + 1} · {offsetLabel(row.offset)} {row.strike}</button></th>
                <td>{num(row.premium)}</td>
                {phase === 'result' && <>
                  <td>{num(row.premiumAfter)}</td><td>{num(row.delta)}</td><td>{num(row.gamma, 4)}</td><td>{num(row.theta)}</td><td>{num(row.spread)}</td>
                  <td>{money(row.pnlPerLot)}</td><td>{num(row.returnPct, 1)}%</td>{s?.objective === 'capital_pnl' && <td>{row.lots} · {money(row.pnlOnCapital)}</td>}
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {phase === 'pick' && <p className="games-hint">Up and down arrows or 1 to 7 to choose, Enter to confirm. Premiums are per unit, in points.</p>}
      {phase === 'result' && s && result && (
        <div className="games-market-flash" role="status">
          <p>{result.timedOut ? 'Time ran out: no strike chosen.' : `You picked ${offsetLabel(result.offset ?? 0)}: ${Math.round(result.roundScore * 100)}% of the way from the worst strike to the best.`}</p>
          {explain(s, rows, result).map(line => <p key={line}>{line}</p>)}
          <div className="games-market-pad"><button onClick={() => { nextRef.current = true }}>Next <kbd>Space</kbd></button></div>
        </div>
      )}
    </div>
  )
}
