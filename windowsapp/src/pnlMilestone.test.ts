import { describe, expect, it } from 'vitest'
import { pnlMilestone } from '../../shared/pnlMilestone'

const CAPITAL = 100000
const at = (pctOfCapital: number, maxLoss = 6, maxWin = 9) => pnlMilestone(CAPITAL * pctOfCapital / 100, CAPITAL, maxLoss, maxWin)

describe('Milestones P&L display', () => {
  it('stays neutral until a third of the target is reached', () => {
    expect(at(0).text).toBe('—')
    expect(at(2.9).level).toBe('none')
    expect(at(-1.9).level).toBe('none')
    expect(at(2.9).tone).toBe('neutral')
  })

  it('steps through thirds on the win side, inclusive at each boundary', () => {
    expect([at(3).text, at(5.9).text, at(6).text, at(8.9).text, at(9).text, at(25).text])
      .toEqual(['Win 1/3', 'Win 1/3', 'Win 2/3', 'Win 2/3', 'Max win', 'Max win'])
    expect(at(3).tone).toBe('win')
  })

  it('steps through thirds on the loss side against the loss limit', () => {
    expect([at(-2).text, at(-3.9).text, at(-4).text, at(-5.9).text, at(-6).text, at(-40).text])
      .toEqual(['Loss 1/3', 'Loss 1/3', 'Loss 2/3', 'Loss 2/3', 'Max loss', 'Max loss'])
    expect(at(-2).tone).toBe('loss')
  })

  it('is not thrown by floating point at exact thirds', () => {
    expect(pnlMilestone(10, 100, 30, 30).level).toBe('win1')
    expect(pnlMilestone(-20, 100, 30, 30).level).toBe('loss2')
    expect(pnlMilestone(33.3333333333, 100, 100, 100).level).toBe('win1')
  })

  it('shows nothing when capital or a limit is unusable', () => {
    expect(pnlMilestone(500, 0, 10, 10).text).toBe('—')
    expect(pnlMilestone(500, -1, 10, 10).text).toBe('—')
    expect(pnlMilestone(Number.NaN, CAPITAL, 10, 10).text).toBe('—')
    expect(pnlMilestone(5000, CAPITAL, 10, 0).text).toBe('—')
    expect(pnlMilestone(-5000, CAPITAL, 0, 10).text).toBe('—')
  })
})
