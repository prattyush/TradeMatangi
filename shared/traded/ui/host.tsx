import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { DiveChartProps } from '../../deepdive/ui/host'
import type { TradedApi } from '../types'

/** What the traded-patterns screens need from where they run (the Windows app or the website). */
export interface TradedHost {
  api: TradedApi
  /** The chart: the KLine Analysis chart, or the website's Lightweight chart. It draws the `annotations` it is given. */
  Chart: ComponentType<DiveChartProps>
  historicalDays: number
  /** Opens a saved pattern chart for editing (the host's Annotate screen). */
  onEdit: (chartId: string) => void | Promise<void>
}

const Context = createContext<TradedHost | null>(null)
export const TradedHostProvider = ({ host, children }: { host: TradedHost; children: ReactNode }) => <Context.Provider value={host}>{children}</Context.Provider>
export function useTradedHost(): TradedHost {
  const host = useContext(Context)
  if (!host) throw new Error('The traded patterns screen needs a host')
  return host
}
