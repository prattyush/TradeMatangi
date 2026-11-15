import type { ReviewRow } from '../core/trial'

const MAX_ROWS = 60

/** Per-trial review on the result screen: what was shown, what you answered, the right answer and your reaction time. */
export function TrialReview({ rows }: { rows: ReviewRow[] }) {
  if (!rows.length) return null
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <details className="games-review">
      <summary>Trial review ({rows.length} trials)</summary>
      <table>
        <thead><tr><th>#</th><th>Shown</th><th>You answered</th><th>Correct answer</th><th>Time</th></tr></thead>
        <tbody>
          {shown.map(row => (
            <tr key={row.n} data-correct={row.correct}>
              <td>{row.n}</td><td>{row.shown}</td><td>{row.answered}</td><td>{row.correctAnswer}</td>
              <td>{row.rtMs === null ? '—' : `${Math.round(row.rtMs)} ms`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && <p className="games-meta">Showing the first {MAX_ROWS} trials.</p>}
    </details>
  )
}
