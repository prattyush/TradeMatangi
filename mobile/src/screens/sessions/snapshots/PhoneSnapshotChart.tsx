import { useMemo, type ReactNode } from 'react'
import type { EventSnapshot } from '../../../../../shared/analysis/api'
import AnalysisChart from '../../../../../shared/analysis/kline/AnalysisChart'
import { EmptyState } from '../../../shell/States'

export type SnapshotTab = 'underlying' | 'CE' | 'PE'

/**
 * The chart as it was at one event: candles up to that moment, the position and open orders drawn, and the fills so far.
 * Same shared chart and the same props the website's snapshot viewer passes; the host's controls go in its header row.
 * The chart stays mounted while stepping from event to event, so the zoom and scroll position are kept.
 */
export function PhoneSnapshotChart({ snapshot, tab, historicalDays, toolbarStart }: {
  snapshot: EventSnapshot; tab: SnapshotTab; historicalDays: number; toolbarStart: ReactNode
}) {
  const data = snapshot.snapshot
  // The chart wants a missing broker order id as undefined, the snapshot stores null. Memoized: the chart reloads when the array changes.
  const filledTrades = useMemo(() => (data.filled_trades ?? []).map(trade => ({ ...trade, kotak_order_id: trade.kotak_order_id ?? undefined })), [data.filled_trades])
  const common = {
    sessionId: snapshot.session_id, symbol: snapshot.symbol, date: snapshot.date, historicalDays,
    snapshotEventId: snapshot.event_id, snapshotEventTime: snapshot.timestamp, filledTrades, toolbarStart,
  }
  if (tab === 'CE' || tab === 'PE') {
    const strike = tab === 'CE' ? data.strike_ce : data.strike_pe
    if (strike == null || !data.expiry) return <><div className="detail-bar">{toolbarStart}</div><EmptyState title={`No ${tab} contract in this snapshot`} /></>
    const observation = tab === 'CE' ? data.option_observation_ce : data.option_observation_pe
    return (
      <AnalysisChart key={`${tab}:${strike}`} {...common} right={tab} strike={strike} expiry={data.expiry}
        observationResolution={observation?.resolution_seconds ?? undefined} barTime={observation?.time ?? data.bar_time} barOhlc={observation?.ohlc ?? null}
        currentPrice={tab === 'CE' ? data.current_price_ce : data.current_price_pe} position={tab === 'CE' ? data.position_ce : data.position_pe}
        openOrders={data.open_orders.filter(order => !order.right || order.right === tab)} />
    )
  }
  return (
    <AnalysisChart key="underlying" {...common} title="Underlying"
      observationResolution={data.bar_observation_resolution_seconds ?? undefined} barTime={data.bar_time} barOhlc={data.bar_ohlc}
      currentPrice={data.current_price} position={data.position} openOrders={data.open_orders} />
  )
}
