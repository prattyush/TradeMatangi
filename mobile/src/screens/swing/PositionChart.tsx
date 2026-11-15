import { useEffect, useMemo, useState } from 'react'
import AnalysisChart from '../../../../shared/analysis/kline/AnalysisChart'
import { useAnalysisEnvironment } from '../../../../shared/analysis/environment'
import type { OHLCCandle } from '../../../../frontend/src/services/api'
import { isAbort } from '../../api/transport'
import { useBackHandler } from '../../app/Nav'
import { ErrorState, Spinner } from '../../shell/States'
import { marketDate } from '../browse/live/liveModel'
import { describeSwingError } from './swingErrors'
import type { SwingApi } from './swingApi'
import { contractName } from './swingFormat'
import type { Position, Snapshot } from './swingTypes'

const INTERVALS: Record<number, string> = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1h' }
const CANDLES = 300

/**
 * A minute chart of one position: the same minute candles the swing portfolio uses (separate from the second-level data
 * of replay), the average entry and the pending orders of that contract drawn on it. Read-only; the interval is the
 * chart's own interval control.
 */
export function PositionChart({ api, snapshot, position, onClose }: { api: SwingApi; snapshot: Snapshot; position: Position; onClose: () => void }) {
  const environment = useAnalysisEnvironment()
  const minutes = INTERVALS[environment.intervalMinutes ?? 3] ? environment.intervalMinutes ?? 3 : 3
  const portfolio = snapshot.portfolio!
  const [state, setState] = useState<{ candles: OHLCCandle[]; loading: boolean; error: string | null }>({ candles: [], loading: true, error: null })
  const [attempt, setAttempt] = useState(0)
  const today = useMemo(() => marketDate(), [])
  useBackHandler(() => { onClose(); return true })

  useEffect(() => {
    const controller = new AbortController()
    setState(current => ({ candles: current.candles, loading: true, error: null }))
    api.chartHistory(portfolio.session_id, {
      symbol: position.symbol,
      instrument_type: position.instrument_type,
      ...(position.instrument_type === 'options' ? { right: position.right, strike: position.strike } : {}),
      ...(position.instrument_type !== 'equity' ? { expiry: position.expiry } : {}),
      interval: INTERVALS[minutes], as_of_date: today, limit: CANDLES,
    }, controller.signal)
      .then(result => setState({ candles: result.candles.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })), loading: false, error: null }))
      .catch(error => { if (!isAbort(error) && !controller.signal.aborted) setState({ candles: [], loading: false, error: describeSwingError(error) }) })
    return () => controller.abort()
  }, [api, portfolio.session_id, position.symbol, position.instrument_type, position.right, position.strike, position.expiry, minutes, today, attempt])

  const orders = (snapshot.open_orders ?? []).filter(order => order.symbol === position.symbol && contractName(order) === contractName(position))
    .map(order => ({ side: order.side, order_type: order.order_type, trigger_price: order.trigger_price, limit_price: order.limit_price, quantity: order.quantity }))
  const name = contractName(position)
  return (
    <div className="swing-chart" role="dialog" aria-label={`${name} chart`}>
      <div className="swing-chart-bar">
        <button type="button" className="btn btn-link" onClick={onClose} aria-label="Back to the position">← Back</button>
        <strong>{name}</strong>
        <span className="muted">{minutes}-minute candles</span>
      </div>
      <div className="swing-chart-body phone-chart">
        {state.error && state.candles.length === 0 ? <ErrorState message={state.error} onRetry={() => setAttempt(value => value + 1)} />
          : state.loading && state.candles.length === 0 ? <div className="swing-center"><Spinner label="Loading the chart" /></div>
            : state.candles.length === 0 ? <div className="swing-center"><p className="muted" role="status">No candles yet for this contract.</p></div>
              : (
                <AnalysisChart key={`${name}:${minutes}`} symbol={position.symbol} date={today} title={name} liveCandles={state.candles}
                  {...(position.instrument_type === 'options' ? { right: position.right ?? undefined, strike: position.strike ?? undefined } : {})}
                  {...(position.instrument_type !== 'equity' ? { expiry: position.expiry ?? undefined } : {})}
                  position={{ side: position.side, quantity: position.quantity, avg_entry_price: position.avg_entry_price }} openOrders={orders} />
              )}
      </div>
    </div>
  )
}
