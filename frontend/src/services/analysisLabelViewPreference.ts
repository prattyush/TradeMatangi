export type AnalysisLabelView = 'one_by_one' | 'all'
export const analysisLabelViewEvent = 'analysis-label-view'
let cached: AnalysisLabelView = 'one_by_one'
export const cachedAnalysisLabelView = () => cached
export const isAnalysisLabelView = (value: unknown): value is AnalysisLabelView => value === 'one_by_one' || value === 'all'
/** Remembers the server value and tells every mounted Label Trades view. */
export function publishAnalysisLabelView(value: unknown) {
  if (!isAnalysisLabelView(value)) return
  cached = value
  window.dispatchEvent(new CustomEvent(analysisLabelViewEvent, { detail: value }))
}
