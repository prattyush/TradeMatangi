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

// ── Risk switch: Milestones turn into a live % view once the loss is half way to Max loss ──────────────────────────────
// In Milestones mode the player sees thirds, which hides how deep a loss is. When the DAY loss reaches half of Max loss the
// display switches to P&L % (a number that moves with every tick) and the header turns red, so the player slows down and
// recovers. It goes back to Milestones only after the loss has recovered clearly below half, so a P&L hovering near the
// line does not flip the screen back and forth on every tick.

/** The share of Max loss at which the switch happens (inclusive). */
export const RISK_SWITCH_ENTER = 0.5
/** The share the loss must fall below to go back to Milestones. */
export const RISK_SWITCH_EXIT = 0.4

/** The day loss as a share of Max loss: 0 for a profit, flat, or when capital or the limit is not usable. */
export function lossShare(dayPnl: number, capital: number, maxLossPct: number): number {
  if (![dayPnl, capital, maxLossPct].every(Number.isFinite) || capital <= 0 || maxLossPct <= 0 || dayPnl >= 0) return 0
  return (-dayPnl / capital) * 100 / maxLossPct
}

/** The next state of the switch, given whether it is on now. Hysteresis: on at `RISK_SWITCH_ENTER`, off below `RISK_SWITCH_EXIT`. */
export function riskSwitchActive(active: boolean, dayPnl: number, capital: number, maxLossPct: number): boolean {
  const share = lossShare(dayPnl, capital, maxLossPct)
  return share >= (active ? RISK_SWITCH_EXIT : RISK_SWITCH_ENTER) - EPSILON
}

/** The mode to draw with: Milestones becomes percent while the switch is on; every other mode is left alone. */
export function effectiveDisplayMode(mode: PnlDisplayMode, riskActive: boolean): PnlDisplayMode {
  return mode === 'milestones' && riskActive ? 'percent' : mode
}

export function riskSwitchMessage(entering: boolean, dayPnl: number, capital: number, maxLossPct: number): string {
  const loss = capital > 0 ? (-dayPnl / capital) * 100 : 0
  return entering
    ? `Loss is ${loss.toFixed(2)}% of capital, past ${Math.round(RISK_SWITCH_ENTER * 100)}% of your Max loss (${maxLossPct}%). P&L now shows in %: slow down and recover.`
    : `Loss has recovered below ${Math.round(RISK_SWITCH_EXIT * 100)}% of your Max loss. Milestones are back.`
}
