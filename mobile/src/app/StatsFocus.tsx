import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { CycleIdentity } from '../../../shared/analysis/performance'

/** A trade cycle another screen wants Stats to open (the execution details' "Open cycle"). Consumed once by Stats. */
interface StatsFocusValue {
  cycle: CycleIdentity | null
  open(cycle: CycleIdentity): void
  clear(): void
}
const StatsFocusContext = createContext<StatsFocusValue | null>(null)

export function StatsFocusProvider({ children }: { children: ReactNode }) {
  const [cycle, setCycle] = useState<CycleIdentity | null>(null)
  const open = useCallback((value: CycleIdentity) => setCycle(value), [])
  const clear = useCallback(() => setCycle(null), [])
  const value = useMemo(() => ({ cycle, open, clear }), [cycle, open, clear])
  return <StatsFocusContext.Provider value={value}>{children}</StatsFocusContext.Provider>
}

export function useStatsFocus(): StatsFocusValue {
  const value = useContext(StatsFocusContext)
  if (!value) throw new Error('useStatsFocus must be used inside <StatsFocusProvider>')
  return value
}
