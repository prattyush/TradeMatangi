import { useEffect, useRef, useState } from 'react'
import api, { type EmergencyExitResult, type RealTradingDayStatus } from '../services/api'
import { mergeRealTradingDayStatus } from '../services/realTradingDayState'
import { flashError, flashMessage } from '../services/notifications'
import ConfirmModal from './ConfirmModal'

interface Props {
  sessionId: string
  sessionType: string
  onOrdersRequested: (sessionId: string) => Promise<void>
}
export default function TradingSafetyActions({ sessionId, sessionType, onOrdersRequested }: Props) {
  const [exiting, setExiting] = useState(false)
  const [dayPending, setDayPending] = useState(false)
  const [day, setDay] = useState<RealTradingDayStatus | null>(null)
  const [closeSummary, setCloseSummary] = useState('')
  const [confirm, setConfirm] = useState(false)
  const updateDay = (value: RealTradingDayStatus) => setDay(previous => mergeRealTradingDayStatus(previous, value))
  const busy = useRef(false)
  const selection = useRef(sessionId); selection.current = sessionId
  useEffect(() => {
    if (sessionType !== 'real') { setDay(null); return }
    let cancelled = false
    const refresh = () => { void api.getRealTradingDayStatus().then(value => { if (!cancelled) updateDay(value) }).catch(() => {}) }
    refresh(); const timer = setInterval(refresh, 15000)
    const update = (event: Event) => { const value = (event as CustomEvent<RealTradingDayStatus>).detail; if (!cancelled) updateDay(value) }
    window.addEventListener('real-trading-day-status', update)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('real-trading-day-status', update) }
  }, [sessionType])
  const announceExits = (result: EmergencyExitResult) => {
    const errors = result.results.flatMap(row => row.errors.map(message => `${row.right ?? 'Equity'} ${row.strike ?? ''} ${row.expiry ?? ''}: ${message}`))
    if (errors.length) flashMessage(errors.join('\n'), 'warning', 'Exit all now')
    else flashMessage(result.status === 'already_flat' ? 'No open positions in this session.' : 'Exit orders requested for this session. Positions close only when fills are confirmed.', 'info', 'Exit all now')
  }
  const exit = async () => {
    if (busy.current) return
    busy.current = true; setExiting(true)
    const owner = sessionId
    try {
      announceExits(await api.exitAllPositions(owner))
      if (selection.current === owner) await onOrdersRequested(owner)
    } catch (error) { flashError(error, 'Exit all now') }
    finally { busy.current = false; setExiting(false) }
  }
  const finish = async () => {
    setConfirm(false)
    if (busy.current) return
    busy.current = true; setDayPending(true)
    try {
      const result = await api.doneForRealTradingDay(sessionId)
      updateDay(result)
      const errors = result.results.flatMap(row => 'error' in row ? [row.error] : row.results.flatMap(contract => contract.errors))
      flashMessage(errors.length ? `Day closure requested; some exits need attention:\n${errors.join('\n')}` : result.state === 'done' ? 'Real trading is locked for today.' : 'Closing real positions. New entries are blocked; the day is marked done after broker-confirmed closure.', errors.length ? 'warning' : 'info', 'Done for day')
      await onOrdersRequested(sessionId)
    } catch (error) { flashError(error, 'Done for day'); void api.getRealTradingDayStatus().then(updateDay).catch(() => {}) }
    finally { busy.current = false; setDayPending(false) }
  }
  const style = { border: '1px solid #a33c3c', color: '#ffb7b7', background: '#35191b', borderRadius: 5, padding: '5px 9px', fontSize: 12, width: 142, cursor: 'pointer', whiteSpace: 'nowrap' as const }
  return <>
    <button style={style} disabled={exiting || dayPending || (sessionType === 'real' && day?.state === 'done')} onClick={() => void exit()} title="Exit every open contract in this session using aggressive LIMIT orders, 3% below market for longs or above for shorts">{exiting ? 'Requesting exits…' : 'Exit all now'}</button>
    {sessionType === 'real' && <button style={{ ...style, minWidth: 132 }} disabled={!day || day.state !== 'active' || dayPending || exiting} onClick={() => { void api.realCloseSummary(sessionId).then(summary => { setCloseSummary(`${summary.position_count} open position(s) will be closed and ${summary.pending_order_count} pending order(s) reconciled. Cancel to close them yourself. `); setConfirm(true) }).catch(error => flashError(error, 'Done for day')) }} title="Close your real-session positions and permanently lock real trading for this IST day; no settings or restart override">{dayPending || day?.state === 'closing' ? 'Closing for day…' : day?.state === 'done' ? 'Done for day 🔒' : 'Done for day'}</button>}
    {confirm && <ConfirmModal message={`${closeSummary}Stop Real trading for today across both brokers? New entries will be blocked while exits finish. After confirmed closure, today's ban has no UI or API override.`} onYes={() => void finish()} onNo={() => setConfirm(false)} />}
  </>
}
