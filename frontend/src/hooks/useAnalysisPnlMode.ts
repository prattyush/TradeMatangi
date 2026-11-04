import { useEffect, useState } from 'react'
import { analysisPnlModeEvent, cachedAnalysisPnlMode, type AnalysisPnlMode } from '../services/analysisPnlModePreference'

/** P&L display preference (percent or currency) for Analysis; follows Settings changes and the server value. */
export function useAnalysisPnlMode(): AnalysisPnlMode {
  const [mode, setMode] = useState(cachedAnalysisPnlMode)
  useEffect(() => {
    const changed = (event: Event) => setMode((event as CustomEvent<AnalysisPnlMode>).detail)
    window.addEventListener(analysisPnlModeEvent, changed)
    return () => window.removeEventListener(analysisPnlModeEvent, changed)
  }, [])
  return mode
}
