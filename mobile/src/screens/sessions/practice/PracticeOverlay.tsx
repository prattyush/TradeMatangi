import AnalysisPracticeReview from '../../../../../shared/practice/ui/AnalysisPracticeReview'
import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import { useAnalysisEnvironment } from '../../../../../shared/analysis/environment'
import { useBackHandler } from '../../../app/Nav'
import './practice.css'

/**
 * The review of a practice run, full screen on the phone (the shared review screen with the phone's layout, practice.css). The phone
 * cannot start a practice run (it has no order screens); it reads the review. Back or "← Back" returns to the session.
 */
export function PracticeOverlay({ group, onClose }: { group: SessionGroup; onClose: () => void }) {
  const environment = useAnalysisEnvironment()
  useBackHandler(() => { onClose(); return true })
  // A group is one practice strategy on one day: review its newest run.
  const run = [...group.sessions].sort((a, b) => b.session_id.localeCompare(a.session_id))[0]
  if (!environment.practice || !run) return null
  return (
    <div className="phone-practice" role="dialog" aria-label="Practice review">
      <AnalysisPracticeReview host={environment.practice} sessionId={run.session_id} onBack={onClose} />
    </div>
  )
}
