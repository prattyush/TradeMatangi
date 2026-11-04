import { useCallback, useEffect, useState } from 'react'
import api from '../services/api'
import { analysisLabelViewEvent, cachedAnalysisLabelView, publishAnalysisLabelView, type AnalysisLabelView } from '../services/analysisLabelViewPreference'

/** Label Trades layout: cached locally, the server value wins once loaded; writing persists to user settings. */
export function useAnalysisLabelView(): [AnalysisLabelView, (view: AnalysisLabelView) => Promise<void>] {
  const [view, setView] = useState(cachedAnalysisLabelView)
  useEffect(() => {
    const changed = (event: Event) => setView((event as CustomEvent<AnalysisLabelView>).detail)
    window.addEventListener(analysisLabelViewEvent, changed)
    // getUserSettings publishes analysis_label_view, which updates this hook.
    void api.getUserSettings().catch(() => undefined)
    return () => window.removeEventListener(analysisLabelViewEvent, changed)
  }, [])
  const change = useCallback(async (next: AnalysisLabelView) => {
    const previous = cachedAnalysisLabelView()
    publishAnalysisLabelView(next)
    try { await api.updateUserSettings({ analysis_label_view: next }) }
    catch (error) { publishAnalysisLabelView(previous); throw error }
  }, [])
  return [view, change]
}
