import { useMemo, type ComponentType } from 'react'
import type { DeepDiveHost, DiveChartProps } from '../../../../shared/deepdive/ui/host'
import { resolveStrikes } from '../../../../shared/deepdive/strikes'
import DesktopAnalysisChart from '../../AnalysisChart'
import type { PatternsClient } from '../../patternsClient'
import type { PatternSettings } from '../usePatternsRuntime'

/** The Deep Dive's host on the Windows app: the patterns transport, the account settings and the KLine Analysis chart. */
export function useDesktopDeepDiveHost(client: PatternsClient, settings: PatternSettings): DeepDiveHost {
  return useMemo(() => ({
    api: client.deepDive,
    names: {
      categories: async () => (await client.listCategories()).categories,
      strategies: async () => (await client.listStrategies()).strategies,
      addCategory: client.addCategory,
      addStrategy: client.addStrategy,
    },
    expiry: async (symbol, date) => (await client.getExpiry(symbol, date)).expiry,
    resolveStrikes: (symbol, date, offset, current) => resolveStrikes(client, symbol, date, offset, current),
    settings,
    Chart: DesktopAnalysisChart as ComponentType<DiveChartProps>,
  }), [client, settings])
}
