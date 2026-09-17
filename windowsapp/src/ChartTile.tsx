import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { dispose, init, type Chart, type KLineData } from 'klinecharts'
import { registerExtensions } from 'react-klinecharts-ui/extensions'
import type { Candle } from './contracts'

interface ChartSettings { background: string; textColor: string; gridColor: string; gridOpacity: number; gridStyle: 'solid' | 'dashed'; gridSize: number; movingAverageType: 'MA' | 'EMA'; movingAveragePeriods: string; horizontalLineColor: string; horizontalLineWidth: number; trendLineColor: string; trendLineWidth: number; drawingLineColor: string; drawingLineWidth: number; drawingFillColor: string; drawingFillOpacity: number }
const withOpacity = (hex: string, opacity: number) => `${hex}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`

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

export function ChartTile({ symbol, interval, supportedIntervals, onIntervalChange, candles = demo, loading, message, settings, isReplaying, instrument, baseUrl, onConfigure, onMaximize, maximized, active, indicators, drawingCommand, drawingAction, onActivate }: { symbol: string; interval: string; supportedIntervals: number[]; onIntervalChange: (interval: string) => void; candles?: Candle[]; loading: boolean; message: string; settings: ChartSettings; isReplaying: boolean; replayDatasetKey?: string; instrument: Record<string, unknown>; baseUrl: string; onConfigure: () => void; onMaximize: () => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; onActivate: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const candlesRef = useRef(candles)
  const renderedCandlesRef = useRef<Candle[]>([])
  const subscribeBarRef = useRef<((data: KLineData) => void) | null>(null)
  const lastDrawingCommandRef = useRef(0)
  const lastDrawingActionRef = useRef(0)
  const [tool, setTool] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Array<{ id: string; tool: string; locked: boolean; hidden: boolean }>>([])
  const [selected, setSelected] = useState<string | null>(null)
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
    chart.setStyles({ grid: { horizontal: { show: true, color: withOpacity(settings.gridColor, settings.gridOpacity), style: settings.gridStyle, size: settings.gridSize, dashedValue: [2, 2] }, vertical: { show: true, color: withOpacity(settings.gridColor, settings.gridOpacity), style: settings.gridStyle, size: settings.gridSize, dashedValue: [2, 2] } }, crosshair: { show: true, horizontal: { show: true, line: { show: true, color: '#94a3b8', style: 'dashed', size: 1, dashedValue: [4, 2] } }, vertical: { show: true, line: { show: true, color: '#94a3b8', style: 'dashed', size: 1, dashedValue: [4, 2] } } }, xAxis: { tickText: { color: settings.textColor } }, yAxis: { tickText: { color: settings.textColor } } })
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 })
    chart.setPeriod({ span: Number(interval.replace('m', '')), type: 'minute' })
    chart.setDataLoader({
      getBars: ({ callback }) => callback(candlesRef.current.map(candle => ({ timestamp: candle.timestamp * 1000, open: candle.open, high: candle.high, low: candle.low, close: candle.close }))),
      subscribeBar: ({ callback }) => { subscribeBarRef.current = callback },
      unsubscribeBar: () => { subscribeBarRef.current = null },
    })
    // MA is drawn over the candle pane. RSI and MACD are deliberately created
    // without a pane ID: KLineCharts creates a real, independently resizable pane.
    indicators.forEach(indicator => {
      if (indicator === 'MA') { const periods = settings.movingAveragePeriods.split(',').map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0).slice(0, 6); chart.createIndicator({ name: settings.movingAverageType, calcParams: periods.length ? periods : [5, 10, 20], paneId: 'candle_pane' }, true) }
      else chart.createIndicator(indicator)
    })
    return () => { subscribeBarRef.current = null; chartRef.current = null; dispose(element.current!) }
  }, [symbol, interval, indicators, settings])
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
      // KLineCharts may follow the newest bar when its subscription callback
      // receives an update. Preserve the user's deliberate right-side gap so
      // a manually panned Replay chart does not jump back to real time.
      const rightOffset = chart.getOffsetRightDistance()
      subscribeBarRef.current({ timestamp: latest.timestamp * 1000, open: latest.open, high: latest.high, low: latest.low, close: latest.close })
      chart.setOffsetRightDistance(rightOffset)
      requestAnimationFrame(() => chart.setOffsetRightDistance(rightOffset))
      renderedCandlesRef.current = candles
      return
    }
    const barSpace = chart.getBarSpace().bar
    chart.resetData()
    chart.setBarSpace(barSpace)
    renderedCandlesRef.current = candles
  }, [candles, isReplaying])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool(null)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) { chartRef.current?.removeOverlay({ id: selected }); setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') setDrawings(current => { const drawing = current[current.length - 1]; if (drawing) chartRef.current?.removeOverlay({ id: drawing.id }); setSelected(null); return current.slice(0, -1) })
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [selected])
  const addDrawing = (nextTool: string) => {
    const name = nextTool === 'Trend' ? 'segment' : nextTool === 'Horizontal' ? 'horizontalStraightLine' : nextTool === 'Fib Retracement' ? 'fibonacciLine' : nextTool
    const lineColor = nextTool === 'Trend' ? settings.trendLineColor : nextTool === 'Horizontal' ? settings.horizontalLineColor : settings.drawingLineColor
    const lineWidth = nextTool === 'Trend' ? settings.trendLineWidth : nextTool === 'Horizontal' ? settings.horizontalLineWidth : settings.drawingLineWidth
    const fillColor = withOpacity(settings.drawingFillColor, settings.drawingFillOpacity)
    const id = chartRef.current?.createOverlay({
      name,
      paneId: 'candle_pane',
      // Use a high-contrast explicit line instead of depending on a theme's
      // drawing defaults, which made newly-created overlays hard to see.
      styles: { line: { color: lineColor, size: lineWidth, style: 'solid', dashedValue: [2, 2] }, polygon: { color: fillColor }, rect: { color: fillColor }, circle: { color: fillColor } },
      onDrawEnd: event => { const points = event.overlay.points.map(point => ({ timestamp: Math.floor(Number(point.timestamp) / 1000), price: Number(point.value) })); if (points.length) void invoke('desktop_drawing_request', { baseUrl, path: 'drawings', method: 'POST', body: { instrument, drawing: { tool: nextTool, points, style: { color: lineColor, width: lineWidth, fillColor, fillOpacity: settings.drawingFillOpacity }, visible: true, locked: false } } }) },
      onSelected: event => setSelected(event.overlay.id),
      onRemoved: event => setDrawings(current => current.filter(drawing => drawing.id !== event.overlay.id)),
    })
    if (typeof id !== 'string') return
    setTool(nextTool); setDrawings(current => [...current, { id, tool: nextTool, locked: false, hidden: false }]); setSelected(id)
  }
  const updateSelected = (update: (drawing: { id: string; tool: string; locked: boolean; hidden: boolean }) => { id: string; tool: string; locked: boolean; hidden: boolean }) => setDrawings(current => current.map(drawing => { if (drawing.id !== selected) return drawing; const next = update(drawing); chartRef.current?.overrideOverlay({ id: next.id, lock: next.locked, visible: !next.hidden }); return next }))
  useEffect(() => {
    if (!active || !drawingCommand || drawingCommand.id === lastDrawingCommandRef.current) return
    lastDrawingCommandRef.current = drawingCommand.id
    addDrawing(drawingCommand.tool)
  }, [active, drawingCommand])
  useEffect(() => {
    if (!active || !drawingAction || drawingAction.id === lastDrawingActionRef.current || selected === null) return
    lastDrawingActionRef.current = drawingAction.id
    if (drawingAction.action === 'delete') { chartRef.current?.removeOverlay({ id: selected }); setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }
    if (drawingAction.action === 'hide') updateSelected(drawing => ({ ...drawing, hidden: !drawing.hidden }))
    if (drawingAction.action === 'lock') updateSelected(drawing => ({ ...drawing, locked: !drawing.locked }))
  }, [active, drawingAction, selected])
  return <section className={`chart ${active ? 'active-chart' : ''}`} style={{ background: settings.background, color: settings.textColor }} onPointerDownCapture={onActivate}><div className="chart-head"><span>{symbol} · <select className="interval-picker" value={interval.replace('m', '')} onChange={event => onIntervalChange(event.target.value)} aria-label="Candle interval">{supportedIntervals.map(value => <option key={value} value={value}>{value}m</option>)}</select> · IST</span><span className="chart-actions"><button className="icon-button" title="Choose instrument" aria-label="Choose instrument" onClick={onConfigure}>⌕</button><button className="icon-button" title={maximized ? 'Restore chart' : 'Maximize chart'} aria-label={maximized ? 'Restore chart' : 'Maximize chart'} onClick={onMaximize}>{maximized ? '⊡' : '⛶'}</button><span>{tool ? `Drawing: ${tool}` : 'Browse'} · {drawings.length} drawing(s)</span></span></div><div className="kline-container"><div className="kline" ref={element} />{loading && <div className="chart-loading"><span className="spinner" />Loading candles…</div>}{!loading && message && <div className="chart-loading chart-message">{message}</div>}</div></section>
}
