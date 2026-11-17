import { useEffect, useState } from 'react'
import { formatDay } from '../../deepdive/model'
import { friendlyError } from '../../deepdive/ui/errors'
import { historyLine, historySummary, runLine } from '../model'
import type { PracticeRun } from '../types'
import { usePracticeHost } from './host'

/** Your practice runs, newest first. A run that has ended can be reviewed; one still running cannot (the answer stays hidden). */
export default function PracticeHistory({ onReview }: { onReview: (sessionId: string) => void }) {
  const { api } = usePracticeHost()
  const [runs, setRuns] = useState<PracticeRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.runs().then(value => { if (alive) setRuns(value) }, e => { if (alive) { setError(friendlyError(e)); setRuns([]) } })
    return () => { alive = false }
  }, [api])

  const line = runs ? historyLine(historySummary(runs)) : ''
  return <div className="pr-history">
    {line && <p className="pr-summary" role="status">{line}</p>}
    {error && <p className="pl-error" role="alert">{error}</p>}
    {runs === null ? <p className="pl-muted">Loading…</p> : runs.length === 0 && !error ? <p className="pl-muted">No practice runs yet.</p> : <table className="dd-table">
      <thead><tr><th>Day</th><th>Strategy</th><th>Symbol</th><th>Started</th><th>How it went</th><th /></tr></thead>
      <tbody>{runs.map(run => <tr key={run.session_id}>
        <td>{formatDay(run.date)}</td>
        <td>{run.category} / {run.strategy}</td>
        <td>{run.symbol}</td>
        <td className="pl-muted">{run.start_time.slice(0, 5)}</td>
        <td>{run.ended ? runLine(run.result) : <span className="pl-muted">In progress</span>}</td>
        <td className="pl-actions"><button disabled={!run.ended} title={run.ended ? 'Review this run' : 'Stop the session first'} onClick={() => onReview(run.session_id)}>Review</button></td>
      </tr>)}</tbody>
    </table>}
  </div>
}
