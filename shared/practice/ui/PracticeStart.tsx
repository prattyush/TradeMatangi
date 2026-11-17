import { useCallback, useEffect, useMemo, useState } from 'react'
import { friendlyError } from '../../deepdive/ui/errors'
import { daysOnOffer, gradeLabel, isDayProblem, negativeDays, pickFilter } from '../model'
import { GRADES, type Grade, type PracticeDayRef, type PracticePlan, type PracticeStrategy } from '../types'
import { usePracticeHost } from './host'

/** Choose a strategy (and optionally a symbol and grades), a speed, and start: the system picks the day and the start minute. */
export default function PracticeStart() {
  const host = usePracticeHost()
  const [strategies, setStrategies] = useState<PracticeStrategy[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [symbol, setSymbol] = useState('')
  const [grades, setGrades] = useState<ReadonlySet<Grade>>(new Set(GRADES))
  const [negatives, setNegatives] = useState(false)
  const [speed, setSpeed] = useState(host.defaultSpeed)
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Days that could not be started (their data could not be loaded): not offered again until another strategy is chosen.
  const [skipped, setSkipped] = useState<PracticeDayRef[]>([])

  const load = useCallback(async () => {
    try { setStrategies(await host.api.strategies()); setError(null) } catch (e) { setError(friendlyError(e)); setStrategies([]) }
  }, [host.api])
  useEffect(() => { void load() }, [load])

  const strategy = useMemo(() => strategies?.find(s => `${s.category}::${s.strategy}` === chosen) ?? null, [strategies, chosen])
  const toggle = (grade: Grade) => setGrades(current => { const next = new Set(current); if (next.has(grade)) next.delete(grade); else next.add(grade); return next })
  const absent = strategy ? negativeDays(strategy, symbol) : 0
  const offer = strategy ? daysOnOffer(strategy, symbol, grades) + (negatives ? absent : 0) : 0
  const blocked = host.blockedReason
  const cannot = !strategy || starting || offer === 0 || grades.size === 0 || blocked !== null

  const start = async () => {
    if (!strategy) return
    setStarting(true); setError(null); setNote(null)
    let plan: PracticePlan | null = null
    try {
      plan = await host.api.pick(strategy, pickFilter(symbol, grades, negatives && absent > 0, skipped))
      if (plan.repeated) setNote('You have practised every matching day, so this one repeats.')
      await host.startPractice(plan, speed)
    } catch (e) {
      const message = friendlyError(e)
      if (plan && isDayProblem(message)) {
        // The day was chosen but could not be started (its data could not be loaded): it is not offered again.
        const day = { date: plan.date, symbol: plan.symbol }
        setSkipped(current => [...current, day])
        setError(`That day could not be started: ${message} Press Start practice again for another day.`)
      } else setError(message)
    } finally { setStarting(false) }
  }

  return <div className="pr-start">
    <section className="pr-strategies" aria-label="Strategies to practise">
      <h3>Strategy{strategies ? ` (${strategies.length})` : ''}</h3>
      <p className="pl-muted">Strategies from your Deep Dive with at least one day that has an <strong>Entry</strong> mark.</p>
      {strategies === null ? <p className="pl-muted">Loading…</p> : strategies.length === 0 && !error
        ? <p className="pl-muted">Nothing to practise yet. In Deep dive, mark days for a strategy and put an Entry mark on their charts.</p>
        : <ul>{strategies.map(item => <li key={`${item.category}::${item.strategy}`}>
          <button aria-pressed={`${item.category}::${item.strategy}` === chosen} onClick={() => { setChosen(`${item.category}::${item.strategy}`); setSymbol(''); setNote(null); setSkipped([]) }}>
            <strong>{item.strategy}</strong>
            <span className="pl-muted">{item.category} · {item.days} {item.days === 1 ? 'day' : 'days'}</span>
          </button>
        </li>)}</ul>}
    </section>
    <section className="pr-options" aria-label="Practice options">
      {strategy ? <>
        <h3>{strategy.category} / {strategy.strategy}</h3>
        <label className="pr-field">Symbol
          <select value={symbol} onChange={e => setSymbol(e.target.value)} aria-label="Symbol">
            <option value="">Any ({strategy.symbols.reduce((n, s) => n + s.days, 0)} days)</option>
            {strategy.symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.symbol} ({s.days})</option>)}
          </select>
        </label>
        <fieldset className="pr-grades"><legend>Days to include</legend>
          {GRADES.map(grade => <label key={grade} className={strategy.grades[grade] ? '' : 'pl-muted'}>
            <input type="checkbox" checked={grades.has(grade)} onChange={() => toggle(grade)} /> {gradeLabel(grade)} ({strategy.grades[grade]})
          </label>)}
        </fieldset>
        {(strategy.negative_days?.length ?? 0) > 0 && <label className="pr-negatives" title="Days between your oldest and newest marked day that you did not mark: you reviewed them and the strategy was not there">
          <input type="checkbox" checked={negatives} onChange={e => setNegatives(e.target.checked)} aria-label="Include no-setup days" /> Include no-setup days
          <span className="pl-muted"> ({absent} {absent === 1 ? 'day' : 'days'}; about 1 run in 4 is one, and the right call there is not to trade)</span>
        </label>}
        <div className="pr-field">Replay speed {host.renderSpeed(speed, setSpeed)}</div>
        <p className="pl-muted">The replay starts a few minutes before the first recorded entry (a different minute each time). Nothing tells you whether the setup is Buy or Sell, or where you marked it; you see that in the review after you stop.</p>
        <div className="pl-bar">
          <button className="pl-primary" disabled={cannot} aria-busy={starting} aria-describedby="pr-start-hint" onClick={() => void start()}>{starting ? 'Starting…' : 'Start practice'}</button>
          <span className="pl-muted" id="pr-start-hint">{offer === 0 ? 'No day matches these choices.' : `About ${offer} ${offer === 1 ? 'day' : 'days'} on offer`}</span>
        </div>
        {blocked && <p className="pl-muted" role="status">{blocked}</p>}
        {starting && <p className="pl-muted" role="status">Loading the day's data can take a minute the first time.</p>}
        {note && <p className="pl-muted" role="status">{note}</p>}
        {skipped.length > 0 && <p className="pl-muted" role="status">{skipped.length} {skipped.length === 1 ? 'day' : 'days'} skipped: their data could not be loaded.</p>}
      </> : <p className="pl-muted pr-empty">Choose a strategy to practise.</p>}
      {error && <p className="pl-error" role="alert">{error}</p>}
    </section>
  </div>
}
