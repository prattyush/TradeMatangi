import { useCallback, useEffect, useState } from 'react'
import type { BehaviorQuestion } from '../api'
import { readableError, type BehaviorApi } from './types'

const EMPTY: ReadonlySet<string> = new Set()
export type BehaviorDataStatus = 'loading' | 'ready' | 'error'

/**
 * Behavior questions (including archived ones, so earlier marks stay visible) and the marks already saved for one
 * session, for the in-session labeling popups. A failure never blocks labeling; the popup just omits the checklist.
 */
export function useBehaviorData(api: BehaviorApi, sessionId: string) {
  const [status, setStatus] = useState<BehaviorDataStatus>('loading')
  const [error, setError] = useState('')
  const [questions, setQuestions] = useState<BehaviorQuestion[]>([])
  const [marks, setMarks] = useState<Map<number, Set<string>>>(new Map())
  const load = useCallback(async (silent = false) => {
    if (!silent) { setStatus('loading'); setError('') }
    try {
      const [rows, saved] = await Promise.all([api.getBehaviorQuestions(true), api.getBehaviorMarks(sessionId)])
      const byTrip = new Map<number, Set<string>>()
      for (const mark of Array.isArray(saved) ? saved : []) byTrip.set(mark.round_trip_index, (byTrip.get(mark.round_trip_index) ?? new Set()).add(mark.question_id))
      setQuestions(Array.isArray(rows) ? rows : []); setMarks(byTrip); setStatus('ready')
    } catch (cause) { if (!silent) { setError(readableError(cause)); setStatus('error') } }
  }, [api, sessionId])
  useEffect(() => { void load() }, [load])
  const markedFor = useCallback((roundTripIndex: number): ReadonlySet<string> => marks.get(roundTripIndex) ?? EMPTY, [marks])
  /** Refreshes the question list without resetting the popup (after the manager changed something). */
  const refresh = useCallback(() => load(true), [load])
  return { status, error, questions, markedFor, reload: load, refresh }
}
