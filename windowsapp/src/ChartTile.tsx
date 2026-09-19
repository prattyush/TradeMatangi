import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import { registerExtensions } from 'react-klinecharts-ui/extensions'
import type { Candle } from './contracts'
import { formatCandleCloseCountdown } from './liveCountdown'

interface ChartSettings { background: string; textColor: string; gridColor: string; gridOpacity: number; gridStyle: 'solid' | 'dashed'; gridSize: number; movingAverageType: 'MA' | 'EMA'; movingAveragePeriods: string; horizontalLineColor: string; horizontalLineWidth: number; trendLineColor: string; trendLineWidth: number; drawingLineColor: string; drawingLineWidth: number; drawingFillColor: string; drawingFillOpacity: number }
const withOpacity = (hex: string, opacity: number) => `${hex}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`
const applyChartStyles = (chart: Chart, settings: ChartSettings) => chart.setStyles({ grid: { horizontal: { show: true, color: withOpacity(settings.gridColor, settings.gridOpacity), style: settings.gridStyle, size: settings.gridSize, dashedValue: [2, 2] }, vertical: { show: true, color: withOpacity(settings.gridColor, settings.gridOpacity), style: settings.gridStyle, size: settings.gridSize, dashedValue: [2, 2] } }, crosshair: { show: true, horizontal: { show: true, line: { show: true, color: '#94a3b8', style: 'dashed', size: 1, dashedValue: [4, 2] } }, vertical: { show: true, line: { show: true, color: '#94a3b8', style: 'dashed', size: 1, dashedValue: [4, 2] } } }, xAxis: { tickText: { color: settings.textColor } }, yAxis: { tickText: { color: settings.textColor } } })

const demo: Candle[] = [
  { timestamp: 1746522900, open: 23100, high: 23124, low: 23080, close: 23112 },
  { timestamp: 1746522960, open: 23112, high: 23140, low: 23101, close: 23132 },
  { timestamp: 1746523020, open: 23132, high: 23148, low: 23120, close: 23125 },
]

let extensionsRegistered = false
const ensureExtensions = () => {
  if (extensionsRegistered) return
  registerExtensions()
  extensionsRegistered = true
}

interface DrawingCommand { id: number; tool: string }
interface DrawingAction { id: number; action: 'delete' | 'hide' | 'lock' }
type DrawingMode = 'once' | 'repeat'
interface PersistedDrawing { tool: string; points: Array<{ timestamp: number; price: number }>; style?: { color?: string; width?: number; fillColor?: string; fillOpacity?: number }; visible?: boolean; locked?: boolean }
interface DrawingRecord { drawing_id: string; revision: number; drawing: PersistedDrawing }
interface LocalDrawing { id: string; backendId?: string; revision?: number; drawing: PersistedDrawing; locked: boolean; hidden: boolean }
const hasNativeHost = '__TAURI_INTERNALS__' in window
const overlayName = (tool: string) => tool === 'Trend' ? 'segment' : tool === 'Horizontal' ? 'horizontalStraightLine' : tool === 'Fib Retracement' ? 'fibonacciLine' : tool
const drawingPoints = (drawing: PersistedDrawing) => drawing.points.map(point => ({ timestamp: point.timestamp * 1000, value: point.price }))

export function ChartTile({ symbol, interval, supportedIntervals, onIntervalChange, candles = demo, loading, message, settings, isReplaying, isLive, instrument, baseUrl, onConfigure, onMaximize, maximized, active, indicators, drawingCommand, drawingAction, drawingMode, onDrawingComplete, onActivate }: { symbol: string; interval: string; supportedIntervals: number[]; onIntervalChange: (interval: string) => void; candles?: Candle[]; loading: boolean; message: string; settings: ChartSettings; isReplaying: boolean; isLive: boolean; replayDatasetKey?: string; instrument: Record<string, unknown>; baseUrl: string; onConfigure: () => void; onMaximize: () => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; drawingMode: DrawingMode; onDrawingComplete: () => void; onActivate: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const candlesRef = useRef(candles)
  const renderedCandlesRef = useRef<Candle[]>([])
  const subscribeBarRef = useRef<((data: KLineData) => void) | null>(null)
  const lastDrawingCommandRef = useRef(0)
  const lastDrawingActionRef = useRef(0)
  const drawingModeRef = useRef<DrawingMode>(drawingMode)
  const [drawings, setDrawings] = useState<LocalDrawing[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const indicatorKey = indicators.join('|')
  useEffect(() => { drawingModeRef.current = drawingMode }, [drawingMode])
  useEffect(() => {
    if (!isLive) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isLive])
  useEffect(() => {
    if (!element.current) return
    ensureExtensions()
    const chart = init(element.current)
    if (!chart) return
    chartRef.current = chart
    // Backend candle timestamps deliberately encode IST market wall-clock time
    // as UTC-labelled seconds. Rendering as UTC prevents KLineCharts from
    // applying the machine/Asia-Kolkata offset a second time.
    chart.setTimezone('Etc/UTC')
    applyChartStyles(chart, settings)
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 })
    chart.setPeriod({ span: Number(interval.replace('m', '')), type: 'minute' })
    chart.setDataLoader({
      getBars: ({ callback }) => callback(candlesRef.current.map(candle => ({ timestamp: candle.timestamp * 1000, open: candle.open, high: candle.high, low: candle.low, close: candle.close }))),
      subscribeBar: ({ callback }) => { subscribeBarRef.current = callback },
      unsubscribeBar: () => { subscribeBarRef.current = null },
    })
    return () => { subscribeBarRef.current = null; renderedCandlesRef.current = []; chartRef.current = null; dispose(element.current!) }
  }, [symbol, interval])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    applyChartStyles(chart, settings)
  }, [settings])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.removeIndicator()
    // MA is drawn over the candle pane. Other indicators get their own pane.
    indicators.forEach(indicator => {
      if (indicator === 'MA') { const periods = settings.movingAveragePeriods.split(',').map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0).slice(0, 6); chart.createIndicator({ name: settings.movingAverageType, calcParams: periods.length ? periods : [5, 10, 20], paneId: 'candle_pane' }, true) }
      else chart.createIndicator(indicator)
    })
  }, [indicatorKey, settings.movingAveragePeriods, settings.movingAverageType, symbol, interval])
  useEffect(() => {
    candlesRef.current = candles
    const chart = chartRef.current
    if (!chart) return
    const latest = candles[candles.length - 1]
    const previous = renderedCandlesRef.current
    const sameCandle = (left: Candle, right: Candle) => left.timestamp === right.timestamp && left.open === right.open && left.high === right.high && left.low === right.low && left.close === right.close
    // Live snapshots normally change only the current candle or append one
    // candle. Feed those updates through KLineCharts' incremental loader so
    // the user's scroll position and crosshair remain untouched.
    // Replay and live snapshots commonly update the last candle in place. The
    // previous implementation compared every candle, including that mutable
    // last candle, so every replay tick fell back to resetData() and cleared
    // the crosshair. Permit a same-length last-bar update, or one new bar,
    // while still resetting when history/symbol data is replaced.
    const sameLengthUpdate = candles.length === previous.length && previous.length > 0 && previous.slice(0, -1).every((candle, index) => sameCandle(candle, candles[index]))
    const appendUpdate = candles.length === previous.length + 1 && previous.length > 0 && previous.every((candle, index) => sameCandle(candle, candles[index]))
    const incremental = Boolean(subscribeBarRef.current && (sameLengthUpdate || appendUpdate))
    if (incremental && latest && subscribeBarRef.current) {
      subscribeBarRef.current({ timestamp: latest.timestamp * 1000, open: latest.open, high: latest.high, low: latest.low, close: latest.close })
      renderedCandlesRef.current = candles
      return
    }
    const barSpace = chart.getBarSpace().bar
    chart.resetData()
    chart.setBarSpace(barSpace)
    renderedCandlesRef.current = candles
  }, [candles, isReplaying])
  const persistDrawing = async (path: string, method: 'POST' | 'PUT' | 'DELETE', drawing: PersistedDrawing, revision?: number) => {
    if (!hasNativeHost) return null
    return invoke<DrawingRecord>('desktop_drawing_request', { baseUrl, path, method, body: { instrument, drawing, revision, mutation_id: crypto.randomUUID() } })
  }
  const createPersistedOverlay = (record: DrawingRecord) => {
    const style = record.drawing.style ?? {}
    const id = chartRef.current?.createOverlay({
      id: record.drawing_id,
      name: overlayName(record.drawing.tool),
      paneId: 'candle_pane',
      points: drawingPoints(record.drawing),
      lock: Boolean(record.drawing.locked),
      visible: record.drawing.visible !== false,
      styles: { line: { color: style.color ?? settings.drawingLineColor, size: style.width ?? settings.drawingLineWidth, style: 'solid', dashedValue: [2, 2] }, polygon: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) }, rect: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) }, circle: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) } },
      onSelected: (event: any) => setSelected(event.overlay.id),
      onRemoved: (event: any) => setDrawings(current => current.filter(drawing => drawing.id !== event.overlay.id)),
    } as any)
    if (typeof id !== 'string') return
    setDrawings(current => current.some(item => item.id === id) ? current : [...current, { id, backendId: record.drawing_id, revision: record.revision, drawing: record.drawing, locked: Boolean(record.drawing.locked), hidden: record.drawing.visible === false }])
  }
  useEffect(() => {
    if (!chartRef.current || !hasNativeHost) return
    let cancelled = false
    const encoded = encodeURIComponent(JSON.stringify(instrument))
    void invoke<{ drawings: DrawingRecord[] }>('desktop_drawing_request', { baseUrl, path: `drawings?instrument=${encoded}`, method: 'GET', body: {} }).then(value => {
      if (cancelled) return
      setDrawings([])
      value.drawings.forEach(createPersistedOverlay)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [baseUrl, JSON.stringify(instrument), symbol, interval])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) { const drawing = drawings.find(item => item.id === selected); if (drawing?.backendId && drawing.revision) void persistDrawing(`drawings/${drawing.backendId}`, 'DELETE', drawing.drawing, drawing.revision); chartRef.current?.removeOverlay({ id: selected }); setDrawings(current => current.filter(item => item.id !== selected)); setSelected(null) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') setDrawings(current => { const drawing = current[current.length - 1]; if (drawing) chartRef.current?.removeOverlay({ id: drawing.id }); setSelected(null); return current.slice(0, -1) })
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [selected, drawings])
  const addDrawing = (nextTool: string) => {
    const name = overlayName(nextTool)
    const lineColor = nextTool === 'Trend' ? settings.trendLineColor : nextTool === 'Horizontal' ? settings.horizontalLineColor : settings.drawingLineColor
    const lineWidth = nextTool === 'Trend' ? settings.trendLineWidth : nextTool === 'Horizontal' ? settings.horizontalLineWidth : settings.drawingLineWidth
    const fillColor = withOpacity(settings.drawingFillColor, settings.drawingFillOpacity)
    const id = chartRef.current?.createOverlay({
      name,
      paneId: 'candle_pane',
      // Use a high-contrast explicit line instead of depending on a theme's
      // drawing defaults, which made newly-created overlays hard to see.
      styles: { line: { color: lineColor, size: lineWidth, style: 'solid', dashedValue: [2, 2] }, polygon: { color: fillColor }, rect: { color: fillColor }, circle: { color: fillColor } },
      onDrawEnd: event => { const points = event.overlay.points.map(point => ({ timestamp: Math.floor(Number(point.timestamp) / 1000), price: Number(point.value) })); const drawing = { tool: nextTool, points, style: { color: lineColor, width: lineWidth, fillColor, fillOpacity: settings.drawingFillOpacity }, visible: true, locked: false }; if (points.length && typeof event.overlay.id === 'string') void persistDrawing('drawings', 'POST', drawing).then(record => { if (!record) return; setDrawings(current => current.map(item => item.id === event.overlay.id ? { ...item, backendId: record.drawing_id, revision: record.revision, drawing: record.drawing } : item)) }); onDrawingComplete(); if (drawingModeRef.current === 'repeat') window.setTimeout(() => addDrawing(nextTool), 0) },
      onSelected: event => setSelected(event.overlay.id),
      onRemoved: event => setDrawings(current => current.filter(drawing => drawing.id !== event.overlay.id)),
    })
    if (typeof id !== 'string') return
    setDrawings(current => [...current, { id, drawing: { tool: nextTool, points: [], style: { color: lineColor, width: lineWidth, fillColor, fillOpacity: settings.drawingFillOpacity }, visible: true, locked: false }, locked: false, hidden: false }]); setSelected(id)
  }
  const updateSelected = (update: (drawing: LocalDrawing) => LocalDrawing) => setDrawings(current => current.map(drawing => { if (drawing.id !== selected) return drawing; const next = update(drawing); const persisted = { ...next.drawing, locked: next.locked, visible: !next.hidden }; chartRef.current?.overrideOverlay({ id: next.id, lock: next.locked, visible: !next.hidden }); if (next.backendId && next.revision) void persistDrawing(`drawings/${next.backendId}`, 'PUT', persisted, next.revision).then(record => { if (record) setDrawings(items => items.map(item => item.id === next.id ? { ...item, revision: record.revision, drawing: record.drawing } : item)) }); return { ...next, drawing: persisted } }))
  useEffect(() => {
    if (!active || !drawingCommand || drawingCommand.id === lastDrawingCommandRef.current) return
    lastDrawingCommandRef.current = drawingCommand.id
    addDrawing(drawingCommand.tool)
  }, [active, drawingCommand])
  useEffect(() => {
    if (!active || !drawingAction || drawingAction.id === lastDrawingActionRef.current || selected === null) return
    lastDrawingActionRef.current = drawingAction.id
    if (drawingAction.action === 'delete') { const drawing = drawings.find(item => item.id === selected); if (drawing?.backendId && drawing.revision) void persistDrawing(`drawings/${drawing.backendId}`, 'DELETE', drawing.drawing, drawing.revision); chartRef.current?.removeOverlay({ id: selected }); setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }
    if (drawingAction.action === 'hide') updateSelected(drawing => ({ ...drawing, hidden: !drawing.hidden }))
    if (drawingAction.action === 'lock') updateSelected(drawing => ({ ...drawing, locked: !drawing.locked }))
  }, [active, drawingAction, selected, drawings])
  const closeCountdown = formatCandleCloseCountdown(clock / 1000, Number(interval.replace('m', '')))
  return <section className={`chart ${active ? 'active-chart' : ''}`} style={{ background: settings.background, color: settings.textColor }} onPointerDownCapture={onActivate}><div className="chart-head"><span>{symbol} · <select className="interval-picker" value={interval.replace('m', '')} onChange={event => onIntervalChange(event.target.value)} aria-label="Candle interval">{supportedIntervals.map(value => <option key={value} value={value}>{value}m</option>)}</select> · IST</span><span className="chart-actions">{isLive && <span className="candle-close" aria-label={`Candle closes in ${closeCountdown}`}>{closeCountdown}</span>}<button className="icon-button" title="Choose instrument" aria-label="Choose instrument" onClick={onConfigure}>⌕</button><button className="icon-button" title={maximized ? 'Restore chart' : 'Maximize chart'} aria-label={maximized ? 'Restore chart' : 'Maximize chart'} onClick={onMaximize}>{maximized ? '⊡' : '⛶'}</button></span></div><div className="kline-container"><div className="kline" ref={element} />{loading && <div className="chart-loading"><span className="spinner" />Loading candles…</div>}{!loading && message && <div className="chart-loading chart-message">{message}</div>}</div></section>
}
