import type { ScoreRuleKey } from './types'

/**
 * The numbers the day score uses, as the Notes tab explains them. They are a copy of `CONFIG` in `backend/app/services/day_score_service.py`
 * (the backend is the source; `backend/tests/test_day_score.py` parses this literal and fails when the two differ). Keep it a plain literal.
 */
export const RULE_NUMBERS = {
  base: 60,
  drawdownTiers: [[0.5, -8], [0.75, -14], [1.0, -25], [1.5, -35]],
  repeatWindowBars: 3,
  defaultBarSeconds: 180,
  repeatPoints: [6, 10, 16, 24],
  addPoints: [6, 10, 16, 24],
  cleanDayTiers: [[3, 15], [6, 20]],
  wipeMinWins: 3,
  wipeTiers: [[1.0, -10], [2.0, -16], [3.0, -22]],
}

const sign = (points: number) => (points > 0 ? `+${points}` : `−${Math.abs(points)}`)
const chain = (points: number[]) => `${sign(-points[0])} for the first, then ${points.slice(1).map(p => sign(-p)).join(', ')} for each further one`

export interface RuleHelp {
  /** Why the rule exists, in the owner's terms. */
  why: string
  /** How the points are worked out, with the numbers in use. */
  how: string
}

/** What a rule of the day score means and how its points are set, for the click-to-open explanation in the Notes tab. */
export function ruleHelp(key: ScoreRuleKey): RuleHelp {
  const n = RULE_NUMBERS
  switch (key) {
    case 'drawdown':
      return {
        why: 'A position that went against you and then came back still put the day at risk. The guardrail limit is the most you decided to lose in a day, so getting near it costs points even when you recovered.',
        how: `The lowest point of the day's total P&L (closed trades plus open positions, marked at the worst price of each minute) as a share of the guardrail limit: ${n.drawdownTiers.map(([share, points]) => `${Math.round(share * 100)}% of the limit ${sign(points)}`).join(', ')}. The highest tier reached counts.`,
      }
    case 'repeat_entry':
      return {
        why: 'Going straight back in after a loss, on the same contract and direction, is usually hope or revenge, not a new setup. It is the habit that breaks discipline fastest.',
        how: `A trade entered within ${n.repeatWindowBars} bars (${n.repeatWindowBars * n.defaultBarSeconds / 60} minutes on 3-minute bars) of the last one closing at a loss, on the same contract (and the same expected strategy when both are labelled), that also lost: ${chain(n.repeatPoints)} in a chain.`,
      }
    case 'add_to_loser':
      return {
        why: 'Adding to a position that is losing makes the loss bigger without a new reason.',
        how: `An entry added while the position was losing, where it and the entry before it both ended in a loss: ${chain(n.addPoints)}.`,
      }
    case 'clean_day':
      return {
        why: 'A day whose closed P&L never dipped below zero shows good selection and discipline, so it earns the biggest bonus.',
        how: `The running closed P&L never below zero over ${n.cleanDayTiers[0][0]} or more closed trades: ${sign(n.cleanDayTiers[0][1])}; over ${n.cleanDayTiers[1][0]} or more: ${sign(n.cleanDayTiers[1][1])}. Fewer trades are too few to count.`,
      }
    case 'big_loss_wipes_gains':
      return {
        why: 'One oversized loss that erases several wins points to size or over-confidence, not to a bad market.',
        how: `A loss at least as big as the ${n.wipeMinWins} or more wins just before it: ${n.wipeTiers.map(([multiple, points]) => `${multiple === 1 ? 'as big' : `${multiple} times as big`} ${sign(points)}`).join(', ')}.`,
      }
  }
}

/** The plain-day line above the rules. */
export const baseHelp = `Every day starts at ${RULE_NUMBERS.base}, a plain day. Each rule adds or removes points and the score stays between 0 and 100.`
