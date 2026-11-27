import SwingChart from '../components/SwingChart'
import {BACKEND_URL} from '../config'
import {_authHeaders} from './api'
import type {SwingRequest} from '../../../shared/SwingPortfolioPanel'
import { WebsiteAnalysisChart, WebsiteOptionsChart, WebsiteAnalysisChartPanel } from '../components/analysis/AnalysisCharts'
import { WebsiteSnapshotChart, WebsiteSnapshotOptionsChart } from '../components/analysis/SnapshotCharts'
import { WebsiteTradesChart, WebsitePatternChart } from '../components/analysis/ComparisonCharts'
import { useMemo, type ComponentType, type ComponentProps } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import api, { practiceApi, getVideoLinks, saveVideoLink, removeVideoLink, getWhatIfScenarios, getWhatIfRange, saveWhatIfScenario, removeWhatIfScenario } from './api'
import { flashError } from './notifications'
import * as performance from './performanceApi'
import { useAnalysisChartRenderer } from '../hooks/useAnalysisChartRenderer'
import { useAnalysisPnlMode } from '../hooks/useAnalysisPnlMode'
import { useAnalysisLabelView } from '../hooks/useAnalysisLabelView'
import { KLineAnalysisScope, klineAnalysisCharts } from '../components/analysis/KLineAnalysis'
import { desktopDrawingRequest, resolveSymbolInstrument } from './desktopDrawingRequest'
import { rendererAccountKey } from './websiteChartPreferences'
import DeepDiveLightChart from '../components/deepdive/DeepDiveLightChart'
import { loadHistoricalDays } from '../components/SettingsModal'
const swingRequest:SwingRequest=async<T,>(path:string,method:string,body?:Record<string,unknown>)=>{const response=await fetch(`${BACKEND_URL}/api/swing/portfolios/${path}`,{method,headers:{..._authHeaders(),'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});if(!response.ok)throw new Error('Swing history could not load');return response.json() as Promise<T>}
const lightweightCharts = {
  SwingChart, AnalysisChart: WebsiteAnalysisChart, OptionsChart: WebsiteOptionsChart, AnalysisChartPanel: WebsiteAnalysisChartPanel,
  SnapshotChart: WebsiteSnapshotChart, SnapshotOptionsChart: WebsiteSnapshotOptionsChart,
  TradesChart: WebsiteTradesChart, PatternChart: WebsitePatternChart,
}
const videoLinks = { list: getVideoLinks, save: saveVideoLink, remove: removeVideoLink, open: (video: { url: string }) => { window.open(video.url, '_blank', 'noopener,noreferrer') } }
const whatIf = { list: getWhatIfScenarios, range: getWhatIfRange, save: saveWhatIfScenario, remove: removeWhatIfScenario }
const base = { swingRequest, api, performance, videoLinks, whatIf, reportError: flashError }
// Strategy Practice: the review of a practice run on the same chart the Pattern Library's Practice tab uses for each renderer.
const practiceFor = (Chart: ComponentType<any>) => ({ api: practiceApi, Chart, historicalDays: loadHistoricalDays() })
// The Lightweight charts save their drawings to the database through the same service and instrument identity as KLine, so both share them.
const lightweightEnvironment = { ...base, charts: lightweightCharts, practice: practiceFor(DeepDiveLightChart), drawingRequest: desktopDrawingRequest, resolveSymbolInstrument }
export function withWebsiteAnalysis<T extends ComponentType<any>>(Component: T) {
  return function WebsiteAnalysis(props: ComponentProps<T>) {
    // Analysis & Patterns use their own renderer setting, independent of the trading chart.
    const renderer = useAnalysisChartRenderer()
    const [labelView, onLabelViewChange] = useAnalysisLabelView()
    const pnlDisplayMode = useAnalysisPnlMode()
    const kline = useMemo(() => ({
      ...base, charts: { SwingChart, ...klineAnalysisCharts }, practice: practiceFor(klineAnalysisCharts.AnalysisChart),
      drawingRequest: desktopDrawingRequest, resolveSymbolInstrument, accountKey: rendererAccountKey(), chartPicking: true,
    }), [])
    const labels = useMemo(() => ({ labelView, onLabelViewChange, pnlDisplayMode }), [labelView, onLabelViewChange, pnlDisplayMode])
    const klineValue = useMemo(() => ({ ...kline, ...labels }), [kline, labels])
    const lightweightValue = useMemo(() => ({ ...lightweightEnvironment, ...labels }), [labels])
    if (renderer === 'kline') return <AnalysisProvider value={klineValue}><KLineAnalysisScope><Component {...props} /></KLineAnalysisScope></AnalysisProvider>
    return <AnalysisProvider value={lightweightValue}><Component {...props} /></AnalysisProvider>
  }
}
