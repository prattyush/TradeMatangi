import { useEffect, useRef } from 'react'
import { useAnalysisEnvironment } from '../../analysis/environment'

/**
 * Puts the day's saved candle interval on the charts and reports a change the user makes. It ignores everything until the charts
 * have taken the saved interval, so opening a day can never overwrite that day's interval with the previous one.
 * Mount it with a key per day.
 */
export default function DayIntervalBridge({ interval, onUserChange }: { interval: number; onUserChange?: (minutes: number) => void }) {
  const env = useAnalysisEnvironment()
  const settled = useRef(false)
  useEffect(() => { env.setIntervalMinutes?.(interval) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const now = env.intervalMinutes ?? 3
    if (!settled.current) { if (now === interval) settled.current = true; return }
    if (now !== interval) onUserChange?.(now)
  }, [env.intervalMinutes]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
