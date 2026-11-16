import { describe, expect, it } from 'vitest'
import { effectiveDisplayMode, lossShare, pnlMilestone, riskSwitchActive, riskSwitchMessage, RISK_SWITCH_ENTER, RISK_SWITCH_EXIT } from '../../shared/pnlMilestone'

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


describe('Risk switch: Milestones show P&L % once the loss is half way to Max loss', () => {
  const MAX = 6 // Max loss, % of capital
  const state = (active: boolean, pctOfCapital: number) => riskSwitchActive(active, CAPITAL * pctOfCapital / 100, CAPITAL, MAX)

  it('measures the day loss as a share of Max loss, and only a loss counts', () => {
    expect(lossShare(-3000, CAPITAL, MAX)).toBeCloseTo(0.5, 9)
    expect(lossShare(-6000, CAPITAL, MAX)).toBeCloseTo(1, 9)
    expect(lossShare(-12000, CAPITAL, MAX)).toBeCloseTo(2, 9)
    for (const value of [0, 500, 99999]) expect(lossShare(value, CAPITAL, MAX)).toBe(0)
  })

  it('has no share when capital or the limit is missing or not a number', () => {
    expect(lossShare(-3000, 0, MAX)).toBe(0)
    expect(lossShare(-3000, CAPITAL, 0)).toBe(0)
    expect(lossShare(Number.NaN, CAPITAL, MAX)).toBe(0)
    expect(lossShare(-3000, CAPITAL, Number.POSITIVE_INFINITY)).toBe(0)
    expect(riskSwitchActive(false, -3000, 0, MAX)).toBe(false)
    expect(riskSwitchActive(true, -3000, CAPITAL, Number.NaN)).toBe(false)
  })

  it('switches on at exactly half of Max loss and not before', () => {
    expect(RISK_SWITCH_ENTER).toBe(0.5)
    expect(state(false, -2.99)).toBe(false)
    expect(state(false, -3)).toBe(true)
    expect(state(false, -3.01)).toBe(true)
    expect(state(false, -6)).toBe(true)
    expect(state(false, 5)).toBe(false)
  })

  it('is not thrown by floating point at the boundary', () => {
    expect(riskSwitchActive(false, -15, 100, 30)).toBe(true)
    expect(riskSwitchActive(false, -0.5 * 0.3 * 100, 100, 0.3)).toBe(true)
  })

  it('stays on while the loss is between 40% and 50% of Max loss, and goes off only below 40%', () => {
    expect(RISK_SWITCH_EXIT).toBe(0.4)
    expect(state(true, -2.9)).toBe(true)
    expect(state(true, -2.5)).toBe(true)
    expect(state(true, -2.4)).toBe(true) // exactly 40%: still on
    expect(state(true, -2.39)).toBe(false)
    expect(state(true, 0)).toBe(false)
    expect(state(true, 3)).toBe(false)
  })

  it('does not flip on every tick of a P&L that hovers around the line', () => {
    let active = false
    const flips: boolean[] = []
    for (const pct of [-2.8, -3.0, -2.9, -3.1, -2.7, -3.0, -2.6, -2.95, -2.5]) {
      const next = state(active, pct)
      if (next !== active) flips.push(next)
      active = next
    }
    expect(flips).toEqual([true]) // turned on once at -3.0 and stayed on
  })

  it('goes through a whole loss and recovery', () => {
    let active = false
    const seen: boolean[] = []
    for (const pct of [0, -1, -2, -3, -4, -5, -4, -3, -2.5, -2.3, -1, 0]) { active = state(active, pct); seen.push(active) }
    expect(seen).toEqual([false, false, false, true, true, true, true, true, true, false, false, false])
  })

  it('only Milestones is replaced, and by percent; the other modes are never touched', () => {
    expect(effectiveDisplayMode('milestones', true)).toBe('percent')
    expect(effectiveDisplayMode('milestones', false)).toBe('milestones')
    expect(effectiveDisplayMode('currency', true)).toBe('currency')
    expect(effectiveDisplayMode('percent', true)).toBe('percent')
    expect(effectiveDisplayMode('currency', false)).toBe('currency')
  })

  it('tells the player what happened, in numbers', () => {
    const on = riskSwitchMessage(true, -3300, CAPITAL, MAX)
    expect(on).toContain('3.30%')
    expect(on).toContain('50%')
    expect(on).toContain('Max loss (6%)')
    expect(on).toMatch(/slow down and recover/)
    expect(riskSwitchMessage(false, -2000, CAPITAL, MAX)).toMatch(/below 40% of your Max loss.*Milestones are back/)
    expect(riskSwitchMessage(true, -3300, 0, MAX)).not.toMatch(/NaN|Infinity/)
  })

  it('a milestone read at the switch point agrees with the thirds (half of Max loss is between Loss 1/3 and Loss 2/3)', () => {
    expect(pnlMilestone(-3000, CAPITAL, MAX, 9).level).toBe('loss1')
    expect(pnlMilestone(-4000, CAPITAL, MAX, 9).level).toBe('loss2')
  })
})
