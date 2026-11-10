import { useEffect, useMemo, useState } from 'react'
import type { SessionGroup } from '../../../../shared/analysis/TradeAnalysis'
import type { AnalysisTrade } from '../../../../shared/analysis/api'
import DayJourneyChart from '../../../../shared/analysis/DayJourneyChart'
import { sessionJourney } from '../../../../shared/analysis/dayJourney'
import ExecutionInspector from '../../../../windowsapp/src/ExecutionInspector'
import { useBackHandler, useNav } from '../../app/Nav'
import { useStatsFocus } from '../../app/StatsFocus'
import SessionVideos from '../../../../shared/analysis/SessionVideos'
import StoredOrders from '../../../../shared/analysis/StoredOrders'
import { useAnalysisApi, useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import { describeError, isNotAvailable } from '../../api/errors'
import { useLoad } from '../../app/useLoad'
import { EmptyState, ErrorState, NotAvailable, Spinner } from '../../shell/States'
import { dateParts, formatPnl, pnlClass } from './format'
import { PopoverMenu, type MenuItem } from '../../shell/PopoverMenu'
import { useToast } from '../../shell/Toast'
import { CompareOverlay } from './compare/CompareOverlay'
import { LabelingOverlay } from './labeling/LabelingOverlay'
import { useLabelProgress } from './labeling/useLabelProgress'
import { PhoneChartPanel } from './PhoneChartPanel'
import { SnapshotsView } from './snapshots/SnapshotsView'
import { TradesList } from './TradesList'

type View = 'chart' | 'trades' | 'journey' | 'orders' | 'snapshots' | 'videos'
/** The view menu also offers actions that open their own screen (Label trades). */
type Choice = View | 'label' | 'compare'
const LABELS: Record<Choice, string> = { chart: 'Chart', trades: 'Trades', journey: 'Day journey', orders: 'Orders', snapshots: 'Snapshots', videos: 'Videos', label: 'Label trades', compare: 'Compare' }

/** The right-hand pane: one trading day of one instrument, with the chart, executions, orders and videos. */
export function SessionDetail({ group, daysOpen, onToggleDays }: { group: SessionGroup; daysOpen: boolean; onToggleDays: () => void }) {
  const api = useAnalysisApi()
  const statsFocus = useStatsFocus()
  const { setTab: goToTab } = useNav()
  const environment = useAnalysisEnvironment()
  const isSwing = group.trading_style === 'swing'
  const tabs: View[] = isSwing ? ['trades', 'videos'] : ['chart', 'trades', 'journey', 'orders', 'snapshots', 'videos']
  const [tab, setTab] = useState<View>(tabs[0])
  useEffect(() => { setTab(isSwing ? 'trades' : 'chart') }, [group.key, isSwing])

  const details = useLoad(() => Promise.all(group.sessions.map(session => api.getSessionDetail(session.session_id))), [group.key, api])
  const toast = useToast()
  const [labeling, setLabeling] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [labelRevision, setLabelRevision] = useState(0)
  const progress = useLabelProgress(group, !isSwing, labelRevision)
  const [inspected, setInspected] = useState<AnalysisTrade | null>(null)
  useBackHandler(inspected ? () => { setInspected(null); return true } : null)
  useEffect(() => setInspected(null), [group.key, tab])
  const journey = useMemo(
    () => sessionJourney((details.data ?? []).flatMap(detail => detail.cycles ?? []), new Map(group.sessions.map(session => [session.session_id, session.session_capital]))),
    [details.data, group.sessions])
  const trades = useMemo(() => (details.data ?? []).flatMap(detail => detail.trades), [details.data])
  const parts = dateParts(group.date)
  const shared = group.sessions.some(session => session.shared)

  const menuItems: Array<MenuItem<Choice>> = [
    ...tabs.map(id => ({ id, label: LABELS[id] })),
    ...(isSwing ? [] : [
      { id: 'compare' as const, label: LABELS.compare },
      { id: 'label' as const, label: LABELS.label, detail: progress ? `${progress.labeled}/${progress.total}` : undefined },
    ]),
  ]
  const choose = (choice: Choice) => {
    if (choice !== 'label' && choice !== 'compare') { setTab(choice); return }
    if (!details.data) { toast('The session is still loading'); return }
    if (choice === 'compare') setComparing(true)
    else setLabeling(true)
  }
  // One row of controls: Days, the view menu and (for the chart) everything else. It is part of the chart's own header
  // when the chart shows, so the candles keep the height.
  const lead = (
    <>
      <button type="button" className="days-button" aria-pressed={daysOpen} aria-label={daysOpen ? 'Hide days' : 'Show days'} onClick={onToggleDays}>
        <span aria-hidden="true">☰</span><span className="days-text"> Days</span>
      </button>
      <PopoverMenu ariaLabel="View" value={tab} onChange={choose} items={menuItems} />
    </>
  )
  const chartReady = details.data !== null && tab === 'chart' && trades.length > 0
  // The chart views draw the control row themselves (inside the chart header); everything else gets the plain bar.
  const ownsBar = chartReady || tab === 'snapshots'

  return (
    <section className="detail" aria-label={`${group.symbol} ${group.date}`}>
      {!ownsBar && (
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
        {tab === 'snapshots' && <SnapshotsView group={group} lead={lead} />}
        {tab !== 'snapshots' && details.loading && !details.data && <Spinner label="Loading session" />}
        {tab !== 'snapshots' && details.error != null && !details.data && (isNotAvailable(details.error)
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
                <TradesList trades={detail.trades} onSelect={setInspected} />
              </div>
            ))}
          </div>
        )}
        {details.data && tab === 'journey' && (
          <div className="scroll pad"><DayJourneyChart journey={journey} /></div>
        )}
        {details.data && tab === 'orders' && (
          <div className="scroll pad">
            {details.data.every(detail => !detail.orders?.length)
              ? <p className="muted">No stored orders for this session.</p>
              : details.data.map(detail => detail.orders?.length ? <StoredOrders key={detail.session_id} orders={detail.orders} /> : null)}
          </div>
        )}
        {labeling && details.data && (
          <LabelingOverlay group={group} trades={trades} readOnly={shared} onClose={() => { setLabeling(false); setLabelRevision(value => value + 1) }} />
        )}
        {comparing && details.data && (
          <CompareOverlay group={group} trades={trades} historicalDays={environment.historicalDays ?? 2} onClose={() => setComparing(false)} />
        )}
        {inspected && (
          <div className="phone-inspector">
            <ExecutionInspector trade={inspected} detail={details.data?.find(detail => detail.session_id === inspected.session_id) ?? null} error=""
              onRetry={details.reload} onClose={() => setInspected(null)}
              onCycle={cycle => { statsFocus.open({ session_id: cycle.session_id, cycle_id: cycle.cycle_id }); setInspected(null); goToTab('stats') }} />
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
