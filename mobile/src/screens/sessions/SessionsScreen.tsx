import { useEffect, useMemo, useState } from 'react'
import { useBackHandler, useTabReselect } from '../../app/Nav'
import { groupSessions } from '../../../../shared/analysis/TradeAnalysis'
import { useAnalysisApi } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useLoad } from '../../app/useLoad'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { activeFilterCount, customRangeProblem, DEFAULT_FILTERS, describeRange, rangeDates, type SessionFilters } from './filters'
import { FilterSheet } from './FilterSheet'
import { SessionDetail } from './SessionDetail'
import { SessionRow } from './SessionList'
import './sessions.css'

/** What the screen was showing when the user left it (another tab), so coming back finds the same day and filters. */
const remembered: { filters: SessionFilters; selected: string | null } = { filters: DEFAULT_FILTERS, selected: null }

/**
 * Sessions: the list of trading days on the left, the chosen day on the right. Choosing a day hides the list so the
 * chart gets the whole width; the Days button or tapping Sessions again brings it back, and Back does too.
 */
export function SessionsScreen() {
  const api = useAnalysisApi()
  const [filters, setFilters] = useState<SessionFilters>(() => remembered.filters)
  const [showFilters, setShowFilters] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => remembered.selected)
  const [listOpen, setListOpen] = useState(() => remembered.selected === null)
  useEffect(() => { remembered.filters = filters; remembered.selected = selected }, [filters, selected])

  const sessions = useLoad(() => {
    if (customRangeProblem(filters)) return Promise.resolve([])
    const { startDate, endDate } = rangeDates(filters)
    return api.getAnalysisSessions({
      startDate, endDate,
      tradingStyle: filters.style || undefined,
      symbol: filters.symbol || undefined,
      instrumentType: filters.instrument || undefined,
      sessionType: filters.mode || undefined,
    })
  }, [api, JSON.stringify(filters)])

  const groups = useMemo(() => (sessions.data ? groupSessions(sessions.data) : []), [sessions.data])
  const symbols = useMemo(() => [...new Set((sessions.data ?? []).map(session => session.symbol))].sort(), [sessions.data])
  const current = groups.find(group => group.key === selected) ?? null
  useEffect(() => { if (selected && sessions.data && !current) setSelected(null) }, [selected, sessions.data, current])
  // With nothing chosen the list is always shown; with a day chosen it is shown only when asked for.
  const showList = listOpen || !current
  useTabReselect('sessions', () => { if (current) setListOpen(open => !open) })
  useBackHandler(current && !listOpen ? () => { setListOpen(true); return true } : null)

  const count = activeFilterCount(filters)
  return (
    <section className={`screen sessions${showList ? '' : ' list-hidden'}`} aria-label="Sessions">
      <aside className="session-pane" hidden={!showList}>
        <header className="pane-head">
          <h2>Sessions</h2>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => setShowFilters(true)}>
            Filters{count > 0 && <span className="count" aria-label={`${count} filters active`}>{count}</span>}
          </button>
        </header>
        <div className="range-note">{describeRange(filters)}{sessions.data ? ` · ${groups.length} ${groups.length === 1 ? 'day' : 'days'}` : ''}</div>
        <div className="session-list" role="list">
          {sessions.loading && !sessions.data && <Spinner label="Loading sessions" />}
          {sessions.error != null && !sessions.data && (isNotAvailable(sessions.error)
            ? <NotAvailable what="Sessions" />
            : <ErrorState message={describeError(sessions.error)} onRetry={sessions.reload} />)}
          {sessions.data && groups.length === 0 && (
            <EmptyState title="No sessions in this period">
              {filters.range === '90d' || filters.range === '1y' ? 'Try other filters.' : 'Widen the period or change the filters.'}
              {filters.range !== '1y' && <><br /><button type="button" className="btn" onClick={() => setFilters({ ...filters, range: '1y' })}>Show 1 year</button></>}
            </EmptyState>
          )}
          {groups.map(group => (
            <SessionRow key={group.key} group={group} selected={group.key === selected} onSelect={() => { setSelected(group.key); setListOpen(false) }} />
          ))}
        </div>
      </aside>
      <div className="detail-pane">
        {current ? <SessionDetail key={current.key} group={current} daysOpen={showList} onToggleDays={() => setListOpen(open => !open)} /> : (
          <EmptyState title={groups.length ? 'Pick a session' : 'No session selected'}>
            {groups.length ? 'Choose a trading day on the left to see its chart, trades and videos.' : ''}
          </EmptyState>
        )}
      </div>
      {showFilters && (
        <FilterSheet filters={filters} symbols={symbols} onClose={() => setShowFilters(false)}
          onApply={next => { setFilters(next); setSelected(null); setListOpen(true); setShowFilters(false) }} />
      )}
    </section>
  )
}
