import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { rendererAccountKey } from '../../services/websiteChartPreferences'
import {
  LW_DRAW_ITEMS, LW_DRAW_LABEL, LightweightDrawingController, emptyLwSnapshot,
  type LwDrawMode, type LwDrawingSnapshot,
} from './lightweightDrawings'

const emaEvent = 'analysis-lw-ema'
const emaKey = () => `analysis-lw-ema:${rendererAccountKey()}`
const readEma = () => { try { return localStorage.getItem(emaKey()) !== '0' } catch { return true } }

/** EMA 9/21 visibility shared by every Lightweight Analysis chart; on by default (it was always on). */
function useEmaPreference() {
  const [showEma, set] = useState(readEma)
  useEffect(() => {
    const sync = () => set(readEma())
    window.addEventListener(emaEvent, sync)
    return () => window.removeEventListener(emaEvent, sync)
  }, [])
  const setShowEma = useCallback((value: boolean) => {
    try { localStorage.setItem(emaKey(), value ? '1' : '0') } catch { /* Optional local UI preference. */ }
    window.dispatchEvent(new Event(emaEvent))
  }, [])
  return [showEma, setShowEma] as const
}

/**
 * Drawing + indicator state for one Lightweight Analysis chart.
 * Call `attach(chart, series)` right after creating the chart and call the returned
 * function before `chart.remove()`; drawings are restored from `storageKey` on attach,
 * so recreating the chart (e.g. maximize) keeps them.
 */
export function useLightweightTools(storageKey: string | null) {
  const controller = useRef<LightweightDrawingController | null>(null)
  const key = useRef(storageKey)
  key.current = storageKey
  const [state, setState] = useState<LwDrawingSnapshot>(emptyLwSnapshot)
  const [showEma, setShowEma] = useEmaPreference()
  const attach = useCallback((chart: IChartApi, series: ISeriesApi<'Candlestick'>) => {
    const ctl = new LightweightDrawingController(chart, series, key.current)
    controller.current = ctl
    const off = ctl.subscribe(() => setState(ctl.snapshot()))
    setState(ctl.snapshot())
    return () => {
      off()
      ctl.dispose()
      if (controller.current === ctl) controller.current = null
    }
  }, [])
  useEffect(() => { controller.current?.setStorageKey(storageKey) }, [storageKey])
  return {
    attach, state, showEma, setShowEma,
    setMode: (mode: LwDrawMode) => controller.current?.setMode(mode),
    clearLast: () => controller.current?.clearLast(),
  }
}
export type LightweightTools = ReturnType<typeof useLightweightTools>

const buttonStyle = (active: boolean): React.CSSProperties => ({
  padding: '3px 8px', fontSize: 11, borderRadius: 4,
  border: `1px solid ${active ? '#f0883e' : '#30363d'}`,
  background: active ? '#2a1a0a' : '#161b22', color: active ? '#f0883e' : '#8b949e', cursor: 'pointer',
})
const menuStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, zIndex: 120, background: '#161b22',
  border: '1px solid #30363d', borderRadius: 4, marginTop: 2, boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
}

/** "Indicators ▾" and "Draw ▾" dropdowns, matching the Lightweight trading chart's toolbar. */
export function LightweightChartTools({ tools }: { tools: LightweightTools }) {
  const [open, setOpen] = useState<'indicators' | 'draw' | null>(null)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const { mode, step, count } = tools.state
  const hint = mode === 'none' ? '' : mode === 'channel' ? (step === 0 ? 'click 1st point' : step === 1 ? 'click 2nd point' : 'click to set width')
    : mode === 'hline' || mode === 'buymarker' || mode === 'sellmarker' ? 'click chart' : step === 0 ? 'click 1st point' : 'click 2nd point'
  return (
    <span ref={root} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ position: 'relative' }}>
        <button type="button" title="Indicators" style={buttonStyle(tools.showEma)} onClick={() => setOpen(v => v === 'indicators' ? null : 'indicators')}>Indicators ▾</button>
        {open === 'indicators' && (
          <div style={{ ...menuStyle, minWidth: 160 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 11, color: tools.showEma ? '#f0883e' : '#e6edf3' }}>
              <input type="checkbox" checked={tools.showEma} onChange={() => tools.setShowEma(!tools.showEma)} />
              <span>EMA 9/21</span>
            </label>
          </div>
        )}
      </span>
      <span style={{ position: 'relative' }}>
        <button type="button" title="Drawing tools" style={buttonStyle(mode !== 'none')} onClick={() => setOpen(v => v === 'draw' ? null : 'draw')}>
          {LW_DRAW_LABEL[mode] ?? 'Draw'} ▾
        </button>
        {open === 'draw' && (
          <div style={{ ...menuStyle, minWidth: 155 }}>
            {LW_DRAW_ITEMS.map(item => (
              <div
                key={item.mode} role="menuitem"
                onClick={() => { tools.setMode(item.mode); setOpen(null) }}
                style={{ padding: '5px 10px', cursor: 'pointer', fontSize: 11, color: mode === item.mode ? '#f0883e' : '#e6edf3', background: mode === item.mode ? '#2a1a0a' : 'transparent' }}
              >
                {item.label}
              </div>
            ))}
          </div>
        )}
      </span>
      {hint && <span style={{ fontSize: 10, color: '#f0883e' }}>{hint}</span>}
      {count > 0 && <button type="button" style={buttonStyle(false)} title="Remove the last drawing" onClick={tools.clearLast}>Clear</button>}
    </span>
  )
}
