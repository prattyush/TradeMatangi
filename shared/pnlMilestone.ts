/**
 * "Milestones" P&L display: instead of a number, show how far the DAY P&L is towards a
 * Max Win or a Max Loss, in thirds. One pure helper for the website and the Windows app.
 */
export type PnlDisplayMode = 'currency' | 'percent' | 'milestones'
export type MilestoneLevel = 'none' | 'win1' | 'win2' | 'max_win' | 'loss1' | 'loss2' | 'max_loss'
export type MilestoneTone = 'win' | 'loss' | 'neutral'

export interface Milestone {
  level: MilestoneLevel
  text: string
  tone: MilestoneTone
}

/** Percent-of-capital limits behind the steps. Max Loss is the GuardRails "Capital loss limit (%)". */
export interface MilestoneLimits {
  maxWinPct: number
  maxLossPct: number
}

export const DEFAULT_MAX_WIN_PCT = 10
export const DEFAULT_MAX_LOSS_PCT = 10
export const MILESTONE_NONE_TEXT = '—'

const TEXT: Record<MilestoneLevel, string> = {
  none: MILESTONE_NONE_TEXT,
  win1: 'Win 1/3',
  win2: 'Win 2/3',
  max_win: 'Max win',
  loss1: 'Loss 1/3',
  loss2: 'Loss 2/3',
  max_loss: 'Max loss',
}

const EPSILON = 1e-9

function step(ratio: number): 0 | 1 | 2 | 3 {
  // Thirds are inclusive; compare in thirds so 33.333…% of the max counts as reached.
  const thirds = ratio * 3
  if (thirds >= 3 - EPSILON) return 3
  if (thirds >= 2 - EPSILON) return 2
  if (thirds >= 1 - EPSILON) return 1
  return 0
}

export function pnlMilestone(dayPnl: number, capital: number, maxLossPct: number, maxWinPct: number): Milestone {
  const none: Milestone = { level: 'none', text: TEXT.none, tone: 'neutral' }
  if (![dayPnl, capital, maxLossPct, maxWinPct].every(Number.isFinite) || capital <= 0) return none
  const pct = (dayPnl / capital) * 100
  if (pct > 0 && maxWinPct > 0) {
    const level = (['none', 'win1', 'win2', 'max_win'] as const)[step(pct / maxWinPct)]
    return level === 'none' ? none : { level, text: TEXT[level], tone: 'win' }
  }
  if (pct < 0 && maxLossPct > 0) {
    const level = (['none', 'loss1', 'loss2', 'max_loss'] as const)[step(-pct / maxLossPct)]
    return level === 'none' ? none : { level, text: TEXT[level], tone: 'loss' }
  }
  return none
}
