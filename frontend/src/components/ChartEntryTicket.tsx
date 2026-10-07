import { forwardRef, useLayoutEffect, useRef, useState } from 'react'
import type { SizingMode, FundsRatios, RiskRatios } from './SettingsModal'

export type EntryOrderType = 'MARKET' | 'AUTO_STOP' | 'AUTO_STOP_LIMIT' | 'TARGET' | 'LIMIT'
export interface EntryTicket {
  x: number; y: number; price: number; right?: 'CE' | 'PE'; strike?: number; expiry?: string
  side: 'BUY' | 'SELL' | null
  orderType?: EntryOrderType
  sizingMode: SizingMode
}
interface Props {
  ticket: EntryTicket
  fundsRatios: FundsRatios
  riskRatios: RiskRatios
  instrumentType: string
  sessionType: string
  onChange: (ticket: EntryTicket) => void
  onSubmit: (ticket: EntryTicket, quantity: number | null, fundsRatioPct?: number, riskRatioPct?: number) => void
  onClose: () => void
}
const choices = [
  ['MARKET', 'Market', 'Market'], ['LIMIT', 'Limit', 'Limit'],
  ['AUTO_STOP', 'AS', 'Auto Stop Order'], ['AUTO_STOP_LIMIT', 'ASL', 'Auto Stop Order Limit'],
  ['TARGET', 'Target', 'Target'],
] as const

/** One compact ticket; the second selection submits through the existing handler. */
export default forwardRef<HTMLDivElement, Props>(function ChartEntryTicket({ ticket, fundsRatios, riskRatios, instrumentType, sessionType, onChange, onSubmit, onClose }, ref) {
  const root = useRef<HTMLDivElement | null>(null)
  const submitted = useRef(false)
  const chooseDirection = useRef(ticket.side === null).current
  const [sizeKey, setSizeKey] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: ticket.x, top: ticket.y })
  const mode = ticket.sizingMode
  useLayoutEffect(() => {
    const place = () => {
      if (!root.current) return
      const bounds = root.current.getBoundingClientRect()
      const next = { left: Math.max(8, Math.min(ticket.x + 10, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(ticket.y + 10, window.innerHeight - bounds.height - 8)) }
      setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next)
    }
    place(); const observer = new ResizeObserver(place)
    if (root.current) observer.observe(root.current)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [ticket.x, ticket.y])
  const submit = (next: EntryTicket, key: string) => {
    if (!next.side || !next.orderType || submitted.current) return
    submitted.current = true
    if (next.sizingMode === 'quantity') onSubmit(next, Number(key))
    else {
      const preset = key as 'l' | 'm' | 'h'
      onSubmit(next, null, next.sizingMode === 'fundsRatio' ? fundsRatios[preset] / 100 : undefined, next.sizingMode === 'riskRatio' ? riskRatios[preset] : undefined)
    }
  }
  const buttonStyle = (active: boolean) => ({ width: '100%', padding: '5px 6px', minHeight: 25, background: active ? '#1f3a5f' : '#21262d', color: active ? '#79c0ff' : '#e6edf3', border: `1px solid ${active ? '#388bfd' : '#30363d'}`, borderRadius: 4, cursor: 'pointer', fontSize: 10 })
  return <div ref={element => { root.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element }} role="dialog" aria-modal="false" aria-label="Chart entry ticket" style={{ position: 'fixed', ...position, zIndex: 10002, width: 'min(260px, calc(100vw - 16px))', maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto', boxSizing: 'border-box', background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 9, boxShadow: '0 8px 24px #0006', color: '#e6edf3', fontSize: 10 }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}><strong style={{ fontSize: 11 }}>Use as SL · {ticket.side ?? 'Choose direction'}</strong><button aria-label="Close order ticket" onClick={onClose} style={{ border: 0, background: 'transparent', color: '#8b949e', cursor: 'pointer' }}>×</button></header>
    <div style={{ color: '#8b949e', marginBottom: 7 }}>SL ₹{ticket.price.toFixed(2)}</div>
    {chooseDirection && <div role="group" aria-label="Entry direction" style={{ display: 'flex', gap: 5, marginBottom: 7 }}>{(['BUY', 'SELL'] as const).map(side => <button key={side} aria-pressed={ticket.side === side} style={buttonStyle(ticket.side === side)} onClick={() => { setSizeKey(null); onChange({ ...ticket, side }) }}>{side === 'BUY' ? 'Buy' : 'Sell'}</button>)}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 8 }}>
      <section aria-label="Entry order type"><div style={{ color: '#8b949e', marginBottom: 5 }}>Order type</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4 }}>{choices.map(([orderType, label, name]) => <button key={orderType} title={name} aria-label={name} aria-pressed={ticket.orderType === orderType} disabled={!ticket.side || submitted.current} style={{ ...buttonStyle(ticket.orderType === orderType), padding: '3px 4px', minHeight: 23 }} onClick={() => { const next = { ...ticket, orderType }; if (sizeKey) submit(next, sizeKey); else onChange(next) }}>{label}</button>)}</div></section>
      <section aria-label="Entry sizing">
        {mode !== 'quantity' ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5, minHeight: 14 }}><span>Risk</span><button type="button" role="switch" aria-label="Use Capital % instead of Risk % for this order" aria-checked={mode === 'fundsRatio'} onClick={() => { setSizeKey(null); onChange({ ...ticket, sizingMode: mode === 'fundsRatio' ? 'riskRatio' : 'fundsRatio' }) }} style={{ width: 27, height: 15, border: 0, padding: 2, borderRadius: 10, background: mode === 'fundsRatio' ? '#1d4ed8' : '#475569', cursor: 'pointer' }}><span style={{ display: 'block', width: 11, height: 11, borderRadius: '50%', background: '#fff', transform: mode === 'fundsRatio' ? 'translateX(12px)' : undefined }}/></button><span>Capital %</span></div> : <div style={{ color: '#8b949e', marginBottom: 5 }}>Quantity</div>}
        <div style={{ display: 'grid', gap: 5 }}>{(mode === 'quantity' ? ['1', '2', '3', '5', '10'] : ['l', 'm', 'h']).map(key => { const value = mode === 'quantity' ? key : (mode === 'riskRatio' ? riskRatios : fundsRatios)[key as 'l' | 'm' | 'h']; return <button key={key} aria-pressed={sizeKey === key} disabled={!ticket.side || submitted.current} style={buttonStyle(sizeKey === key)} onClick={() => { setSizeKey(key); if (ticket.orderType) submit(ticket, key) }}>{mode === 'quantity' ? `Qty ${value}` : `${mode === 'riskRatio' ? 'Risk' : 'Capital'} ${value}%`}</button> })}</div>
      </section>
    </div>
    <small style={{ display: 'block', color: '#8b949e', marginTop: 7, fontSize: 9 }}>Select order type and size in either order.</small>
    {mode === 'riskRatio' && ['paper', 'sim', 'stepwise'].includes(sessionType) && <small style={{ display: 'block', color: '#f0883e', marginTop: 5, fontSize: 9 }}>Minimum one {instrumentType === 'options' ? 'lot' : 'share'} if funded, even above selected Risk %.</small>}
  </div>
})
