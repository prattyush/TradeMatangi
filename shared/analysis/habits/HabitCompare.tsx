import { useMemo, useState } from 'react'
import { fmtNumber, fmtPct, fmtSigned } from './format'
import {
  COMPARE_METRICS, compareHabit, customPeriods, daysWithWithout, lastPeriods, tradingDays,
  type CompareCell, type CompareMetric, type Flag, type HabitComparison, type Period,
} from './habitSeries'
import type { HabitsOverview, StatMode, Unit } from './habitStats'
import type { LedgerTrade } from './types'

const FLAG_LABEL: Record<Flag, string> = { improving: 'Improving', worse: 'Worse', mixed: 'Mixed', same: 'Same', too_few: 'Too few trades' }
const PRESETS = [5, 10, 20] as const

interface Props { trades: LedgerTrade[]; overview: HabitsOverview; unit: Unit; mode: StatMode }

const COLUMN: Record<CompareMetric, { label: (unit: Unit) => string; title: string; show: (n: number | null, unit: Unit) => string; delta: (n: number, unit: Unit) => string }> = {
  per_day: { label: () => 'Per day', title: 'Trades with the habit per trading day in the period', show: n => (n == null ? '—' : n.toFixed(2)), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(2)}` },
  net: { label: u => (u === 'pct' ? 'Net %' : 'Net ₹'), title: 'Profit and loss of the habit’s trades added together', show: (n, u) => fmtSigned(n, u), delta: (n, u) => fmtSigned(n, u) },
  loss: { label: u => (u === 'pct' ? 'Loss %' : 'Loss ₹'), title: 'Total of the losing trades', show: (n, u) => fmtSigned(n, u), delta: (n, u) => fmtSigned(n, u) },
  capital: { label: () => 'Capital %', title: 'Capital deployed on a typical habit trade', show: n => fmtPct(n, 1), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(1)} pts` },
  bars: { label: () => 'Bars held', title: 'Candles a typical habit trade lasted', show: n => fmtNumber(n, 1), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(1)}` },
  within_1: { label: () => '≤ 1 bar', title: 'Share of habit trades closed within the candle they were entered in', show: n => fmtPct(n, 0), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(0)} pts` },
  entries: { label: () => 'Entries', title: 'Entry orders per trade', show: n => fmtNumber(n, 1), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(1)}` },
  exits: { label: () => 'Exits', title: 'Exit orders per trade', show: n => fmtNumber(n, 1), delta: n => `${n > 0 ? '+' : ''}${n.toFixed(1)}` },
}

function Cell({ metric, cell, unit }: { metric: CompareMetric; cell: CompareCell; unit: Unit }) {
  const column = COLUMN[metric]
  const arrow = cell.delta == null || Math.abs(cell.delta) < 1e-9 ? '' : cell.delta > 0 ? '▲' : '▼'
  return (
    <td className="hb-compare-cell">
      <span className="hb-before-after">{column.show(cell.before, unit)} → <b>{column.show(cell.recent, unit)}</b></span>
      {cell.delta != null && arrow && <small className={`hb-delta ${cell.tone}`} aria-label={`${cell.tone === 'good' ? 'Better' : cell.tone === 'bad' ? 'Worse' : 'Changed'} by ${column.delta(cell.delta, unit)}`}>{arrow} {column.delta(cell.delta, unit)}</small>}
    </td>
  )
}

const range = (period: Period) => `${period.start} – ${period.end} (${period.days.length} day${period.days.length === 1 ? '' : 's'})`

/** Two periods side by side per habit (Before → Recent) with an improving / same / worse flag. */
export default function HabitCompare({ trades, overview, unit, mode }: Props) {
  const days = useMemo(() => tradingDays(trades), [trades])
  const [preset, setPreset] = useState<number | 'custom'>(10)
  const [custom, setCustom] = useState({ beforeStart: '', beforeEnd: '', recentStart: '', recentEnd: '' })
  const periods = useMemo(() => {
    if (preset !== 'custom') return lastPeriods(days, preset)
    const { beforeStart, beforeEnd, recentStart, recentEnd } = custom
    return beforeStart && beforeEnd && recentStart && recentEnd ? customPeriods(days, [beforeStart, beforeEnd], [recentStart, recentEnd]) : null
  }, [days, preset, custom])
  const rows = useMemo(() => periods
    ? overview.habits.map(h => ({ h, result: compareHabit(trades, h.question_id, periods.before, periods.recent, unit, mode, h.verdict) as HabitComparison }))
        .filter(({ result }) => result.trades.before + result.trades.recent > 0)
    : [], [periods, overview.habits, trades, unit, mode])
  const choosePreset = (value: number | 'custom') => {
    if (value === 'custom' && !custom.beforeStart && days.length > 1) {
      const half = Math.floor(days.length / 2)
      setCustom({ beforeStart: days[0], beforeEnd: days[half - 1], recentStart: days[half], recentEnd: days[days.length - 1] })
    }
    setPreset(value)
  }
  const dateField = (key: keyof typeof custom, label: string) => (
    <label className="hb-field">{label}<input type="date" value={custom[key]} min={days[0]} max={days[days.length - 1]} onChange={event => setCustom(current => ({ ...current, [key]: event.target.value }))} /></label>
  )
  return (
    <>
      <section className="pa-card">
        <div className="pa-card-title">
          <div>
            <h3>Compare two periods</h3>
            <p>Each cell reads <i>before → recent</i>. “Improving” combines loss per day, how often the habit happens and the capital used on it (see the footnote).</p>
          </div>
        </div>
        <div className="hb-controls">
          <div className="hb-segmented" role="group" aria-label="Period length">
            {PRESETS.map(n => <button key={n} type="button" aria-pressed={preset === n} onClick={() => choosePreset(n)}>Last {n} days vs before</button>)}
            <button type="button" aria-pressed={preset === 'custom'} onClick={() => choosePreset('custom')}>Custom</button>
          </div>
        </div>
        {preset === 'custom' && (
          <div className="hb-controls">{dateField('beforeStart', 'Before: from')}{dateField('beforeEnd', 'to')}{dateField('recentStart', 'Recent: from')}{dateField('recentEnd', 'to')}</div>
        )}
        {!periods ? (
          <p className="pa-muted" role="status">
            {preset === 'custom' ? 'Pick two date ranges that each contain trading days.' : `Needs more than ${preset} trading days of history to compare the last ${preset} with the ${preset} before (${days.length} in this selection).`}
          </p>
        ) : (
          <>
            <p className="hb-periods"><span><b>Before</b> {range(periods.before)}</span><span><b>Recent</b> {range(periods.recent)}</span></p>
            {rows.length === 0 ? <p className="pa-muted">None of these habits occurred in either period.</p> : (
              <div className="pa-table-wrap">
                <table className="hb-table hb-compare">
                  <caption className="hb-visually-hidden">Habit comparison between two periods</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="hb-sticky">Habit</th>
                      <th scope="col" title="Improving: loss per day, frequency and capital together moved the right way. Worse: the opposite. Mixed: they disagree.">Trend</th>
                      <th scope="col" title="Trades with the habit">Trades</th>
                      {COMPARE_METRICS.map(metric => <th key={metric} scope="col" title={COLUMN[metric].title}>{COLUMN[metric].label(unit)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ h, result }) => (
                      <tr key={h.question_id} className={h.status === 'archived' ? 'archived' : ''}>
                        <th scope="row" className="hb-sticky">
                          <span className={`hb-kind ${h.kind}`}>{h.kind === 'entry' ? 'Entry' : 'Exit'}</span><span className="hb-name">{h.text}</span>
                        </th>
                        <td><span className={`hb-flag ${result.flag}`} title={result.reasons.join('. ')}>{FLAG_LABEL[result.flag]}</span></td>
                        <td>{result.trades.before} → <b>{result.trades.recent}</b></td>
                        {COMPARE_METRICS.map(metric => <Cell key={metric} metric={metric} cell={result.cells[metric]} unit={unit} />)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="pa-footnote">
              Colours judge results (net, loss) and, for a Costly or Rewarding habit, how often it happens; capital, bars and orders stay neutral — read them with the arrow.
              Trend needs 3 trades in each period; a change under 10% counts as unchanged. For a Costly habit, less loss, less often and less capital count as better; for a Rewarding habit, more often and more capital do; a Mixed habit is judged by loss alone.
              Per-day figures use the trading days in each period; typical values follow the Mean / Median switch.
            </p>
          </>
        )}
      </section>
      <section className="pa-card">
        <div className="pa-card-title"><div><h3>Days with vs without the habit</h3><p>How the whole day ended (all trades that day) when the habit did and did not occur, in the current filters.</p></div></div>
        <div className="pa-table-wrap">
          <table className="hb-table">
            <thead><tr><th scope="col" className="hb-sticky">Habit</th><th scope="col">Days with</th><th scope="col">{unit === 'pct' ? 'Avg day net %' : 'Avg day net ₹'}</th><th scope="col">Days without</th><th scope="col">{unit === 'pct' ? 'Avg day net %' : 'Avg day net ₹'}</th><th scope="col">Difference</th></tr></thead>
            <tbody>
              {overview.habits.map(h => {
                const r = daysWithWithout(trades, h.question_id, unit)
                const show = (n: number | null) => fmtSigned(n, unit)
                const tone = r.difference == null ? '' : r.difference >= 0 ? 'positive' : 'negative'
                return (
                  <tr key={h.question_id} className={h.status === 'archived' ? 'archived' : ''}>
                    <th scope="row" className="hb-sticky"><span className={`hb-kind ${h.kind}`}>{h.kind === 'entry' ? 'Entry' : 'Exit'}</span><span className="hb-name">{h.text}</span></th>
                    <td>{r.daysWith}</td><td>{show(r.netWith)}</td><td>{r.daysWithout}</td><td>{show(r.netWithout)}</td><td className={tone}>{show(r.difference)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

