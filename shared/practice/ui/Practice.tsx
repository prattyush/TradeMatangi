import { useEffect, useState } from 'react'
import { PracticeHostProvider, usePracticeHost, type PracticeHost } from './host'
import PracticeStart from './PracticeStart'
import PracticeHistory from './PracticeHistory'
import PracticeReview from './PracticeReview'
import '../../deepdive/ui/deepdive.css'
import './practice.css'

/**
 * The Pattern Library's Practice tab: practise a strategy by replaying one of the days marked in its Deep Dive, then review
 * your trades against what you recorded. Start picks the day, History lists past runs, Review opens one that has ended.
 */
export default function Practice({ host }: { host: PracticeHost }) {
  return <PracticeHostProvider host={host}><PracticeScreen /></PracticeHostProvider>
}

function PracticeScreen() {
  const host = usePracticeHost()
  const [tab, setTab] = useState<'start' | 'history'>('start')
  const [review, setReview] = useState<string | null>(host.reviewSessionId ?? null)
  const requested = host.reviewSessionId
  useEffect(() => {
    if (requested) { setReview(requested); host.onReviewOpened?.() }
  }, [requested]) // eslint-disable-line react-hooks/exhaustive-deps

  if (review) return <div className="pr"><PracticeReview key={review} sessionId={review} onBack={() => { setReview(null); setTab('history') }} /></div>
  return <div className="pr">
    <div className="pl-bar pr-tabs" role="tablist" aria-label="Practice">
      <button role="tab" aria-selected={tab === 'start'} className={tab === 'start' ? 'pl-primary' : ''} onClick={() => setTab('start')}>Start practice</button>
      <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'pl-primary' : ''} onClick={() => setTab('history')}>History</button>
    </div>
    {tab === 'start' ? <PracticeStart /> : <PracticeHistory onReview={setReview} />}
  </div>
}
