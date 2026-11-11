import { useEffect, useMemo, useState } from 'react'
import { signedMoney, signedPct } from '../walkthrough/walkthroughModel'
import type { WhatIfScenario, WhatIfSource } from './scenarios'
import './whatif.css'

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return iso(date) }
const tone = (value: number) => (Math.abs(value) < 0.005 ? '' : value > 0 ? 'up' : 'down')

/** Group saved what-ifs by name: the same idea ("Exit at close") tried on many days, with its total. */
export function groupByName(rows: WhatIfScenario[]): Array<{ name: string; rows: WhatIfScenario[]; actual: number; whatif: number; delta: number }> {
  const groups = new Map<string, WhatIfScenario[]>()
  for (const row of rows) {
    const key = row.scenario_id
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map(list => ({
    name: list[0].name,
    rows: [...list].sort((a, b) => a.date.localeCompare(b.date) || a.session_id.localeCompare(b.session_id)),
    actual: list.reduce((sum, row) => sum + row.summary.actual_pnl, 0),
    whatif: list.reduce((sum, row) => sum + row.summary.whatif_pnl, 0),
    delta: list.reduce((sum, row) => sum + row.summary.delta, 0),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Compare days: your saved what-ifs over a date range, actual against what-if per day, and the total for each idea. */
export default function CompareDays({ source, onClose }: { source: WhatIfSource; onClose: () => void }) {
  const [start, setStart] = useState(daysAgo(30))
  const [end, setEnd] = useState(daysAgo(0))
  const [rows, setRows] = useState<WhatIfScenario[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (start && end && start > end) { setError('The start date is after the end date.'); return }
    let cancelled = false
    setRows(null); setError('')
    source.range(start || undefined, end || undefined).then(list => { if (!cancelled) setRows(list) }, cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [source, start, end, retry])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onClose])
  const groups = useMemo(() => groupByName(rows ?? []), [rows])
  const money = (value: number) => signedMoney(Math.round(value * 100) / 100)

  return (
    <div className="wi-modal-back" role="presentation" onClick={onClose}>
      <div className="wi-modal" role="dialog" aria-modal="true" aria-label="Compare days" onClick={event => event.stopPropagation()}>
        <header>
          <h3>Compare days</h3>
          <button type="button" onClick={onClose} aria-label="Close compare days">Close</button>
        </header>
        <div className="wi-facts">
          <label>From <input type="date" value={start} max={end || undefined} onChange={event => setStart(event.target.value)} aria-label="From date" /></label>
          <label>To <input type="date" value={end} min={start || undefined} onChange={event => setEnd(event.target.value)} aria-label="To date" /></label>
        </div>
        {error && <p role="alert" className="wi-note">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
        {!error && rows === null && <p role="status" className="wi-muted">Loading saved what-ifs…</p>}
        {rows !== null && groups.length === 0 && <p role="status" className="wi-muted">No saved what-ifs in this period. Edit a trade in the What If tab and save it to compare days here.</p>}
        {groups.map(group => (
          <table key={group.name} className="wi-compare" aria-label={`What-if ${group.name}`}>
            <caption>{group.name} · {group.rows.length} {group.rows.length === 1 ? 'day' : 'days'}</caption>
            <thead><tr><th>Day</th><th>Symbol</th><th className="num">Actual</th><th className="num">What-if</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {group.rows.map(row => (
                <tr key={`${row.session_id}:${row.scenario_id}`}>
                  <td>{row.date}</td><td>{row.symbol}</td>
                  <td className="num">{money(row.summary.actual_pnl)}</td>
                  <td className="num">{money(row.summary.whatif_pnl)}</td>
                  <td className={`num ${tone(row.summary.delta)}`}>{money(row.summary.delta)}{row.summary.delta_pct !== null && <small> ({signedPct(row.summary.delta_pct)})</small>}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={2}>Total</td>
                <td className="num">{money(group.actual)}</td><td className="num">{money(group.whatif)}</td>
                <td className={`num ${tone(group.delta)}`}>{money(group.delta)}</td>
              </tr>
            </tbody>
          </table>
        ))}
      </div>
    </div>
  )
}
