import { useCallback, useState } from 'react'
import type { ChartLayout } from './inDepthModel'

const KEY = 'tm.deepdive.chartLayout'
const read = (): ChartLayout => {
  try { return localStorage.getItem(KEY) === 'side' ? 'side' : 'stacked' } catch { return 'stacked' }
}

/** The in-depth step's chart layout (stacked, or the two charts side by side), remembered in this browser; day to day it stays as chosen. */
export function useChartLayout() {
  const [layout, setLayout] = useState<ChartLayout>(read)
  const choose = useCallback((next: ChartLayout) => {
    setLayout(next)
    try { localStorage.setItem(KEY, next) } catch { /* the choice just is not remembered */ }
  }, [])
  return [layout, choose] as const
}
