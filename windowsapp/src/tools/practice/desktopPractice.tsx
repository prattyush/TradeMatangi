import { useMemo, type ComponentType } from 'react'
import type { DiveChartProps } from '../../../../shared/deepdive/ui/host'
import type { PracticeHost } from '../../../../shared/practice/ui/host'
import { practiceStartConfig } from '../../../../shared/practice/startConfig'
import DesktopAnalysisChart from '../../AnalysisChart'
import type { PatternsClient } from '../../patternsClient'
import type { PatternSettings } from '../usePatternsRuntime'
import { REPLAY_SPEEDS, launchFrom, type PracticeLaunch } from './launch'

const renderSpeed = (value: number, onChange: (value: number) => void) => (
  <select value={String(value)} onChange={e => onChange(Number(e.target.value))} aria-label="Replay speed">
    {REPLAY_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
  </select>
)

/**
 * The Strategy Practice host on the Windows app: the patterns transport, the account settings and the KLine Analysis chart.
 * Starting resolves the day's contracts here (the patterns client has the price and expiry lookups) and hands a launch to the
 * workspace, which starts the ordinary Replay on a screen. It rejects with a sentence when the screen cannot start it.
 */
export function useDesktopPracticeHost(
  client: PatternsClient, settings: PatternSettings,
  launch: (request: PracticeLaunch) => Promise<void>,
  review: { sessionId: string | null; onOpened: () => void },
): PracticeHost {
  return useMemo(() => {
    let counter = 0
    return {
      api: client.practice,
      Chart: DesktopAnalysisChart as ComponentType<DiveChartProps>,
      historicalDays: settings.historicalDays,
      blockedReason: null, // the workspace screen refuses (with the reason) when a run is still going
      modes: ['replay', 'stepwise'],
      defaultSpeed: 1,
      renderSpeed,
      startPractice: async (plan, { mode, speed }) => {
        const config = await practiceStartConfig(plan, { getExpiry: (symbol, date) => client.getExpiry(symbol, date), getPriceAt: (symbol, date, time) => client.getPriceAt(symbol, date, time) })
        await launch(launchFrom(Date.now() * 1000 + (++counter), plan, config, speed, mode))
      },
      reviewSessionId: review.sessionId,
      onReviewOpened: review.onOpened,
    } satisfies PracticeHost
  }, [client, settings.historicalDays, launch, review.sessionId, review.onOpened])
}
