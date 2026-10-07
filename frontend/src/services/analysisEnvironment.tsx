import { WebsiteAnalysisChart, WebsiteOptionsChart, WebsiteAnalysisChartPanel } from '../components/analysis/AnalysisCharts'
import { WebsiteSnapshotChart, WebsiteSnapshotOptionsChart } from '../components/analysis/SnapshotCharts'
import { WebsiteTradesChart, WebsitePatternChart } from '../components/analysis/ComparisonCharts'
import type { ComponentType, ComponentProps } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import api from './api'
import { flashError } from './notifications'
import * as performance from './performanceApi'
const environment = { api, performance, reportError: flashError, charts: {
  AnalysisChart: WebsiteAnalysisChart, OptionsChart: WebsiteOptionsChart, AnalysisChartPanel: WebsiteAnalysisChartPanel,
  SnapshotChart: WebsiteSnapshotChart, SnapshotOptionsChart: WebsiteSnapshotOptionsChart,
  TradesChart: WebsiteTradesChart, PatternChart: WebsitePatternChart,
} }
export function withWebsiteAnalysis<T extends ComponentType<any>>(Component: T) {
  return function WebsiteAnalysis(props: ComponentProps<T>) {
    return <AnalysisProvider value={environment}><Component {...props} /></AnalysisProvider>
  }
}
