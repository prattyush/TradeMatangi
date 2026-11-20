import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import ChartTextPrompt from '../../../../shared/charts/ChartTextPrompt'
import { rendererAccountKey } from '../../services/websiteChartPreferences'
import { attachVolumeStudies, type VolumeStudies } from '../../indicators/volumeStudies'
import { VWAP_COLOR, type VolumeCandle } from '../../indicators/vwap'
import {
  LW_DRAW_ITEMS, LW_DRAW_LABEL, LightweightDrawingController, emptyLwSnapshot, lightweightStoreKey,
  type LwDrawMode, type LwDrawingSnapshot, type LwStore,
} from './lightweightDrawings'

/** A boolean indicator preference shared by every Lightweight Analysis chart (localStorage per account, synced by an event). */
function useFlagPreference(name: string, defaultValue: boolean) {
  const key = () => `${name}:${rendererAccountKey()}`
  const read = () => { try { const saved = localStorage.getItem(key()); return saved === null ? defaultValue : saved !== '0' } catch { return defaultValue } }
  const [value, set] = useState(read)
  useEffect(() => {
    const sync = () => set(read())
    window.addEventListener(name, sync)
    return () => window.removeEventListener(name, sync)
  }, [])
  const setValue = useCallback((next: boolean) => {
    try { localStorage.setItem(key(), next ? '1' : '0') } catch { /* Optional local UI preference. */ }
    window.dispatchEvent(new Event(name))
  }, [])
  return [value, setValue] as const
}

/**
 * The saved drawings of one Lightweight chart (no indicators): the controller, its state for the toolbar and its actions.
 * Call `attach(chart, series)` right after creating the chart and call the returned function before `chart.remove()`;
 * the drawings are loaded from the database on attach (`store`: the drawings service and the instrument; null keeps
 * them on the chart only). Used by the Analysis charts (through `useLightweightTools`) and by the trading chart.
 */
export function useLightweightDrawing(store: LwStore | null) {
  const controller = useRef<LightweightDrawingController | null>(null)
  const latest = useRef(store)
  latest.current = store
  const [state, setState] = useState<LwDrawingSnapshot>(emptyLwSnapshot)
  const attach = useCallback((chart: IChartApi, series: ISeriesApi<'Candlestick'>) => {
    const ctl = new LightweightDrawingController(chart, series, latest.current)
    controller.current = ctl
    const off = ctl.subscribe(() => setState(ctl.snapshot()))
    setState(ctl.snapshot())
    return () => {
      off()
      ctl.dispose()
      if (controller.current === ctl) controller.current = null
    }
  }, [])
  // A change of instrument (another contract tab); a new request function alone does not reload.
  const storeKey = lightweightStoreKey(store)
  useEffect(() => { controller.current?.setStore(latest.current) }, [storeKey])
  return {
    attach, state,
    setMode: (mode: LwDrawMode) => controller.current?.setMode(mode),
    clearLast: () => controller.current?.clearLast(),
    submitText: (text: string) => controller.current?.submitText(text),
    cancelText: () => controller.current?.cancelText(),
    deleteSelected: () => controller.current?.deleteSelected(),
    hitsDrawing: (point: { x: number; y: number }) => controller.current?.hitsDrawing(point) ?? false,
    editSelectedText: () => controller.current?.editSelectedText(),
  }
}
export type LightweightDrawingTools = ReturnType<typeof useLightweightDrawing>

/**
 * Drawing + indicator state for one Lightweight Analysis chart.
 * Call `attach(chart, series)` right after creating the chart and call the returned
 * function before `chart.remove()`; drawings are loaded from the database on attach
 * (`store`: the drawings service and the instrument; null keeps them on the chart only),
 * so recreating the chart (e.g. maximize) keeps them.
 */
export function useLightweightTools(store: LwStore | null) {
  const drawing = useLightweightDrawing(store)
  // EMA 9/21 is on by default (it was always on); VWAP and Volume are opt-in.
  const [showEma, setShowEma] = useFlagPreference('analysis-lw-ema', true)
  const [showVwap, setShowVwap] = useFlagPreference('analysis-lw-vwap', false)
  const [showVolume, setShowVolume] = useFlagPreference('analysis-lw-volume', false)
  // Volume and VWAP are offered only when the loaded candles have volume (indices report none).
  const [volumeAvailable, setVolumeAvailable] = useState(false)
  const studies = useRef<VolumeStudies | null>(null)
  const visible = useRef({ vwap: showVwap, volume: showVolume })
  visible.current = { vwap: showVwap, volume: showVolume }
  const attach = useCallback((chart: IChartApi, series: ISeriesApi<'Candlestick'>) => {
    const detach = drawing.attach(chart, series)
    const volume = attachVolumeStudies(chart, { ...visible.current, onAvailableChange: setVolumeAvailable })
    studies.current = volume
    return () => {
      detach()
      if (studies.current === volume) studies.current = null
    }
  }, [])
  useEffect(() => { studies.current?.setVisible({ vwap: showVwap, volume: showVolume }) }, [showVwap, showVolume])
  return {
    ...drawing, attach, showEma, setShowEma,
    showVwap, setShowVwap, showVolume, setShowVolume, volumeAvailable,
    /** Feed the loaded candles (with volume) to the VWAP and volume series; [] clears them. */
    setVolumeData: (candles: ReadonlyArray<VolumeCandle>) => studies.current?.setData(candles),
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
  return (
    <span ref={root} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ position: 'relative' }}>
        <button type="button" title="Indicators" style={buttonStyle(tools.showEma || (tools.volumeAvailable && (tools.showVwap || tools.showVolume)))} onClick={() => setOpen(v => v === 'indicators' ? null : 'indicators')}>Indicators ▾</button>
        {open === 'indicators' && (
          <div style={{ ...menuStyle, minWidth: 160 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 11, color: tools.showEma ? '#f0883e' : '#e6edf3' }}>
              <input type="checkbox" checked={tools.showEma} onChange={() => tools.setShowEma(!tools.showEma)} />
              <span>EMA 9/21</span>
            </label>
            {tools.volumeAvailable && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 11, color: tools.showVwap ? VWAP_COLOR : '#e6edf3' }}>
                  <input type="checkbox" checked={tools.showVwap} onChange={() => tools.setShowVwap(!tools.showVwap)} />
                  <span>VWAP</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', fontSize: 11, color: tools.showVolume ? '#26a69a' : '#e6edf3' }}>
                  <input type="checkbox" checked={tools.showVolume} onChange={() => tools.setShowVolume(!tools.showVolume)} />
                  <span>Volume</span>
                </label>
              </>
            )}
          </div>
        )}
      </span>
      <LightweightDrawControls tools={tools} />
    </span>
  )
}

/**
 * "Draw ▾", the hint for the tool in use, a failed save, the Text box, the picked drawing's actions and "Clear".
 * Shared by the Analysis charts and the trading chart; `style` lets a toolbar keep its own button look.
 */
export function LightweightDrawControls({ tools, style = buttonStyle }: { tools: LightweightDrawingTools; style?: (active: boolean) => React.CSSProperties }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const { mode, step, count } = tools.state
  const hint = mode === 'none' ? '' : mode === 'hline' || mode === 'text' || mode === 'buymarker' || mode === 'sellmarker' ? 'click chart'
    : step === 0 ? 'click 1st point' : 'click 2nd point'
  return (
    <span ref={root} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ position: 'relative' }}>
        <button type="button" title="Drawing tools" style={style(mode !== 'none')} onClick={() => setOpen(v => !v)}>
          {LW_DRAW_LABEL[mode] ?? 'Draw'} ▾
        </button>
        {open && (
          <div style={{ ...menuStyle, minWidth: 155 }}>
            {LW_DRAW_ITEMS.map(item => (
              <div
                key={item.mode} role="menuitem"
                onClick={() => { tools.setMode(item.mode); setOpen(false) }}
                style={{ padding: '5px 10px', cursor: 'pointer', fontSize: 11, color: mode === item.mode ? '#f0883e' : '#e6edf3', background: mode === item.mode ? '#2a1a0a' : 'transparent' }}
              >
                {item.label}
              </div>
            ))}
          </div>
        )}
      </span>
      {hint && <span style={{ fontSize: 10, color: '#f0883e' }}>{hint}</span>}
      {tools.state.notice && <span role="alert" style={{ fontSize: 10, color: '#f85149' }} title={tools.state.notice}>⚠ {tools.state.notice.length > 60 ? `${tools.state.notice.slice(0, 57)}…` : tools.state.notice}</span>}
      {tools.state.pendingText && <ChartTextPrompt x={tools.state.pendingText.x} y={tools.state.pendingText.y} initial={tools.state.pendingText.initial ?? ""} onSubmit={tools.submitText} onCancel={tools.cancelText} />}
      {tools.state.selection && <SelectionActions tools={tools} />}
      {count > 0 && <button type="button" style={style(false)} title="Remove the last drawing" onClick={tools.clearLast}>Clear</button>}
    </span>
  )
}

/** The actions of the picked drawing, beside the click: change its text (a Text), delete it. It is drawn into `document.body`. */
function SelectionActions({ tools }: { tools: LightweightDrawingTools }) {
  const selection = tools.state.selection
  if (!selection) return null
  const width = selection.canEditText ? 230 : 150
  return createPortal(
    <div
      role="toolbar" aria-label={`${selection.label} selected`}
      onMouseDown={(event) => event.stopPropagation()}
      style={{ position: 'fixed', left: Math.max(8, Math.min(selection.x + 10, window.innerWidth - width - 8)), top: Math.max(8, selection.y + 14), zIndex: 2000, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: '#161b22', border: '1px solid #f0883e', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', fontSize: 11, color: '#e6edf3' }}
    >
      <span>{selection.label}</span>
      {selection.canEditText && <button type="button" style={buttonStyle(false)} onClick={tools.editSelectedText}>Edit text</button>}
      <button type="button" style={buttonStyle(false)} onClick={tools.deleteSelected}>Delete</button>
    </div>,
    document.body,
  )
}
