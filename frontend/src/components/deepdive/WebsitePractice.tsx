import { useMemo } from 'react'
import { practiceApi } from '../../services/api'
import { withWebsiteAnalysis } from '../../services/analysisEnvironment'
import { useAnalysisChartRenderer } from '../../hooks/useAnalysisChartRenderer'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import Practice from '../../../../shared/practice/ui/Practice'
import type { PracticeHost } from '../../../../shared/practice/ui/host'
import type { PracticePlan } from '../../../../shared/practice/types'
import { loadHistoricalDays } from '../SettingsModal'
import DeepDiveLightChart from './DeepDiveLightChart'
import './deepDiveWeb.css'

/** What the page that hosts the Pattern Library hands in: how to start a replay, and whether one can start now. */
export interface WebsitePracticeProps {
  startPractice: (plan: PracticePlan, speed: number) => Promise<void>
  blockedReason: string | null
  reviewSessionId?: string | null
  onReviewOpened?: () => void
}

const renderSpeed = (value: number, onChange: (value: number) => void) => (
  <label className="pr-speed" title="1 = real time; a smaller number replays faster">
    <input type="number" min={0.05} max={100} step={0.05} value={value} aria-label="Replay speed"
      onChange={e => onChange(parseFloat(e.target.value) || 1)} style={{ width: 70 }} /> x <span className="pl-muted">(1 = real time, lower is faster)</span>
  </label>
)

function Page({ startPractice, blockedReason, reviewSessionId, onReviewOpened }: WebsitePracticeProps) {
  const env = useAnalysisEnvironment()
  const renderer = useAnalysisChartRenderer()
  const historicalDays = loadHistoricalDays()
  const host = useMemo<PracticeHost>(() => ({
    api: practiceApi,
    // KLine: the shared Analysis chart. Lightweight: the page's own candles, EMA and marks (the same chart the Deep Dive uses).
    Chart: (renderer === 'kline' && env.charts?.AnalysisChart ? env.charts.AnalysisChart : DeepDiveLightChart) as PracticeHost['Chart'],
    historicalDays, blockedReason, defaultSpeed: 1, renderSpeed, startPractice, reviewSessionId, onReviewOpened,
  }), [renderer, env.charts, historicalDays, blockedReason, startPractice, reviewSessionId, onReviewOpened])
  return <div className="dd-web"><Practice host={host} /></div>
}

/** The Pattern Library's Practice tab on the website and webapp, on whichever chart renderer Analysis & Patterns uses. */
export default withWebsiteAnalysis(Page)
