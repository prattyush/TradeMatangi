import type { SessionGroup } from '../../../../../shared/analysis/TradeAnalysis'
import { useAnalysisApi } from '../../../../../shared/analysis/environment'
import { isLabeled, labelKey, tripKey } from '../../../../../shared/analysis/labeling/model'
import { useLoad } from '../../../app/useLoad'

export interface LabelProgress { labeled: number; total: number }

/** How many of a day's round trips have a pattern chosen. Two small requests per session, only for the open day. */
export function useLabelProgress(group: SessionGroup, enabled: boolean, revision: number): LabelProgress | null {
  const api = useAnalysisApi()
  const progress = useLoad(async (): Promise<LabelProgress | null> => {
    if (!enabled) return null
    const ids = group.sessions.map(session => session.session_id)
    const [tripPages, labelPages] = await Promise.all([Promise.all(ids.map(id => api.getRoundTrips(id))), Promise.all(ids.map(id => api.getLabels(id)))])
    const labels = new Map(labelPages.flat().map(label => [labelKey(label.session_id, label.round_trip_index), label]))
    const trips = tripPages.flatMap((rows, position) => rows.map(row => ({ ...row, session_id: ids[position] })))
    return { labeled: trips.filter(trip => isLabeled(labels.get(tripKey(trip)))).length, total: trips.length }
  }, [group.key, api, enabled, revision])
  // A failure here only hides the count; labeling itself reports its own errors.
  return progress.data
}
