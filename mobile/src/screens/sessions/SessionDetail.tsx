import { useEffect, useMemo, useState } from 'react'
import type { SessionGroup } from '../../../../shared/analysis/TradeAnalysis'
import SessionVideos from '../../../../shared/analysis/SessionVideos'
import StoredOrders from '../../../../shared/analysis/StoredOrders'
import { useAnalysisApi, useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useLoad } from '../../app/useLoad'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { dateParts, formatPnl, pnlClass } from './format'
import { PopoverMenu } from '../../shell/PopoverMenu'
import { PhoneChartPanel } from './PhoneChartPanel'
import { TradesList } from './TradesList'

type Tab = 'chart' | 'trades' | 'orders' | 'videos'
const LABELS: Record<Tab, string> = { chart: 'Chart', trades: 'Trades', orders: 'Orders', videos: 'Videos' }

/** The right-hand pane: one trading day of one instrument, with the chart, executions, orders and videos. */
export function SessionDetail({ group, daysOpen, onToggleDays }: { group: SessionGroup; daysOpen: boolean; onToggleDays: () => void }) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const isSwing = group.trading_style === 'swing'
  const tabs: Tab[] = isSwing ? ['trades', 'videos'] : ['chart', 'trades', 'orders', 'videos']
  const [tab, setTab] = useState<Tab>(tabs[0])
  useEffect(() => { setTab(isSwing ? 'trades' : 'chart') }, [group.key, isSwing])

  const details = useLoad(() => Promise.all(group.sessions.map(session => api.getSessionDetail(session.session_id))), [group.key, api])
  const trades = useMemo(() => (details.data ?? []).flatMap(detail => detail.trades), [details.data])
  const parts = dateParts(group.date)
  const shared = group.sessions.some(session => session.shared)

  // One row of controls: Days, the view menu and (for the chart) everything else. It is part of the chart's own header
  // when the chart shows, so the candles keep the height.
  const lead = (
    <>
      <button type="button" className="days-button" aria-pressed={daysOpen} aria-label={daysOpen ? 'Hide days' : 'Show days'} onClick={onToggleDays}>
        <span aria-hidden="true">☰</span><span className="days-text"> Days</span>
      </button>
      <PopoverMenu ariaLabel="View" value={tab} onChange={setTab} items={tabs.map(id => ({ id, label: LABELS[id] }))} />
    </>
  )
  const chartReady = details.data !== null && tab === 'chart' && trades.length > 0

  return (
    <section className="detail" aria-label={`${group.symbol} ${group.date}`}>
      {!chartReady && (
        <div className="detail-bar">
          {lead}
          <span className="grow" />
          <span className="tabs-result" title={`${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`}>
            <span className="tabs-when">{group.symbol} · {parts.day} {parts.month}</span>
            <strong className={pnlClass(group.totalPnl)}>{formatPnl(group.totalPnl)}</strong>
          </span>
        </div>
      )}
      <div className={`detail-body detail-${tab}`}>
        {details.loading && !details.data && <Spinner label="Loading session" />}
        {details.error != null && !details.data && (isNotAvailable(details.error)
          ? <NotAvailable what="Session details" />
          : <ErrorState message={describeError(details.error)} onRetry={details.reload} />)}
        {details.data && tab === 'chart' && trades.length === 0 && <EmptyState title="Nothing to chart">This session has no executions.</EmptyState>}
        {chartReady && (
          <PhoneChartPanel symbol={group.symbol} date={group.date} trades={trades} historicalDays={environment.historicalDays ?? 2} toolbarLead={lead} />
        )}
        {details.data && tab === 'trades' && (
          <div className="scroll">
            {details.data.map((detail, index) => (
              <div key={detail.session_id}>
                {group.sessions.length > 1 && <div className="session-split">Session {index + 1} · {group.sessions[index]?.start_time?.slice(0, 5) ?? detail.session_id.slice(0, 8)}</div>}
                <TradesList trades={detail.trades} />
              </div>
            ))}
          </div>
        )}
        {details.data && tab === 'orders' && (
          <div className="scroll pad">
            {details.data.every(detail => !detail.orders?.length)
              ? <p className="muted">No stored orders for this session.</p>
              : details.data.map(detail => detail.orders?.length ? <StoredOrders key={detail.session_id} orders={detail.orders} /> : null)}
          </div>
        )}
        {tab === 'videos' && (
          <div className="scroll pad">
            <SessionVideos sessionIds={group.sessions.map(session => session.session_id)} canAdd={!shared} />
            {!environment.videoLinks && <p className="muted">Videos are not available on this server.</p>}
          </div>
        )}
      </div>
    </section>
  )
}
