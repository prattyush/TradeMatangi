import { useState } from 'react'
import type { DayScore, ScoreRuleKey } from './types'
import { eventTimes, itemsByImpact, pendingText, scoreBand, signedPoints, trustNote } from './model'
import { baseHelp, ruleHelp } from './ruleHelp'
import './dayScore.css'

/**
 * The day's score and where every point came from: the base, then each rule with what it found. A rule opens on a click to say why it
 * exists, how its points are set and when it was found. Shown in the Notes tab.
 */
export default function DayScoreBreakdown({ score, loading, error }: { score: DayScore | null; loading?: boolean; error?: string | null }) {
  const [open, setOpen] = useState<string | null>(null)
  if (error) return <p className="pl-muted" role="status">The day score could not be read: {error}</p>
  if (!score) return <p className="pl-muted" role="status">{loading ? 'Reading the day score…' : ''}</p>
  if (score.status !== 'scored' || score.score === null || !score.items) return <section className="ds" aria-label="Day score"><h4>Day score</h4><p className="pl-muted" data-testid="score-pending">{pendingText(score)}</p></section>
  const trust = trustNote(score)
  return <section className="ds" aria-label="Day score">
    <h4>Day score <span className={`ds-badge ${scoreBand(score.score)}`} data-testid="score-value">{score.score}</span><span className="pl-muted ds-of"> of 100</span></h4>
    <table className="ds-table"><tbody>
      <tr className="ds-base"><td>A plain day</td><td className="ds-points">{score.base}</td><td className="pl-muted">The starting point. <span title={baseHelp}>Click a rule to see how it works.</span></td></tr>
      {itemsByImpact(score.items).flatMap(item => {
        const expanded = open === item.key
        const help = ruleHelp(item.key as ScoreRuleKey)
        const times = eventTimes(score, item.key as ScoreRuleKey)
        return [
          <tr key={item.key} data-rule={item.key} className={`ds-rule ${item.points < 0 ? 'cost' : item.points > 0 ? 'gain' : 'none'}`}>
            <td><button type="button" className="ds-toggle" aria-expanded={expanded} aria-controls={`ds-help-${item.key}`} onClick={() => setOpen(expanded ? null : item.key)}>
              <span className="ds-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>{item.title}</button></td>
            <td className="ds-points">{signedPoints(item.points)}</td><td className="pl-muted">{item.detail}</td></tr>,
          expanded && <tr key={`${item.key}-help`} className="ds-help" id={`ds-help-${item.key}`}><td colSpan={3}>
            <p><strong>Why it counts.</strong> {help.why}</p>
            <p><strong>How the points are set.</strong> {help.how}</p>
            {times.length > 0 && <p><strong>Found today at</strong> {times.join(', ')}.</p>}
          </td></tr>,
        ]
      })}
    </tbody></table>
    {score.drawdown && score.limit_pct ? <p className="pl-muted ds-note">Lowest point of the day: {score.drawdown.worst_pct}% of capital against a {score.limit_pct}% guardrail limit ({Math.round(score.drawdown.limit_ratio * 100)}% of it).</p> : null}
    {trust && <p className="ds-warn" role="note">Note: {trust}.</p>}
  </section>
}
