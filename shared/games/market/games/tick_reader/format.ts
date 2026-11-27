import type { RoundResult, TickRound } from './engine'

export const clock = (second: number): string => {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${pad(second / 3600)}:${pad((second % 3600) / 60)}:${pad(second % 60)}`
}

const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`

/** One plain sentence about how the round went, shown after it (spec 5.1 "Result flash"). */
export function describeResult(round: TickRound, result: RoundResult): string {
  const move = `The underlying moved ${points(round.move)} points over the hold.`
  switch (result.kind) {
    case 'trade': return `${result.answer === 'long' ? 'Long (CE)' : 'Short (PE)'}: ${points(result.net)} option points after costs of ${round.costPts.toFixed(2)}. ${move} ${round.edge ? 'A tradable move existed.' : 'There was no tradable edge in this window.'}`
    case 'correct_skip': return `Correct skip. ${move} Too small to pay for the costs.`
    case 'timeout_skip': return `Time ran out, counted as a skip. ${move} There was no tradable edge.`
    case 'missed_move': return `Skipped a tradable move. ${move}`
    case 'timeout_missed': return `Time ran out, counted as a skip. ${move} A tradable move was there.`
  }
}
