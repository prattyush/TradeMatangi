import { pnlMilestone, MILESTONE_NONE_TEXT, type PnlDisplayMode, type MilestoneTone } from '../../shared/pnlMilestone.ts'

/** Follow the P&L unit setting; currency remains usable without a capital baseline. */
export function formatPnl(value: number, percentMode: boolean, capital: number): string {
  const percentage = percentMode && Number.isFinite(capital) && capital > 0
  const amount = percentage ? value / capital * 100 : value
  return `${value >= 0 ? '+' : ''}${amount.toFixed(2)}${percentage ? '%' : ''}`
}

export interface PnlDisplayConfig {
  mode: PnlDisplayMode
  maxWinPct: number
  maxLossPct: number
}

/** The one place a trading P&L turns into text. In Milestones mode it is always the DAY level, never the number passed in. */
export function formatPnlDisplay(value: number, display: PnlDisplayConfig, capital: number, dayPnl: number, available = true): string {
  if (display.mode === 'milestones') return available ? pnlMilestone(dayPnl, capital, display.maxLossPct, display.maxWinPct).text : MILESTONE_NONE_TEXT
  return formatPnl(value, display.mode === 'percent', capital)
}

const TONE_COLORS = { win: '#26a641', loss: '#f85149', neutral: '#8b949e' } as const

/** Colour for a P&L text: sign of the number, or the day level in Milestones mode. */
export function pnlDisplayColor(value: number, display: PnlDisplayConfig, capital: number, dayPnl: number): string {
  if (display.mode === 'milestones') return TONE_COLORS[pnlMilestone(dayPnl, capital, display.maxLossPct, display.maxWinPct).tone as MilestoneTone]
  return value > 0 ? TONE_COLORS.win : value < 0 ? TONE_COLORS.loss : TONE_COLORS.neutral
}
