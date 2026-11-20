import type { DayScore } from './types'
import { itemsByImpact, pendingText, scoreBand, signedPoints, trustNote } from './model'
import './dayScore.css'

/** The day's score and where every point came from: the base, then each rule with what it found. Shown in the Notes tab. */
export default function DayScoreBreakdown({ score, loading, error }: { score: DayScore | null; loading?: boolean; error?: string | null }) {
  if (error) return <p className="pl-muted" role="status">The day score could not be read: {error}</p>
  if (!score) return <p className="pl-muted" role="status">{loading ? 'Reading the day score…' : ''}</p>
  if (score.status !== 'scored' || score.score === null || !score.items) return <section className="ds" aria-label="Day score"><h4>Day score</h4><p className="pl-muted" data-testid="score-pending">{pendingText(score)}</p></section>
  const trust = trustNote(score)
  return <section className="ds" aria-label="Day score">
    <h4>Day score <span className={`ds-badge ${scoreBand(score.score)}`} data-testid="score-value">{score.score}</span><span className="pl-muted ds-of"> of 100</span></h4>
    <table className="ds-table"><tbody>
      <tr className="ds-base"><td>A plain day</td><td className="ds-points">{score.base}</td><td className="pl-muted">The starting point</td></tr>
      {itemsByImpact(score.items).map(item => <tr key={item.key} data-rule={item.key} className={item.points < 0 ? 'cost' : item.points > 0 ? 'gain' : 'none'}>
        <td>{item.title}</td><td className="ds-points">{signedPoints(item.points)}</td><td className="pl-muted">{item.detail}</td></tr>)}
    </tbody></table>
    {score.drawdown && score.limit_pct ? <p className="pl-muted ds-note">Lowest point of the day: {score.drawdown.worst_pct}% of capital against a {score.limit_pct}% guardrail limit ({Math.round(score.drawdown.limit_ratio * 100)}% of it).</p> : null}
    {trust && <p className="ds-warn" role="note">Note: {trust}.</p>}
  </section>
}
