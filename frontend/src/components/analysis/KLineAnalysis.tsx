import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import './klineAnalysisSite.css'

// KLine is lazy-loaded so Lightweight-only users never download it.
const Chart = lazy(() => import('../../../../shared/analysis/kline/AnalysisChart'))
const Comparison = lazy(() => import('../../../../shared/analysis/kline/AnalysisChart').then(module => ({ default: module.ComparisonChart })))
const Panels = lazy(() => import('../../../../shared/analysis/kline/AnalysisPanels'))

function suspended(Component: ComponentType<any>): ComponentType<any> {
  return function KLineAnalysisRenderer(props) {
    return <Suspense fallback={<p role="status" style={{ color: '#8b949e', fontSize: 12 }}>Loading KLine chart…</p>}><Component {...props} /></Suspense>
  }
}
const KLineChart = suspended(Chart)
const KLineComparison = suspended(Comparison)
const KLinePanels = suspended(Panels)

/** Renderer map for `AnalysisEnvironment.charts` when the Analysis & Patterns renderer is KLine. */
export const klineAnalysisCharts = {
  AnalysisChart: KLineChart, OptionsChart: KLineChart,
  AnalysisChartPanel: KLinePanels,
  SnapshotChart: KLineChart, SnapshotOptionsChart: KLineChart,
  TradesChart: KLineComparison, PatternChart: KLineComparison,
}
/** Scopes the KLine Analysis styles; renders no box of its own. */
export function KLineAnalysisScope({ children }: { children: ReactNode }) {
  return <div className="kline-analysis-site">{children}</div>
}
