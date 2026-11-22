import { useEffect } from 'react'
import { useAnalysisEnvironment } from '../../../shared/analysis/environment'

/** Reports the shared candle interval upward and lets the host set it (a saved chart or flow restores its own). */
export function IntervalBridge({ requested, onChange }: { requested: number | null; onChange: (minutes: number) => void }) {
  const env = useAnalysisEnvironment()
  useEffect(() => { onChange(env.intervalMinutes ?? 3) }, [env.intervalMinutes, onChange])
  useEffect(() => { if (requested != null) env.setIntervalMinutes?.(requested) }, [requested]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
