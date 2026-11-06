import { useMemo, useState } from 'react'
import { fmtDuration, fmtMoney, fmtNumber, fmtPct, fmtShare, fmtSigned } from './format'
import {
  barBuckets, capitalBuckets, quickLosses, scatterPoints, sortTrades, timeBuckets, weekdayBuckets, MIN_TERCILE_TRADES, type BucketRow, type TradeSort,
} from './deepDiveStats'
import { metric, type HabitsOverview, type SortKey, type StatMode, type Unit } from './habitStats'
import { SCORE_COLUMNS, VERDICT_LABEL } from './HabitScorecard'
import ScatterPlot from './ScatterPlot'
import type { LedgerTrade } from './types'

const TILES: SortKey[] = ['trades', 'days', 'net', 'profit', 'loss', 'win_pct', 'average', 'vs_without', 'if_skipped', 'capital', 'bars', 'within_1', 'loser_within_1']
const PAGE = 25
const istTime = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

interface Props {
  trades: LedgerTrade[]
  overview: HabitsOverview
  unit: Unit
  mode: StatMode
  habitId: string | null
  onSelectHabit: (id: string) => void
  onOpenTrade?: (identity: { session_id: string; cycle_id: string }) => void
}

function BucketTable({ title, caption, rows, unit, empty }: { title: string; caption: string; rows: BucketRow[]; unit: Unit; empty?: string }) {
  const extent = Math.max(...rows.map(r => Math.abs(r.net ?? 0)), 1e-9)
  return (
    <section className="pa-card hb-bucket">
      <h4>{title}</h4>
      <p className="hb-hint">{caption}</p>
      {rows.length === 0 ? <p className="pa-muted">{empty ?? 'No trades.'}</p> : (
        <div className="pa-table-wrap">
          <table>
            <caption className="hb-visually-hidden">{title}</caption>
            <thead><tr><th scope="col">Group</th><th scope="col">Trades</th><th scope="col">{unit === 'pct' ? 'Net %' : 'Net ₹'}</th><th scope="col">Win %</th><th scope="col">Avg / trade</th></tr></thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td>{row.count}</td>
                  <td className={row.net == null ? '' : row.net >= 0 ? 'positive' : 'negative'}>
                    {fmtSigned(row.net, unit)}
                    {row.net != null && <span className={`hb-minibar ${row.net >= 0 ? 'positive' : 'negative'}`} style={{ width: `${Math.max(2, (Math.abs(row.net) / extent) * 60)}px` }} aria-hidden="true" />}
                  </td>
                  <td>{fmtPct(row.win_pct, 0)}</td>
                  <td className={row.average == null ? '' : row.average >= 0 ? 'positive' : 'negative'}>{fmtSigned(row.average, unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** One habit in depth: results by bars held, capital %, time of day and weekday; a capital-vs-result scatter; and its trades. */
export default function HabitDeepDive({ trades, overview, unit, mode, habitId, onSelectHabit, onOpenTrade }: Props) {
  const summary = overview.habits.find(h => h.question_id === habitId) ?? overview.habits[0]
  const [sort, setSort] = useState<{ key: TradeSort; direction: 'asc' | 'desc' }>({ key: 'date', direction: 'desc' })
  const [shown, setShown] = useState(PAGE)
  const own = useMemo(() => (summary ? trades.filter(t => t.habits.includes(summary.question_id)) : []), [trades, summary])
  const analysis = useMemo(() => ({
    bars: barBuckets(own, unit, mode),
    capital: capitalBuckets(own, trades, unit, mode),
    time: timeBuckets(own, unit, mode),
    weekday: weekdayBuckets(own, unit, mode),
    quick: quickLosses(own, unit),
    points: scatterPoints(own, unit),
    rows: sortTrades(own, sort.key, sort.direction, unit),
  }), [own, trades, unit, mode, sort])
  if (!summary) return <section className="pa-card"><p className="pa-muted">No habit to show.</p></section>
  const habitName = (id: string) => overview.habits.find(h => h.question_id === id)?.text
  const choose = (key: TradeSort) => { setShown(PAGE); setSort(current => current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: key === 'date' ? 'desc' : 'desc' }) }
  const ariaSort = (key: TradeSort) => (sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none'
  const head = (key: TradeSort, label: string) => <th scope="col" aria-sort={ariaSort(key)}><button type="button" onClick={() => choose(key)}>{label}{sort.key === key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>
  const missingCapital = own.filter(t => t.capital_pct == null).length, missingBars = own.filter(t => t.bars == null).length
  const q = analysis.quick

  return (
    <div className="hb-deep">
      <section className="pa-card">
        <div className="pa-card-title">
          <div>
            <h3>Habit deep dive</h3>
            <p>{summary.verdict_reason}</p>
          </div>
        </div>
        <div className="hb-controls">
          <label className="hb-field">Habit
            <select value={summary.question_id} onChange={event => { onSelectHabit(event.target.value); setShown(PAGE) }}>
              {overview.habits.map(h => <option key={h.question_id} value={h.question_id}>{h.kind === 'entry' ? 'Entry' : 'Exit'} · {h.text}{h.status === 'archived' ? ' (archived)' : ''}</option>)}
            </select>
          </label>
          <span className={`hb-verdict ${summary.verdict}`} title={summary.verdict_reason}>{VERDICT_LABEL[summary.verdict]}</span>
          <span className={`hb-kind ${summary.kind}`}>{summary.kind === 'entry' ? 'Entry habit' : 'Exit habit'}</span>
        </div>
        <div className="hb-tiles">
          {TILES.map(key => {
            const column = SCORE_COLUMNS[key]
            const value = metric(summary, key, unit, mode) as number | null
            const tone = column.signed && value != null && value !== 0 ? (value > 0 ? 'positive' : 'negative') : ''
            return <div key={key} className="hb-tile" title={column.title}><span>{column.label(unit, mode)}</span><strong className={tone}>{column.render(value, unit)}</strong></div>
          })}
        </div>
      </section>

      {q.losers > 0 && (
        <section className="pa-card hb-quick">
          <h4>Losses closed within one bar</h4>
          {q.quick_pct == null
            ? <p className="pa-muted">None of this habit’s {q.losers} losing trades has a bar count, so quick exits cannot be measured.</p>
            : <p>
                <strong>{q.quick} of {q.known}</strong> losing trades ({fmtShare(q.quick_pct)}) were closed inside the candle they were entered in
                {q.quick_loss_share != null && <>, accounting for <strong>{fmtShare(q.quick_loss_share)}</strong> of this habit’s total loss ({fmtSigned(q.quick_loss, unit)}).</>}
              </p>}
        </section>
      )}

      <div className="hb-bucket-grid">
        <BucketTable title="By bars held" caption="Candles the trade touched; 1 bar = entered and exited inside the same candle." rows={analysis.bars} unit={unit} />
        {analysis.capital
          ? <BucketTable title="By capital used" caption="Thirds of all your trades in these filters, by capital deployed." rows={analysis.capital.rows} unit={unit} />
          : <section className="pa-card hb-bucket"><h4>By capital used</h4><p className="pa-muted">Needs at least {MIN_TERCILE_TRADES} trades with a capital % (and some spread) in these filters to split into thirds.</p></section>}
        <BucketTable title="By time of day" caption="Half-hour of the entry (IST)." rows={analysis.time} unit={unit} />
        <BucketTable title="By weekday" caption="Day of the week of the trade." rows={analysis.weekday} unit={unit} />
      </div>

      <section className="pa-card">
        <div className="pa-card-title"><div><h3>Size against result</h3><p>Each dot is one trade with this habit. Dots above the line made money; lighter dots are more recent — look for them moving left (smaller size) over time.</p></div></div>
        <ScatterPlot points={analysis.points} unit={unit}
          ariaLabel={`Capital deployed against ${unit === 'pct' ? 'P&L %' : 'P&L'} for ${analysis.points.length} trades with the habit ${summary.text}`}
          onOpen={point => onOpenTrade?.({ session_id: point.trade.session_id, cycle_id: point.trade.cycle_id })} />
      </section>

      <section className="pa-card">
        <div className="pa-card-title"><div><h3>Trades with this habit</h3><p>{own.length} closed trades · click a heading to sort</p></div></div>
        <div className="pa-table-wrap">
          <table className="hb-table hb-trades">
            <caption className="hb-visually-hidden">Trades carrying the habit {summary.text}</caption>
            <thead>
              <tr>
                {head('date', 'Date')}<th scope="col">Instrument</th>{head('pnl', unit === 'pct' ? 'P&L %' : 'P&L ₹')}{head('capital', 'Capital %')}{head('risk', 'Risk %')}{head('bars', 'Bars')}{head('held', 'Held')}{head('entries', 'Entries')}{head('exits', 'Exits')}
                <th scope="col">Other habits</th><th scope="col"><span className="hb-visually-hidden">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {analysis.rows.slice(0, shown).map(t => {
                const result = unit === 'pct' ? t.pnl_pct : t.net_pnl
                return (
                  <tr key={t.cycle_id}>
                    <th scope="row" title={t.created_date ? `Session run on ${t.created_date}` : undefined}>{t.date} {istTime(t.entry_time)}</th>
                    <td>{[t.symbol, t.strike, t.right].filter(Boolean).join(' ')}</td>
                    <td className={result == null || result === 0 ? '' : result > 0 ? 'positive' : 'negative'}>{fmtSigned(result, unit)}</td>
                    <td>{fmtPct(t.capital_pct, 1)}</td><td>{fmtPct(t.risk_pct, 2)}</td><td>{t.bars ?? '—'}</td><td>{fmtDuration(t.holding_seconds)}</td><td>{t.entries}</td><td>{t.exits}</td>
                    <td>{t.habits.filter(id => id !== summary.question_id).map(habitName).filter(Boolean).join(' · ') || '—'}</td>
                    <td>{onOpenTrade && <button type="button" onClick={() => onOpenTrade({ session_id: t.session_id, cycle_id: t.cycle_id })} aria-label={`Open trade on ${t.date} at ${istTime(t.entry_time)}`}>Open</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {analysis.rows.length > shown && <button type="button" className="hb-more" onClick={() => setShown(value => value + PAGE)}>Show {Math.min(PAGE, analysis.rows.length - shown)} more of {analysis.rows.length - shown} remaining</button>}
        <p className="pa-footnote">{missingCapital > 0 ? `${missingCapital} of ${own.length} trades have no capital % (older or imported fills) and are left out of the capital figures and the scatter. ` : ''}{missingBars > 0 ? `${missingBars} have no bar count. ` : ''}Money values: {fmtMoney(summary.habit.net_pnl)} net over {summary.habit.trades} trades; averages use {mode === 'mean' ? 'means' : 'medians'}; entries/exits average {fmtNumber(summary.profile.entries[mode], 1)} / {fmtNumber(summary.profile.exits[mode], 1)}.</p>
      </section>
    </div>
  )
}
