import { useEffect, useRef } from 'react'
import { flashMessage } from './notifications'
import { riskSwitchActive, riskSwitchMessage } from './pnlMilestone'

export interface RiskSwitchInput {
  /** True only in Milestones mode with a session on screen; otherwise the switch is off and silent. */
  enabled: boolean
  /** The DAY P&L (realized plus unrealized), the same number Milestones is built from. */
  dayPnl: number
  capital: number
  /** The GuardRails "Capital loss limit (%)". */
  maxLossPct: number
}

/**
 * Whether the Milestones display should be showing P&L % instead (loss at or past half of Max loss, with the hysteresis of
 * `riskSwitchActive`). It is derived during render, so the switch happens in the same frame as the tick that crossed the line,
 * and a notification is flashed once when it turns on and once when it turns off.
 */
export function useRiskSwitch({ enabled, dayPnl, capital, maxLossPct }: RiskSwitchInput): boolean {
  const previous = useRef(false)
  const active = enabled ? riskSwitchActive(previous.current, dayPnl, capital, maxLossPct) : false
  previous.current = active
  const announced = useRef(false)
  const latest = useRef({ dayPnl, capital, maxLossPct })
  latest.current = { dayPnl, capital, maxLossPct }
  useEffect(() => {
    const { dayPnl: pnl, capital: base, maxLossPct: limit } = latest.current
    if (active && !announced.current) {
      announced.current = true
      flashMessage(riskSwitchMessage(true, pnl, base, limit), 'warning', 'Risk')
    } else if (!active && announced.current) {
      announced.current = false
      if (enabled) flashMessage(riskSwitchMessage(false, pnl, base, limit), 'info', 'Risk')
    }
  }, [active, enabled])
  return active
}
