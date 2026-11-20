import { badgeFor, scoreBand } from './model'
import type { DayScore, ScoreRow } from './types'
import './dayScore.css'

/** The day's score on a card header; nothing until the day has been scored. */
export default function DayScoreBadge({ score }: { score: Pick<DayScore, 'score' | 'limit_source' | 'drawdown'> | Pick<ScoreRow, 'score' | 'limit_source' | 'partial'> | null | undefined }) {
  if (!score || score.score === null || score.score === undefined) return null
  const { text, title } = badgeFor(score)
  return <span className={`ds-chip ${scoreBand(score.score)}`} data-testid="day-score-badge" title={title}>{text}</span>
}
