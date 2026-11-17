import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { PatternAnnotation } from '../../analysis/api'
import type { OptionStrikes } from '../strikes'
import type { DeepDiveApi } from '../types'

/** The account settings the Deep Dive reads: how option strikes are picked, and how many days a chart loads. */
export interface DiveSettings { mode: string; ceCap: number; peCap: number; historicalDays: number; loaded?: boolean }

/** What every host's chart takes. The desktop and the website's KLine mode pass the shared Analysis chart; Lightweight has its own. */
export interface DiveChartProps {
  symbol: string
  date: string
  title?: string
  strike?: number
  right?: string
  expiry?: string
  historicalDays?: number
  annotations?: PatternAnnotation[]
  activeStrategy?: string | null
  activeCategory?: string | null
  pickMode?: boolean
  onPick?: (point: { time: number; price: number }) => void
  pickHint?: string
  /** Epoch seconds (the chart clock) to centre the chart on, e.g. a trade's entry; absent = the whole day as before. */
  focusTime?: number
}

/**
 * Everything the Deep Dive screens need from where they run, so one set of screens serves the Windows app and the website:
 * the Deep Dive API, the category and strategy names, the strike lookup, the account settings and the chart component.
 */
export interface DeepDiveHost {
  api: DeepDiveApi
  names: {
    categories(): Promise<string[]>
    strategies(): Promise<string[]>
    addCategory(name: string): Promise<unknown>
    addStrategy(name: string): Promise<unknown>
  }
  expiry(symbol: string, date: string): Promise<string>
  /** The strikes the account's strike setting picks for a day (OTM from the 09:15 price, or Max Price at 09:30). */
  resolveStrikes(symbol: string, date: string, offset: number, settings: DiveSettings): Promise<OptionStrikes>
  settings: DiveSettings
  Chart: ComponentType<DiveChartProps>
}

const Context = createContext<DeepDiveHost | null>(null)

export function DeepDiveHostProvider({ host, children }: { host: DeepDiveHost; children: ReactNode }) {
  return <Context.Provider value={host}>{children}</Context.Provider>
}

export function useDeepDiveHost(): DeepDiveHost {
  const host = useContext(Context)
  if (!host) throw new Error('The Deep Dive needs a host')
  return host
}
