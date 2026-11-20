import { useEffect, useState } from 'react'
import { useOptionalAnalysisEnvironment } from '../environment'
import type { DayScore } from './types'

/**
 * The day score of a date, read again whenever `refresh` changes (a tab switch, a data revision), so a label saved in Label Trades is in
 * the score by the time the user looks. `enabled` false does nothing. Without a host score source the result stays null.
 */
export function useDayScore(date: string, enabled: boolean, refresh: unknown): { score: DayScore | null; loading: boolean; error: string | null } {
  const source = useOptionalAnalysisEnvironment()?.dayScore
  const [state, setState] = useState<{ date: string; score: DayScore | null; error: string | null; loading: boolean }>({ date, score: null, error: null, loading: false })
  useEffect(() => {
    if (!source || !enabled) return
    let live = true
    setState(current => ({ date, score: current.date === date ? current.score : null, error: null, loading: true }))
    source.day(date)
      .then(score => { if (live) setState({ date, score, error: null, loading: false }) })
      .catch(cause => { if (live) setState({ date, score: null, error: cause instanceof Error ? cause.message : String(cause), loading: false }) })
    return () => { live = false }
  }, [source, date, enabled, refresh])
  return { score: state.date === date ? state.score : null, loading: state.loading, error: state.error }
}
