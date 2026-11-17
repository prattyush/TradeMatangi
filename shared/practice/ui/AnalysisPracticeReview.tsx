import { useMemo } from 'react'
import type { PracticeHost } from './host'
import { PracticeHostProvider } from './host'
import PracticeReview from './PracticeReview'
import '../../deepdive/ui/deepdive.css'
import './practice.css'

/** The Practice review as the Analysis screens show it: only what a review reads (the API and the chart), no way to start a run. */
export interface AnalysisPracticeHost { api: Pick<PracticeHost['api'], 'runs' | 'evaluate'>; Chart: PracticeHost['Chart']; historicalDays?: number }

export default function AnalysisPracticeReview({ host, sessionId, onBack }: { host: AnalysisPracticeHost; sessionId: string; onBack: () => void }) {
  const full = useMemo<PracticeHost>(() => ({
    api: { ...host.api, strategies: async () => [], pick: async () => { throw new Error('A practice run is started from the Pattern Library.') } },
    Chart: host.Chart, historicalDays: host.historicalDays ?? 2, blockedReason: 'A practice run is started from the Pattern Library.',
    defaultSpeed: 1, renderSpeed: () => null, startPractice: async () => { throw new Error('A practice run is started from the Pattern Library.') },
  }), [host])
  return <PracticeHostProvider host={full}><div className="pr"><PracticeReview sessionId={sessionId} onBack={onBack} /></div></PracticeHostProvider>
}
