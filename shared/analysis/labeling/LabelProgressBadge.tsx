import { useEffect, useRef, useState } from 'react'
import { useAnalysisApi } from '../environment'
import './labeling.css'
import { dayProgress, subscribeLabelProgress, type DayProgress } from './dayProgress'

/**
 * A small mark on a date row: green tick when every round trip of the day is fully labelled (expected and actual category and
 * strategy), amber "2/5" when some are not, nothing for a day without round trips. It reads only when the row is on screen.
 */
export default function LabelProgressBadge({ sessionIds }: { sessionIds: string[] }) {
  const api = useAnalysisApi()
  const host = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState<DayProgress | 'loading' | 'error'>('loading')
  const key = sessionIds.join('|')

  useEffect(() => {
    const element = host.current
    if (!element || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const load = () => {
      dayProgress(api, sessionIds).then(value => { if (!cancelled) setProgress(value) }).catch(() => { if (!cancelled) setProgress('error') })
    }
    load()
    const stop = subscribeLabelProgress(changed => { if (changed.some(id => sessionIds.includes(id))) load() })
    return () => { cancelled = true; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key, api])

  let body: React.ReactNode = null
  if (progress === 'loading') body = <span className="tl-day-badge" data-state="loading" aria-label="Checking labels" title="Checking which trades are labelled">…</span>
  else if (progress !== 'error' && progress.total > 0) {
    const complete = progress.done === progress.total
    body = complete
      ? <span className="tl-day-badge" data-state="done" aria-label="All trades labelled" title={`All ${progress.total} round trip${progress.total === 1 ? '' : 's'} labelled (expected and actual category and strategy)`}>{'✓'} Labelled</span>
      : <span className="tl-day-badge" data-state="todo" aria-label={`${progress.done} of ${progress.total} trades labelled`} title={`${progress.done} of ${progress.total} round trips fully labelled; ${progress.total - progress.done} still need expected and actual category and strategy`}>{progress.done}/{progress.total} labelled</span>
  }
  return <span ref={host} className="tl-day-badge-host">{body}</span>
}
