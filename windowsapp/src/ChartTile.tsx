import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { dispose, init, registerOverlay, type Chart, type KLineData } from 'klinecharts'
import { registerExtensions } from 'react-klinecharts-ui/extensions'
import type { Candle, DesktopOrder, DesktopPosition, DesktopStrategy, DesktopTrade, DesktopTradingSettings } from './contracts'
import { formatCandleCloseCountdown } from './liveCountdown'
import { buildTradeMarkers } from './tradeMarkers'

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
  registerOverlay({
    name: 'desktopTradeMarker',
    totalStep: 1,
    lock: true,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const coordinate = coordinates[0]
      const marker = overlay.extendData as { color: string; text: string }
      if (!coordinate || !marker) return []
      return [
        { type: 'circle', attrs: { x: coordinate.x, y: coordinate.y, r: 3 }, styles: { style: 'fill', color: marker.color }, ignoreEvent: true },
        { type: 'text', attrs: { x: coordinate.x, y: coordinate.y - 6, text: marker.text, align: 'center', baseline: 'bottom' }, styles: { color: marker.color, size: 8, family: 'Inter, system-ui, sans-serif', weight: 'bold' }, ignoreEvent: true },
      ]
    },
  })
  extensionsRegistered = true
}

interface DrawingCommand { id: number; tool: string }
interface DrawingAction { id: number; action: 'delete' | 'hide' | 'lock' }
type DrawingMode = 'once' | 'repeat'
type OrderAction = 'USE_SL_BUY' | 'USE_SL_SELL' | 'BULK_LIMIT' | 'BULK_MOVE_SL' | 'START_TARGET_PROFIT' | 'START_LOCK_PROFIT' | 'START_AGGRESSIVE_SL' | 'START_BREAKEVEN' | 'START_UNDERLYING_TARGET' | 'START_UNDERLYING_SL'
type ConversionTarget = 'LIMIT' | 'STOPLOSS' | 'TARGET'
type PricePickAction = { orderId?: string; conversion?: ConversionTarget; ticket?: unknown }
interface FloatingLabel { key: string; x: number; y: number; text: string; color: string }
interface PersistedDrawing { tool: string; points: Array<{ timestamp: number; price: number }>; style?: { color?: string; width?: number; fillColor?: string; fillOpacity?: number }; visible?: boolean; locked?: boolean }
interface DrawingRecord { drawing_id: string; revision: number; drawing: PersistedDrawing }
interface LocalDrawing { id: string; backendId?: string; revision?: number; drawing: PersistedDrawing; locked: boolean; hidden: boolean }
const hasNativeHost = '__TAURI_INTERNALS__' in window
const reportChartDiagnostic = (kind: string, payload: Record<string, unknown>) => {
  if (!hasNativeHost) return
  void invoke('record_desktop_renderer_diagnostic', { kind, payload }).catch(() => undefined)
}
const overlayName = (tool: string) => tool === 'Trend' ? 'segment' : tool === 'Horizontal' ? 'horizontalStraightLine' : tool === 'Fib Retracement' ? 'fibonacciLine' : tool
const drawingPoints = (drawing: PersistedDrawing) => drawing.points.map(point => ({ timestamp: point.timestamp * 1000, value: point.price }))
const canonicalInstrumentKey = (instrument: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(instrument).sort(([left], [right]) => left.localeCompare(right))))
const orderPrice = (order: DesktopOrder) => order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price
const orderLineLabel = (order: DesktopOrder, position?: DesktopPosition | null, settings?: DesktopTradingSettings | null, sessionCapital = 0) => {
  const qty = compactQty(order.quantity)
  if (position && position.side !== 'FLAT' && ((position.side === 'LONG' && order.side === 'SELL') || (position.side === 'SHORT' && order.side === 'BUY'))) {
    const dir = position.side === 'LONG' ? 1 : -1
    const pnl = dir * (orderPrice(order) - position.avg_entry_price) * Math.min(order.quantity, position.quantity)
    if (settings?.desktop_pnl_display_mode === 'percent') {
      const base = Math.max(1, sessionCapital)
      return `${order.order_type === 'STOPLOSS' || order.is_stoploss ? 'SL' : order.order_type === 'LIMIT' ? 'L' : 'T'} ${pnl >= 0 ? '+' : ''}${((pnl / base) * 100).toFixed(1)}%`
    }
    return `${order.order_type === 'STOPLOSS' || order.is_stoploss ? 'SL' : order.order_type === 'LIMIT' ? 'L' : 'T'} ${pnl >= 0 ? '+' : ''}${Math.round(pnl)}`
  }
  return `${order.side === 'BUY' ? 'B' : 'S'}${order.order_type === 'LIMIT' ? 'L' : order.order_type === 'STOPLOSS' ? 'SL' : 'T'} ${qty}`
}
const compactQty = (value: number) => value >= 100000 ? `${(value / 100000).toFixed(value % 100000 === 0 ? 0 : 1)}L` : value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K` : String(value)
const orderColor = (order: DesktopOrder, selected: boolean) => selected ? '#facc15' : order.order_type === 'STOPLOSS' || order.is_stoploss ? '#ef4444' : order.order_type === 'TARGET' ? '#22c55e' : '#60a5fa'
const placeNearPoint = (x: number, y: number, width: number, height: number) => {
  const preferredLeft = x + 10 + width <= window.innerWidth - 8 ? x + 10 : x - width - 10
  const preferredTop = y + 10 + height <= window.innerHeight - 8 ? y + 10 : y - height - 10
  return {
    left: Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8)),
    top: Math.max(56, Math.min(preferredTop, window.innerHeight - height - 8)),
  }
}

export function ChartTile({ symbol, interval, supportedIntervals, onIntervalChange, candles = demo, loading, message, settings, isReplaying, isLive, instrument, baseUrl, onConfigure, onMaximize, maximized, active, indicators, drawingCommand, drawingAction, drawingMode, onDrawingComplete, onActivate, trades = [], openOrders = [], strategies = [], position = null, sessionCapital = 0, tradingSettings = null, tradingEnabled = false, orderEntryEnabled = false, underlyingStrategyEnabled = false, pricePickAction = null, onPricePick, onOrderDrag, onStrategyDrag, onOrderCancel, onOrderConvertRequest, onChartOrderAction }: { symbol: string; interval: string; supportedIntervals: number[]; onIntervalChange: (interval: string) => void; candles?: Candle[]; loading: boolean; message: string; settings: ChartSettings; isReplaying: boolean; isLive: boolean; replayDatasetKey?: string; instrument: Record<string, unknown>; baseUrl: string; onConfigure: () => void; onMaximize: () => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; drawingMode: DrawingMode; onDrawingComplete: (commandId: number, tool: string) => void; onActivate: () => void; trades?: DesktopTrade[]; openOrders?: DesktopOrder[]; strategies?: DesktopStrategy[]; position?: DesktopPosition | null; sessionCapital?: number; tradingSettings?: DesktopTradingSettings | null; tradingEnabled?: boolean; orderEntryEnabled?: boolean; underlyingStrategyEnabled?: boolean; pricePickAction?: PricePickAction | null; onPricePick?: (price: number) => void; onOrderDrag?: (order: DesktopOrder, price: number) => void; onStrategyDrag?: (strategyId: string, price: number) => void; onOrderCancel?: (order: DesktopOrder) => void; onOrderConvertRequest?: (order: DesktopOrder, target: ConversionTarget) => void; onChartOrderAction?: (action: OrderAction, price: number, anchor: { x: number; y: number }) => void }) {
  const element = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const candlesRef = useRef(candles)
  const renderedCandlesRef = useRef<Candle[]>([])
  const subscribeBarRef = useRef<((data: KLineData) => void) | null>(null)
  const lastDrawingCommandRef = useRef(0)
  const lastDrawingActionRef = useRef(0)
  const drawingModeRef = useRef<DrawingMode>(drawingMode)
  const drawingOverlayIdsRef = useRef<Set<string>>(new Set())
  const drawingsRef = useRef<LocalDrawing[]>([])
  const createPersistedOverlayRef = useRef<(record: DrawingRecord) => void>(() => undefined)
  const [drawings, setDrawings] = useState<LocalDrawing[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; price: number } | null>(null)
  const [selectedOrderAnchor, setSelectedOrderAnchor] = useState<{ x: number; y: number } | null>(null)
  const [floatingLabels, setFloatingLabels] = useState<FloatingLabel[]>([])
  const [pnlLabel, setPnlLabel] = useState<FloatingLabel | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const indicatorKey = indicators.join('|')
  const orderOverlayIdsRef = useRef<Map<string, string>>(new Map())
  const strategyOverlayIdsRef = useRef<Map<string, string>>(new Map())
  const tradeMarkerOverlayIdsRef = useRef<Set<string>>(new Set())
  const pricePickActionRef = useRef(pricePickAction)
  const onPricePickRef = useRef(onPricePick)
  const tradingEnabledRef = useRef(tradingEnabled)
  const onChartOrderActionRef = useRef(onChartOrderAction)
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const drawingInstrumentKey = canonicalInstrumentKey(instrument)
  useEffect(() => { drawingsRef.current = drawings }, [drawings])
  useEffect(() => { pricePickActionRef.current = pricePickAction; onPricePickRef.current = onPricePick; tradingEnabledRef.current = tradingEnabled; onChartOrderActionRef.current = onChartOrderAction }, [pricePickAction, onPricePick, tradingEnabled, onChartOrderAction])
  const fitChart = () => {
    const chart = chartRef.current
    const container = element.current
    const data = renderedCandlesRef.current.length ? renderedCandlesRef.current : candlesRef.current
    if (!chart || !container || data.length === 0) return
    const width = Math.max(1, container.clientWidth)
    const nextBarSpace = Math.max(1, Math.min(18, width / Math.max(data.length + 8, 1)))
    try {
      chart.setBarSpace(nextBarSpace)
      chart.setOffsetRightDistance(8)
      chart.scrollToDataIndex(data.length - 1, 0)
      chart.resize()
      reportChartDiagnostic('fit_success', { symbol, interval, candle_count: data.length })
    } catch (error) {
      reportChartDiagnostic('fit_error', { symbol, interval, candle_count: data.length, error: String(error), stack: error instanceof Error ? error.stack : undefined })
    }
  }
  useEffect(() => { drawingModeRef.current = drawingMode }, [drawingMode])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const id of tradeMarkerOverlayIdsRef.current) chart.removeOverlay({ id })
    tradeMarkerOverlayIdsRef.current.clear()
    const intervalSeconds = Number(interval.replace('m', '')) * 60
    if (!intervalSeconds) return
    buildTradeMarkers(trades, instrument, intervalSeconds).forEach(marker => {
      const id = chart.createOverlay({ name: 'desktopTradeMarker', paneId: 'candle_pane', points: [{ timestamp: marker.timestamp * 1000, value: marker.price }], extendData: { color: marker.color, text: marker.text }, lock: true, visible: true, zLevel: 10 })
      if (typeof id === 'string') tradeMarkerOverlayIdsRef.current.add(id)
    })
    return () => {
      for (const id of tradeMarkerOverlayIdsRef.current) chart.removeOverlay({ id })
      tradeMarkerOverlayIdsRef.current.clear()
    }
  }, [trades, instrument, interval, candles])
  useEffect(() => {
    if (!isLive) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isLive])
  useEffect(() => {
    if (!element.current) return
    let chart: Chart | null = null
    try {
      ensureExtensions()
      chart = init(element.current)
      if (!chart) {
        reportChartDiagnostic('chart_init_empty', { symbol, interval })
        return
      }
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
      // KLineCharts recreates its canvas for interval changes. Re-apply the
      // already loaded persisted drawings locally; this is not a backend
      // reload, so changing interval or mode cannot duplicate requests.
      queueMicrotask(() => {
        if (chartRef.current !== chart) return
        drawingsRef.current
          .filter(drawing => drawing.backendId && drawing.revision !== undefined)
          .forEach(drawing => createPersistedOverlayRef.current({ drawing_id: drawing.backendId!, revision: drawing.revision!, drawing: drawing.drawing }))
      })
      reportChartDiagnostic('chart_init_success', { symbol, interval, candle_count: candlesRef.current.length })
    } catch (error) {
      reportChartDiagnostic('chart_init_error', { symbol, interval, error: String(error), stack: error instanceof Error ? error.stack : undefined })
      if (chart && element.current) {
        try { dispose(element.current) } catch {}
      }
      chartRef.current = null
      return
    }
    const container = element.current
    const rememberPointer = (event: MouseEvent) => { lastPointerRef.current = { x: event.clientX, y: event.clientY } }
    const pickPrice = (event: MouseEvent) => {
      if (contextMenu) setContextMenu(null)
      if (!pricePickActionRef.current || !chartRef.current || !container) return
      const rect = container.getBoundingClientRect()
      const point = chartRef.current.convertFromPixel([{ x: event.clientX - rect.left, y: event.clientY - rect.top }], { paneId: 'candle_pane' })
      const value = Array.isArray(point) ? point[0]?.value : undefined
      if (typeof value === 'number' && Number.isFinite(value)) {
        event.preventDefault()
        onPricePickRef.current?.(Number(value.toFixed(2)))
      }
    }
    const openContext = (event: MouseEvent) => {
      if (!tradingEnabledRef.current || !chartRef.current || !container) return
      const rect = container.getBoundingClientRect()
      const point = chartRef.current.convertFromPixel([{ x: event.clientX - rect.left, y: event.clientY - rect.top }], { paneId: 'candle_pane' })
      const value = Array.isArray(point) ? point[0]?.value : undefined
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      event.preventDefault()
      setContextMenu({ x: event.clientX, y: event.clientY, price: Number(value.toFixed(2)) })
    }
    container.addEventListener('mousedown', rememberPointer)
    container.addEventListener('click', pickPrice)
    container.addEventListener('contextmenu', openContext)
    return () => {
      container.removeEventListener('mousedown', rememberPointer); container.removeEventListener('click', pickPrice); container.removeEventListener('contextmenu', openContext)
      subscribeBarRef.current = null; renderedCandlesRef.current = []; chartRef.current = null
      try { dispose(element.current!) ; reportChartDiagnostic('chart_dispose_success', { symbol, interval }) }
      catch (error) { reportChartDiagnostic('chart_dispose_error', { symbol, interval, error: String(error), stack: error instanceof Error ? error.stack : undefined }) }
    }
  }, [symbol, interval])
  useEffect(() => {
    if (!contextMenu) return
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.chart-context-menu')) setContextMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])
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
    try {
      if (incremental && latest && subscribeBarRef.current) {
        subscribeBarRef.current({ timestamp: latest.timestamp * 1000, open: latest.open, high: latest.high, low: latest.low, close: latest.close })
        renderedCandlesRef.current = candles
        reportChartDiagnostic('chart_incremental_success', { symbol, interval, candle_count: candles.length, latest })
        return
      }
      const barSpace = chart.getBarSpace().bar
      chart.resetData()
      chart.setBarSpace(barSpace)
      renderedCandlesRef.current = candles
      reportChartDiagnostic('chart_reset_success', { symbol, interval, candle_count: candles.length, latest: latest ?? null })
    } catch (error) {
      reportChartDiagnostic('chart_data_error', { symbol, interval, candle_count: candles.length, latest: latest ?? null, error: String(error), stack: error instanceof Error ? error.stack : undefined })
    }
  }, [candles, isReplaying])
  const persistDrawing = async (path: string, method: 'POST' | 'PUT' | 'DELETE', drawing: PersistedDrawing, revision?: number) => {
    if (!hasNativeHost) return null
    return invoke<DrawingRecord>('desktop_drawing_request', { baseUrl, path, method, body: { instrument, drawing, revision, mutation_id: crypto.randomUUID() } })
  }
  const createPersistedOverlay = (record: DrawingRecord) => {
    const style = record.drawing.style ?? {}
    chartRef.current?.removeOverlay({ id: record.drawing_id })
    drawingOverlayIdsRef.current.delete(record.drawing_id)
    const id = chartRef.current?.createOverlay({
      id: record.drawing_id,
      name: overlayName(record.drawing.tool),
      paneId: 'candle_pane',
      points: drawingPoints(record.drawing),
      lock: Boolean(record.drawing.locked),
      visible: record.drawing.visible !== false,
      styles: { line: { color: style.color ?? settings.drawingLineColor, size: style.width ?? settings.drawingLineWidth, style: 'solid', dashedValue: [2, 2] }, polygon: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) }, rect: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) }, circle: { color: style.fillColor ?? withOpacity(settings.drawingFillColor, style.fillOpacity ?? settings.drawingFillOpacity) } },
      onSelected: (event: any) => setSelected(event.overlay.id),
      onRemoved: (event: any) => { drawingOverlayIdsRef.current.delete(event.overlay.id); setDrawings(current => current.filter(drawing => drawing.id !== event.overlay.id)) },
    } as any)
    if (typeof id !== 'string') return
    drawingOverlayIdsRef.current.add(id)
    setDrawings(current => current.some(item => item.id === id) ? current : [...current, { id, backendId: record.drawing_id, revision: record.revision, drawing: record.drawing, locked: Boolean(record.drawing.locked), hidden: record.drawing.visible === false }])
  }
  createPersistedOverlayRef.current = createPersistedOverlay
  useEffect(() => {
    if (!chartRef.current || !hasNativeHost) return
    let cancelled = false
    const encoded = encodeURIComponent(drawingInstrumentKey)
    void invoke<{ drawings: DrawingRecord[] }>('desktop_drawing_request', { baseUrl, path: `drawings?instrument=${encoded}`, method: 'GET', body: {} }).then(value => {
      if (cancelled) return
      for (const id of drawingOverlayIdsRef.current) chartRef.current?.removeOverlay({ id })
      drawingOverlayIdsRef.current.clear()
      setDrawings([])
      value.drawings.forEach(createPersistedOverlay)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [baseUrl, drawingInstrumentKey])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setContextMenu(null); if (pricePickAction) onPricePick?.(NaN) }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOrderId !== null) { const order = openOrders.find(item => item.order_id === selectedOrderId); if (order) onOrderCancel?.(order); setSelectedOrderId(null); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) { const drawing = drawings.find(item => item.id === selected); if (drawing?.backendId && drawing.revision) void persistDrawing(`drawings/${drawing.backendId}`, 'DELETE', drawing.drawing, drawing.revision); chartRef.current?.removeOverlay({ id: selected }); drawingOverlayIdsRef.current.delete(selected); setDrawings(current => current.filter(item => item.id !== selected)); setSelected(null) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') setDrawings(current => { const drawing = current[current.length - 1]; if (drawing) { chartRef.current?.removeOverlay({ id: drawing.id }); drawingOverlayIdsRef.current.delete(drawing.id) }; setSelected(null); return current.slice(0, -1) })
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [selected, selectedOrderId, drawings, openOrders, pricePickAction])
  const addDrawing = (nextTool: string, commandId: number) => {
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
      onDrawEnd: event => { const points = event.overlay.points.map(point => ({ timestamp: Math.floor(Number(point.timestamp) / 1000), price: Number(point.value) })); const drawing = { tool: nextTool, points, style: { color: lineColor, width: lineWidth, fillColor, fillOpacity: settings.drawingFillOpacity }, visible: true, locked: false }; if (points.length && typeof event.overlay.id === 'string') void persistDrawing('drawings', 'POST', drawing).then(record => { if (!record) return; setDrawings(current => current.map(item => item.id === event.overlay.id ? { ...item, backendId: record.drawing_id, revision: record.revision, drawing: record.drawing } : item)) }); onDrawingComplete(commandId, nextTool); if (drawingModeRef.current === 'repeat') window.setTimeout(() => addDrawing(nextTool, commandId), 0) },
      onSelected: event => setSelected(event.overlay.id),
      onRemoved: event => { drawingOverlayIdsRef.current.delete(event.overlay.id); setDrawings(current => current.filter(drawing => drawing.id !== event.overlay.id)) },
    })
    if (typeof id !== 'string') return
    drawingOverlayIdsRef.current.add(id)
    setDrawings(current => [...current, { id, drawing: { tool: nextTool, points: [], style: { color: lineColor, width: lineWidth, fillColor, fillOpacity: settings.drawingFillOpacity }, visible: true, locked: false }, locked: false, hidden: false }]); setSelected(id)
  }
  const updateSelected = (update: (drawing: LocalDrawing) => LocalDrawing) => setDrawings(current => current.map(drawing => { if (drawing.id !== selected) return drawing; const next = update(drawing); const persisted = { ...next.drawing, locked: next.locked, visible: !next.hidden }; chartRef.current?.overrideOverlay({ id: next.id, lock: next.locked, visible: !next.hidden }); if (next.backendId && next.revision) void persistDrawing(`drawings/${next.backendId}`, 'PUT', persisted, next.revision).then(record => { if (record) setDrawings(items => items.map(item => item.id === next.id ? { ...item, revision: record.revision, drawing: record.drawing } : item)) }); return { ...next, drawing: persisted } }))
  useEffect(() => {
    if (!active || !drawingCommand || drawingCommand.id === lastDrawingCommandRef.current) return
    lastDrawingCommandRef.current = drawingCommand.id
    addDrawing(drawingCommand.tool, drawingCommand.id)
  }, [active, drawingCommand])
  useEffect(() => {
    if (!active || !drawingAction || drawingAction.id === lastDrawingActionRef.current || selected === null) return
    lastDrawingActionRef.current = drawingAction.id
    if (drawingAction.action === 'delete') { const drawing = drawings.find(item => item.id === selected); if (drawing?.backendId && drawing.revision) void persistDrawing(`drawings/${drawing.backendId}`, 'DELETE', drawing.drawing, drawing.revision); chartRef.current?.removeOverlay({ id: selected }); drawingOverlayIdsRef.current.delete(selected); setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }
    if (drawingAction.action === 'hide') updateSelected(drawing => ({ ...drawing, hidden: !drawing.hidden }))
    if (drawingAction.action === 'lock') updateSelected(drawing => ({ ...drawing, locked: !drawing.locked }))
  }, [active, drawingAction, selected, drawings])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const id of orderOverlayIdsRef.current.values()) chart.removeOverlay({ id })
    orderOverlayIdsRef.current.clear()
    for (const id of strategyOverlayIdsRef.current.values()) chart.removeOverlay({ id })
    strategyOverlayIdsRef.current.clear()
    const rendered = renderedCandlesRef.current
    const currentCandles = candlesRef.current
    const lastRendered = rendered.length ? rendered[rendered.length - 1] : undefined
    const lastCandle = currentCandles.length ? currentCandles[currentCandles.length - 1] : undefined
    const timestamp = (lastRendered?.timestamp ?? lastCandle?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000
    const nextLabels: FloatingLabel[] = []
    const pointToPixel = (time: number, value: number) => {
      const converted = (chart as any).convertToPixel?.([{ timestamp: time, value }], { paneId: 'candle_pane' })
      return Array.isArray(converted) ? converted[0] : undefined
    }
    for (const order of openOrders.filter(item => item.status === 'PENDING')) {
      const selectedLine = selectedOrderId === order.order_id
      const color = orderColor(order, selectedLine)
      const price = orderPrice(order)
      const label = orderLineLabel(order, position, tradingSettings, sessionCapital)
      const pixel = pointToPixel(timestamp, price)
      if (pixel && typeof pixel.y === 'number') nextLabels.push({ key: order.order_id, x: Math.max(8, (element.current?.clientWidth ?? 0) - 122), y: pixel.y, text: label, color })
      const id = chart.createOverlay({
        name: 'horizontalStraightLine',
        paneId: 'candle_pane',
        points: [{ timestamp, value: price }],
        styles: { line: { color, size: selectedLine ? 3 : 2, style: 'dashed', dashedValue: [6, 3] } },
        extendData: { orderId: order.order_id, label },
        onSelected: () => { setSelectedOrderId(order.order_id); setSelectedOrderAnchor(lastPointerRef.current); setSelected(null) },
        onDeselected: () => { setSelectedOrderId(current => current === order.order_id ? null : current); setSelectedOrderAnchor(null) },
        onPressedMoveEnd: (event: any) => {
          const value = event.overlay.points[0]?.value
          if (typeof value === 'number' && Number.isFinite(value)) onOrderDrag?.(order, Number(value.toFixed(2)))
        },
      } as any)
      if (typeof id === 'string') orderOverlayIdsRef.current.set(order.order_id, id)
    }
    for (const strategy of strategies) {
      if (typeof strategy.price !== 'number' || !Number.isFinite(strategy.price)) continue
      const id = chart.createOverlay({
        name: 'horizontalStraightLine', paneId: 'candle_pane', points: [{ timestamp, value: strategy.price }],
        styles: { line: { color: '#f59e0b', size: 2, style: 'dashed', dashedValue: [3, 3] } },
        extendData: { strategyId: strategy.strategy_id, label: `${strategy.strategy_type} @ ${strategy.price.toFixed(2)}` },
        onPressedMoveEnd: (event: any) => {
          const value = event.overlay.points[0]?.value
          if (typeof value === 'number' && Number.isFinite(value)) onStrategyDrag?.(strategy.strategy_id, Number(value.toFixed(2)))
        },
      } as any)
      if (typeof id === 'string') strategyOverlayIdsRef.current.set(strategy.strategy_id, id)
    }
    setFloatingLabels(nextLabels)
    return () => {
      for (const id of orderOverlayIdsRef.current.values()) chart.removeOverlay({ id })
      orderOverlayIdsRef.current.clear()
      for (const id of strategyOverlayIdsRef.current.values()) chart.removeOverlay({ id })
      strategyOverlayIdsRef.current.clear()
      setFloatingLabels([])
    }
  }, [openOrders, strategies, selectedOrderId, position, tradingSettings, sessionCapital, symbol, interval, candles])
  useEffect(() => {
    const chart = chartRef.current
    const latest = candles[candles.length - 1]
    if (!chart || !latest || !position || position.side === 'FLAT' || position.quantity <= 0) {
      setPnlLabel(null)
      return
    }
    const dir = position.side === 'LONG' ? 1 : -1
    const pnl = dir * (latest.close - position.avg_entry_price) * position.quantity - (position.entry_commission ?? 0)
    const text = tradingSettings?.desktop_pnl_display_mode === 'percent' && sessionCapital > 0
      ? `${pnl >= 0 ? '+' : ''}${((pnl / sessionCapital) * 100).toFixed(2)}%`
      : `${pnl >= 0 ? '+' : ''}${Math.round(pnl)}`
    const converted = (chart as any).convertToPixel?.([{ timestamp: latest.timestamp * 1000, value: latest.high }], { paneId: 'candle_pane' })
    const pixel = Array.isArray(converted) ? converted[0] : undefined
    if (pixel && typeof pixel.x === 'number' && typeof pixel.y === 'number') {
      setPnlLabel({ key: 'position-pnl', x: pixel.x, y: Math.max(12, pixel.y - 24), text, color: pnl >= 0 ? '#22c55e' : '#ef4444' })
    } else {
      setPnlLabel(null)
    }
  }, [candles, position, tradingSettings, sessionCapital, symbol, interval])
  const closeCountdown = formatCandleCloseCountdown(clock / 1000, Number(interval.replace('m', '')))
  const selectedOrder = openOrders.find(order => order.order_id === selectedOrderId)
  const menuAction = (action: OrderAction) => { if (!contextMenu) return; onChartOrderActionRef.current?.(action, contextMenu.price, { x: contextMenu.x, y: contextMenu.y }); setContextMenu(null) }
  const hasClosingOrders = Boolean(position && position.side !== 'FLAT' && openOrders.some(order => order.status === 'PENDING' && ((position.side === 'LONG' && order.side === 'SELL') || (position.side === 'SHORT' && order.side === 'BUY'))))
  const hasSlOrders = Boolean(position && position.side !== 'FLAT' && openOrders.some(order => order.status === 'PENDING' && order.is_stoploss && ((position.side === 'LONG' && order.side === 'SELL') || (position.side === 'SHORT' && order.side === 'BUY'))))
  const hasPosition = Boolean(position && position.side !== 'FLAT' && position.quantity > 0)
  const menuPosition = contextMenu ? placeNearPoint(contextMenu.x, contextMenu.y, 230, orderEntryEnabled ? 330 : 180) : { left: 0, top: 0 }
  const lineActionPosition = selectedOrderAnchor ? placeNearPoint(selectedOrderAnchor.x, selectedOrderAnchor.y, 360, 46) : { left: 12, top: 64 }
  return <section className={`chart ${active ? 'active-chart' : ''}`} style={{ background: settings.background, color: settings.textColor }} onPointerDownCapture={onActivate}><div className="chart-head"><span>{tradingSettings?.desktop_hide_chart_labels ? '' : `${symbol} · `}<select className="interval-picker" value={interval.replace('m', '')} onChange={event => onIntervalChange(event.target.value)} aria-label="Candle interval">{supportedIntervals.map(value => <option key={value} value={value}>{value}m</option>)}</select>{tradingSettings?.desktop_hide_chart_labels ? '' : ' · IST'}</span><span className="chart-actions">{pricePickAction && <span className="candle-close">Pick price</span>}{isLive && <span className="candle-close" aria-label={`Candle closes in ${closeCountdown}`}>{closeCountdown}</span>}<button className="icon-button" title="Fit data to chart" aria-label="Fit data to chart" onClick={fitChart}>⤧</button><button className="icon-button" title="Choose instrument" aria-label="Choose instrument" onClick={onConfigure}>⌕</button><button className="icon-button" title={maximized ? 'Restore chart' : 'Maximize chart'} aria-label={maximized ? 'Restore chart' : 'Maximize chart'} onClick={onMaximize}>{maximized ? '⊡' : '⛶'}</button></span></div><div className="kline-container"><div className="kline" ref={element} />{floatingLabels.map(label => <div key={label.key} className="order-line-label" style={{ left: label.x, top: label.y, borderColor: label.color, color: label.color }}>{label.text}</div>)}{pnlLabel && <div className="position-pnl-label" style={{ left: pnlLabel.x, top: pnlLabel.y, color: pnlLabel.color, borderColor: pnlLabel.color }}>{pnlLabel.text}</div>}{selectedOrder && <div className="line-actions" style={{ left: lineActionPosition.left, top: lineActionPosition.top }}><span>{orderLineLabel(selectedOrder, position, tradingSettings, sessionCapital)}</span><button onClick={() => onOrderConvertRequest?.(selectedOrder, 'LIMIT')}>To Limit</button><button onClick={() => onOrderConvertRequest?.(selectedOrder, 'STOPLOSS')}>To SL</button><button onClick={() => onOrderConvertRequest?.(selectedOrder, 'TARGET')}>To Target</button><button onClick={() => onOrderCancel?.(selectedOrder)}>Delete</button></div>}{contextMenu && <div className="chart-context-menu" style={{ left: menuPosition.left, top: menuPosition.top }}><strong>{orderEntryEnabled ? `Use as SL ${contextMenu.price.toFixed(2)}` : `Underlying ${contextMenu.price.toFixed(2)}`}</strong>{hasPosition && <><button onClick={() => menuAction('START_AGGRESSIVE_SL')}>Aggressive SL</button><button onClick={() => menuAction('START_BREAKEVEN')}>Breakeven</button></>}{orderEntryEnabled && <><button onClick={() => menuAction('USE_SL_BUY')}>Buy entry</button>{tradingSettings?.context_menu_sl_mode === 'both' && <button onClick={() => menuAction('USE_SL_SELL')}>Sell entry</button>}{hasSlOrders && <button onClick={() => menuAction('BULK_MOVE_SL')}>Move SL here</button>}{hasClosingOrders && <button onClick={() => menuAction('BULK_LIMIT')}>Move exits to Limit here</button>}<button onClick={() => menuAction('START_TARGET_PROFIT')}>Take profit here</button><button onClick={() => menuAction('START_LOCK_PROFIT')}>Lock profit here</button></>}{underlyingStrategyEnabled && <><button onClick={() => menuAction('START_UNDERLYING_TARGET')}>Underlying target here</button><button onClick={() => menuAction('START_UNDERLYING_SL')}>Underlying SL here</button></>}</div>}{loading && <div className="chart-loading"><span className="spinner" />Loading candles...</div>}{!loading && message && <div className="chart-loading chart-message">{message}</div>}</div></section>
}
