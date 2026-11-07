import { useMemo, useState } from 'react'
import { fmtDuration, fmtNumber, fmtPct, fmtShare, fmtSigned, tint } from './format'
import { metric, sortHabits, type HabitSummary, type SortKey, type StatMode, type Unit, type Verdict } from './habitStats'

export type ColumnSet = 'results' | 'size'

export interface Column {
  key: SortKey
  label: (unit: Unit, mode: StatMode) => string
  title?: string
  render: (value: number | null, unit: Unit) => string
  /** Tint by sign (positive = good). */
  signed?: boolean
}

const avg = (mode: StatMode) => (mode === 'mean' ? 'Avg' : 'Median')
export const SCORE_COLUMNS: Record<SortKey, Column> = {
  text: { key: 'text', label: () => 'Habit', render: () => '' },
  trades: { key: 'trades', label: () => 'Trades', title: 'Closed trades carrying this habit', render: v => fmtNumber(v, 0) },
  days: { key: 'days', label: () => 'Days', title: 'Trading days with at least one trade carrying this habit', render: v => fmtNumber(v, 0) },
  net: { key: 'net', label: u => (u === 'pct' ? 'Net %' : 'Net ₹'), title: 'Profit and loss of the trades with this habit added together; % is percent of capital, summed over trades', render: (v, u) => fmtSigned(v, u), signed: true },
  profit: { key: 'profit', label: u => (u === 'pct' ? 'Profit %' : 'Profit ₹'), title: 'Sum of the winning trades', render: (v, u) => fmtSigned(v, u), signed: true },
  loss: { key: 'loss', label: u => (u === 'pct' ? 'Loss %' : 'Loss ₹'), title: 'Sum of the losing trades', render: (v, u) => fmtSigned(v, u), signed: true },
  win_pct: { key: 'win_pct', label: () => 'Win %', render: v => fmtPct(v, 0) },
  average: { key: 'average', label: (u, m) => `${avg(m)} ${u === 'pct' ? '%' : '₹'} / trade`, title: 'Result of a typical trade with this habit', render: (v, u) => fmtSigned(v, u), signed: true },
  vs_without: { key: 'vs_without', label: () => 'vs without', title: 'Typical trade with the habit minus a typical trade without it, in the same period. Negative: the habit trades do worse.', render: (v, u) => fmtSigned(v, u), signed: true },
  if_skipped: { key: 'if_skipped', label: u => (u === 'pct' ? 'If skipped %' : 'If skipped ₹'), title: 'What you would have gained (positive) or given up (negative) by not taking these trades', render: (v, u) => fmtSigned(v, u), signed: true },
  share_loss: { key: 'share_loss', label: () => 'Share of losses', title: "Part of all losing % in this period that came from this habit's trades. Habits overlap, so shares do not add up to 100%.", render: v => fmtShare(v) },
  share_profit: { key: 'share_profit', label: () => 'Share of profits', title: "Part of all winning % in this period that came from this habit's trades. Habits overlap, so shares do not add up to 100%.", render: v => fmtShare(v) },
  profit_factor: { key: 'profit_factor', label: () => 'Profit factor', title: 'Winning total ÷ losing total. Below 1 loses money.', render: v => fmtNumber(v, 2) },
  payoff: { key: 'payoff', label: () => 'Payoff', title: 'Average win ÷ average loss', render: v => fmtNumber(v, 2) },
  largest_loss: { key: 'largest_loss', label: u => (u === 'pct' ? 'Worst loss %' : 'Worst loss ₹'), render: (v, u) => fmtSigned(v, u), signed: true },
  entries: { key: 'entries', label: (_u, m) => `${avg(m)} entries`, title: 'Entry orders per trade (scale-ins add entries)', render: v => fmtNumber(v, 1) },
  exits: { key: 'exits', label: (_u, m) => `${avg(m)} exits`, title: 'Exit orders per trade (partial exits add exits)', render: v => fmtNumber(v, 1) },
  capital: { key: 'capital', label: (_u, m) => `${avg(m)} capital %`, title: 'Capital deployed on the trade (all entries together) as % of session capital', render: v => fmtPct(v, 1) },
  capital_max: { key: 'capital_max', label: () => 'Max capital %', render: v => fmtPct(v, 1) },
  risk: { key: 'risk', label: (_u, m) => `${avg(m)} risk %`, title: 'Capital at risk at entry (distance to stoploss) as % of session capital', render: v => fmtPct(v, 2) },
  bars: { key: 'bars', label: (_u, m) => `${avg(m)} bars held`, title: 'Candles touched (3-minute strategy candles by default). Entering and exiting inside one candle is 1 bar.', render: v => fmtNumber(v, 1) },
  held: { key: 'held', label: (_u, m) => `${avg(m)} time held`, render: v => fmtDuration(v) },
  within_1: { key: 'within_1', label: () => '≤ 1 bar', title: 'Trades closed within the candle they were entered in', render: v => fmtShare(v) },
  within_2: { key: 'within_2', label: () => '≤ 2 bars', render: v => fmtShare(v) },
  loser_within_1: { key: 'loser_within_1', label: () => 'Losers ≤ 1 bar', title: 'Losing trades that were closed within one candle', render: v => fmtShare(v) },
}

const SETS: Record<ColumnSet, SortKey[]> = {
  results: ['trades', 'days', 'net', 'profit', 'loss', 'win_pct', 'average', 'vs_without', 'if_skipped', 'share_loss', 'share_profit', 'profit_factor', 'payoff', 'largest_loss'],
  size: ['trades', 'entries', 'exits', 'capital', 'capital_max', 'risk', 'bars', 'held', 'within_1', 'within_2', 'loser_within_1'],
}

export const VERDICT_LABEL: Record<Verdict, string> = { costly: 'Costly', rewarding: 'Rewarding', mixed: 'Mixed', low_sample: 'Low sample' }

interface Props {
  habits: HabitSummary[]
  columns: ColumnSet
  unit: Unit
  mode: StatMode
  /** Opens the habit in the deep dive. */
  onOpenHabit?: (questionId: string) => void
}

/** One row per habit, sortable by any column; the first column stays in view when the table scrolls on a phone. */
export default function HabitScorecard({ habits, columns, unit, mode, onOpenHabit }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'net', direction: 'asc' })
  const sortKey = SETS[columns].includes(sort.key) || sort.key === 'text' ? sort.key : 'trades'
  const rows = useMemo(() => sortHabits(habits, sortKey, sort.direction, unit, mode), [habits, sortKey, sort.direction, unit, mode])
  const choose = (key: SortKey) => setSort(current => current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: key === 'text' ? 'asc' : 'desc' })
  const ariaSort = (key: SortKey) => (sortKey === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none'
  const header = (key: SortKey) => {
    const column = SCORE_COLUMNS[key]
    return (
      <th key={key} scope="col" aria-sort={ariaSort(key)} title={column.title}>
        <button type="button" onClick={() => choose(key)}>{column.label(unit, mode)}{sortKey === key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</button>
      </th>
    )
  }
  return (
    <div className="pa-table-wrap">
      <table className="hb-table">
        <caption className="hb-visually-hidden">Habit scorecard: one row per habit, click a column heading to sort</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort('text')} className="hb-sticky">
              <button type="button" onClick={() => choose('text')}>Habit{sortKey === 'text' ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</button>
            </th>
            {columns === 'results' && <th scope="col" title="Costly: net negative and below the trades without it. Rewarding: net positive and above them.">Verdict</th>}
            {SETS[columns].map(header)}
          </tr>
        </thead>
        <tbody>
          {rows.map(summary => (
            <tr key={summary.question_id} className={summary.status === 'archived' ? 'archived' : ''}>
              <th scope="row" className="hb-sticky">
                <span className={`hb-kind ${summary.kind}`}>{summary.kind === 'entry' ? 'Entry' : 'Exit'}</span>
                {onOpenHabit
                  ? <button type="button" className="hb-name hb-link" onClick={() => onOpenHabit(summary.question_id)} title="Open the deep dive for this habit" aria-label={`Deep dive: ${summary.text}`}>{summary.text}</button>
                  : <span className="hb-name">{summary.text}</span>}
                {summary.status === 'archived' && <small className="pa-badge">Archived</small>}
              </th>
              {columns === 'results' && (
                <td><span className={`hb-verdict ${summary.verdict}`} title={summary.verdict_reason}>{VERDICT_LABEL[summary.verdict]}</span></td>
              )}
              {SETS[columns].map(key => {
                const column = SCORE_COLUMNS[key]
                const value = metric(summary, key, unit, mode) as number | null
                return <td key={key} className={column.signed ? tint(value) : ''}>{column.render(value, unit)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

