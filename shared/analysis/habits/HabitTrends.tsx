import { useMemo, useState } from 'react'
import { fmtMoney, fmtNumber, fmtPct, fmtSigned } from './format'
import { SERIES_METRICS, daySeries, rollingMean, tradingDays, type SeriesMetric } from './habitSeries'
import type { HabitsOverview, StatMode, Unit } from './habitStats'
import MultiLineChart from './MultiLineChart'
import type { LedgerTrade } from './types'

const PALETTE = ['#8b9dff', '#36c9a0', '#fbbf24', '#fb7185', '#38bdf8', '#c084fc', '#f97316', '#a3e635']
const ROLLING_DAYS = 5
const MAX_DEFAULT_HABITS = 4

interface Props {
  trades: LedgerTrade[]
  overview: HabitsOverview
  unit: Unit
  mode: StatMode
  onOpenTrade?: (identity: { session_id: string; cycle_id: string }) => void
}

const istTime = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

/** Per-day line chart of a chosen metric, one line per habit, with a click-through to the day's trades. */
export default function HabitTrends({ trades, overview, unit, mode, onOpenTrade }: Props) {
  const [metric, setMetric] = useState<SeriesMetric>('net')
  const [rolling, setRolling] = useState(false)
  const habits = overview.habits
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const selected = useMemo(() => {
    const ids = chosen ?? [...habits].sort((a, b) => b.habit.trades - a.habit.trades).slice(0, MAX_DEFAULT_HABITS).map(h => h.question_id)
    return habits.filter(h => ids.includes(h.question_id))
  }, [chosen, habits])
  const days = useMemo(() => tradingDays(trades), [trades])
  const colorOf = (id: string) => PALETTE[habits.findIndex(h => h.question_id === id) % PALETTE.length]
  const series = selected.map(h => {
    const raw = daySeries(trades, days, h.question_id, metric, unit, mode).map(p => p.value)
    return { id: h.question_id, label: h.text, color: colorOf(h.question_id), values: rolling ? rollingMean(raw, ROLLING_DAYS) : raw }
  })
  const results = metric === 'net' || metric === 'loss' || metric === 'profit'
  const format = (n: number) => {
    if (results) return unit === 'pct' ? fmtPct(n, Math.abs(n) < 10 ? 2 : 1) : fmtMoney(n)
    if (metric === 'capital') return fmtPct(n, 1)
    if (metric === 'within_1') return fmtPct(n, 0)
    return fmtNumber(n, Number.isInteger(n) ? 0 : 1)
  }
  const toggle = (id: string) => setChosen(current => {
    const base = current ?? selected.map(h => h.question_id)
    return base.includes(id) ? base.filter(x => x !== id) : [...base, id]
  })
  const dayRows = day ? trades.filter(t => t.date === day && selected.some(h => t.habits.includes(h.question_id))) : []
  const unitNote = results ? (unit === 'pct' ? ' (% of capital)' : ' (₹)') : ''

  return (
    <section className="pa-card hb-trends">
      <div className="pa-card-title">
        <div>
          <h3>Habits across days</h3>
          <p>{SERIES_METRICS[metric].help}. {SERIES_METRICS[metric].empty === 'gap' ? 'Days without the habit are gaps.' : 'Days without the habit show 0.'}</p>
        </div>
      </div>
      <div className="hb-controls">
        <label className="hb-field">Metric
          <select value={metric} onChange={event => { setMetric(event.target.value as SeriesMetric); setDay(null) }}>
            {(Object.keys(SERIES_METRICS) as SeriesMetric[]).map(id => <option key={id} value={id}>{SERIES_METRICS[id].label}</option>)}
          </select>
        </label>
        <label className="hb-check"><input type="checkbox" checked={rolling} onChange={event => setRolling(event.target.checked)} /> {ROLLING_DAYS}-day average</label>
      </div>
      <div className="hb-legend" role="group" aria-label="Habits shown">
        {habits.map(h => {
          const on = selected.some(s => s.question_id === h.question_id)
          return (
            <button key={h.question_id} type="button" aria-pressed={on} className={`hb-chip ${on ? 'on' : ''}`} onClick={() => toggle(h.question_id)}>
              <i style={{ background: on ? colorOf(h.question_id) : 'transparent', borderColor: colorOf(h.question_id) }} />{h.text}
            </button>
          )
        })}
      </div>
      {selected.length === 0
        ? <p className="pa-muted">Choose at least one habit above.</p>
        : <MultiLineChart days={days} series={series} format={format} selectedDay={day} onSelectDay={setDay}
            ariaLabel={`${SERIES_METRICS[metric].label}${unitNote} per trading day for ${selected.map(h => h.text).join(', ')}${rolling ? `, ${ROLLING_DAYS}-day average` : ''}`} />}
      {day && (
        <div className="hb-day">
          <div className="pa-card-title">
            <div><h4>{day}: trades carrying the shown habits</h4></div>
            <button type="button" onClick={() => setDay(null)}>Close</button>
          </div>
          {dayRows.length === 0 ? <p className="pa-muted">None of the shown habits occurred on this day.</p> : (
            <div className="pa-table-wrap">
              <table>
                <caption className="hb-visually-hidden">Trades on {day} carrying the shown habits</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Instrument</th><th scope="col">Habits</th><th scope="col">P&amp;L</th><th scope="col">Capital %</th><th scope="col">Bars</th><th scope="col"><span className="hb-visually-hidden">Open</span></th></tr></thead>
                <tbody>
                  {dayRows.map(t => (
                    <tr key={t.cycle_id}>
                      <td>{istTime(t.entry_time)}</td>
                      <td>{[t.symbol, t.strike, t.right].filter(Boolean).join(' ')}</td>
                      <td>{t.habits.map(id => habits.find(h => h.question_id === id)?.text).filter(Boolean).join(' · ')}</td>
                      <td className={(unit === 'pct' ? t.pnl_pct : t.net_pnl) == null ? '' : (unit === 'pct' ? t.pnl_pct! : t.net_pnl) >= 0 ? 'positive' : 'negative'}>{fmtSigned(unit === 'pct' ? t.pnl_pct : t.net_pnl, unit)}</td>
                      <td>{fmtPct(t.capital_pct, 1)}</td>
                      <td>{t.bars ?? '—'}</td>
                      <td>{onOpenTrade && <button type="button" onClick={() => onOpenTrade({ session_id: t.session_id, cycle_id: t.cycle_id })} aria-label={`Open trade at ${istTime(t.entry_time)} on ${t.date}`}>Open</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
