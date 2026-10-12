import SwingChart from '../components/SwingChart'
import {BACKEND_URL} from '../config'
import {_authHeaders} from './api'
import type {SwingRequest} from '../../../shared/SwingPortfolioPanel'
import { WebsiteAnalysisChart, WebsiteOptionsChart, WebsiteAnalysisChartPanel } from '../components/analysis/AnalysisCharts'
import { WebsiteSnapshotChart, WebsiteSnapshotOptionsChart } from '../components/analysis/SnapshotCharts'
import { WebsiteTradesChart, WebsitePatternChart } from '../components/analysis/ComparisonCharts'
import type { ComponentType, ComponentProps } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import api from './api'
import { flashError } from './notifications'
import * as performance from './performanceApi'
const swingRequest:SwingRequest=async<T,>(path:string,method:string,body?:Record<string,unknown>)=>{const response=await fetch(`${BACKEND_URL}/api/swing/portfolios/${path}`,{method,headers:{..._authHeaders(),'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});if(!response.ok)throw new Error('Swing history could not load');return response.json() as Promise<T>}
const environment = { swingRequest, api, performance, reportError: flashError, charts: {
  SwingChart, AnalysisChart: WebsiteAnalysisChart, OptionsChart: WebsiteOptionsChart, AnalysisChartPanel: WebsiteAnalysisChartPanel,
  SnapshotChart: WebsiteSnapshotChart, SnapshotOptionsChart: WebsiteSnapshotOptionsChart,
  TradesChart: WebsiteTradesChart, PatternChart: WebsitePatternChart,
} }
export function withWebsiteAnalysis<T extends ComponentType<any>>(Component: T) {
  return function WebsiteAnalysis(props: ComponentProps<T>) {
    return <AnalysisProvider value={environment}><Component {...props} /></AnalysisProvider>
  }
}
