import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SymbolSearch, type SymbolChoice } from '../../../../shared/SymbolSearch'
import { formatBrowseDate, parseCap } from '../../../../shared/browse/browseModel.ts'
import { premiumPresetsFor, withSavedPremium } from '../../../../shared/optionPremiumPresets'
import { paneTitle, stepPaneDate, withDate, withSymbol, type BrowsePane } from '../../services/browseWorkspace'
import type { PaneContract } from './usePaneContract'

const button: React.CSSProperties = { background: '#21262d', border: '1px solid #30363d', color: '#e5e7eb', borderRadius: 5, padding: '3px 8px', fontSize: 12, cursor: 'pointer' }
const chip = (on: boolean): React.CSSProperties => ({ ...button, background: on ? '#1f6feb' : '#21262d', borderColor: on ? '#1f6feb' : '#30363d', color: on ? '#fff' : '#e5e7eb' })

/**
 * The one control of a Browse pane, in the chart's own header: a button that says what the pane shows ("NIFTY · Mon 9 Nov · CE 24500")
 * and opens a small panel to change the symbol, the day, spot or option and the strike (by hand or by premium cap).
 */
export function BrowsePaneMenu({ pane, symbols, today, contract, onChange, open, onOpenChange }: {
  pane: BrowsePane; symbols: SymbolChoice[] & Array<{ strike_interval?: number }>; today: string; contract: PaneContract; onChange: (next: BrowsePane) => void
  /** Held by the pane, not here: changing the symbol rebuilds the chart (and this button) while the panel stays open. */
  open: boolean; onOpenChange: (open: boolean) => void
}) {
  const setOpen = onOpenChange
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const info = symbols.find(item => item.symbol === pane.symbol)
  const optionEligible = info?.option_eligible !== false
  const capText = useRef(pane.pick.cap != null ? String(pane.pick.cap) : '')

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const box = anchor.current.getBoundingClientRect()
    setPlace({ left: Math.max(4, Math.min(box.left, window.innerWidth - 336)), top: box.bottom + 4 })
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    // Capture phase: choosing a symbol re-renders and removes the clicked option before a bubbling listener would look at it.
    document.addEventListener('mousedown', outside, true)
    window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', outside, true); window.removeEventListener('keydown', escape) }
  }, [open])

  const setKind = (kind: BrowsePane['kind']) => onChange({ ...pane, kind, expiry: null, strike: null, pick: kind === 'spot' ? { mode: 'manual', cap: null } : pane.pick })
  const presets = withSavedPremium(premiumPresetsFor(pane.symbol), pane.pick.cap ?? NaN)

  return (
    <>
      <button ref={anchor} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`Pane: ${paneTitle(pane, formatBrowseDate)}`} style={{ ...button, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => setOpen(!open)}>
        {paneTitle(pane, formatBrowseDate)} ▾
      </button>
      {open && createPortal(
        <div ref={panel} role="dialog" aria-label="Pane settings" style={{ position: 'fixed', left: place.left, top: place.top, width: 328, maxHeight: 'calc(100vh - 80px)', overflow: 'auto', zIndex: 2500, background: '#161b22', border: '1px solid #475569', borderRadius: 8, padding: 12, display: 'grid', gap: 10, boxShadow: '0 8px 24px #000a', fontSize: 12, color: '#e5e7eb' }}>
          <label style={{ display: 'grid', gap: 4 }}>Symbol
            <SymbolSearch value={pane.symbol} options={symbols} onChange={symbol => onChange(withSymbol(pane, symbol))} />
          </label>
          <div style={{ display: 'grid', gap: 4 }}>
            <span>Day</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button type="button" style={button} aria-label="Previous day" onClick={() => onChange(stepPaneDate(pane, -1, today))}>‹</button>
              <input type="date" aria-label="Day" max={today} value={pane.date} style={{ flex: 1, background: '#0d1117', color: 'inherit', border: '1px solid #30363d', borderRadius: 4, padding: '3px 6px' }}
                onChange={event => { const value = event.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today) onChange(withDate(pane, value)) }} />
              <button type="button" style={button} aria-label="Next day" disabled={pane.date >= today} onClick={() => onChange(stepPaneDate(pane, 1, today))}>›</button>
            </div>
          </div>
          <div role="group" aria-label="Contract" style={{ display: 'flex', gap: 6 }}>
            {(['spot', 'CE', 'PE'] as const).map(kind => (
              <button key={kind} type="button" aria-pressed={pane.kind === kind} disabled={kind !== 'spot' && !optionEligible} style={chip(pane.kind === kind)} onClick={() => setKind(kind)}>{kind === 'spot' ? 'Spot' : kind}</button>
            ))}
          </div>
          {pane.kind !== 'spot' && (
            <>
              {contract.loading && <span role="status">Loading the day's contracts…</span>}
              {contract.error && <span role="alert" style={{ color: '#f85149' }}>{contract.error}</span>}
              <div role="group" aria-label="Strike by" style={{ display: 'flex', gap: 6 }}>
                <button type="button" aria-pressed={pane.pick.mode === 'manual'} style={chip(pane.pick.mode === 'manual')} onClick={() => onChange({ ...pane, strike: null, pick: { mode: 'manual', cap: pane.pick.cap } })}>Strike</button>
                <button type="button" aria-pressed={pane.pick.mode === 'max_price'} style={chip(pane.pick.mode === 'max_price')} onClick={() => onChange({ ...pane, strike: null, pick: { mode: 'max_price', cap: pane.pick.cap } })}>Max price</button>
              </div>
              {pane.pick.mode === 'manual' ? (
                <label style={{ display: 'grid', gap: 4 }}>Strike {pane.expiry ? <small style={{ color: '#94a3b8' }}>expiry {pane.expiry}</small> : null}
                  <select aria-label="Strike" value={pane.strike ?? ''} onChange={event => onChange({ ...pane, strike: event.target.value ? Number(event.target.value) : null })}
                    style={{ background: '#0d1117', color: 'inherit', border: '1px solid #30363d', borderRadius: 4, padding: '4px 6px' }}>
                    <option value="">Choose…</option>
                    {contract.ladder.map(strike => <option key={strike} value={strike}>{strike}</option>)}
                    {pane.strike !== null && !contract.ladder.includes(pane.strike) && <option value={pane.strike}>{pane.strike}</option>}
                  </select>
                </label>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  <span>Premium at or below (₹)</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {presets.map(value => <button key={value} type="button" aria-pressed={pane.pick.cap === value} style={chip(pane.pick.cap === value)} onClick={() => { capText.current = String(value); onChange({ ...pane, strike: null, pick: { mode: 'max_price', cap: value } }) }}>{value}</button>)}
                  </div>
                  <input type="number" aria-label="Premium cap" min="1" inputMode="decimal" defaultValue={capText.current} key={`${pane.symbol}:${pane.pick.cap}`} placeholder="Type a cap"
                    style={{ background: '#0d1117', color: 'inherit', border: '1px solid #30363d', borderRadius: 4, padding: '4px 6px' }}
                    onBlur={event => { const cap = parseCap(event.target.value); if (cap !== pane.pick.cap) onChange({ ...pane, strike: null, pick: { mode: 'max_price', cap } }) }}
                    onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
                  {contract.searching && <span role="status">Finding the strike…</span>}
                  {contract.note && <span role="status" style={{ color: '#94a3b8' }}>{contract.note}</span>}
                </div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
