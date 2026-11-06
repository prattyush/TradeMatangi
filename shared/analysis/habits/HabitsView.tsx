import { useEffect, useMemo, useRef, useState } from 'react'
import BehaviorManagerModal from '../behavior/BehaviorManagerModal'
import { useAnalysisEnvironment } from '../environment'
import type { PerformanceFilters } from '../performance'
import DivergingBars from './DivergingBars'
import HabitCompare from './HabitCompare'
import HabitDeepDive from './HabitDeepDive'
import HabitScorecard, { type ColumnSet } from './HabitScorecard'
import HabitTrends from './HabitTrends'
import { fmtSigned } from './format'
import type { AxisMode } from './habitSeries'
import { summarize, worstFirst, type StatMode, type Unit } from './habitStats'
import type { HabitLedger } from './types'
import './habits.css'

interface Props {
  /** The dashboard's current filters (dates, symbol, mode, …). */
  filters: PerformanceFilters
  /** Bumped by the dashboard's Refresh button. */
  refresh: number
  /** Opens the trade's detail drawer (the dashboard's own). */
  onOpenTrade?: (identity: { session_id: string; cycle_id: string }) => void
}

type Kind = 'all' | 'entry' | 'exit'
type Section = 'Scorecard' | 'Trends' | 'Compare' | 'Deep dive'
const plural = (count: number, noun: string) => (count === 1 ? noun : `${noun}s`)

/** Segmented control: one active option. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div className="hb-segmented" role="group" aria-label={label}>
      {options.map(([id, text]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>)}
    </div>
  )
}

/** Stats → Habits: which habits cost you and which pay, from the trade ledger for the dashboard's filters. */
export default function HabitsView({ filters, refresh, onOpenTrade }: Props) {
  const environment = useAnalysisEnvironment()
  const getLedger = environment.performance.getHabitLedger
  const [ledger, setLedger] = useState<HabitLedger | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [kind, setKind] = useState<Kind>('all')
  const [includeArchived, setIncludeArchived] = useState(true)
  const [mode, setMode] = useState<StatMode>('mean')
  const [unit, setUnit] = useState<Unit>('pct')
  const [columns, setColumns] = useState<ColumnSet>('results')
  const [axis, setAxis] = useState<AxisMode>('session')
  const [section, setSection] = useState<Section>('Scorecard')
  const [deepHabit, setDeepHabit] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    if (!getLedger) return
    const controller = new AbortController()
    const revision = ++generation.current
    setLoading(true); setError('')
    void getLedger(filters, controller.signal)
      .then(result => { if (generation.current === revision) setLedger(result) })
      .catch(cause => { if (!controller.signal.aborted && generation.current === revision) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (generation.current === revision) setLoading(false) })
    return () => { controller.abort() }
  }, [getLedger, filters, refresh, reload, environment.dataRevision])

  const overview = useMemo(
    () => (ledger ? summarize(ledger.questions, ledger.trades, { kind, includeArchived }) : null),
    [ledger, kind, includeArchived],
  )
  const ordered = useMemo(() => (overview ? worstFirst(overview.habits, unit, mode) : []), [overview, unit, mode])

  if (!getLedger) return <section className="pa-card"><h3>Habits</h3><p className="pa-muted">Habit statistics are not available in this app version.</p></section>
  const coverage = ledger?.coverage
  const hasQuestions = (ledger?.questions.length ?? 0) > 0

  return (
    <div className="hb">
      <section className="pa-card">
        <div className="pa-card-title">
          <div>
            <h3>Habits</h3>
            <p>Which of your own behaviors cost you, and which pay — from the trades you marked, in the period and filters above.</p>
          </div>
          <button type="button" onClick={() => setManaging(true)}>Manage questions</button>
        </div>
        <div className="hb-controls">
          <Segmented label="Habit type" value={kind} onChange={setKind} options={[['all', 'All'], ['entry', 'Entry'], ['exit', 'Exit']]} />
          <Segmented label="Average" value={mode} onChange={setMode} options={[['mean', 'Mean'], ['median', 'Median']]} />
          <Segmented label="Unit" value={unit} onChange={setUnit} options={[['pct', '% of capital'], ['money', '₹']]} />
          {(section === 'Trends' || section === 'Compare') && <Segmented label="Across" value={axis} onChange={setAxis} options={[['session', 'Sessions (order run)'], ['date', 'Market dates']]} />}
          {section === 'Scorecard' && <Segmented label="Columns" value={columns} onChange={setColumns} options={[['results', 'Results'], ['size', 'Size & timing']]} />}
          <label className="hb-check"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} /> Include archived</label>
        </div>
      </section>

      {loading && !ledger && <p role="status">Reading your habits…</p>}
      {error && (
        <div role="alert" className="pa-error">
          {error}<button type="button" onClick={() => setReload(value => value + 1)}>Retry</button>
        </div>
      )}

      {ledger && overview && coverage && (
        <>
          <div className="pa-coverage hb-coverage">
            <span>{coverage.closed_trades} closed trades · {coverage.marks} habit marks on {coverage.marked_trades} trades</span>
            <span>
              {coverage.unmatched_marks > 0 && <span title="Marks in this period and symbol that no trade in the current filters matches: the trade was filtered out (direction, entry method, tags…) or its broker day was re-synced.">{coverage.unmatched_marks} {plural(coverage.unmatched_marks, 'mark')} not matched to a trade · </span>}
              {coverage.open_marked_trades > 0 && <span title="Marked trades that are still open are counted once they close.">{coverage.open_marked_trades} marked {plural(coverage.open_marked_trades, 'trade')} still open · </span>}
              {coverage.trades_without_capital} {plural(coverage.trades_without_capital, 'trade')} without capital % · {coverage.trades_without_bars} without bars
            </span>
          </div>
          {coverage.truncated && <p className="pa-footnote" role="note">Showing the most recent trades only (the list is capped). Narrow the date range for the full picture.</p>}

          {!hasQuestions && (
            <section className="pa-card">
              <h3>Start with a habit to track</h3>
              <p>Add a behavior question — for example “Exited after one bar in profit” — then mark it on trades while you trade or in Analysis → Label Trades. This page then shows what each habit costs or earns.</p>
              <button type="button" onClick={() => setManaging(true)}>Add a question</button>
            </section>
          )}
          {hasQuestions && !overview.habits.length && (
            <section className="pa-card">
              <h3>No habit marks in this selection</h3>
              <p>None of your {overview.scope.trades} closed trades here carry a habit{kind !== 'all' ? ` of this type` : ''}. Mark trades in Analysis → Label Trades, or widen the date range.</p>
            </section>
          )}

          {overview.habits.length > 0 && (
            <>
              <nav className="hb-sections" aria-label="Habits sections">
                {(['Scorecard', 'Trends', 'Compare', 'Deep dive'] as Section[]).map(id => (
                  <button key={id} type="button" aria-pressed={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
                    {id === 'Trends' ? (axis === 'session' ? 'Trends across sessions' : 'Trends across days') : id === 'Compare' ? 'Compare periods' : id}
                  </button>
                ))}
              </nav>
              {section === 'Trends' && <HabitTrends trades={ledger.trades} overview={overview} unit={unit} mode={mode} axis={axis} onOpenTrade={onOpenTrade} />}
              {section === 'Compare' && <HabitCompare trades={ledger.trades} overview={overview} unit={unit} mode={mode} axis={axis} />}
              {section === 'Deep dive' && <HabitDeepDive trades={ledger.trades} overview={overview} unit={unit} mode={mode} habitId={deepHabit ?? ordered[0]?.question_id ?? null} onSelectHabit={setDeepHabit} onOpenTrade={onOpenTrade} />}
              {section === 'Scorecard' && (
                <>
                <section className="pa-card">
                  <div className="pa-card-title">
                    <div><h3>Which habit costs or earns the most</h3><p>Losses to the left, profits to the right, ◆ the net. Most destructive first.</p></div>
                  </div>
                  <DivergingBars habits={ordered} unit={unit} mode={mode} />
                </section>
                <section className="pa-card">
                  <div className="pa-card-title">
                    <div>
                      <h3>Scorecard</h3>
                      <p>
                        Click a heading to sort · across {overview.scope.trades} closed trades, net {unit === 'pct' ? fmtSigned(overview.scope.net_pct, 'pct') : fmtSigned(overview.scope.net_pnl, 'money')}
                      </p>
                    </div>
                  </div>
                  <HabitScorecard habits={overview.habits} columns={columns} unit={unit} mode={mode} onOpenHabit={id => { setDeepHabit(id); setSection('Deep dive') }} />
                  {overview.habits.some(h => h.verdict === 'low_sample') && <p className="pa-footnote">Habits with fewer than 10 trades are marked “Low sample”: too few to judge.</p>}
                  {overview.idle.length > 0 && <p className="pa-footnote">Not marked on any trade in this period: {overview.idle.map(q => q.text).join(' · ')}</p>}
                </section>
                <details className="pa-card hb-help">
                  <summary>How these numbers are calculated</summary>
                  <ul>
                    <li><b>% of capital</b> is each trade’s net result divided by the session’s capital; profit %, loss % and net % add those percentages over the trades with the habit.</li>
                    <li><b>vs without</b> compares a typical trade with the habit to a typical trade without it, in the same period and filters.</li>
                    <li><b>If skipped</b> is the net you would have gained or given up by not taking the habit’s trades.</li>
                    <li><b>Share of losses/profits</b> is the part of all losing/winning % that came from the habit’s trades. A trade can carry several habits, so shares overlap.</li>
                    <li><b>Capital %</b> is the capital deployed on the trade (all entries together); <b>bars held</b> counts the candles the trade touched — entering and exiting inside one candle is 1 bar.</li>
                    <li><b>Costly</b>: net negative and a worse average than your other trades. <b>Rewarding</b>: net positive and a better average. <b>Mixed</b> otherwise. Fewer than 10 trades is <b>Low sample</b>. Verdicts use means.</li>
                  </ul>
                </details>
                </>
              )}
            </>
          )}
        </>
      )}
      {managing && <BehaviorManagerModal api={environment.api} zIndex={2300} onClose={() => setManaging(false)} onChanged={() => setReload(value => value + 1)} />}
    </div>
  )
}
