import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDay, sideLabel, strengthLabel } from '../../deepdive/model'
import ChartFrame, { useMaximizedChart } from '../../deepdive/ui/ChartFrame'
import { friendlyError } from '../../deepdive/ui/errors'
import { useFillWindow } from '../../deepdive/ui/useFillWindow'
import { captureSentence, deltaText, pctText, pointsText, tripMarks } from '../model'
import type { PracticeReview as Review, ReviewSetup, ReviewTrade } from '../types'
import { usePracticeHost } from './host'
import '../../traded/ui/traded.css'

const clockOf = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

/** The review of an ended practice run: what you recorded, what it would have made, and how your trades compare. */
export default function PracticeReview({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { api } = usePracticeHost()
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [side, setSide] = useState(0)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    api.evaluate(sessionId).then(value => { if (alive) setReview(value) }, e => { if (alive) setError(friendlyError(e)) })
    return () => { alive = false }
  }, [api, sessionId, attempt])

  const setup = review?.setups[Math.min(side, (review?.setups.length ?? 1) - 1)] ?? null
  return <div className="pr-review">
    <div className="pl-bar">
      <button onClick={onBack}>← Back</button>
      {review && <strong>{review.category} / {review.strategy}</strong>}
      {review && <span className="pl-muted">{review.symbol} · {formatDay(review.date)} · started {review.start_time.slice(0, 5)}, {review.start_offset_min} min before the first recorded entry</span>}
    </div>
    {error && <p className="pl-error" role="alert">{error} <button onClick={() => setAttempt(n => n + 1)}>Try again</button></p>}
    {!review && !error && <p className="pl-muted" role="status">Loading the review… (prices for the recorded marks are read the first time)</p>}
    {review && <>
      {review.setups.length > 1 && <div className="pl-bar" role="tablist" aria-label="Recorded setups of this day">
        {review.setups.map((s, i) => <button key={s.side} role="tab" aria-selected={i === side} className={i === side ? 'pl-primary' : ''} onClick={() => setSide(i)}>{sideLabel(s.side)} setup</button>)}
      </div>}
      {setup && <SetupReview key={setup.side} review={review} setup={setup} />}
      {review.other_trades.length > 0 && <>
        <h4>Trades that matched no recorded setup</h4>
        <p className="pl-muted">These went the other way from what you recorded for the day, so there is nothing to compare them with.</p>
        <TradeTable trades={review.other_trades} />
      </>}
      {review.setups.every(s => s.trades.length === 0) && review.other_trades.length === 0 && <p className="pl-muted">You placed no trades in this run.</p>}
    </>}
  </div>
}

function SetupReview({ review, setup }: { review: Review; setup: ReviewSetup }) {
  const { Chart, historicalDays } = usePracticeHost()
  const ref = { category: review.category, strategy: review.strategy }
  const area = useRef<HTMLDivElement>(null)
  useFillWindow(area, { minHeight: 520 })
  const right = setup.side === 'buy' ? 'CE' : 'PE'
  const strike = (right === 'CE' ? setup.strike_ce : setup.strike_pe) ?? setup.trades.find(t => t.right === right)?.strike ?? null
  const expiry = setup.theoretical.find(t => t.instrument === right)?.expiry ?? setup.trades.find(t => t.right === right)?.expiry ?? undefined
  const { maximized, toggle } = useMaximizedChart<'underlying' | 'option'>('practice-review', strike ? ['underlying', 'option'] : ['underlying'])

  const marks = useMemo(() => {
    const mine = setup.trades.flatMap((trade, i) => tripMarks(trade, ref, setup.interval_minutes, `${setup.side}${i}`))
    const on = (instrument: string) => [...setup.annotations.filter(a => a.instrument === instrument), ...mine.filter(m => m.instrument === instrument)]
    return { underlying: on('underlying'), option: on(right) }
  }, [setup, right]) // eslint-disable-line react-hooks/exhaustive-deps
  const focusTime = setup.recorded.entry?.time ?? setup.trades[0]?.entry.time
  const chartProps = { symbol: review.symbol, date: review.date, historicalDays, activeStrategy: review.strategy, activeCategory: review.category, focusTime }
  const graded = setup.outcome === 'failed' ? 'Failed' : setup.outcome === 'success' ? (setup.strength ? strengthLabel(setup.strength) : 'Success') : null

  return <div className="pr-setup">
    <div className="pr-recorded">
      <span className={`dd-side-tag ${setup.side}`}>{sideLabel(setup.side)} setup</span>
      {graded && <span className={setup.outcome === 'failed' ? 'dd-bad' : 'dd-ok'}>{graded}</span>}
      <span>You recorded: entry <strong>{setup.recorded.entry?.clock ?? '—'}</strong> · exit <strong>{setup.recorded.exit?.clock ?? '—'}</strong></span>
      <span className="pl-muted">candle {setup.interval_minutes} min, IST</span>
    </div>
    <h4>What the recorded marks would have made</h4>
    <p className="pl-muted">Entry at the open of the marked candle, exit at the close of the marked candle; with several entries or exits, the most profitable pair.</p>
    <table className="dd-table pr-table">
      <thead><tr><th>Instrument</th><th>Entry</th><th>Exit</th><th>Result</th></tr></thead>
      <tbody>{setup.theoretical.map((t, i) => <tr key={i}>
        <td>{t.instrument === 'underlying' ? review.symbol : `${review.symbol} ${t.instrument} ${t.strike ?? ''}`}</td>
        {t.unavailable ? <td colSpan={3} className="pl-muted">{t.unavailable}</td> : <>
          <td>{t.entry?.clock} @ {t.entry?.price}</td><td>{t.exit?.clock} @ {t.exit?.price}</td>
          <td className={(t.points ?? 0) >= 0 ? 'dd-ok' : 'dd-bad'}>{pointsText(t.points)} ({pctText(t.pct)})</td></>}
      </tr>)}</tbody>
    </table>
    <h4>Your trades</h4>
    {setup.trades.length === 0 ? <p className="pl-muted">You placed no {sideLabel(setup.side)}-side trade on this day.</p> : <TradeTable trades={setup.trades} />}
    <p className="pl-muted td-legend" title="Gold ⚑ marks are the orders you placed. The other marks are the ones you recorded in the Deep Dive.">⚑ gold = your orders · other marks = what you recorded</p>
    <div className="td-charts" ref={area}>
      <ChartFrame className="td-chartbox" label={review.symbol} isMaximized={maximized === 'underlying'} isHidden={maximized === 'option'} onToggle={() => toggle('underlying')}>
        <Chart {...chartProps} title={`${review.symbol} · ${formatDay(review.date)}`} annotations={marks.underlying} />
      </ChartFrame>
      {strike && <ChartFrame className="td-chartbox" label={`${review.symbol} ${right} ${strike}`} isMaximized={maximized === 'option'} isHidden={maximized === 'underlying'} onToggle={() => toggle('option')}>
        <Chart {...chartProps} title={`${review.symbol} ${right} ${strike}`} strike={strike} right={right} expiry={expiry} annotations={marks.option} />
      </ChartFrame>}
    </div>
  </div>
}

function TradeTable({ trades }: { trades: ReviewTrade[] }) {
  return <table className="dd-table pr-table">
    <thead><tr><th>Trade</th><th>Entry</th><th>Exit</th><th>Points</th><th>P&L</th><th>Against the recorded</th></tr></thead>
    <tbody>{trades.map((t, i) => <tr key={`${t.index}-${i}`}>
      <td>{t.action === 'BUY' ? 'Bought' : 'Sold'} {t.instrument === 'underlying' ? '' : `${t.instrument} ${t.strike ?? ''}`} <span className="pl-muted">× {t.quantity}</span></td>
      <td>{clockOf(t.entry.time)} @ {t.entry.price}<div className="pl-muted">{deltaText(t.entry_delta_min, 'entry')}</div></td>
      <td>{t.exit ? <>{clockOf(t.exit.time)} @ {t.exit.price}<div className="pl-muted">{deltaText(t.exit_delta_min, 'exit')}</div></> : <span className="pl-muted">open</span>}</td>
      <td className={(t.points ?? 0) >= 0 ? 'dd-ok' : 'dd-bad'}>{pointsText(t.points)}</td>
      <td className={t.pnl >= 0 ? 'dd-ok' : 'dd-bad'}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}</td>
      <td>{captureSentence(t)}{t.theoretical_rupees !== null && t.theoretical_points !== null && t.theoretical_points > 0 ? <div className="pl-muted">On offer at your size: {t.theoretical_rupees.toFixed(2)} (before costs)</div> : null}</td>
    </tr>)}</tbody>
  </table>
}
