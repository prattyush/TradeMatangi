import type { ComponentType, ComponentProps } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import api from './api'
import * as performance from './performanceApi'
const environment = { api, performance }
export function withWebsiteAnalysis<T extends ComponentType<any>>(Component: T) {
  return function WebsiteAnalysis(props: ComponentProps<T>) {
    return <AnalysisProvider value={environment}><Component {...props} /></AnalysisProvider>
  }
}
