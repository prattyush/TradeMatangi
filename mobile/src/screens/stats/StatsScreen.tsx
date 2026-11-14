import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PerformanceDashboard from '../../../../shared/analysis/PerformanceDashboard'
import { AnalysisProvider, useAnalysisEnvironment, type AnalysisEnvironment } from '../../../../shared/analysis/environment'
import { describeError } from '../../api/errors'
import { useBackHandler, useNav } from '../../app/Nav'
import { useStatsFocus } from '../../app/StatsFocus'
import './stats.css'

/** An error whose text is already phrased for the user: the shared dashboard prints `String(error)`. */
class ReadableError extends Error {
  override toString() { return this.message }
}

/** Wrap a data call so the shared screens show a sentence ("not available on this server") instead of a raw error. */
function readable<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => call(...args).catch((error: unknown) => {
    if ((error as { name?: string })?.name === 'AbortError') throw error
    throw new ReadableError(describeError(error))
  })
}

/**
 * The phone's read-only Stats: the shared performance dashboard (so every statistic stays identical to the
 * website and desktop) inside a phone layout. Actual-charges editing is not offered; nothing is written here.
 */
export function phoneStatsEnvironment(base: AnalysisEnvironment): AnalysisEnvironment {
  const p = base.performance
  return {
    ...base,
    performance: {
      getPerformance: readable(p.getPerformance),
      getPerformanceCycles: readable(p.getPerformanceCycles),
      getPerformanceDetail: readable(p.getPerformanceDetail),
      getHabitLedger: p.getHabitLedger && readable(p.getHabitLedger),
      getSwingReport: p.getSwingReport && readable(p.getSwingReport),
    },
  }
}

const isoDaysAgo = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function StatsScreen() {
  const base = useAnalysisEnvironment()
  const environment = useMemo(() => phoneStatsEnvironment(base), [base])
  const { setTab } = useNav()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const focus = useStatsFocus()
  // A trade opened from elsewhere (Sessions > execution details > Open cycle) is shown once, then forgotten.
  const selected = useRef(focus.cycle).current
  const { clear } = focus
  useEffect(() => { clear() }, [clear])
  const range = useMemo(() => ({ start: isoDaysAgo(29), end: isoDaysAgo(0) }), [])

  // Back closes, in order: the trade details drawer, then the filters panel.
  const onBack = useCallback(() => {
    const closeDetails = root.current?.querySelector<HTMLButtonElement>('button[aria-label="Close trade details"]')
    if (closeDetails) { closeDetails.click(); return true }
    if (filtersOpen) { setFiltersOpen(false); return true }
    return false
  }, [filtersOpen])
  useBackHandler(onBack)

  return (
    <AnalysisProvider value={environment}>
      <section className="screen phone-stats" ref={root} data-filters={filtersOpen ? 'open' : 'closed'} aria-label="Stats">
        <PerformanceDashboard
          defaultSymbol=""
          defaultStartDate={range.start}
          defaultEndDate={range.end}
          defaultInstrumentType=""
          defaultSessionType=""
          selectedCycle={selected ?? undefined}
          onClose={() => setTab('sessions')}
        />
        <button type="button" className="stats-filters-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(open => !open)}>
          {filtersOpen ? 'Hide filters' : 'Filters'}
        </button>
      </section>
    </AnalysisProvider>
  )
}
