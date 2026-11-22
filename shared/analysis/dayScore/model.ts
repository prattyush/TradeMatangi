/** Pure helpers for showing a day score: its colour band, its wording and the trend series. */
import type { DayScore, ScoreItem, ScoreRow, ScoreRuleKey } from './types'

export type ScoreBand = 'good' | 'fair' | 'poor'

/** 75 and above is a good day, 50 to 74 fair, below 50 poor. */
export const scoreBand = (score: number): ScoreBand => (score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor')

export const signedPoints = (points: number) => (points > 0 ? `+${points}` : points < 0 ? `−${Math.abs(points)}` : '0')

const sessionKind = (type: string) => (type === 'sim' ? 'Replay' : type === 'stepwise' ? 'Stepwise' : type === 'paper' ? 'Paper' : type === 'real' ? 'Real' : type)

/** What to say when a day has no score yet. The score covers every session of the date, so a pending day says where the missing labels are. */
export function pendingText(score: Pick<DayScore, 'status' | 'closed' | 'labelled'> & Partial<Pick<DayScore, 'unlabelled'>>): string {
  if (score.status === 'no_trades') return 'No closed trades on this day, so there is nothing to score.'
  if (score.status === 'pending_labels') {
    const left = score.closed - score.labelled
    const where = (score.unlabelled ?? []).map(row => {
      const trades = (row.trades ?? []).map(trade => [trade.entry_time ? new Date(trade.entry_time * 1000).toISOString().slice(11, 16) : '', trade.strike ?? '', trade.right ?? '', trade.direction === 'SHORT' ? 'short' : ''].join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
      const more = row.count > trades.length && trades.length ? ', …' : ''
      return `${sessionKind(row.session_type)} ${row.symbol} ${row.count}`.replace(/\s+/g, ' ').trim() + (trades.length ? ` (${trades.join(', ')}${more})` : '')
    })
    return `Label ${left === 1 ? 'the last closed trade' : `the ${left} closed trades that have no label`} (${score.labelled} of ${score.closed} labelled) to get the day's score.`
      + (where.length ? ` The score covers every session of the day. Still without a label: ${where.join(', ')}.` : '')
  }
  return ''
}

/** A short note about how far the score can be trusted, or null when nothing needs saying. */
export function trustNote(score: Pick<DayScore, 'limit_source' | 'limit_pct' | 'drawdown'>): string | null {
  const notes: string[] = []
  if (score.limit_source === 'estimated') notes.push(`the guardrail limit is estimated at ${score.limit_pct ?? 12}% (the session did not save one)`)
  if (score.drawdown?.partial) notes.push('candles were missing for some contracts, so the drawdown may be larger than shown')
  return notes.length ? notes.join('; ') : null
}

/** The badge text and hover for a day card. */
export function badgeFor(score: Pick<DayScore, 'score' | 'limit_source' | 'drawdown'> | Pick<ScoreRow, 'score' | 'limit_source' | 'partial'>): { text: string; title: string } {
  const partial = 'partial' in score ? score.partial : !!score.drawdown?.partial
  const flags = [score.limit_source === 'estimated' ? 'limit estimated' : '', partial ? 'partial candles' : ''].filter(Boolean)
  return { text: `Score ${score.score}`, title: `Day score ${score.score} of 100${flags.length ? ` (${flags.join(', ')})` : ''}` }
}

/** Items that cost points first, then bonuses, then the neutral ones: what to look at first. */
export const itemsByImpact = (items: readonly ScoreItem[]): ScoreItem[] => [...items].sort((a, b) => a.points - b.points)

/** Trend values by date for the Stats chart; days without a stored score are absent. */
export const scoreByDate = (rows: readonly ScoreRow[]): Map<string, number> => new Map(rows.map(row => [row.date, row.score]))

/** When each event of a rule happened (HH:MM on the market clock, in order), for "found at 10:42, 11:15" in the explanation. */
export function eventTimes(score: Pick<DayScore, 'events'>, key: ScoreRuleKey): string[] {
  const events = (score.events as Record<string, Array<{ time?: number }> | undefined> | undefined)?.[key] ?? []
  return events
    .map(event => event.time)
    .filter((time): time is number => typeof time === 'number' && Number.isFinite(time) && time > 1e9)
    .sort((a, b) => a - b)
    .map(time => new Date((time > 1e12 ? time : time * 1000)).toISOString().slice(11, 16))
}
