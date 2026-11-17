import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { DiveChartProps } from '../../deepdive/ui/host'
import type { PracticeApi, PracticePlan } from '../types'

/** What the Strategy Practice screens need from where they run (the website or the Windows app). */
export interface PracticeHost {
  api: PracticeApi
  /** The chart: the KLine Analysis chart, or the website's Lightweight chart. It draws the `annotations` it is given. */
  Chart: ComponentType<DiveChartProps>
  historicalDays: number
  /** Why a practice run cannot start right now (for example a session is running), or null. */
  blockedReason: string | null
  /** The host's own replay speed: the website counts seconds per tick (lower is faster), the desktop a multiplier. */
  defaultSpeed: number
  renderSpeed(value: number, onChange: (value: number) => void): ReactNode
  /** Starts the replay on the chosen day (leaves the library for the trading screen). Rejects with a sentence the user can read. */
  startPractice(plan: PracticePlan, speed: number): Promise<void>
  /** A session whose review should open now (after Stop on the trading screen), or null. */
  reviewSessionId?: string | null
  onReviewOpened?(): void
}

const Context = createContext<PracticeHost | null>(null)
export const PracticeHostProvider = ({ host, children }: { host: PracticeHost; children: ReactNode }) => <Context.Provider value={host}>{children}</Context.Provider>
export function usePracticeHost(): PracticeHost {
  const host = useContext(Context)
  if (!host) throw new Error('The Practice screen needs a host')
  return host
}
