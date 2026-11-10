import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Browser } from '@capacitor/browser'
import { AnalysisProvider, type AnalysisEnvironment } from '../../../shared/analysis/environment'
import AnalysisPanels from '../../../shared/analysis/kline/AnalysisPanels'
import AnalysisChart, { ComparisonChart } from '../../../shared/analysis/kline/AnalysisChart'
import { createAnalysisApi, validAnalysisPath, type AnalysisRequest } from '../../../windowsapp/src/analysisApi'
import { createVideoLinksApi } from '../../../windowsapp/src/tools/videoLinks'
import { createWhatIfApi } from '../../../windowsapp/src/tools/whatIf'
import { useServices } from '../app/AppContext'
import { useChartInfo } from '../app/ChartInfo'
import { isNativeApp } from '../api/storage'
import type { ApiClient } from '../api/transport'
import '../../../shared/analysis/kline/desktopAnalysis.css'

/**
 * The analysis requests the shared screens make, sent through the phone's Bearer transport.
 * The path allowlist is the desktop's: nothing outside the analysis routes can be reached from here.
 */
export function createAnalysisRequest(client: ApiClient): AnalysisRequest {
  return async <T,>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> => {
    if (!validAnalysisPath(path, method)) throw new Error('Invalid analysis request')
    const value = await client.request<T>(`/api/desktop/v1/analysis/${path}`, { method, body: method === 'POST' ? body ?? {} : undefined, signal })
    // The shared code expects null (not undefined) for "no content".
    return (value === undefined ? null : value) as T
  }
}

/** Open a saved YouTube video outside the app: the YouTube app when installed, otherwise a Custom Tab. */
export async function openVideo(video: { videoId: string; url: string }): Promise<void> {
  if (isNativeApp()) await Browser.open({ url: video.url })
  else window.open(video.url, '_blank', 'noopener,noreferrer')
}

/** Build the environment that the shared Analysis components read. Rebuilt only when the signed-in client changes. */
export function usePhoneAnalysisEnvironment(): AnalysisEnvironment {
  const { client } = useServices()
  const { chartInfo } = useChartInfo()
  // The user's P&L display preference (money or % of capital), the same setting the website and desktop use for labeling.
  const [pnlDisplayMode, setPnlDisplayMode] = useState<'currency' | 'percent'>('currency')
  useEffect(() => {
    const controller = new AbortController()
    client.get<{ desktop_pnl_display_mode?: string }>('/api/desktop/v1/trading/settings/current', undefined, { signal: controller.signal, retries: 0 })
      .then(settings => setPnlDisplayMode(settings.desktop_pnl_display_mode === 'percent' ? 'percent' : 'currency'))
      .catch(() => undefined) // an older server or no access: money, the default
    return () => controller.abort()
  }, [client])
  const built = useMemo(() => {
    const request = createAnalysisRequest(client)
    const adapter = createAnalysisApi(request)
    const links = createVideoLinksApi(request)
    const whatIf = createWhatIfApi(request)
    const environment: AnalysisEnvironment = {
      api: adapter.api,
      performance: adapter.performance,
      videoLinks: { list: links.list, listMine: links.listMine, save: links.save, remove: links.remove, open: video => { void openVideo(video) } },
      whatIf,
      active: true,
      desktop: false,
      historicalDays: 2,
      charts: {
        AnalysisChartPanel: AnalysisPanels,
        LabelCharts: AnalysisPanels,
        AnalysisChart,
        OptionsChart: AnalysisChart,
        SnapshotChart: AnalysisChart,
        SnapshotOptionsChart: AnalysisChart,
        TradesChart: ComparisonChart,
        PatternChart: ComparisonChart,
      },
    }
    return { adapter, environment }
  }, [client])
  // The data layer is built once per client; only the display setting changes here.
  return useMemo(() => ({ ...built.environment, chartInfo, pnlDisplayMode }), [built, chartInfo, pnlDisplayMode])
}

export function PhoneAnalysisProvider({ children }: { children: ReactNode }) {
  const environment = usePhoneAnalysisEnvironment()
  return <AnalysisProvider value={environment}>{children}</AnalysisProvider>
}
