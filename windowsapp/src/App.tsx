import { parseGuardrailError } from './guardrailFeedback'
import { GuardrailFields, guardrailFields } from './GuardrailSettings'
import { ToolbarIcon } from './ToolbarIcon'
import { TradingRefresh, TRADING_RECONCILE_MS, eventNeedsTradingRefresh } from './tradingRefresh'
import { bounded, closeAfterSave, controlledScreens, SAVE_TIMEOUT_MS, journalKey, recoverState, type RecoveryJournal } from './windowLifecycle'
import { ticketSizingPayload, ticketSizingLabel, switchTicketSizing } from './ticketSizing'
import { entryUnavailableReason, equityEntryEnabled, entryQuantity, instrumentLotSize, validateEntryStop } from './tradingInstrument'
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ChartTile } from './ChartTile'
import { replayCandles } from './chartState'
import { shouldConsumeDrawingCommand } from './drawingState'
import type { Candle, DesktopOrder, DesktopPosition, DesktopTrade, DesktopTradingSnapshot } from './contracts'
import { aggregateLiveTileCandles, appendLiveTick, reconcileLiveTicks } from './liveCandles'
import { applyLiveStreamPayloadToSnapshot, type LiveSnapshot, type LiveTileState } from './liveStreamState'
import { acceptPaperSnapshot, applyPaperStreamEvent, isDesktopTradingSnapshot } from './paperTradingState'
import { shouldShowMessage, useDismissMessage } from './useDismissMessage'

interface HistoricalPage { candles: Candle[]; available?: boolean; unavailable_reason?: string }
interface Instrument { symbol: string; display_name: string; exchange: string; chart_type?: string; option_eligible: boolean; supported_intervals: number[] }
interface Catalogue { instruments: Instrument[] }
interface OptionMetadata { expiries: string[]; strike_interval: number; rights: string[]; available: boolean; unavailable_reason?: string }
interface TileConfig { id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string; expiry: string; strike: string; right: string }
type Layout = '1' | '2-side' | '2-stacked' | '3-wide-top' | '4-grid' | '4-one-three' | '5-equal' | '5-wide-right'
interface Screen { id: string; persistedId?: string; revision?: number; name: string; tiles: TileConfig[]; layout: Layout; saved?: PersistedScreenState }
interface PersistedScreenState { id?: string; layout?: Layout; tiles?: TileConfig[]; indicators?: Record<string, string[]>; activeToolTileId?: string; mode?: DesktopMode; live_enabled?: boolean; session_id?: string; run_id?: string; live_stream_id?: string; owned?: boolean; run_date?: string; start_time?: string; speed?: string }
interface DesktopScreenRecord { screen_id: string; name: string; state: PersistedScreenState; revision: number; order: number; active?: boolean }
interface ReplaySnapshot { run_id: string; event_id: number; cursor: number; state: string; mode: string; bar_index: number; interval_seconds: number; tile_states: Array<{ tile_id: string; availability: string; interval_minutes?: number; candle?: Candle }> }
interface ChartSettings { background: string; textColor: string; gridColor: string; gridOpacity: number; gridStyle: 'solid' | 'dashed'; gridSize: number; movingAverageType: 'MA' | 'EMA'; movingAveragePeriods: string; showChartInfo: boolean; liveProvider: 'breeze'; horizontalLineColor: string; horizontalLineWidth: number; trendLineColor: string; trendLineWidth: number; drawingLineColor: string; drawingLineWidth: number; drawingFillColor: string; drawingFillOpacity: number }
interface TileSwap { dir: string; label: string; onClick: () => void }
interface DesktopStreamSnapshot<T> { key: string; last_event_id: number; latest_payload: T | null; connection: 'connected' | 'reconnecting' | 'offline' | 'authentication_required' }
interface DesktopRoundTrip { index: number; right: string | null; strike?: number | null; expiry?: string | null; entry_trades: Array<Record<string, unknown>>; exit_trades: Array<Record<string, unknown>>; pnl: number }
interface DesktopTradeLabel { round_trip_index: number; expected_category: string; expected_strategy: string; actual_category: string; actual_strategy: string; entry_tag: string; exit_tag: string }
interface DesktopTradeLabelState { completed: DesktopRoundTrip[]; open: DesktopRoundTrip[]; labels: DesktopTradeLabel[] }
interface DesktopLabelMetadata { categories: string[]; strategies: string[]; entry_tags: string[]; exit_tags: string[] }
type DesktopLabelMetadataStatus = 'idle' | 'loading' | 'ready' | 'error'
const emptyLabelMetadata: DesktopLabelMetadata = { categories: [], strategies: [], entry_tags: [], exit_tags: [] }
interface DesktopTradingCandidate { status: 'none' | 'active' | 'checkpoint' | 'existing' | 'stopped' | 'remote'; active?: DesktopTradingSnapshot | null; stopped?: DesktopTradingSnapshot | null; checkpoint?: { current_time: number; current_bar_index: number; desktop_mode?: string } | null; existing_session_id?: string | null }
type DesktopTradingStreamPayload = DesktopTradingSnapshot | Record<string, unknown> | null
interface DrawingCommand { id: number; tool: string }
interface DrawingAction { id: number; action: 'delete' | 'hide' | 'lock' }
type DrawingMode = 'once' | 'repeat'
type ConversionTarget = 'LIMIT' | 'STOPLOSS' | 'TARGET'
type ChartOrderType = 'MARKET' | 'LIMIT' | 'TARGET' | 'AUTO_STOP'
type OrderAction = 'FILL_MISSING_SL' | 'USE_SL_BUY' | 'USE_SL_SELL' | 'BULK_LIMIT' | 'BULK_MOVE_SL' | 'START_TARGET_PROFIT' | 'START_LOCK_PROFIT' | 'START_AGGRESSIVE_SL' | 'START_BREAKEVEN' | 'START_UNDERLYING_TARGET' | 'START_UNDERLYING_SL'
interface TradeTicket { tile: TileConfig; side: 'BUY' | 'SELL'; slPrice: number; orderType: ChartOrderType | null; anchor: { x: number; y: number }; sizeKey?: string; sessionId: string; settings: DesktopTradingSnapshot['settings'] }
interface UnderlyingStrategyTicket { strategyType: 'UnderlyingTargetProfit' | 'UnderlyingStoploss'; price: number; anchor: { x: number; y: number } }
type PricePickAction = { orderId?: string; conversion?: ConversionTarget; ticket?: TradeTicket }
type DesktopMode = 'Browse' | 'Paper' | 'Replay' | 'Stepwise'
const isHistoricalTradingMode = (value: string) => value === 'Stepwise' || value === 'Replay'
const isTradingMode = (value: string) => value === 'Paper' || isHistoricalTradingMode(value)
const paperMarketDate = () => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: string) => parts.find(value => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
const paperMarketTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date())
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void
          prompt: (callback?: (notification: { isNotDisplayed: () => boolean }) => void) => void
          cancel: () => void
        }
      }
    }
  }
}

const historyCache = new Map<string, Promise<Candle[]>>()
type Api = <T,>(path: string, params?: URLSearchParams) => Promise<T>
const GOOGLE_CLIENT_ID = '249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com'
const fallbackCatalogue: Instrument[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }]
const defaultChartSettings: ChartSettings = { background: '#151a23', textColor: '#aeb8ca', gridColor: '#ffffff', gridOpacity: 0.12, gridStyle: 'solid', gridSize: 1, movingAverageType: 'MA', movingAveragePeriods: '5,10,20', showChartInfo: true, liveProvider: 'breeze', horizontalLineColor: '#facc15', horizontalLineWidth: 2, trendLineColor: '#60a5fa', trendLineWidth: 2, drawingLineColor: '#60a5fa', drawingLineWidth: 2, drawingFillColor: '#60a5fa', drawingFillOpacity: 0.16 }
const PAPER_STREAM_POLL_MS = 500
const isMissingSession = (error: unknown) => /\(404(?:\s|\))/.test(String(error)) && /Session not found|Trading request failed/i.test(String(error))
const isMissingLiveStream = (error: unknown) => /\(404(?:\s|\))/.test(String(error)) && /Live|desktop request/i.test(String(error))
const noIndicators: string[] = []
const reportOptionEntryDiagnostic = (payload: Record<string, unknown>) => {
  if ('__TAURI_INTERNALS__' in window) void invoke('record_desktop_renderer_diagnostic', { kind: 'option_entry_unavailable', payload }).catch(() => undefined)
}
const newTile = (): TileConfig => ({ id: crypto.randomUUID(), kind: 'spot', symbol: 'NIFTY', interval: '3', tradingDate: '2026-05-06', expiry: '', strike: '', right: 'CE' })
const newScreen = (number: number): Screen => ({ id: crypto.randomUUID(), name: `Screen ${number}`, layout: '1', tiles: [newTile()] })
const mainIndicators = ['MA', 'EMA', 'BOLL_TV', 'VWAP', 'SuperTrend', 'Ichimoku', 'MA_Ribbon', 'HMA', 'PivotPoints']
const subIndicators = ['RSI_TV', 'MACD_TV', 'Stochastic', 'CCI_TV']
const placeNearPoint = (x: number, y: number, width: number, height: number) => {
  const preferredLeft = x + 10 + width <= window.innerWidth - 8 ? x + 10 : x - width - 10
  const preferredTop = y + 10 + height <= window.innerHeight - 8 ? y + 10 : y - height - 10
  return {
    left: Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8)),
    top: Math.max(56, Math.min(preferredTop, window.innerHeight - height - 8)),
  }
}
const drawingTools = [
  { label: 'Horizontal line', icon: '━', tool: 'Horizontal' },
  { label: 'Trend line', icon: '╱', tool: 'Trend' },
  { label: 'Ray', icon: '↗', tool: 'ray' },
  { label: 'Arrow', icon: '➜', tool: 'arrow' },
  { label: 'Rectangle', icon: '▭', tool: 'rect' },
  { label: 'Brush', icon: '✎', tool: 'brush' },
  { label: 'Fibonacci retracement', icon: 'Φ', tool: 'Fib Retracement' },
  { label: 'Fibonacci extension', icon: 'Φ+', tool: 'fibonacciExtension' },
  { label: 'Fibonacci fan', icon: '◿', tool: 'fibonacciSpeedResistanceFan' },
  { label: 'Parallel channel', icon: '∥', tool: 'parallelChannel' },
  { label: 'Measure', icon: '⌁', tool: 'measure' },
  { label: 'Gann box', icon: '▦', tool: 'gannBox' },
  { label: 'Long position', icon: 'L', tool: 'longPosition' },
  { label: 'Short position', icon: 'S', tool: 'shortPosition' },
]

const canonicalKey = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalKey(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const instrumentKeyForTile = (tile: TileConfig, catalogue: Instrument[]): string => {
  const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]
  const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }
  return canonicalKey(instrument)
}

const contractKeyForTile = (tile: TileConfig): string | null => {
  if (tile.kind !== 'option' || !tile.expiry || !tile.strike || !tile.right) return null
  return `${tile.symbol}:${tile.expiry}:${Number(tile.strike)}:${tile.right.toUpperCase()}`
}

const swapTargetsForLayout = (layout: Layout, index: number): Array<{ target: number; dir: string; label: string }> => {
  const targets: Array<{ target: number; dir: string; label: string }> = []
  const add = (target: number, dir: string, label: string) => targets.push({ target, dir, label })
  if (layout === '4-grid') {
    if (index === 0) { add(1, '→', 'Swap with chart to the right'); add(2, '↓', 'Swap with chart below') }
    else if (index === 1) { add(0, '←', 'Swap with chart to the left'); add(3, '↓', 'Swap with chart below') }
    else if (index === 2) { add(3, '→', 'Swap with chart to the right'); add(0, '↑', 'Swap with chart above') }
    else if (index === 3) { add(2, '←', 'Swap with chart to the left'); add(1, '↑', 'Swap with chart above') }
  } else if (layout === '4-one-three') {
    if (index === 0) add(1, '↓', 'Swap with bottom-left chart')
    else if (index === 1) { add(2, '→', 'Swap with chart to the right'); add(0, '↑', 'Swap with top chart') }
    else if (index === 2) { add(1, '←', 'Swap with chart to the left'); add(3, '→', 'Swap with chart to the right'); add(0, '↑', 'Swap with top chart') }
    else if (index === 3) { add(2, '←', 'Swap with chart to the left'); add(0, '↑', 'Swap with top chart') }
  } else if (layout === '5-equal' || layout === '5-wide-right') {
    if (index === 0) { add(1, '→', 'Swap with chart to the right'); add(3, '↓', 'Swap with chart below') }
    else if (index === 1) { add(0, '←', 'Swap with chart to the left'); add(2, '→', 'Swap with chart to the right'); add(4, '↓', 'Swap with chart below') }
    else if (index === 2) { add(1, '←', 'Swap with chart to the left'); add(4, '↓', 'Swap with chart below') }
    else if (index === 3) { add(4, '→', 'Swap with chart to the right'); add(0, '↑', 'Swap with chart above') }
    else if (index === 4) { add(3, '←', 'Swap with chart to the left'); add(1, '↑', 'Swap with chart above') }
  }
  return targets
}

const positionForTile = (tile: TileConfig, snapshot?: DesktopTradingSnapshot | null): DesktopPosition | null => {
  if (!snapshot) return null
  const contractKey = contractKeyForTile(tile)
  if (contractKey) return snapshot.positions_by_contract?.[contractKey] ?? null
  if (tile.kind === 'option') return snapshot.positions[tile.right as 'CE' | 'PE'] ?? null
  return snapshot.positions.equity ?? null
}

const paperStreamEvents = (payload: DesktopTradingStreamPayload): Record<string, unknown>[] => {
  if (!payload || typeof payload !== 'object') return []
  const maybeBatch = payload as { type?: unknown; events?: unknown }
  if (maybeBatch.type === 'batch' && Array.isArray(maybeBatch.events)) {
    return maybeBatch.events.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  }
  return [payload as Record<string, unknown>]
}


function DesktopOpenOrders({ orders, onUpdate, onCancel, readOnly = false }: { orders: DesktopOrder[]; onUpdate: (order: DesktopOrder, price: number, quantity: number) => Promise<void>; onCancel: (order: DesktopOrder) => Promise<void>; readOnly?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [price, setPrice] = useState('')
  const [quantity, setQuantity] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useDismissMessage(error, setError, 10_000)
  const beginEdit = (order: DesktopOrder) => { setEditing(order.order_id); setPrice(String(order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price)); setQuantity(String(order.quantity)); setError('') }
  const save = async (order: DesktopOrder) => {
    const nextPrice = Number(price), nextQuantity = Number(quantity)
    if (!Number.isFinite(nextPrice) || nextPrice <= 0 || !Number.isInteger(nextQuantity) || nextQuantity <= 0) { setError('Enter a positive price and whole quantity.'); return }
    setBusy(true); setError('')
    try { await onUpdate(order, nextPrice, nextQuantity); setEditing(null) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const cancel = async (order: DesktopOrder) => {
    setBusy(true); setError('')
    try { await onCancel(order); if (editing === order.order_id) setEditing(null) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  return <section className="desktop-open-orders"><strong>Open Orders ({orders.length})</strong>{orders.length === 0 && <span>No pending orders</span>}{orders.map(order => <div className="desktop-open-order" key={order.order_id}><span>{order.symbol}{order.strike ? ` ${order.strike}${order.right ?? ''}` : ''}</span><span>{order.side} · {order.is_stoploss ? 'SL' : order.order_type} · {order.quantity} @ {(order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price).toFixed(2)}</span>{!readOnly && (editing === order.order_id ? <div className="desktop-order-edit"><label>Price<input aria-label="Order price" type="number" min="0.01" step="0.05" value={price} onChange={event => setPrice(event.target.value)} /></label><label>Qty<input aria-label="Order quantity" type="number" min="1" step="1" value={quantity} onChange={event => setQuantity(event.target.value)} /></label><button disabled={busy} onClick={() => void save(order)}>Save</button><button disabled={busy} onClick={() => setEditing(null)}>Back</button></div> : <div className="desktop-order-actions"><button disabled={busy} onClick={() => beginEdit(order)}>Edit</button><button disabled={busy} onClick={() => void cancel(order)}>Cancel</button></div>)}</div>)}{error && <small role="alert">{error}</small>}</section>
}

function WorkspaceToolPanel({ tiles, activeTileId, setActiveTileId, activeTileLabel, activePosition, sessionCapital, positionMarginRate, indicators, toggleIndicator, clearIndicators, sendDrawing, sendDrawingAction, activeDrawingTool, drawingMode, setDrawingMode, tradeHistoryCount, onOpenTradeHistory, labelState, labelMetadata, labelMetadataStatus, labelMetadataError, onReloadLabelMetadata, onSaveTradeLabel, strategies, onCancelStrategy, onUpdateStrategyPrice, tradingActive, ordersReadOnly, openOrders, onUpdateOrder, onCancelOrder }: { tiles: TileConfig[]; activeTileId: string; setActiveTileId: (tileId: string) => void; activeTileLabel: string; activePosition: DesktopPosition | null; sessionCapital: number; positionMarginRate: number; indicators: string[]; toggleIndicator: (name: string) => void; clearIndicators: () => void; sendDrawing: (tool: string) => void; sendDrawingAction: (action: DrawingAction['action']) => void; activeDrawingTool: string | null; drawingMode: DrawingMode; setDrawingMode: (mode: DrawingMode) => void; tradeHistoryCount: number; onOpenTradeHistory: () => void; labelState: DesktopTradeLabelState | null; labelMetadata: DesktopLabelMetadata; labelMetadataStatus: DesktopLabelMetadataStatus; labelMetadataError: string; onReloadLabelMetadata: () => void; onSaveTradeLabel: (roundTrip: DesktopRoundTrip, fields: Partial<DesktopTradeLabel>) => void; strategies: DesktopTradingSnapshot['strategies']; onCancelStrategy: (strategyId: string) => void; onUpdateStrategyPrice: (strategyId: string, currentPrice: number) => void; tradingActive: boolean; ordersReadOnly: boolean; openOrders: DesktopOrder[]; onUpdateOrder: (order: DesktopOrder, price: number, quantity: number) => Promise<void>; onCancelOrder: (order: DesktopOrder) => Promise<void> }) {
  const hasPosition = Boolean(activePosition && activePosition.side !== 'FLAT' && activePosition.quantity > 0)
  const walletPct = hasPosition && sessionCapital > 0 ? (activePosition!.quantity * activePosition!.avg_entry_price * positionMarginRate / sessionCapital) * 100 : null
  return <aside className="tool-panel" aria-label="Chart tools">
    <label>Chart<select value={activeTileId} onChange={event => setActiveTileId(event.target.value)}>{tiles.map((tile, index) => <option key={tile.id} value={tile.id}>{index + 1}. {tile.kind === 'option' ? `${tile.symbol} ${tile.strike}${tile.right}` : tile.symbol}</option>)}</select></label>
    <section className="desktop-position-panel"><strong>Position</strong><span className="desktop-position-instrument">{activeTileLabel}</span>{hasPosition ? <><span className={`desktop-position-side ${activePosition!.side === 'LONG' ? 'long' : 'short'}`}>{activePosition!.side} {activePosition!.quantity}</span><div className="desktop-position-metrics"><span>Avg entry <b>{activePosition!.avg_entry_price.toFixed(2)}</b></span><span>{walletPct === null ? '—' : `${walletPct.toFixed(1)}%`} <small>wallet</small></span></div></> : <span className="desktop-position-flat">FLAT</span>}</section>
    <section><strong>Draw</strong><div className="segmented"><button className={drawingMode === 'once' ? 'active' : ''} aria-pressed={drawingMode === 'once'} onClick={() => setDrawingMode('once')}>Once</button><button className={drawingMode === 'repeat' ? 'active' : ''} aria-pressed={drawingMode === 'repeat'} onClick={() => setDrawingMode('repeat')}>Repeat</button></div><div className="tool-grid icon-tool-grid">{drawingTools.map(item => <button key={item.tool} className={`tool-icon ${activeDrawingTool === item.tool ? 'active' : ''}`} aria-label={item.label} aria-pressed={activeDrawingTool === item.tool} data-tooltip={item.label} title={item.label} onClick={() => sendDrawing(item.tool)}>{item.icon}</button>)}</div><div className="tool-actions icon-actions"><button className="tool-icon" aria-label="Lock selected drawing" data-tooltip="Lock selected drawing" title="Lock selected drawing" onClick={() => sendDrawingAction('lock')}>🔒</button><button className="tool-icon" aria-label="Hide selected drawing" data-tooltip="Hide selected drawing" title="Hide selected drawing" onClick={() => sendDrawingAction('hide')}>◌</button><button className="tool-icon" aria-label="Delete selected drawing" data-tooltip="Delete selected drawing" title="Delete selected drawing" onClick={() => sendDrawingAction('delete')}>⌫</button></div></section>
    <section><strong>Main indicators</strong><div className="tool-grid">{mainIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '').replace('_Ribbon', ' Ribbon')}</button>)}</div></section>
    <section><strong>Sub indicators</strong><div className="tool-grid">{subIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '')}</button>)}</div></section>
    {tradingActive && <section><strong>Trading</strong><button className="panel-clear history-tool-button" title="Trade history" aria-label="Trade history" onClick={onOpenTradeHistory}>History {tradeHistoryCount ? `(${tradeHistoryCount})` : ''}</button><DesktopOpenOrders orders={openOrders} readOnly={ordersReadOnly} onUpdate={onUpdateOrder} onCancel={onCancelOrder} />{labelState && <DesktopLabelPanel state={labelState} metadata={labelMetadata} metadataStatus={labelMetadataStatus} metadataError={labelMetadataError} onReloadMetadata={onReloadLabelMetadata} onSave={onSaveTradeLabel} />}{strategies.length > 0 && <div className="desktop-strategy-list"><strong>Running strategies</strong>{strategies.map(strategy => <div className="desktop-strategy-row" key={strategy.strategy_id}><span>{strategy.strategy_type} {strategy.right ?? ''}{strategy.strike ? ` ${strategy.strike}` : ''}{strategy.price ? ` @${strategy.price.toFixed(2)}` : ''}</span>{strategy.price !== undefined && strategy.price !== null && <button onClick={() => onUpdateStrategyPrice(strategy.strategy_id, strategy.price ?? 0)}>Move</button>}<button onClick={() => onCancelStrategy(strategy.strategy_id)}>Cancel</button></div>)}</div>}</section>}
    <button className="panel-clear" disabled={!indicators.length} onClick={clearIndicators}>Clear indicators</button>
  </aside>
}

function TradeHistoryModal({ trades, roundTrips, labels, sessionCapital, onClose }: { trades: DesktopTrade[]; roundTrips: DesktopRoundTrip[]; labels: DesktopTradeLabel[]; sessionCapital: number; onClose: () => void }) {
  const rows = [...trades].sort((left, right) => Number(right.timestamp ?? right.created_at ?? 0) - Number(left.timestamp ?? left.created_at ?? 0))
  const exitSummary = new Map<string, { pnl: number; pnlPct: number; strategy: string }>()
  for (const roundTrip of roundTrips) {
    const lastExit = roundTrip.exit_trades[roundTrip.exit_trades.length - 1]
    if (!lastExit) continue
    const tradeId = String(lastExit.trade_id ?? lastExit.order_id ?? '')
    if (!tradeId) continue
    const label = labels.find(item => item.round_trip_index === roundTrip.index)
    exitSummary.set(tradeId, {
      pnl: roundTrip.pnl,
      pnlPct: sessionCapital > 0 ? (roundTrip.pnl / sessionCapital) * 100 : 0,
      strategy: label?.expected_strategy ?? '',
    })
  }
  const fmtTime = (value: unknown) => {
    const ts = Number(value)
    return Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString().slice(11, 19) : '-'
  }
  const fmtPrice = (value: unknown) => {
    const price = Number(value)
    return Number.isFinite(price) ? price.toFixed(2) : '-'
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="trade-history-modal" role="dialog" aria-modal="true" aria-label="Trade history">
      <header><strong>Trade History</strong><button onClick={onClose}>x</button></header>
      <div className="trade-history-table">
        <div className="trade-history-row trade-history-head"><span>Time</span><span>Side</span><span>Qty</span><span>Price</span><span>Instrument</span><span>P&L %</span><span>Strategy</span></div>
        {rows.length === 0 && <div className="trade-history-empty">No trades yet</div>}
        {rows.map((trade, index) => { const summary = exitSummary.get(String(trade.trade_id ?? trade.order_id ?? '')); return <div className="trade-history-row" key={String(trade.trade_id ?? trade.order_id ?? index)}>
          <span>{fmtTime(trade.timestamp ?? trade.filled_at ?? trade.created_at)}</span>
          <span className={String(trade.side) === 'BUY' ? 'trade-buy' : 'trade-sell'}>{String(trade.side ?? '-')}</span>
          <span>{String(trade.quantity ?? '-')}</span>
          <span>{fmtPrice(trade.price ?? trade.filled_price)}</span>
          <span>{[trade.symbol, trade.strike, trade.right].filter(Boolean).join(' ') || '-'}</span>
          <span className={summary ? summary.pnl >= 0 ? 'trade-buy' : 'trade-sell' : ''}>{summary ? `${summary.pnlPct >= 0 ? '+' : ''}${summary.pnlPct.toFixed(2)}%` : '-'}</span>
          <span>{summary?.strategy || '-'}</span>
        </div> })}
      </div>
    </section>
  </div>
}

function DesktopLabelPanel({ state, metadata, metadataStatus, metadataError, onReloadMetadata, onSave }: { state: DesktopTradeLabelState | null; metadata: DesktopLabelMetadata; metadataStatus: DesktopLabelMetadataStatus; metadataError: string; onReloadMetadata: () => void; onSave: (roundTrip: DesktopRoundTrip, fields: Partial<DesktopTradeLabel>) => void }) {
  const [popup, setPopup] = useState<{ mode: 'entry' | 'exit'; roundTrip: DesktopRoundTrip } | null>(null)
  if (!state) return null
  const existing = (roundTrip: DesktopRoundTrip) => state.labels.find(label => label.round_trip_index === roundTrip.index)
  const title = (roundTrip: DesktopRoundTrip) => `${roundTrip.right ?? 'EQ'}${roundTrip.strike ? ` ${roundTrip.strike}` : ''}`
  const openRows = state.open.filter(roundTrip => { const label = existing(roundTrip); return !(label?.expected_category || label?.expected_strategy) })
  const closedRows = state.completed.filter(roundTrip => { const label = existing(roundTrip); return !(label?.actual_category || label?.actual_strategy) })
  if (!openRows.length && !closedRows.length) return null
  const openPopup = (mode: 'entry' | 'exit', roundTrip: DesktopRoundTrip) => { if (metadataStatus !== 'ready') onReloadMetadata(); setPopup({ mode, roundTrip }) }
  return <section className="desktop-label-panel"><div className="desktop-label-heading"><span>Strategy</span><span className="desktop-label-icon">🏷</span></div>
    {openRows.map(roundTrip => <button className="desktop-label-row" key={`open-${roundTrip.index}`} onClick={() => openPopup('entry', roundTrip)}><span>{title(roundTrip)} open</span><span>Expected</span></button>)}
    {closedRows.map(roundTrip => <button className="desktop-label-row" key={`closed-${roundTrip.index}`} onClick={() => openPopup('exit', roundTrip)}><span>{title(roundTrip)} close</span><span className={roundTrip.pnl >= 0 ? 'trade-buy' : 'trade-sell'}>{roundTrip.pnl >= 0 ? '+' : ''}{roundTrip.pnl.toFixed(2)}</span></button>)}
    {popup && <DesktopLabelPopup mode={popup.mode} roundTrip={popup.roundTrip} existing={existing(popup.roundTrip)} metadata={metadata} metadataStatus={metadataStatus} metadataError={metadataError} onReloadMetadata={onReloadMetadata} onClose={() => setPopup(null)} onSave={(roundTrip, fields) => { onSave(roundTrip, fields); setPopup(null) }} />}
  </section>
}

function DesktopLabelPopup({ mode, roundTrip, existing, metadata, metadataStatus, metadataError, onReloadMetadata, onClose, onSave }: { mode: 'entry' | 'exit'; roundTrip: DesktopRoundTrip; existing?: DesktopTradeLabel; metadata: DesktopLabelMetadata; metadataStatus: DesktopLabelMetadataStatus; metadataError: string; onReloadMetadata: () => void; onClose: () => void; onSave: (roundTrip: DesktopRoundTrip, fields: Partial<DesktopTradeLabel>) => void }) {
  const isEntry = mode === 'entry'
  const [category, setCategory] = useState(isEntry ? existing?.expected_category ?? '' : existing?.actual_category ?? '')
  const [strategy, setStrategy] = useState(isEntry ? existing?.expected_strategy ?? '' : existing?.actual_strategy ?? '')
  const [tag, setTag] = useState(isEntry ? existing?.entry_tag || 'AS_PER_PATTERN' : existing?.exit_tag || 'AS_PER_PATTERN')
  const label = `${roundTrip.right ?? 'EQ'}${roundTrip.strike ? ` ${roundTrip.strike}` : ''}`
  return <div className="modal-backdrop label-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="label-modal" role="dialog" aria-modal="true" aria-label={isEntry ? 'Label expected strategy' : 'Label actual strategy'}>
      <header><strong>{isEntry ? 'Expected Pattern' : 'Actual Pattern'}</strong><button onClick={onClose}>x</button></header>
      <div className="label-modal-body">
        <div className="label-summary"><span>{label} {isEntry ? 'open' : 'close'}</span>{!isEntry && <b className={roundTrip.pnl >= 0 ? 'trade-buy' : 'trade-sell'}>{roundTrip.pnl >= 0 ? '+' : ''}{roundTrip.pnl.toFixed(2)}</b>}</div>
        {metadataStatus === 'loading' && <div className="label-metadata-status">Loading saved label values…</div>}
        {metadataStatus === 'error' && <div className="label-metadata-status error">Could not load saved label values. <button onClick={onReloadMetadata}>Retry</button><small>{metadataError}</small></div>}
        {metadataStatus === 'ready' && !metadata.categories.length && !metadata.strategies.length && <div className="label-metadata-status">No saved Pattern Library categories or strategies are available for this account yet.</div>}
        <label>Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">Category</option>{metadata.categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Strategy<select value={strategy} onChange={event => setStrategy(event.target.value)}><option value="">Strategy</option>{metadata.strategies.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>{isEntry ? 'Entry tag' : 'Exit tag'}<input list={`desktop-label-tags-${mode}-${roundTrip.index}`} value={tag} onChange={event => setTag(event.target.value)} placeholder="AS_PER_PATTERN" /></label>
        <datalist id={`desktop-label-tags-${mode}-${roundTrip.index}`}>{(isEntry ? metadata.entry_tags : metadata.exit_tags).map(value => <option key={value} value={value} />)}</datalist>
      </div>
      <footer><button onClick={onClose}>Cancel</button><button className="selected" onClick={() => onSave(roundTrip, isEntry ? { expected_category: category, expected_strategy: strategy, entry_tag: tag || 'AS_PER_PATTERN' } : { actual_category: category, actual_strategy: strategy, exit_tag: tag || 'AS_PER_PATTERN' })}>Save</button></footer>
    </section>
  </div>
}

function InstrumentPicker({ initial, lockedTradingDate, catalogue, api, onSave, onClose }: { initial: TileConfig; lockedTradingDate?: string; catalogue: Instrument[]; api: Api; onSave: (tile: TileConfig) => void | Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState({ ...initial, tradingDate: lockedTradingDate ?? initial.tradingDate })
  const [metadata, setMetadata] = useState<OptionMetadata | null>(null)
  const [openingPrice, setOpeningPrice] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [availabilityNotice, setAvailabilityNotice] = useState('')
  useDismissMessage(error, setError, 10_000)
  useDismissMessage(availabilityNotice, setAvailabilityNotice, 10_000)
  const instrument = catalogue.find(item => item.symbol === draft.symbol) ?? fallbackCatalogue[0]
  useEffect(() => {
    if (lockedTradingDate) setDraft(current => ({ ...current, tradingDate: lockedTradingDate, expiry: '', strike: '' }))
  }, [lockedTradingDate])
  useEffect(() => {
    if (draft.kind !== 'option') return
    let active = true
    const params = new URLSearchParams({ symbol: draft.symbol, trading_date: draft.tradingDate, interval_minutes: '1', context_days: '0' })
    void Promise.all([api<OptionMetadata>('metadata', new URLSearchParams({ symbol: draft.symbol, as_of_date: draft.tradingDate })), api<HistoricalPage>('history', params)]).then(([nextMetadata, page]) => {
      if (!active) return
      setMetadata(nextMetadata)
      setAvailabilityNotice(nextMetadata.available ? '' : nextMetadata.unavailable_reason ?? 'Option data unavailable')
      const opening = page.candles.find(candle => new Date(candle.timestamp * 1000).toISOString().slice(0, 10) === draft.tradingDate)?.open ?? page.candles[0]?.open ?? null
      setOpeningPrice(opening)
      const gap = nextMetadata.strike_interval
      const defaultStrike = opening === null ? '' : String(Math.round(opening / gap) * gap)
      setDraft(current => ({ ...current, expiry: nextMetadata.expiries.includes(current.expiry) ? current.expiry : (nextMetadata.expiries[0] ?? ''), right: nextMetadata.rights.includes(current.right) ? current.right : (nextMetadata.rights[0] ?? 'CE'), strike: current.strike && Number(current.strike) % gap === 0 ? current.strike : defaultStrike }))
    }).catch(reason => active && setError(String(reason)))
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind, draft.symbol, draft.tradingDate])
  const gap = metadata?.strike_interval ?? 0
  const baseStrike = openingPrice === null || !gap ? 0 : Math.round(openingPrice / gap) * gap
  // Keep the opening-price strike centered while exposing five additional
  // strikes on both sides for desktop option-chart selection.
  const strikes = baseStrike ? Array.from({ length: 31 }, (_, index) => baseStrike + (index - 15) * gap).filter(value => value > 0) : []
  return <div className="modal-backdrop" role="presentation"><section className="instrument-modal" role="dialog" aria-modal="true" aria-label="Select chart instrument"><header><strong>Select instrument</strong><button onClick={onClose}>×</button></header><div className="picker-fields"><label>Type<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as TileConfig['kind'], expiry: '', strike: '' })}><option value="spot">Equity / index</option><option value="option" disabled={!instrument.option_eligible}>Option</option></select></label><label>Symbol<select value={draft.symbol} onChange={event => setDraft({ ...draft, symbol: event.target.value, expiry: '', strike: '' })}>{catalogue.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name}</option>)}</select></label><label>{lockedTradingDate ? 'Session date' : 'Browse date'}<input type="date" value={draft.tradingDate} disabled={Boolean(lockedTradingDate)} onChange={event => setDraft({ ...draft, tradingDate: event.target.value, expiry: '', strike: '' })} /></label>{draft.kind === 'option' && <><label>Expiry<select value={draft.expiry} onChange={event => setDraft({ ...draft, expiry: event.target.value })} disabled={!metadata?.available}>{metadata?.expiries.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Underlying open<input value={openingPrice ?? 'Loading…'} readOnly /></label><label>Strike<select value={draft.strike} onChange={event => setDraft({ ...draft, strike: event.target.value })} disabled={!strikes.length}>{strikes.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Right<select value={draft.right} onChange={event => setDraft({ ...draft, right: event.target.value })}>{metadata?.rights.map(value => <option key={value} value={value}>{value}</option>)}</select></label></>}</div>{availabilityNotice && <p className="tile-notice">{availabilityNotice}</p>}{error && <p className="tile-notice">{error}</p>}<footer><button onClick={onClose}>Cancel</button><button className="selected" disabled={draft.kind === 'option' && (!draft.expiry || !draft.strike || !metadata?.available)} onClick={() => void onSave(draft)}>Apply to chart</button></footer></section></div>
}

function ChartSettingsModal({ settings, tradingSettings, onSave, onSaveTradingSettings, loadSettings, loadChartSettings, saveGuardrails, onClose }: { loadSettings: () => Promise<Record<string, unknown>>; loadChartSettings: () => Promise<ChartSettings>; saveGuardrails: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>; settings: ChartSettings; tradingSettings: DesktopTradingSnapshot['settings'] | null; onSave: (settings: ChartSettings) => Promise<void>; onSaveTradingSettings: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  const [tradingDraft, setTradingDraft] = useState(tradingSettings)
  const [tab, setTab] = useState('Drawing & Display')
  const [guardrailDraft, setGuardrailDraft] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [status, setStatus] = useState(''), [loadFailed, setLoadFailed] = useState(false)
  useDismissMessage(status, setStatus, status === 'Settings saved' ? 5_000 : 10_000)
  const load = async () => {
    setLoading(true); setLoadFailed(false); setStatus('')
    try { const [user, chart] = await Promise.all([loadSettings(), loadChartSettings()]); setDraft(chart); setTradingDraft(user as unknown as DesktopTradingSnapshot['settings']); setGuardrailDraft(user); setLoading(false); setLoadFailed(false) }
    catch (error) { setLoadFailed(true); setStatus(String(error)) }
  }
  useEffect(() => { void load() }, [])
  const save = async () => {
    setSaving(true); setStatus('')
    try {
      if (tab === 'Drawing & Display') await onSave(draft)
      else if (tab === 'GuardRails') {
        const values = Object.fromEntries(guardrailFields.map(([key]) => [key, guardrailDraft[key]]))
        setGuardrailDraft(await saveGuardrails(values))
      } else if (tradingDraft) {
        const keys = ['desktop_hide_chart_labels', 'desktop_order_size_mode', 'desktop_pnl_display_mode', 'desktop_confirm_flatten', 'funds_ratio_l_pct', 'funds_ratio_m_pct', 'funds_ratio_h_pct', 'risk_ratio_l_pct', 'risk_ratio_m_pct', 'risk_ratio_h_pct']
        const values = Object.fromEntries(keys.map(key => [key, tradingDraft[key as keyof typeof tradingDraft]]))
        setTradingDraft(await onSaveTradingSettings(values) as unknown as DesktopTradingSnapshot['settings'])
      }
      setStatus('Settings saved')
    } catch (error) { setStatus(String(error)) } finally { setSaving(false) }
  }
  return <div className="modal-backdrop"><section className="instrument-modal desktop-settings-modal" role="dialog" aria-modal="true" aria-label="Chart display settings"><header><strong>Settings</strong><button onClick={onClose}>×</button></header><form onSubmit={event => { event.preventDefault(); void save() }}><div className="settings-layout"><nav role="tablist" aria-label="Settings sections">{['Drawing & Display', 'Trading', 'GuardRails'].map(name => <button type="button" role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} key={name} onClick={() => setTab(name)}>{name}</button>)}</nav><fieldset disabled={loading || saving} className="settings-scroll"><section hidden={tab !== 'Drawing & Display'} className="settings-section"><strong>Chart display</strong><div className="picker-fields"><label>Background<input type="color" value={draft.background} onChange={event => setDraft({ ...draft, background: event.target.value })} /></label><label>Text color<input type="color" value={draft.textColor} onChange={event => setDraft({ ...draft, textColor: event.target.value })} /></label><label>Grid color<input type="color" value={draft.gridColor} onChange={event => setDraft({ ...draft, gridColor: event.target.value })} /></label><label>Grid opacity <input type="range" min="0" max="1" step="0.02" value={draft.gridOpacity} onChange={event => setDraft({ ...draft, gridOpacity: Number(event.target.value) })} />{Math.round(draft.gridOpacity * 100)}%</label><label>Grid style<select value={draft.gridStyle} onChange={event => setDraft({ ...draft, gridStyle: event.target.value as ChartSettings['gridStyle'] })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label><label>Grid thickness<select value={draft.gridSize} onChange={event => setDraft({ ...draft, gridSize: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option></select></label><label>Moving average<select value={draft.movingAverageType} onChange={event => setDraft({ ...draft, movingAverageType: event.target.value as ChartSettings['movingAverageType'] })}><option value="MA">Simple MA</option><option value="EMA">Exponential MA</option></select></label><label>MA/EMA periods<input value={draft.movingAveragePeriods} onChange={event => setDraft({ ...draft, movingAveragePeriods: event.target.value.replace(/[^0-9,]/g, '') })} placeholder="5,10,20" /></label><label>Horizontal line color<input type="color" value={draft.horizontalLineColor} onChange={event => setDraft({ ...draft, horizontalLineColor: event.target.value })} /></label><label>Horizontal line width<select value={draft.horizontalLineWidth} onChange={event => setDraft({ ...draft, horizontalLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Trend line color<input type="color" value={draft.trendLineColor} onChange={event => setDraft({ ...draft, trendLineColor: event.target.value })} /></label><label>Trend line width<select value={draft.trendLineWidth} onChange={event => setDraft({ ...draft, trendLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Other drawing line<input type="color" value={draft.drawingLineColor} onChange={event => setDraft({ ...draft, drawingLineColor: event.target.value })} /></label><label>Other drawing width<select value={draft.drawingLineWidth} onChange={event => setDraft({ ...draft, drawingLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Shape fill color<input type="color" value={draft.drawingFillColor} onChange={event => setDraft({ ...draft, drawingFillColor: event.target.value })} /></label><label>Shape fill opacity <input type="range" min="0" max="0.8" step="0.02" value={draft.drawingFillOpacity} onChange={event => setDraft({ ...draft, drawingFillOpacity: Number(event.target.value) })} />{Math.round(draft.drawingFillOpacity * 100)}%</label></div><label><span><input type="checkbox" checked={draft.showChartInfo} onChange={event => setDraft({ ...draft, showChartInfo: event.target.checked })} /> Show OHLC and indicator information</span></label></section>{tradingDraft && <section hidden={tab !== 'Trading'} className="settings-section trading-settings-section"><strong>Trading</strong><p>Sizing is fixed for this session. Changes apply to new sessions.</p><div className="picker-fields"><label><span><input type="checkbox" checked={tradingDraft.desktop_hide_chart_labels} onChange={event => setTradingDraft({ ...tradingDraft, desktop_hide_chart_labels: event.target.checked })} /> Hide chart labels</span></label><label>Size<select value={tradingDraft.desktop_order_size_mode} onChange={event => setTradingDraft({ ...tradingDraft, desktop_order_size_mode: event.target.value as DesktopTradingSnapshot['settings']['desktop_order_size_mode'] })}><option value="quantity">Quantity</option><option value="funds_ratio">Funds ratio</option><option value="risk_ratio">Risk ratio</option></select></label>{tradingDraft.desktop_order_size_mode !== 'quantity' && (['l', 'm', 'h'] as const).map(size => { const field = (tradingDraft.desktop_order_size_mode === 'funds_ratio' ? `funds_ratio_${size}_pct` : `risk_ratio_${size}_pct`) as keyof DesktopTradingSnapshot['settings']; const fraction = tradingDraft.desktop_order_size_mode === 'funds_ratio'; return <label key={size}>{fraction ? 'Capital' : 'Risk'} {size.toUpperCase()} %<input type="number" min="0.01" max="100" step="0.1" value={Number(tradingDraft[field]) * (fraction ? 100 : 1)} onChange={event => { const value = Number(event.target.value); if (value > 0 && value <= 100) setTradingDraft({ ...tradingDraft, [field]: fraction ? value / 100 : value }) }} /></label> })}<label>P&amp;L<select value={tradingDraft.desktop_pnl_display_mode} onChange={event => setTradingDraft({ ...tradingDraft, desktop_pnl_display_mode: event.target.value as DesktopTradingSnapshot['settings']['desktop_pnl_display_mode'] })}><option value="currency">Currency</option><option value="percent">Percent</option></select></label><label><span><input type="checkbox" checked={tradingDraft.desktop_confirm_flatten} onChange={event => setTradingDraft({ ...tradingDraft, desktop_confirm_flatten: event.target.checked })} /> Confirm Flatten</span></label></div></section>}{tab === 'GuardRails' && <GuardrailFields draft={guardrailDraft} onChange={setGuardrailDraft} />}</fieldset></div>{loading && <p>Loading settings…</p>}{status && <p role="status">{status}</p>}{loading && loadFailed && <button type="button" onClick={() => void load()}>Retry</button>}<footer><button type="button" onClick={onClose}>Close</button><button type="submit" className="selected" disabled={loading || saving}>{saving ? 'Saving…' : 'Save settings'}</button></footer></form></section></div>
}

function DesktopTile({ config, catalogue, connection, api, settings, serverUrl, drawingRequest, onDrawingError, replayCursor, replayRunId, replayCandle, replayAttached, liveTile, liveTicks, onLiveTick, onConfigure, onMaximize, onIntervalChange, maximized, active, indicators, drawingCommand, drawingAction, drawingMode, onDrawingComplete, onActivate, tradingSnapshot, pricePickAction, onPricePick, onOrderDrag, onOrderCancel, onOrderConvertRequest, onOrderQuantityUpdate, onChartOrderAction, onStrategyDrag, swapTargets }: { config: TileConfig; catalogue: Instrument[]; connection: string; api: Api; settings: ChartSettings; serverUrl: string; drawingRequest: (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>) => Promise<unknown>; onDrawingError?: (error: unknown) => void; replayCursor?: number; replayRunId?: string; replayCandle?: Candle; replayAttached?: boolean; liveTile?: LiveTileState; liveTicks: Candle[]; onLiveTick: (key: string, tick: Candle) => void; onConfigure: () => void; onMaximize: () => void; onIntervalChange: (interval: string) => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; drawingMode: DrawingMode; onDrawingComplete: (commandId: number, tool: string) => void; onActivate: () => void; tradingSnapshot?: DesktopTradingSnapshot | null; pricePickAction?: PricePickAction | null; onPricePick?: (price: number) => void; onOrderDrag?: (order: DesktopOrder, price: number) => void; onOrderCancel?: (order: DesktopOrder) => void; onOrderConvertRequest?: (order: DesktopOrder, target: ConversionTarget) => void; onOrderQuantityUpdate?: (order: DesktopOrder, quantity: number) => Promise<void>; onChartOrderAction?: (tile: TileConfig, action: OrderAction, price: number, anchor: { x: number; y: number }) => void; onStrategyDrag?: (strategyId: string, price: number) => void; swapTargets?: TileSwap[] }) {
  const [metadata, setMetadata] = useState<OptionMetadata | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  useEffect(() => { if (config.kind === 'option' && connection === 'connected') void api<OptionMetadata>('metadata', new URLSearchParams({ symbol: config.symbol, as_of_date: config.tradingDate })).then(setMetadata).catch(error => setStatus(String(error))) }, [config.kind, config.symbol, config.tradingDate, connection])
  useEffect(() => { if (connection !== 'connected' || (config.kind === 'option' && (!config.expiry || !config.strike || !metadata?.available))) return; let active = true; setCandles([]); setStatus(''); setLoading(true); const params = new URLSearchParams({ symbol: config.symbol, trading_date: config.tradingDate, interval_minutes: config.interval, context_days: '5' }); if (config.kind === 'option') { params.set('expiry', config.expiry); params.set('strike', config.strike); params.set('right', config.right) }; const cacheKey = `${instrumentKeyForTile(config, catalogue)}:${config.tradingDate}:${config.interval}`; const promise = historyCache.get(cacheKey) ?? api<HistoricalPage>(config.kind === 'option' ? 'optionHistory' : 'history', params).then(page => { if (page.available === false) setStatus(page.unavailable_reason ?? 'Option unavailable'); return page.candles }); historyCache.set(cacheKey, promise); void promise.then(nextCandles => { if (active) { setCandles(nextCandles); setHistoryVersion(version => version + 1) } }).catch(error => active && setStatus(String(error))).finally(() => active && setLoading(false)); return () => { active = false } }, [config.expiry, config.interval, config.kind, config.right, config.strike, config.symbol, config.tradingDate, connection, metadata?.available, catalogue])
  const label = config.kind === 'option' ? `${config.symbol} ${config.expiry} ${config.strike} ${config.right}` : config.symbol
  const catalogueInstrument = catalogue.find(item => item.symbol === config.symbol) ?? fallbackCatalogue[0]
  const chartInstrument = config.kind === 'option' ? { kind: 'option', exchange: catalogueInstrument.exchange, underlying: config.symbol, expiry: config.expiry, strike: Number(config.strike), right: config.right } : { kind: catalogueInstrument.chart_type ?? 'equity', exchange: catalogueInstrument.exchange, symbol: config.symbol }
  const subscribedTile = liveTile
  const liveInstrumentKey = subscribedTile ? canonicalKey(subscribedTile.instrument) : null
  const latestTick = subscribedTile?.latest_tick
  useEffect(() => {
    if (latestTick && liveInstrumentKey) onLiveTick(liveInstrumentKey, latestTick)
  }, [latestTick?.close, latestTick?.high, latestTick?.low, latestTick?.open, latestTick?.timestamp, liveInstrumentKey])
  const visibleCandles = subscribedTile ? aggregateLiveTileCandles(subscribedTile.candles ?? [], liveTicks, Number(config.interval), subscribedTile.interval_minutes) : replayCandles(candles, replayCursor, replayCandle, Number(config.interval) * 60)
  const replayDatasetKey = replayCursor ? `${replayRunId ?? 'pending'}:${historyVersion}` : undefined
  const replaySyncing = Boolean(replayCursor && !replayAttached)
  const tileRight = config.kind === 'option' ? config.right as 'CE' | 'PE' : null
  const tileContractKey = contractKeyForTile(config)
  const tileOrders = (tradingSnapshot?.open_orders ?? []).filter(order => {
    if (!tileContractKey) return (order.right ?? null) === tileRight
    return `${order.symbol}:${order.expiry ?? ''}:${Number(order.strike)}:${order.right ?? ''}` === tileContractKey
  })
  const tilePosition: DesktopPosition | null = tileContractKey ? tradingSnapshot?.positions_by_contract?.[tileContractKey] ?? null : tileRight ? tradingSnapshot?.positions[tileRight] ?? null : tradingSnapshot?.positions.equity ?? null
  const tileStrategies = (tradingSnapshot?.strategies ?? []).filter(strategy => tileContractKey ? strategy.contract_key === tileContractKey : strategy.strategy_type.startsWith('Underlying'))
  const entryReason = entryUnavailableReason(config.kind, config.symbol, tradingSnapshot)
  useEffect(() => {
    if (config.kind === 'option' && tradingSnapshot && entryReason) reportOptionEntryDiagnostic({ tile_id: config.id, contract_key: tileContractKey, session_id: tradingSnapshot.session.session_id, session_state: tradingSnapshot.session.state, session_symbol: tradingSnapshot.session.symbol, reason: entryReason })
  }, [config.id, config.kind, tileContractKey, tradingSnapshot?.session.session_id, tradingSnapshot?.session.state, tradingSnapshot?.session.symbol, entryReason])
  return <div className={`workspace-tile ${maximized ? 'is-maximized' : ''}`}><ChartTile symbol={label} interval={`${config.interval}m`} supportedIntervals={catalogueInstrument.supported_intervals} onIntervalChange={onIntervalChange} candles={visibleCandles} loading={subscribedTile ? false : loading || replaySyncing} message={subscribedTile && subscribedTile.availability !== 'available' ? (subscribedTile.reason ?? subscribedTile.availability) : replaySyncing ? 'Attaching to replay...' : status} settings={settings} isReplaying={Boolean(replayCursor)} isLive={Boolean(subscribedTile)} replayDatasetKey={replayDatasetKey} instrument={chartInstrument} baseUrl={serverUrl} drawingRequest={drawingRequest} onDrawingError={onDrawingError} onConfigure={onConfigure} onMaximize={onMaximize} maximized={maximized} active={active} indicators={indicators} drawingCommand={drawingCommand} drawingAction={drawingAction} drawingMode={drawingMode} onDrawingComplete={onDrawingComplete} onActivate={onActivate} trades={tradingSnapshot?.trades ?? []} openOrders={tileOrders} strategies={tileStrategies} position={tilePosition} sessionCapital={tradingSnapshot?.session.session_capital ?? 0} lotSize={instrumentLotSize(config.kind, tradingSnapshot)} tradingSettings={tradingSnapshot?.settings ?? null} tradingEnabled={Boolean(tradingSnapshot)} orderEntryEnabled={equityEntryEnabled(config.kind, config.symbol, tradingSnapshot)} entryUnavailableReason={entryReason} shortEntryEnabled={config.kind === 'spot' && tradingSnapshot?.session.instrument_type === 'equity'} underlyingStrategyEnabled={Boolean(tradingSnapshot) && config.kind === 'spot' && tradingSnapshot?.session.instrument_type === 'options'} pricePickAction={pricePickAction} onPricePick={onPricePick} onOrderDrag={onOrderDrag} onStrategyDrag={onStrategyDrag} onOrderCancel={onOrderCancel} onOrderConvertRequest={onOrderConvertRequest} onOrderQuantityUpdate={onOrderQuantityUpdate} onChartOrderAction={(action, price, anchor) => onChartOrderAction?.(config, action, price, anchor)} swapTargets={swapTargets} /></div>
}

type Connection = 'connected' | 'reconnecting' | 'offline' | 'authentication_required'
interface ScreenControllerProps {
  screenId: string; screens: Screen[]; setScreens: Dispatch<SetStateAction<Screen[]>>
  selectedId: string; selectScreen: (id: string) => void; loaded: boolean
  registerSave: (id: string, save: (() => Promise<unknown>) | null) => void
  external: string[]; assignedId: string | null
  connection: Connection; setConnection: Dispatch<SetStateAction<Connection>>
  browserToken: string; setBrowserToken: Dispatch<SetStateAction<string>>
  serverUrl: string; setServerUrl: Dispatch<SetStateAction<string>>
}

export default function App() {
  const assignedId = new URLSearchParams(window.location.search).get('screen_id')
  const [screens, setScreens] = useState<Screen[]>([newScreen(1)])
  const [selectedId, selectScreen] = useState(screens[0].id)
  const [loaded, setLoaded] = useState(false)
  const [external, setExternal] = useState<string[]>([])
  const saveHandlers = useRef(new Map<string, () => Promise<unknown>>())
  const registerSave = useCallback((id: string, save: (() => Promise<unknown>) | null) => { if (save) saveHandlers.current.set(id, save); else saveHandlers.current.delete(id) }, [])
  const [closeError, setCloseError] = useState('')
  useDismissMessage(closeError, setCloseError, 10_000)
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    const listener = getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault()
      await closeAfterSave(Promise.all([...saveHandlers.current.values()].map(save => Promise.resolve().then(save))),
        () => invoke('finish_window_close'), error => setCloseError(`Closing with locally recovered settings: ${String(error)}`))
        .catch(error => setCloseError(String(error)))
    })
    void listener.then(unlisten => { if (disposed) unlisten() })
    return () => { disposed = true; void listener.then(unlisten => unlisten()) }
  }, [])
  const [connection, setConnection] = useState<Connection>('authentication_required')
  const [browserToken, setBrowserToken] = useState('')
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('desktop-server-url') ?? 'http://localhost:8700')
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let cancelled = false
    const poll = () => void invoke<string[]>('list_screen_windows').then(ids => {
      if (!cancelled) setExternal(current => JSON.stringify(current) === JSON.stringify(ids) ? current : ids)
    }).catch(() => undefined)
    poll()
    const timer = window.setInterval(poll, 500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    localStorage.setItem('desktop-server-url', serverUrl)
    if (!('__TAURI_INTERNALS__' in window)) return
    let cancelled = false
    let inFlight = false
    let failures = 0
    const check = () => {
      if (inFlight) return
      inFlight = true
      void invoke<Connection>('desktop_connection_state', { baseUrl: serverUrl })
        .catch((): Connection => 'offline')
        .then(state => {
          if (cancelled) return
          failures = state === 'offline' ? failures + 1 : 0
          setConnection(current => state === 'offline' && failures < 2 && current === 'connected' ? current : state)
        })
        .finally(() => { inFlight = false })
    }
    check()
    const timer = window.setInterval(check, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [serverUrl])
  const [loadError, setLoadError] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  useDismissMessage(loadError, setLoadError, 10_000)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const discoveryInFlight = useRef(false)
  useEffect(() => {
    if (connection !== 'connected' || loaded || discoveryInFlight.current) return
    let cancelled = false
    discoveryInFlight.current = true
    const discover = async () => {
      const result = '__TAURI_INTERNALS__' in window
        ? await invoke<{ screens: DesktopScreenRecord[] }>('desktop_drawing_request', { baseUrl: serverUrl, path: 'screens', method: 'GET', body: {} })
        : await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/screens`, { headers: { Authorization: `Bearer ${browserToken}` } }).then(async response => { if (!response.ok) throw new Error(`Screen discovery failed (${response.status})`); return response.json() as Promise<{ screens: DesktopScreenRecord[] }> })
      if (cancelled) return
      const records = [...result.screens].sort((a, b) => a.order - b.order)
      const restored = records.map(record => {
        let journal: RecoveryJournal<PersistedScreenState> | null = null
        try { journal = JSON.parse(localStorage.getItem(journalKey(serverUrl, record.state.id ?? record.screen_id)) ?? 'null') } catch { /* ignore invalid journal */ }
        const state = recoverState(record.state, record.revision, journal)
        return { id: state.id ?? record.screen_id, persistedId: record.screen_id, revision: record.revision, name: record.name, saved: state, layout: state.layout ?? '1', tiles: state.tiles?.length ? state.tiles : [newTile()] } as Screen
      })
      if (records.length) {
        setScreens(restored)
        const active = assignedId ? restored.find(screen => screen.id === assignedId || screen.persistedId === assignedId) : restored.find(screen => records.find(record => record.screen_id === screen.persistedId)?.active) ?? restored[0]
        if (active) selectScreen(active.id)
      }
      setLoaded(true)
      setLoadFailed(false)
      setLoadError('')
    }
    void discover().catch(error => { if (!cancelled) { setLoadFailed(true); setLoadError(String(error)) } }).finally(() => { discoveryInFlight.current = false })
    return () => { cancelled = true; discoveryInFlight.current = false }
  }, [connection, loaded, serverUrl, browserToken, loadAttempt, assignedId])
  const visibleId = screens.some(screen => screen.id === selectedId) ? selectedId : screens[0]?.id
  const assigned = screens.find(screen => screen.id === assignedId || screen.persistedId === assignedId)
  const ownedScreens = controlledScreens(screens, assignedId, loaded, external)
  return <>
    {closeError && <p role="alert">{closeError}</p>}
    {loadFailed && <main role="alert">{loadError && <p>{loadError}</p>}<button onClick={() => setLoadAttempt(value => value + 1)}>Retry loading screens</button></main>}
    {assignedId && !loaded && <main><p>{connection === 'authentication_required' ? 'Sign in in the main window to reconnect this screen.' : 'Loading popped-out screen…'}</p><button onClick={() => void invoke('focus_main_window')}>Main window</button></main>}
    {!assignedId && external.includes(visibleId) && <main><header><nav className="screen-tabs">{screens.map(screen => <button key={screen.id} onClick={() => selectScreen(screen.id)}>{screen.name}{external.includes(screen.id) ? ' ↗' : ''}</button>)}</nav><button onClick={() => void invoke('focus_screen_window', { screenId: visibleId })}>Focus window</button><button onClick={() => void invoke('close_screen_window', { screenId: visibleId })}>Bring back</button></header><p>This screen is open in another window.</p></main>}
    {assignedId && loaded && !assigned && <main><p>Saved screen not found. Return to the main window.</p></main>}
    {ownedScreens.map(screen => <div key={screen.id} style={{ display: assignedId || screen.id === visibleId ? 'contents' : 'none' }}>
      <ScreenController registerSave={registerSave} screenId={screen.id} screens={screens} setScreens={setScreens} selectedId={visibleId} selectScreen={selectScreen} loaded={loaded} external={external} assignedId={assignedId} connection={connection} setConnection={setConnection} browserToken={browserToken} setBrowserToken={setBrowserToken} serverUrl={serverUrl} setServerUrl={setServerUrl} />
    </div>)}
  </>
}

function ScreenController(props: ScreenControllerProps) {
  const { screens, setScreens, screenId: activeScreenId, selectScreen: setActiveScreenId, serverUrl, setServerUrl, connection, setConnection, browserToken, setBrowserToken } = props
  const initial = screens.find(screen => screen.id === activeScreenId)?.saved

  const [email, setEmail] = useState('admin@tradematangi.com'), [password, setPassword] = useState('admin123'), [loginError, setLoginError] = useState(''), [mode, setMode] = useState<DesktopMode>(initial?.mode ?? 'Browse'), [catalogue, setCatalogue] = useState<Instrument[]>(fallbackCatalogue), [chartSettings, setChartSettings] = useState<ChartSettings>(defaultChartSettings), [showSettings, setShowSettings] = useState(false), [replay, setReplay] = useState<ReplaySnapshot | null>(null), [replayError, setReplayError] = useState(''), [runDate, setRunDate] = useState(initial?.run_date ?? screens.find(screen => screen.id === activeScreenId)?.tiles[0]?.tradingDate ?? paperMarketDate()), [runStartTime, setRunStartTime] = useState(initial?.start_time ?? '09:15'), [replaySpeed, setReplaySpeed] = useState(initial?.speed ?? '1'), [live, setLive] = useState<LiveSnapshot | null>(null), [liveError, setLiveError] = useState('')
  const [trading, setTrading] = useState<DesktopTradingSnapshot | null>(null), [tradingError, setTradingError] = useState(''), [strategyError, setStrategyError] = useState(''), [tradingNotice, setTradingNotice] = useState(''), [drawingError, setDrawingError] = useState(''), [pricePickAction, setPricePickAction] = useState<{ orderId?: string; conversion?: ConversionTarget; ticket?: TradeTicket; missingSl?: { tile: TileConfig; requestId: string; quantity: number } } | null>(null), [tradeTicket, setTradeTicket] = useState<TradeTicket | null>(null), [underlyingStrategyTicket, setUnderlyingStrategyTicket] = useState<UnderlyingStrategyTicket | null>(null), [tradeLabelState, setTradeLabelState] = useState<DesktopTradeLabelState | null>(null), [labelMetadata, setLabelMetadata] = useState<DesktopLabelMetadata>(emptyLabelMetadata), [labelMetadataStatus, setLabelMetadataStatus] = useState<DesktopLabelMetadataStatus>('idle'), [labelMetadataError, setLabelMetadataError] = useState(''), [sharedTradingSession, setSharedTradingSession] = useState(false), [preStartWallet, setPreStartWallet] = useState<number | null>(null), [historicalStarting, setHistoricalStarting] = useState(false)
  useDismissMessage(loginError, setLoginError, 10_000)
  useDismissMessage(replayError, setReplayError, 10_000)
  useDismissMessage(tradingError, setTradingError, 10_000)
  useDismissMessage(strategyError, setStrategyError, 10_000)
  useDismissMessage(liveError, setLiveError, 10_000)
  useDismissMessage(drawingError, setDrawingError, 10_000)
  useDismissMessage(labelMetadataError, setLabelMetadataError, 10_000)
  useDismissMessage(tradingNotice, setTradingNotice, 5_000)
  const replayPollInFlight = useRef(false)
  const lastReplayPollError = useRef('')
  const [restoredReady, setRestoredReady] = useState(!initial)
  const screenSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const persistedScreenRef = useRef({ id: screens.find(screen => screen.id === activeScreenId)?.persistedId, revision: screens.find(screen => screen.id === activeScreenId)?.revision })
  const [walletLocked, setWalletLocked] = useState(false)
  const [liveEnabled, setLiveEnabled] = useState(Boolean(initial?.live_enabled))
  const [handingOff, setHandingOff] = useState(false)
  const handoffRef = useRef<string | null>(null)
  const [childReady, setChildReady] = useState(!props.assignedId)
  const [handoffError, setHandoffError] = useState('')
  const [handoffFailed, setHandoffFailed] = useState(false)
  useDismissMessage(handoffError, setHandoffError, 10_000)
  useEffect(() => { if (handoffError) setHandoffFailed(true) }, [handoffError])
  const authenticatedRef = useRef(connection !== 'authentication_required')
  const tradingStreamEventRef = useRef<Record<string, number>>({})
  const tradingRefreshRef = useRef(new TradingRefresh())
  const tradingStateRef = useRef(trading)
  tradingStateRef.current = trading
  const tradingSnapshotRequiredRef = useRef<Record<string, boolean>>({})
  const labelMetadataRequestIdRef = useRef(0)
  const lastTradingErrorRef = useRef('')
  const lastLiveErrorRef = useRef('')
  const screenSaveTimerRef = useRef<number | null>(null)
  const lastScreenPayloadRef = useRef('')
  const [googleLoading, setGoogleLoading] = useState(false), [googleReady, setGoogleReady] = useState(false), [googleAccountName, setGoogleAccountName] = useState(''), [pendingGoogleToken, setPendingGoogleToken] = useState<string | null>(null)
  const [walletOpen, setWalletOpen] = useState(false), [walletAmount, setWalletAmount] = useState('150000'), [tradeHistoryOpen, setTradeHistoryOpen] = useState(false)
  const [pickerTileId, setPickerTileId] = useState<string | null>(null), [maximizedTileId, setMaximizedTileId] = useState<string | null>(null)
  const [activeToolTileId, setActiveToolTileId] = useState(initial?.activeToolTileId ?? screens.find(screen => screen.id === activeScreenId)?.tiles[0]?.id ?? ''), [toolPanelOpen, setToolPanelOpen] = useState(true), [tileIndicators, setTileIndicators] = useState<Record<string, string[]>>(initial?.indicators ?? {}), [drawingCommand, setDrawingCommand] = useState<DrawingCommand | null>(null), [drawingAction, setDrawingAction] = useState<DrawingAction | null>(null), [drawingMode, setDrawingMode] = useState<DrawingMode>('once'), [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null), [liveTickCache, setLiveTickCache] = useState<Record<string, Candle[]>>({})
  const clearTradingError = useCallback(() => {
    lastTradingErrorRef.current = ''
    setTradingError('')
  }, [])
  const [guardrailPopup, setGuardrailPopup] = useState<{ type: string; reason: string } | null>(null)
  const [blockPending, setBlockPending] = useState(false)
  const guardrailSeen = useRef('')
  useEffect(() => {
    const state = trading?.guardrails
    const key = state?.blocked ? `${trading?.session.session_id}:${state.reason}:${state.block_until_bar}` : ''
    if (key && key !== guardrailSeen.current) setGuardrailPopup({ type: state!.ban_active ? 'BAN' : state!.type ?? 'BLOCK', reason: state!.reason })
    guardrailSeen.current = key
    if (!trading) setGuardrailPopup(null)
  }, [trading?.session.session_id, trading?.guardrails])
  useEffect(() => {
    if (!guardrailPopup) return
    const timer = window.setTimeout(() => setGuardrailPopup(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [guardrailPopup])
  const reportTradingError = useCallback((error: unknown) => {
    const feedback = parseGuardrailError(error)
    if (feedback) { setGuardrailPopup(feedback); return }
    const message = String(error)
    if (!shouldShowMessage(lastTradingErrorRef.current, message)) return
    lastTradingErrorRef.current = message
    setTradingError(message)
  }, [])
  const clearLiveError = useCallback(() => {
    lastLiveErrorRef.current = ''
    setLiveError('')
  }, [])
  const reportLiveError = useCallback((error: unknown) => {
    const message = String(error)
    if (!shouldShowMessage(lastLiveErrorRef.current, message)) return
    lastLiveErrorRef.current = message
    setLiveError(message)
  }, [])
  const clearLiveTickCache = (streamId?: string) => {
    setLiveTickCache({})
    if (hasNativeHost && streamId) {
      void invoke('clear_desktop_live_ticks', { streamId }).catch(error => recordRendererDiagnostic('live_tick_clear_error', { live_stream_id: streamId, error: String(error) }))
    }
  }
  const setLiveSnapshot = (snapshot: LiveSnapshot | null) => { setLive(snapshot); if (snapshot) clearLiveError() }
  const updateLiveSnapshot = (updater: (snapshot: LiveSnapshot | null) => LiveSnapshot | null) => {
    setLive(current => {
      const next = updater(current)
      if (next) clearLiveError()
      return next
    })
  }
  const hasNativeHost = '__TAURI_INTERNALS__' in window
  const recordRendererDiagnostic = useCallback((kind: string, payload: Record<string, unknown>) => {
    if (!hasNativeHost) return
    void invoke('record_desktop_renderer_diagnostic', { kind, payload }).catch(() => undefined)
  }, [hasNativeHost])
  useEffect(() => {
    const onError = (event: ErrorEvent) => recordRendererDiagnostic('window_error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      mode,
      live_stream_id: live?.stream_id,
      live_event_id: live?.event_id,
    })
    const onUnhandledRejection = (event: PromiseRejectionEvent) => recordRendererDiagnostic('unhandled_rejection', {
      reason: String(event.reason),
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
      mode,
      live_stream_id: live?.stream_id,
      live_event_id: live?.event_id,
    })
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [live?.event_id, live?.stream_id, mode, recordRendererDiagnostic])
  const api: Api = async (path, params) => { if (hasNativeHost) { const commands: Record<string, string> = { catalogue: 'desktop_catalogue', metadata: 'desktop_option_metadata', history: 'desktop_historical_page', optionHistory: 'desktop_option_historical_page' }; const values = Object.fromEntries((params ?? new URLSearchParams()).entries()); return invoke(commands[path], { baseUrl: serverUrl, ...values, asOfDate: values.as_of_date, tradingDate: values.trading_date, intervalMinutes: Number(values.interval_minutes), strike: Number(values.strike) }) }; const route = path === 'catalogue' ? 'catalogue' : path === 'metadata' ? 'option-metadata' : path === 'history' ? 'historical/pages' : 'options/historical/pages'; const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/${route}${params ? `?${params}` : ''}`, { headers: { Authorization: `Bearer ${browserToken}` } }); if (!response.ok) throw new Error(`Request failed (${response.status})`); return response.json() }
  const login = async () => { try { setLoginError(''); if (hasNativeHost) await invoke('desktop_login', { baseUrl: serverUrl, email, password }); else { const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/desktop/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device_name: 'Browser development preview' }) }); if (!response.ok) throw new Error('Login failed: check your email and password'); setBrowserToken((await response.json() as { access_token: string }).access_token) }; setConnection('connected') } catch (error) { setConnection('authentication_required'); setLoginError(String(error)) } }
  const googleLogin = async (idToken: string, accountName?: string) => { try { setLoginError(''); setGoogleLoading(true); if (hasNativeHost) await invoke('desktop_google_login', { baseUrl: serverUrl, accountName: accountName ?? null }); else { const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/desktop/google-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: idToken, account_name: accountName ?? null, device_name: 'Browser development preview' }) }); if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.detail || `Google login failed (${response.status})`) } setBrowserToken((await response.json() as { access_token: string }).access_token) }; setPendingGoogleToken(null); setGoogleAccountName(''); setConnection('connected') } catch (error) { const message = String(error); if (!accountName && message.includes('account_name')) setPendingGoogleToken(hasNativeHost ? 'native-google-token' : idToken); else setLoginError(message) } finally { setGoogleLoading(false) } }
  const beginGoogleLogin = () => { setLoginError(''); if (hasNativeHost) { void googleLogin('native-google-login') } else { window.google?.accounts.id.prompt(notification => { if (notification.isNotDisplayed()) setLoginError('Google Sign-In popup was blocked or this browser origin is not allowed.') }) } }
  useEffect(() => {
    if (props.selectedId !== activeScreenId && !props.assignedId) return
    let cancelled = false
    const initialize = () => {
      if (!window.google) return false
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (response: { credential: string }) => { void googleLogin(response.credential) }, auto_select: false })
      if (!cancelled) setGoogleReady(true)
      return true
    }
    if (initialize()) return () => { cancelled = true; window.google?.accounts.id.cancel() }
    const timer = window.setInterval(() => { if (initialize()) window.clearInterval(timer) }, 250)
    return () => { cancelled = true; window.clearInterval(timer); window.google?.accounts.id.cancel() }
  }, [serverUrl, hasNativeHost, props.selectedId])

  useEffect(() => { if (connection === 'connected') void api<Catalogue>('catalogue').then(value => setCatalogue(value.instruments)).catch(() => undefined) }, [browserToken, connection, serverUrl])
  const chartSettingsLoadedFor = useRef('')
  useEffect(() => {
    if (connection !== 'connected') {
      if (connection === 'offline' || connection === 'authentication_required') chartSettingsLoadedFor.current = ''
      return
    }
    const identity = `${serverUrl}:${browserToken}`
    if (chartSettingsLoadedFor.current === identity) return
    chartSettingsLoadedFor.current = identity
    if (hasNativeHost) void invoke<{ settings: Partial<ChartSettings> }>('desktop_chart_settings', { baseUrl: serverUrl }).then(value => setChartSettings({ ...defaultChartSettings, ...value.settings })).catch(() => { chartSettingsLoadedFor.current = '' })
    else void fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/chart-settings`, { headers: { Authorization: `Bearer ${browserToken}` } }).then(response => response.ok ? response.json() as Promise<{ settings: Partial<ChartSettings> }> : Promise.reject()).then(value => setChartSettings({ ...defaultChartSettings, ...value.settings })).catch(() => { chartSettingsLoadedFor.current = '' })
  }, [browserToken, connection, serverUrl, hasNativeHost])
  const activeScreen = screens.find(screen => screen.id === activeScreenId) ?? screens[0], pickerTile = activeScreen.tiles.find(tile => tile.id === pickerTileId)
  const activeToolTile = activeScreen.tiles.some(tile => tile.id === activeToolTileId) ? activeToolTileId : activeScreen.tiles[0]?.id
  const activeTileIdentity = JSON.stringify(activeScreen.tiles.find(tile => tile.id === activeToolTile))
  useEffect(() => { setPricePickAction(null) }, [trading?.session.session_id, activeToolTile, activeTileIdentity, mode])

  useEffect(() => {
    if (connection !== 'connected' || !props.loaded || !restoredReady || !activeScreen || !childReady || handingOff) return
    const payloadKey = JSON.stringify({ id: activeScreen.id, name: activeScreen.name, state: screenState(activeScreen), order: screens.findIndex(screen => screen.id === activeScreen.id) })
    if (payloadKey === lastScreenPayloadRef.current) return
    if (screenSaveTimerRef.current) window.clearTimeout(screenSaveTimerRef.current)
    screenSaveTimerRef.current = window.setTimeout(() => {
      lastScreenPayloadRef.current = payloadKey
      void persistCurrentScreen().catch(error => { lastScreenPayloadRef.current = ''; setReplayError(`Screen save failed: ${String(error)}`) })
    }, 700)
    return () => { if (screenSaveTimerRef.current) window.clearTimeout(screenSaveTimerRef.current) }
  }, [screens, activeScreenId, tileIndicators, activeToolTile, connection, browserToken, serverUrl, mode, live?.stream_id, trading?.session.session_id, replay?.run_id, runDate, runStartTime, replaySpeed, sharedTradingSession, props.loaded, restoredReady, liveEnabled, childReady, handingOff])
  useEffect(() => { if (activeToolTile && activeToolTile !== activeToolTileId) setActiveToolTileId(activeToolTile) }, [activeToolTile, activeToolTileId])
  const selectedIndicators = tileIndicators[activeToolTile] ?? []
  const toggleIndicator = (name: string) => setTileIndicators(current => ({ ...current, [activeToolTile]: (current[activeToolTile] ?? []).includes(name) ? (current[activeToolTile] ?? []).filter(item => item !== name) : [...(current[activeToolTile] ?? []), name] }))
  const clearIndicators = () => setTileIndicators(current => ({ ...current, [activeToolTile]: [] }))
  const sendDrawing = (tool: string) => { setActiveDrawingTool(tool); setDrawingCommand(command => ({ id: (command?.id ?? 0) + 1, tool })) }
  const sendDrawingAction = (action: DrawingAction['action']) => setDrawingAction(command => ({ id: (command?.id ?? 0) + 1, action }))
  const onDrawingComplete = (commandId: number, tool: string) => {
    if (!shouldConsumeDrawingCommand(drawingMode, drawingCommand, commandId, tool)) return
    setActiveDrawingTool(null)
    setDrawingCommand(null)
  }
  const onLiveTick = (key: string, tick: Candle) => {
    if (hasNativeHost && live?.stream_id) {
      void invoke('record_desktop_live_tick', {
        streamId: live.stream_id,
        instrumentKey: key,
        tick,
      }).catch(error => recordRendererDiagnostic('live_tick_persist_error', {
        instrument_key: key,
        live_stream_id: live.stream_id,
        live_event_id: live.event_id,
        error: String(error),
      }))
    }
    recordRendererDiagnostic('live_tick_received', {
      instrument_key: key,
      tick,
      live_stream_id: live?.stream_id,
      live_event_id: live?.event_id,
    })
    setLiveTickCache(current => ({ ...current, [key]: appendLiveTick(current[key] ?? [], tick) }))
  }
  const layoutTileCount: Record<Layout, number> = { '1': 1, '2-side': 2, '2-stacked': 2, '3-wide-top': 3, '4-grid': 4, '4-one-three': 4, '5-equal': 5, '5-wide-right': 5 }
  const setLayout = (layout: Layout) => setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, layout, tiles: layoutTileCount[layout] > screen.tiles.length ? [...screen.tiles, ...Array.from({ length: layoutTileCount[layout] - screen.tiles.length }, newTile)] : screen.tiles.slice(0, layoutTileCount[layout]) } : screen))
  const swapTiles = useCallback((indexA: number, indexB: number) => {
    setScreens(current => current.map(screen => {
      if (screen.id !== activeScreenId || indexA < 0 || indexB < 0 || indexA >= screen.tiles.length || indexB >= screen.tiles.length || indexA === indexB) return screen
      const tiles = [...screen.tiles]
      ;[tiles[indexA], tiles[indexB]] = [tiles[indexB], tiles[indexA]]
      return { ...screen, tiles }
    }))
  }, [activeScreenId])
  const saveTile = async (tile: TileConfig) => {
    if (isTradingMode(mode) && trading) {
      if (tile.symbol !== trading.session.symbol) {
        reportTradingError(`This ${mode} session is locked to ${trading.session.symbol}. Open another screen to view or trade ${tile.symbol}.`)
        return
      }
      if (tile.kind === 'option') {
        try {
          const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/contracts`, 'POST', { symbol: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right })
          setTrading(snapshot)
          clearTradingError()
        } catch (error) {
          reportTradingError(error)
          return
        }
      }
    }
    setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(item => item.id === tile.id ? tile : item) } : screen))
    setPickerTileId(null)
  }
  const addScreen = () => { const next = newScreen(screens.length + 1); setScreens(current => [...current, next]); setActiveScreenId(next.id) }
  const renameScreen = () => { const name = window.prompt('Screen name', activeScreen.name)?.trim(); if (name) setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, name } : screen)) }
  const duplicateScreen = () => { const mapped = activeScreen.tiles.map(tile => ({ from: tile.id, tile: { ...tile, id: crypto.randomUUID() } })); const next: Screen = { ...activeScreen, id: crypto.randomUUID(), persistedId: undefined, revision: undefined, saved: { mode: 'Browse' }, name: `${activeScreen.name} Copy`, tiles: mapped.map(item => item.tile) }; setTileIndicators(current => ({ ...current, ...Object.fromEntries(mapped.map(item => [item.tile.id, current[item.from] ?? []])) })); setScreens(current => [...current, next]); setActiveScreenId(next.id); setActiveToolTileId(next.tiles[0]?.id ?? '') }
  const moveScreen = (direction: -1 | 1) => setScreens(current => { const index = current.findIndex(screen => screen.id === activeScreenId); const target = index + direction; if (index < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next })
  const closeScreen = async () => {
    if (screens.length <= 1) return
    if (trading) { if (mode === 'Paper') { if (!await stopPaper()) return } else await replayAction('stop', true) }
    if (live) await stopLive()
    const closing = activeScreen
    setScreens(current => current.filter(screen => screen.id !== closing.id))
    const next = screens.find(screen => screen.id !== closing.id)
    if (next) setActiveScreenId(next.id)
    if (closing.persistedId) void desktopRecordRequest(`screens/${closing.persistedId}`, 'DELETE').catch(() => undefined)
  }
  const saveChartSettings = async (settings: ChartSettings) => {
    await desktopRecordRequest('chart-settings', 'PUT', { settings })
    setChartSettings(settings)
  }

  const replayRequest = async <T = ReplaySnapshot,>(path: string, method: 'GET' | 'POST' | 'PUT', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_replay_request', { baseUrl: serverUrl, path, method, body, screenId: activeScreenId })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/replay/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Replay request failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`)
    }
    return response.json() as Promise<T>
  }
  const liveRequest = async (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<LiveSnapshot> => { if (hasNativeHost) return invoke<LiveSnapshot>('desktop_live_request', { baseUrl: serverUrl, path, method, body, screenId: activeScreenId }); const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/live/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`Live request failed (${response.status})`); return response.json() as Promise<LiveSnapshot> }
  const desktopRecordRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_drawing_request', { baseUrl: serverUrl, path, method, body, screenId: activeScreenId })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) throw new Error(`Desktop record request failed (${response.status})`)
    return (response.status === 204 ? null : await response.json()) as T
  }
  const drawingRequest = useCallback((path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}) => desktopRecordRequest(path, method, body), [activeScreenId, browserToken, hasNativeHost, serverUrl])
  const reportDrawingError = useCallback((error: unknown) => setDrawingError(`Drawing sync failed: ${String(error)}`), [])
  const rawDesktopTradingRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_drawing_request', { baseUrl: serverUrl, path: `trading/${path}`, method, body, screenId: activeScreenId })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/trading/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Trading request failed (${response.status})${detail ? `: ${detail.slice(0, 220)}` : ''}`)
    }
    return (response.status === 204 ? null : await response.json()) as T
  }
  const tradingRefreshKey = (sessionId: string) => `${serverUrl}:${browserToken}:${sessionId}`
  const desktopTradingRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'GET' && /^[^/]+\/snapshot$/.test(path)) {
      return tradingRefreshRef.current.request(tradingRefreshKey(path.split('/')[0]), () => rawDesktopTradingRequest<T>(path, method, body))
    }
    const result = await rawDesktopTradingRequest<T>(path, method, body)
    if (isDesktopTradingSnapshot(result)) tradingRefreshRef.current.mark(tradingRefreshKey(result.session.session_id))
    return result
  }
  const loadPreStartWallet = async (date: string) => {
    const wallet = await desktopTradingRequest<{ balance: number; locked?: boolean }>(`wallet?date=${encodeURIComponent(date)}&desktop_mode=${encodeURIComponent(mode.toLowerCase())}`, 'GET')
    setPreStartWallet(wallet.balance)
    setWalletLocked(Boolean(wallet.locked))
  }
  const loadLabelMetadata = async () => {
    const requestId = ++labelMetadataRequestIdRef.current
    setLabelMetadataStatus('loading')
    setLabelMetadataError('')
    try {
      const value = await desktopTradingRequest<DesktopLabelMetadata>('trade-labels/metadata', 'GET')
      if (requestId !== labelMetadataRequestIdRef.current) return
      setLabelMetadata({
        categories: Array.isArray(value.categories) ? value.categories : [],
        strategies: Array.isArray(value.strategies) ? value.strategies : [],
        entry_tags: Array.isArray(value.entry_tags) ? value.entry_tags : [],
        exit_tags: Array.isArray(value.exit_tags) ? value.exit_tags : [],
      })
      setLabelMetadataStatus('ready')
    } catch (error) {
      if (requestId !== labelMetadataRequestIdRef.current) return
      setLabelMetadataStatus('error')
      setLabelMetadataError(String(error))
    }
  }
  useEffect(() => {
    if (!isTradingMode(mode) || !trading?.session.session_id) {
      setTradeLabelState(null)
      return
    }
    let cancelled = false
    void desktopTradingRequest<DesktopTradeLabelState>(`${trading.session.session_id}/trade-labels`, 'GET')
      .then(state => { if (!cancelled) setTradeLabelState(state) })
      .catch(error => { if (!cancelled) console.warn('desktop label state unavailable', error) })
    return () => { cancelled = true }
  }, [mode, trading?.session.session_id, trading?.trades.length])
  useEffect(() => {
    if (!isTradingMode(mode) || !trading?.session.session_id) {
      labelMetadataRequestIdRef.current += 1
      setLabelMetadata(emptyLabelMetadata)
      setLabelMetadataStatus('idle')
      setLabelMetadataError('')
      return
    }
    void loadLabelMetadata()
  }, [mode, trading?.session.session_id])
  const screenState = (screen: Screen): PersistedScreenState => ({ id: screen.id, layout: screen.layout, tiles: screen.tiles, indicators: tileIndicators, activeToolTileId: activeToolTile, mode, live_enabled: liveEnabled, live_stream_id: live?.stream_id, session_id: trading?.session.session_id, run_id: replay?.state !== 'stopped' ? replay?.run_id : undefined, owned: Boolean(trading && !sharedTradingSession), run_date: runDate, start_time: runStartTime, speed: replaySpeed })
  const normalizeScreen = (record: DesktopScreenRecord): Screen => ({ id: record.state?.id ?? record.screen_id, persistedId: record.screen_id, revision: record.revision, name: record.name, saved: record.state, layout: record.state?.layout ?? '1', tiles: record.state?.tiles?.length ? record.state.tiles : [newTile()] })
  const persistCurrentScreen = () => {
    const state = screenState(activeScreen)
    const name = activeScreen.name
    const mutationId = crypto.randomUUID()
    const recoveryKey = journalKey(serverUrl, activeScreenId)
    localStorage.setItem(recoveryKey, JSON.stringify({ state, revision: persistedScreenRef.current.revision, mutationId }))
    const order = screens.findIndex(screen => screen.id === activeScreenId)
    const save = screenSaveQueueRef.current.catch(() => undefined).then(async () => {
      const current = persistedScreenRef.current
      const body = { name, state, order, mutation_id: mutationId, revision: current.revision }
      const record = await desktopRecordRequest<DesktopScreenRecord>(current.id ? `screens/${current.id}` : 'screens', current.id ? 'PUT' : 'POST', body)
      persistedScreenRef.current = { id: record.screen_id, revision: record.revision }
      try { if (JSON.parse(localStorage.getItem(recoveryKey) ?? 'null')?.mutationId === mutationId) localStorage.removeItem(recoveryKey) } catch { /* keep recovery record */ }
      setScreens(items => items.map(screen => screen.id === activeScreenId ? { ...screen, persistedId: record.screen_id, revision: record.revision, saved: record.state } : screen))
      return record
    })
    screenSaveQueueRef.current = save
    return save
  }
  useEffect(() => {
    props.registerSave(activeScreenId, props.loaded && restoredReady ? persistCurrentScreen : null)
    return () => props.registerSave(activeScreenId, null)
  })
  useEffect(() => {
    if (!props.loaded || connection !== 'connected' || restoredReady || !initial) return
    let cancelled = false
    const restore = async () => {
      const records = await desktopRecordRequest<{ screens: DesktopScreenRecord[] }>('screens', 'GET')
      const record = records.screens.find(item => item.screen_id === activeScreen.persistedId || item.state.id === activeScreenId)
      if (cancelled) return
      if (!record) { setReplayError('Saved screen is unavailable'); setRestoredReady(true); return }
      let recovery: RecoveryJournal<PersistedScreenState> | null = null
      try { recovery = JSON.parse(localStorage.getItem(journalKey(serverUrl, activeScreenId)) ?? 'null') } catch { /* ignore invalid journal */ }
      const saved = recoverState(record.state, record.revision, recovery)
      if (recovery && recovery.revision !== record.revision) setReplayError('Newer saved screen found; unsaved recovery copy retained locally.')
      persistedScreenRef.current = { id: record.screen_id, revision: record.revision }
      setScreens(items => items.map(screen => screen.id === activeScreenId ? normalizeScreen({ ...record, state: saved }) : screen))
      setMode(saved.mode ?? 'Browse')
      setRunDate(saved.run_date ?? record.state.tiles?.[0]?.tradingDate ?? paperMarketDate())
      setRunStartTime(saved.start_time ?? '09:15')
      setReplaySpeed(saved.speed ?? '1')
      setTileIndicators(saved.indicators ?? {})
      setActiveToolTileId(saved.activeToolTileId ?? record.state.tiles?.[0]?.id ?? '')
      if (saved.session_id) {
        try {
          const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${saved.session_id}/snapshot`, 'GET')
          if (!cancelled) { setTrading(snapshot); setSharedTradingSession(snapshot.source === 'desktop_paper' ? !snapshot.owned : !saved.owned || !snapshot.owned) }
        } catch (error) { if (!cancelled) { reportTradingError(`Session needs reattachment: ${String(error)}`); if (props.assignedId) setHandoffError(String(error)) } }
      }
      if (saved.run_id) {
        try {
          const snapshot = await replayRequest(`${saved.run_id}/snapshot`, 'GET')
          if (!cancelled) setReplay(snapshot)
          if (!cancelled) await startNativeStream(`replay:${activeScreenId}:${saved.run_id}`, `replay/${saved.run_id}/events`, `replay/${saved.run_id}/snapshot`)
        } catch (error) { if (!cancelled) { setReplayError(`Replay needs restart: ${String(error)}`); if (props.assignedId) setHandoffError(String(error)) } }
      }
      if (saved.live_enabled && (saved.mode === 'Browse' || saved.mode === 'Paper') && saved.tiles?.every(tile => tile.tradingDate === paperMarketDate())) {
        try {
          let snapshot: LiveSnapshot
          try { snapshot = saved.live_stream_id ? await liveRequest(`${saved.live_stream_id}/snapshot`, 'GET') : await liveRequest('start', 'POST', { tiles: saved.tiles.map(liveTile) }) }
          catch (error) { if (props.assignedId || !String(error).includes('(404)')) throw error; snapshot = await liveRequest('start', 'POST', { tiles: saved.tiles.map(liveTile) }) }
          if (!cancelled) {
            const ticks: Record<string, Candle[]> = {}
            for (const tile of snapshot.tiles) {
              const instrumentKey = canonicalKey(tile.instrument)
              const persisted = hasNativeHost ? await invoke<Candle[]>('desktop_live_ticks', { streamId: snapshot.stream_id, instrumentKey, sinceTimestamp: null }) : []
              ticks[instrumentKey] = reconcileLiveTicks(persisted, tile.current_date_seconds ?? [])
            }
            if (!cancelled) { setLiveTickCache(ticks); setLiveSnapshot(snapshot) }
          }
          if (!cancelled) await startNativeStream(`browse-live:${activeScreenId}:${snapshot.stream_id}`, `live/${snapshot.stream_id}/events`, `live/${snapshot.stream_id}/snapshot`)
        } catch (error) { if (!cancelled) { reportLiveError(`Live stream needs restart: ${String(error)}`); if (props.assignedId) setHandoffError(String(error)) } }
      }
      if (!cancelled) setRestoredReady(true)
    }
    void restore().catch(error => { if (!cancelled) { reportTradingError(error); setRestoredReady(true); setHandoffError(String(error)) } })
    return () => { cancelled = true }
  }, [props.loaded, connection, restoredReady])
  const startNativeStream = async (key: string, eventsPath: string, snapshotPath: string) => {
    if (!hasNativeHost || (props.assignedId && !childReady)) return
    await invoke('start_desktop_stream', { baseUrl: serverUrl, key, eventsPath, snapshotPath })
  }
  useEffect(() => {
    if (!props.assignedId || !props.loaded || !restoredReady || connection !== 'connected' || childReady || handoffFailed) return
    const token = new URLSearchParams(window.location.search).get('handoff_token')
    if (!token) { setHandoffError('Missing handoff identity; return to the main window.'); return }
    let cancelled = false
    void invoke('ready_screen_window', { screenId: props.assignedId, handoffToken: token }).then(() => { if (!cancelled) setChildReady(true) }).catch(error => setHandoffError(String(error)))
    return () => { cancelled = true }
  }, [props.assignedId, props.loaded, restoredReady, connection, childReady, handoffError])
  useEffect(() => {
    if (!props.assignedId || !childReady) return
    if (live) void startNativeStream(`browse-live:${activeScreenId}:${live.stream_id}`, `live/${live.stream_id}/events`, `live/${live.stream_id}/snapshot`).catch(reportLiveError)
    if (replay) void startNativeStream(`replay:${activeScreenId}:${replay.run_id}`, `replay/${replay.run_id}/events`, `replay/${replay.run_id}/snapshot`).catch(reportTradingError)
  }, [childReady])
  const stopNativeStream = (key: string) => {
    if (hasNativeHost) void invoke('stop_desktop_stream', { key })
  }
  useEffect(() => {
    if (connection === 'authentication_required') {
      authenticatedRef.current = false
      if (live) stopNativeStream(`browse-live:${activeScreenId}:${live.stream_id}`)
      if (replay) stopNativeStream(`replay:${activeScreenId}:${replay.run_id}`)
      if (trading?.session.session_id) stopNativeStream(`paper:${activeScreenId}:${trading.session.session_id}`)
    } else if (connection === 'connected' && !authenticatedRef.current) {
      authenticatedRef.current = true
      if (live) void startNativeStream(`browse-live:${activeScreenId}:${live.stream_id}`, `live/${live.stream_id}/events`, `live/${live.stream_id}/snapshot`).catch(reportLiveError)
      if (replay) void startNativeStream(`replay:${activeScreenId}:${replay.run_id}`, `replay/${replay.run_id}/events`, `replay/${replay.run_id}/snapshot`).catch(reportTradingError)
      if (trading?.session.session_id) {
        const key = `paper:${activeScreenId}:${trading.session.session_id}`
        delete tradingStreamEventRef.current[key]
        tradingSnapshotRequiredRef.current[key] = true
      }
    }
  }, [connection])
  const readNativeStream = async <T,>(key: string): Promise<T | null> => {
    if (!hasNativeHost) return null
    const snapshot = await readNativeStreamState<T>(key)
    return snapshot?.latest_payload ?? null
  }
  const readNativeStreamState = async <T,>(key: string): Promise<DesktopStreamSnapshot<T> | null> => {
    if (!hasNativeHost || (props.assignedId && !childReady)) return null
    const snapshot = await invoke<DesktopStreamSnapshot<T>>('desktop_stream_snapshot', { key })
    if (snapshot.connection === 'authentication_required') {
      setConnection('authentication_required')
      setLoginError('Desktop session expired; please sign in again.')
      return null
    }
    // A single chart or trading feed can reconnect while the API remains healthy.
    // Only the API capability probe owns the app-wide connection state.
    return snapshot
  }
  const applyLiveStreamPayload = (payload: unknown) => updateLiveSnapshot(current => applyLiveStreamPayloadToSnapshot(current, payload))
  const liveTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument, interval_minutes: Number(tile.interval) } }
    const startLive = async (tilesOverride?: TileConfig[], keepTickCache = false) => { try { const tiles = tilesOverride ?? activeScreen.tiles; if (tiles.some(tile => tile.tradingDate !== paperMarketDate())) throw new Error('Live data requires today’s market date for every tile'); clearLiveError(); if (!keepTickCache) clearLiveTickCache(); const next = await liveRequest('start', 'POST', { tiles: tiles.map(liveTile) }); setLiveEnabled(true); setLiveSnapshot(next); if (keepTickCache && hasNativeHost) await Promise.all(Object.entries(liveTickCache).map(([instrumentKey, ticks]) => invoke('record_desktop_live_ticks', { streamId: next.stream_id, instrumentKey, ticks }).catch(error => recordRendererDiagnostic('live_tick_reconcile_persist_error', { instrument_key: instrumentKey, live_stream_id: next.stream_id, error: String(error) })))); await startNativeStream(`browse-live:${activeScreenId}:${next.stream_id}`, `live/${next.stream_id}/events`, `live/${next.stream_id}/snapshot`) } catch (error) { reportLiveError(error) } }
  const stopLive = async () => { if (!live) return; const streamId = live.stream_id; try { await liveRequest(`${streamId}/stop`, 'POST') } catch (error) { if (!isMissingLiveStream(error)) { reportLiveError(error); return } } stopNativeStream(`browse-live:${activeScreenId}:${streamId}`); setLiveEnabled(false); setLiveSnapshot(null); clearLiveTickCache(streamId) }
  const refreshLive = async () => {
    if (!live) return
    try {
      clearLiveError()
      const refreshed = await liveRequest(`${live.stream_id}/refresh`, 'POST')
      const reconciledByInstrument: Record<string, Candle[]> = {}
      for (const tile of refreshed.tiles) {
        if (!tile.instrument) continue
        const instrumentKey = canonicalKey(tile.instrument)
        let localTicks = liveTickCache[instrumentKey] ?? []
        if (hasNativeHost) {
          try {
            const persisted = await invoke<Candle[]>('desktop_live_ticks', {
              streamId: refreshed.stream_id,
              instrumentKey,
              sinceTimestamp: null,
            })
            localTicks = reconcileLiveTicks(persisted, localTicks)
          } catch (error) {
            recordRendererDiagnostic('live_tick_restore_error', { instrument_key: instrumentKey, live_stream_id: refreshed.stream_id, error: String(error) })
          }
        }
        const reconciled = reconcileLiveTicks(localTicks, tile.current_date_seconds ?? [])
        reconciledByInstrument[instrumentKey] = reconciled
        if (hasNativeHost && reconciled.length) {
          try {
            await invoke('record_desktop_live_ticks', { streamId: refreshed.stream_id, instrumentKey, ticks: reconciled })
          } catch (error) {
            recordRendererDiagnostic('live_tick_reconcile_persist_error', { instrument_key: instrumentKey, live_stream_id: refreshed.stream_id, error: String(error) })
          }
        }
      }
      setLiveTickCache(current => ({ ...current, ...reconciledByInstrument }))
      setLiveSnapshot(refreshed)
    } catch (error) {
      reportLiveError(error)
    }
  }
  useEffect(() => {
    if ((mode !== 'Browse' && mode !== 'Paper') || !live || !childReady || handingOff) return
    let cancelled = false
    const sync = async () => {
      try {
        let snapshot = live
        const desired = activeScreen.tiles.map(liveTile)
        const desiredIds = new Set(desired.map(tile => tile.tile_id))
        for (const existing of snapshot.tiles) {
          if (!desiredIds.has(existing.tile_id)) {
            snapshot = await liveRequest(`${snapshot.stream_id}/tiles/${encodeURIComponent(existing.tile_id)}`, 'DELETE')
          }
        }
        for (const tile of desired) {
          const existing = snapshot.tiles.find(item => item.tile_id === tile.tile_id)
          const same = existing && JSON.stringify({ instrument: existing.instrument, interval_minutes: existing.interval_minutes }) === JSON.stringify({ instrument: tile.instrument, interval_minutes: tile.interval_minutes })
          if (!same) {
            snapshot = await liveRequest(`${snapshot.stream_id}/tiles/${encodeURIComponent(tile.tile_id)}`, 'PUT', { tile })
          }
        }
        if (!cancelled) setLiveSnapshot(snapshot)
      } catch (error) {
        if (!cancelled) reportLiveError(error)
      }
    }
    void sync()
    return () => { cancelled = true }
  }, [mode, live?.stream_id, activeScreen.id, activeScreen.tiles, childReady, handingOff])
  useEffect(() => {
    if (!live || connection === 'authentication_required') return
    let cancelled = false
    let inFlight = false
    let lastHealthCheck = 0
    let lastProviderRetry = 0
    const timer = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      if (hasNativeHost) {
        void readNativeStreamState<unknown>(`browse-live:${activeScreenId}:${live.stream_id}`)
          .then(async stream => {
            if (cancelled) return
            if (stream?.connection === 'connected') applyLiveStreamPayload(stream.latest_payload)
            if (Date.now() - lastHealthCheck < 15_000 || connection !== 'connected') return
            lastHealthCheck = Date.now()
            try {
              let snapshot = await liveRequest(`${live.stream_id}/snapshot`, 'GET')
              if (snapshot.tiles.some(tile => tile.availability === 'provider_error') && Date.now() - lastProviderRetry >= 30_000) {
                lastProviderRetry = Date.now()
                snapshot = await liveRequest(`${live.stream_id}/refresh`, 'POST')
              }
              if (!cancelled) {
                setLive(current => current?.stream_id === snapshot.stream_id && current.event_id > snapshot.event_id ? current : snapshot)
                clearLiveError()
              }
            } catch (error) {
              if (cancelled) return
              if (isMissingLiveStream(error)) {
                stopNativeStream(`browse-live:${activeScreenId}:${live.stream_id}`)
                await startLive(undefined, true)
              } else reportLiveError(error)
            }
          })
          .catch(error => { if (!cancelled) reportLiveError(error) })
          .finally(() => { inFlight = false })
      } else {
        void liveRequest(`${live.stream_id}/snapshot`, 'GET').then(async current => {
          let snapshot = current
          if (current.tiles.some(tile => tile.availability === 'provider_error') && Date.now() - lastProviderRetry >= 30_000) {
            lastProviderRetry = Date.now()
            snapshot = await liveRequest(`${live.stream_id}/refresh`, 'POST')
          }
          if (!cancelled) setLiveSnapshot(snapshot)
        }).catch(error => {
          if (cancelled) return
          if (isMissingLiveStream(error)) void startLive(undefined, true)
          else reportLiveError(error)
        }).finally(() => { inFlight = false })
      }
    }, 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [live?.stream_id, hasNativeHost, serverUrl, reportLiveError, connection])
  useEffect(() => { if (connection === 'authentication_required') clearLiveTickCache() }, [connection])
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if ((mode !== 'Browse' && mode !== 'Paper') || !live || (!props.assignedId && props.selectedId !== activeScreenId)) return; if (event.key === 'F5') { event.preventDefault(); void refreshLive() } }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown) }, [live?.stream_id, mode, props.selectedId])
  const tradingStartBody = (date: string) => {
    const tile = activeScreen.tiles.find(item => item.id === activeToolTile) ?? activeScreen.tiles[0]
    const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]
    const startTime = `${runStartTime}:00`
    const backendInterval = Math.min(...activeScreen.tiles.map(item => Number(item.interval))) * 60
    return {
      symbol: tile.symbol,
      date,
      start_time: startTime,
      speed: mode === 'Replay' ? Number(replaySpeed) : 1,
      instrument_type: (item.chart_type === 'index' || tile.kind === 'option') ? 'options' : 'equity',
      strategy_interval_secs: backendInterval,
      session_type: mode === 'Paper' ? 'paper' : mode === 'Replay' ? 'sim' : 'stepwise',
      stepwise: mode === 'Stepwise',
      desktop_mode: mode.toLowerCase(),
      override: false,
      resume_bar_index: null as number | null,
    }
  }
  const startRun = async () => {
    if (historicalStarting || (trading && trading.session.state !== 'ended')) return
    setHistoricalStarting(true)
    try {
      setReplayError('')
      clearTradingError()
      const date = mode === 'Paper' ? paperMarketDate() : runDate
      if (mode === 'Paper') { setRunDate(date); setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(tile => ({ ...tile, tradingDate: date })) } : screen)) }
      setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(tile => ({ ...tile, tradingDate: date })) } : screen))
      const tiles = activeScreen.tiles.map(tile => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument, interval_minutes: Number(tile.interval) } })
      const backendInterval = Math.min(...activeScreen.tiles.map(tile => Number(tile.interval)))
      const startBody = isTradingMode(mode) ? tradingStartBody(date) : null
      let attached: DesktopTradingSnapshot | null = null
      let resumeSessionId: string | null = null
      let replayStartTime = `${runStartTime}:00`
      let initialBarIndex: number | undefined
      if (startBody) {
        const candidateParams = new URLSearchParams({ symbol: String(startBody.symbol), date, instrument_type: String(startBody.instrument_type), desktop_mode: mode.toLowerCase() })
        const candidate = await desktopTradingRequest<DesktopTradingCandidate>(`candidate?${candidateParams}`, 'GET')
        if (candidate.status === 'active' && candidate.active) {
          if (window.confirm(`Attach this screen to the active ${candidate.active.session.symbol} ${mode} session? Its orders, positions, wallet, and clock will remain shared.`)) {
            attached = candidate.active
          } else {
            return
          }
        } else if (mode === 'Paper' && candidate.status === 'remote' && candidate.stopped) {
          setTrading(candidate.stopped)
          setTradingNotice('Paper engine is running on another backend worker. You can view its saved history or press Stop here.')
          return
        } else if (mode === 'Paper' && candidate.status === 'stopped' && candidate.stopped && candidate.existing_session_id) {
          setTrading(candidate.stopped)
          if (candidate.stopped.paper_status === 'settled' || date !== paperMarketDate() || paperMarketTime() >= '15:09:00') {
            setTradingNotice('Paper session is closed for trading. Its saved positions and history remain available.')
            return
          }
          if (!window.confirm(`Resume Paper session ${candidate.existing_session_id} with its saved positions and history?`)) return
          resumeSessionId = candidate.existing_session_id
        } else if (candidate.status === 'checkpoint' && candidate.checkpoint?.current_time) {
          const checkpointTime = new Date(candidate.checkpoint.current_time * 1000).toISOString().slice(11, 19)
          const selectedCursor = Math.floor(new Date(`${date}T${runStartTime}:00Z`).getTime() / 1000)
          const useSelectedTime = selectedCursor > candidate.checkpoint.current_time
          const keepTime = useSelectedTime ? `${runStartTime}:00` : checkpointTime
          if (window.confirm(`A previous ${mode} run exists. Keep its history visible and start again from ${keepTime}?`)) {
            startBody.start_time = keepTime
            replayStartTime = keepTime
            if (!useSelectedTime) {
              initialBarIndex = candidate.checkpoint.current_bar_index
              startBody.resume_bar_index = candidate.checkpoint.current_bar_index
            }
          } else if (window.confirm('Delete the previous matching run data and start clean from the selected time?')) {
            startBody.override = true
          } else {
            return
          }
        } else if (candidate.status === 'existing') {
          if (window.confirm(`A previous ${mode} run exists. Keep its history visible and start another clean run from the selected time?`)) {
            // Keep startBody unchanged; backend preserves previous records.
          } else if (window.confirm('Delete the previous matching run data and start clean?')) {
            startBody.override = true
          } else {
            return
          }
        }
      }
      let tradeSnapshot: DesktopTradingSnapshot | null = attached
      if (startBody && !tradeSnapshot) {
        tradeSnapshot = resumeSessionId
          ? await desktopTradingRequest<DesktopTradingSnapshot>(`${resumeSessionId}/resume`, 'POST')
          : await desktopTradingRequest<DesktopTradingSnapshot>('start', 'POST', startBody)
      }
      if (mode === 'Paper') {
        if (!live) await startLive(activeScreen.tiles.map(tile => ({ ...tile, tradingDate: date })))
        if (tradeSnapshot?.session.session_id) {
          delete tradingSnapshotRequiredRef.current[`paper:${activeScreenId}:${tradeSnapshot.session.session_id}`]
        }
      } else {
        const attachedStartTime = attached?.current_time ? new Date(attached.current_time * 1000).toISOString().slice(11, 19) : replayStartTime
        const initialCursor = tradeSnapshot && tradeSnapshot.current_time > 0 ? tradeSnapshot.current_time : undefined
        const next = await replayRequest('start', 'POST', { mode: mode.toLowerCase(), date, start_time: attachedStartTime, ...(initialCursor !== undefined ? { initial_cursor: initialCursor } : {}), initial_bar_index: tradeSnapshot?.current_bar_index ?? initialBarIndex, interval_seconds: backendInterval * 60, speed: Number(replaySpeed), trading_session_id: tradeSnapshot?.session.session_id, owns_trading_session: Boolean(startBody && tradeSnapshot && !attached), tiles })
        setReplay(next)
        await startNativeStream(`replay:${activeScreenId}:${next.run_id}`, `replay/${next.run_id}/events`, `replay/${next.run_id}/snapshot`)
      }
      if (startBody && tradeSnapshot) {
        if (attached) {
          setSharedTradingSession(true)
          setTradingNotice(`Attached to shared ${mode} session ${attached.session.session_id.slice(0, 8)}.`)
        } else {
          setSharedTradingSession(false)
        }
        setTrading(tradeSnapshot)
        setPreStartWallet(tradeSnapshot.wallet_balance)
        for (const tile of activeScreen.tiles) {
          if (tile.kind !== 'option' || tile.symbol !== tradeSnapshot.session.symbol || !tile.expiry || !tile.strike) continue
          try {
            tradeSnapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${tradeSnapshot.session.session_id}/contracts`, 'POST', { symbol: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right })
            setTrading(tradeSnapshot)
          } catch (error) {
            reportTradingError(error)
          }
        }
      }
    } catch (error) {
      setReplayError(String(error))
      if (isTradingMode(mode)) reportTradingError(error)
    } finally {
      setHistoricalStarting(false)
    }
  }
  const replayAction = async (action: string, throwOnError = false) => {
    if (!replay) return
    try {
      const tradingSessionId = trading?.session.session_id
      if (action === 'stop' && mode === 'Stepwise' && tradingSessionId && !sharedTradingSession) {
        await desktopTradingRequest(`${tradingSessionId}/stop`, 'POST')
      }
      if (action === 'next-bar' && mode === 'Stepwise' && tradingSessionId) {
        const combined = await replayRequest<{ replay: ReplaySnapshot; trading: DesktopTradingSnapshot }>(`${replay.run_id}/next-bar`, 'POST', { trading_session_id: tradingSessionId })
        setReplay(combined.replay)
        tradingRefreshRef.current.mark(tradingRefreshKey(combined.trading.session.session_id))
        setTrading(combined.trading)
        return
      }
      const next = await replayRequest(`${replay.run_id}/${action}`, 'POST')
      if (action === 'stop') { stopNativeStream(`replay:${activeScreenId}:${replay.run_id}`); setTrading(null); setSharedTradingSession(false); setTradeTicket(null); setPricePickAction(null); clearTradingError() }
      setReplay(next)
    } catch (error) { setReplayError(String(error)); if (isHistoricalTradingMode(mode)) reportTradingError(error); if (throwOnError) throw error }
  }
  const clearPaperSession = (sessionId: string) => {
    const key = `paper:${activeScreenId}:${sessionId}`
    stopNativeStream(key)
    delete tradingStreamEventRef.current[key]
    delete tradingSnapshotRequiredRef.current[key]
    setTrading(current => current?.session.session_id === sessionId ? null : current)
    setSharedTradingSession(false)
    setTradeTicket(null)
    setPricePickAction(null)
    setTradeHistoryOpen(false)
  }
  const stopPaper = async (): Promise<boolean> => {
    if (!trading?.session.session_id) return true
    const sessionId = trading.session.session_id
    let missingSession = false
    try {
      if (!sharedTradingSession) await desktopTradingRequest(`${sessionId}/stop`, 'POST',
        trading.engine_generation == null ? {} : { engine_generation: trading.engine_generation })
    } catch (error) {
      if (!isMissingSession(error)) { reportTradingError(error); return false }
      missingSession = true
    }
    stopNativeStream(`paper:${activeScreenId}:${sessionId}`)
    try {
      if (sharedTradingSession || missingSession) clearPaperSession(sessionId)
      else setTrading(await desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET'))
    } catch (error) {
      reportTradingError(error)
      return false
    }
    await stopLive()
    clearTradingError()
    setTradingNotice(sharedTradingSession ? 'Detached from Paper session.' : 'Paper session stopped.')
    return true
  }
  const updateReplaySpeed = (value: string) => { setReplaySpeed(value); if (replay && replay.mode === 'replay' && replay.state !== 'stopped') void replayRequest(`${replay.run_id}/speed`, 'POST', { speed: Number(value) }).then(setReplay).catch(error => setReplayError(String(error))) }
  const replayTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument, interval_minutes: Number(tile.interval) } }
  const switchMode = (value: DesktopMode) => {
    if (value === mode) return
    if ((trading && trading.session.state !== 'ended') || (replay && replay.state !== 'stopped') || historicalStarting) {
      setTradingNotice('Stop or detach the current run before changing mode.')
      return
    }
    if (trading?.session.session_id) {
      stopNativeStream(`paper:${activeScreenId}:${trading.session.session_id}`)
      delete tradingStreamEventRef.current[`paper:${activeScreenId}:${trading.session.session_id}`]
      delete tradingSnapshotRequiredRef.current[`paper:${activeScreenId}:${trading.session.session_id}`]
    }
    setTrading(null)
    setSharedTradingSession(false)
    setTradeTicket(null)
    setPricePickAction(null)
    if (!isHistoricalTradingMode(value) && replay) {
      stopNativeStream(`replay:${activeScreenId}:${replay.run_id}`)
      setReplay(null)
    }
    setMode(value)
    setRunDate(value === 'Paper' ? paperMarketDate() : activeScreen.tiles[0].tradingDate)
    setWalletOpen(false)
  }
  useEffect(() => {
    if (!isTradingMode(mode) || trading || historicalStarting || connection !== 'connected') return
    void loadPreStartWallet(runDate).catch(reportTradingError)
  }, [mode, runDate, trading?.session.session_id, historicalStarting, connection, serverUrl, browserToken])
  useEffect(() => {
    if (!replay || replay.state === 'stopped') return
    let cancelled = false
    void replayRequest(`${replay.run_id}/tiles`, 'PUT', { tiles: activeScreen.tiles.map(replayTile) }).then(next => { if (!cancelled) setReplay(next) }).catch(error => { if (!cancelled) setReplayError(String(error)) })
    return () => { cancelled = true }
  }, [replay?.run_id, replay?.state, activeScreen.id, activeScreen.tiles, catalogue])
  useEffect(() => {
    if (!replay || replay.state === 'stopped' || connection === 'authentication_required') return
    const runId = replay.run_id
    let cancelled = false
    const timer = window.setInterval(() => {
      if (replayPollInFlight.current) return
      replayPollInFlight.current = true
      const request = hasNativeHost && !(mode === 'Replay' && trading?.session.session_id) ? readNativeStream<ReplaySnapshot>(`replay:${activeScreenId}:${runId}`) : replayRequest(`${runId}/snapshot`, 'GET')
      void request
        .then(next => {
          if (cancelled || !next || next.run_id !== runId) return
          setReplay(next)
          lastReplayPollError.current = ''
          setReplayError('')
        })
        .catch(error => {
          const message = String(error)
          if (message.includes('(401)')) {
            setReplay(null)
            setConnection('authentication_required')
            setLoginError('Replay authentication expired; please sign in again.')
          } else if (message.includes('(404)')) {
            setReplay(null)
            setReplayError('Replay expired or the backend restarted; please start Replay again.')
          } else {
            const notice = 'Replay update unavailable; retrying…'
            if (lastReplayPollError.current !== notice) {
              lastReplayPollError.current = notice
              setReplayError(notice)
            }
          }
        })
        .finally(() => { replayPollInFlight.current = false })
    }, 500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [replay?.run_id, replay?.state, hasNativeHost, serverUrl, mode, trading?.session.session_id, connection])
  useEffect(() => {
    if (!hasNativeHost || !childReady || !isTradingMode(mode) || !trading?.session.session_id || trading.session.state === 'ended' || connection === 'authentication_required') return
    const sessionId = trading.session.session_id
    const key = `paper:${activeScreenId}:${sessionId}`
    void startNativeStream(key, `trading/${sessionId}/events`, `trading/${sessionId}/snapshot`).catch(reportTradingError)
    return () => { stopNativeStream(key); delete tradingStreamEventRef.current[key]; delete tradingSnapshotRequiredRef.current[key] }
  }, [mode, trading?.session.session_id, trading?.session.state, hasNativeHost, childReady, connection === 'authentication_required', serverUrl, browserToken])
  useEffect(() => {
    if (mode !== 'Paper' || !trading?.session.session_id || trading.session.state === 'ended' || !live?.stream_id) return
    void desktopTradingRequest(`${trading.session.session_id}/live-stream`, 'POST', { live_stream_id: live.stream_id }).catch(reportTradingError)
  }, [mode, trading?.session.session_id, trading?.session.state, live?.stream_id])
  useEffect(() => {
    if (!isTradingMode(mode) || !trading?.session.session_id || connection === 'authentication_required' || (props.assignedId && !childReady)) return
    const sessionId = trading.session.session_id
    if (hasNativeHost && trading.session.state !== 'ended') {
      const key = `paper:${activeScreenId}:${sessionId}`
      let cancelled = false
      let inFlight = false
      const refreshKey = tradingRefreshKey(sessionId)
      tradingRefreshRef.current.due(refreshKey)
      const timer = window.setInterval(() => {
        if (inFlight) return
        inFlight = true
        void readNativeStreamState<DesktopTradingStreamPayload>(key)
          .catch(error => { if (!cancelled) reportTradingError(error); return null })
          .then(async stream => {
            if (cancelled) return
            const previousCursor = tradingStreamEventRef.current[key] ?? -1
            const advanced = Boolean(stream && stream.last_event_id > previousCursor)
            let needsSnapshot = Boolean(tradingSnapshotRequiredRef.current[key])
            const now = Date.now()
            if (tradingRefreshRef.current.due(refreshKey, now)) needsSnapshot = true
            if (advanced) {
              const events = paperStreamEvents(stream!.latest_payload)
              if (mode === 'Paper' && events.some(event => event.type === 'session_ended')) {
                needsSnapshot = true
              }
              for (const event of events) {
                if (event.type === 'guardrail_activated' && Number(event.event_id) > previousCursor) setGuardrailPopup({ type: String(event.guardrail_type), reason: String(event.reason) })
                if (event.type === 'strategy_rejected' && Number(event.event_id) > previousCursor) setStrategyError(`AutoStop rejected: ${String(event.reason)}`)
                if (isDesktopTradingSnapshot(event)) tradingRefreshRef.current.mark(refreshKey)
                else if (eventNeedsTradingRefresh(event, tradingStateRef.current?.event_cursor ?? -1)) needsSnapshot = true
              }
              setTrading(current => {
                if (!current || current.session.session_id !== sessionId) return current
                let next = current
                for (const event of events) next = applyPaperStreamEvent(next, event)
                return next
              })
            }
            if (needsSnapshot) {
              tradingSnapshotRequiredRef.current[key] = true
              const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET')
              if (cancelled || snapshot.session.session_id !== sessionId) return
              if (mode === 'Paper' && snapshot.session.state === 'ended') {
                setTrading(snapshot)
                setTradingNotice('Paper engine stopped. Saved positions and history remain available.')
                return
              }
              setTrading(current => current?.session.session_id === sessionId ? acceptPaperSnapshot(current, snapshot) : current)
              delete tradingSnapshotRequiredRef.current[key]
            }
            if (advanced) tradingStreamEventRef.current[key] = stream!.last_event_id
            clearTradingError()
          })
          .catch(error => {
            if (cancelled) return
            if (mode === 'Paper' && isMissingSession(error)) {
              reportTradingError('Paper engine is unavailable; saved session will be retried.')
            } else reportTradingError(error)
          })
          .finally(() => { inFlight = false })
      }, PAPER_STREAM_POLL_MS)
      return () => { cancelled = true; window.clearInterval(timer) }
    }
    let cancelled = false
    let inFlight = false
    const timer = window.setInterval(() => {
      if (inFlight) return
      inFlight = true
      void desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET')
        .then(snapshot => {
          if (cancelled || snapshot.session.session_id !== sessionId) return
          if (mode === 'Paper' && snapshot.session.state === 'ended') {
            setTrading(snapshot)
          } else setTrading(current => current?.session.session_id === sessionId ? acceptPaperSnapshot(current, snapshot) : current)
        })
        .catch(error => {
          if (cancelled) return
          if (mode === 'Paper' && isMissingSession(error)) {
            reportTradingError('Paper session is temporarily unavailable; retrying saved history.')
          } else reportTradingError(error)
        })
        .finally(() => { inFlight = false })
    }, mode === 'Paper' && trading.session.state === 'ended' ? 30_000 : TRADING_RECONCILE_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [mode, trading?.session.session_id, trading?.session.state, serverUrl, browserToken, hasNativeHost, connection, childReady])
  useEffect(() => {
    if (mode !== 'Paper' || !trading?.session.session_id || trading.session.state === 'ended' || connection !== 'connected') return
    const sessionId = trading.session.session_id
    let cancelled = false
    const timer = window.setInterval(() => {
      void desktopTradingRequest<{ balance: number }>(`${sessionId}/wallet`, 'GET').then(wallet => {
        if (!cancelled) setTrading(current => current?.session.session_id === sessionId ? { ...current, wallet_balance: wallet.balance } : current)
      }).catch(reportTradingError)
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [mode, trading?.session.session_id, trading?.session.state, connection])
  const contractPayloadForTile = (tile: TileConfig): Record<string, unknown> => tile.kind === 'option' ? { right: tile.right, strike: Number(tile.strike), expiry: tile.expiry } : { right: null }
  const ensureOptionContractAttached = async (tile: TileConfig) => {
    if (!trading || tile.kind !== 'option') return
    const key = contractKeyForTile(tile)
    if (key && trading.contracts.some(contract => contract.contract_key === key)) return
    const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/contracts`, 'POST', { symbol: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right })
    setTrading(snapshot)
    clearTradingError()
  }
  const paneCurrentPrice = (tile: TileConfig) => {
    if (!trading) return 0
    if (tile.kind === 'option') {
      if (mode === 'Paper') {
        const chartTile = live?.tiles.find(item => item.tile_id === tile.id)
        const instrument = chartTile?.instrument
        if (instrument?.kind === 'option' && instrument.underlying === tile.symbol && instrument.expiry === tile.expiry && Number(instrument.strike) === Number(tile.strike) && instrument.right === tile.right) {
          return Number(chartTile?.latest_tick?.close ?? 0)
        }
        return 0
      }
      const key = contractKeyForTile(tile)
      const quote = key ? trading.contract_quotes?.[key]?.price : 0
      if (quote && quote > 0) return quote
      const activeStrike = tile.right === 'PE' ? trading.session.strike_pe : trading.session.strike_ce
      return Number(tile.strike) === activeStrike && tile.expiry === trading.session.expiry
        ? tile.right === 'PE' ? trading.current_price_pe : trading.current_price_ce
        : 0
    }
    return trading.current_price
  }
  const sizePayload = (ticket: TradeTicket): Record<string, unknown> => {
    if (!trading || !ticket.settings || !ticket.sizeKey) throw new Error('Load sizing settings and select a size first')
    return ticketSizingPayload(ticket.settings, ticket.sizeKey, () => entryQuantity(ticket.tile.kind, ticket.sizeKey!, trading))
  }

  const startDesktopStrategy = async (strategyType: 'AutoStop' | 'BreakEven' | 'TargetProfit' | 'LockProfit' | 'AggressiveStoploss' | 'UnderlyingTargetProfit' | 'UnderlyingStoploss', right: 'CE' | 'PE' | null, price?: number, ticket?: TradeTicket, chartTile?: TileConfig) => {
    if (!trading) return
    // The desktop route scopes the URL by session, but it delegates to the
    // shared strategy request model which also requires session_id in its
    // validated request body.
    const body: Record<string, unknown> = { session_id: trading.session.session_id, strategy_type: strategyType, ...(right ? { right } : {}) }
    const optionTile = ticket?.tile.kind === 'option' ? ticket.tile : chartTile?.kind === 'option' ? chartTile : null
    if (optionTile) { body.strike = Number(optionTile.strike); body.expiry = optionTile.expiry }
    if ((strategyType === 'TargetProfit' || strategyType === 'UnderlyingTargetProfit') && price !== undefined) body.target_profit_value = price
    if (strategyType === 'LockProfit' && price !== undefined) body.lock_profit_value = price
    if (strategyType === 'UnderlyingStoploss' && price !== undefined) body.underlying_sl_price = price
    if (strategyType === 'AutoStop' && ticket) {
      const sizing = sizePayload(ticket)
      body.direction = ticket.side
      body.entry_sl_price = ticket.slPrice
      if ('risk_pct' in sizing) body.risk_ratio_pct = Number(sizing.risk_pct) / 100
      else Object.assign(body, sizing)
    }
    await desktopTradingRequest(`${trading.session.session_id}/strategies/start`, 'POST', body)
    setTrading(await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
    clearTradingError()
    setTradingNotice(`${strategyType === 'AutoStop' ? 'Auto stop' : strategyType.replace(/([A-Z])/g, ' $1').trim()} started.`)
  }
  const placeTicketOrder = async (ticket: TradeTicket, entryPrice?: number) => {
    if (!trading || !ticket.sizeKey || !ticket.orderType || !ticket.settings) return
    if (ticket.sessionId !== trading.session.session_id) throw new Error('Entry ticket belongs to a different session')
    if (!equityEntryEnabled(ticket.tile.kind, ticket.tile.symbol, trading)) throw new Error('Entry requires the active session underlying')
    if (mode === 'Paper' && ticket.tile.kind === 'option' && ticket.orderType === 'MARKET' && paneCurrentPrice(ticket.tile) <= 0) throw new Error('No live premium is available for this option chart yet')
    if (entryPrice !== undefined || ticket.orderType === 'MARKET') validateEntryStop(ticket.side, entryPrice ?? paneCurrentPrice(ticket.tile), ticket.slPrice)
    if (ticket.orderType === 'AUTO_STOP') {
      await startDesktopStrategy('AutoStop', ticket.tile.kind === 'option' ? ticket.tile.right as 'CE' | 'PE' : null, ticket.slPrice, ticket)
      setTradeTicket(null)
      return
    }
    await ensureOptionContractAttached(ticket.tile)
    const intent = ticket.orderType.toLowerCase()
    const body: Record<string, unknown> = {
      symbol: ticket.tile.symbol,
      side: ticket.side,
      intent,
      entry_sl_price: ticket.slPrice,
      group_id: crypto.randomUUID(),
      target_deviation_pct: trading.settings.target_deviation_pct,
      ...contractPayloadForTile(ticket.tile),
      ...sizePayload(ticket),
    }
    if (mode === 'Paper' && ticket.tile.kind === 'option') {
      if (!live) throw new Error('Live option chart is unavailable; refresh it before trading')
      body.live_stream_id = live.stream_id
      body.live_tile_id = ticket.tile.id
    }
    if (intent !== 'market') body.price = entryPrice
    await desktopTradingRequest<DesktopOrder>(`${trading.session.session_id}/chart-orders`, 'POST', body)
    const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET')
    setTrading(snapshot)
    clearTradingError()
    setTradeTicket(null)
    setPricePickAction(null)
  }
  const updateOrderLine = async (order: DesktopOrder, price: number) => {
    if (!trading) return
    const body = order.order_type === 'LIMIT' ? { limit_price: price } : { trigger_price: price }
    const updated = await desktopTradingRequest<DesktopOrder>(`${trading.session.session_id}/orders/${order.order_id}`, 'PATCH', body)
    setTrading(snapshot => snapshot ? { ...snapshot, open_orders: snapshot.open_orders.map(item => item.order_id === updated.order_id ? updated : item) } : snapshot)
  }
  const updateOrderQuantity = async (order: DesktopOrder, quantity: number) => {
    if (!trading) return
    const updated = await desktopTradingRequest<DesktopOrder>(`${trading.session.session_id}/orders/${order.order_id}`, 'PATCH', { quantity })
    setTrading(snapshot => snapshot ? { ...snapshot, open_orders: snapshot.open_orders.map(item => item.order_id === updated.order_id ? updated : item) } : snapshot)
    clearTradingError()
  }
  const updateListedOrder = async (order: DesktopOrder, price: number, quantity: number) => {
    if (!trading) return
    const updated = await desktopTradingRequest<DesktopOrder>(`${trading.session.session_id}/orders/${order.order_id}`, 'PATCH', {
      [order.order_type === 'LIMIT' ? 'limit_price' : 'trigger_price']: price,
      quantity,
    })
    setTrading(snapshot => snapshot?.session.session_id === order.session_id ? { ...snapshot, open_orders: snapshot.open_orders.map(item => item.order_id === updated.order_id ? updated : item) } : snapshot)
    clearTradingError()
  }
  const cancelOrderLine = async (order: DesktopOrder) => {
    if (!trading) return
    await desktopTradingRequest<DesktopOrder | null>(`${trading.session.session_id}/orders/${order.order_id}`, 'DELETE')
    setTrading(snapshot => snapshot ? { ...snapshot, open_orders: snapshot.open_orders.filter(item => item.order_id !== order.order_id) } : snapshot)
  }
  const requestOrderConvert = (order: DesktopOrder, target: ConversionTarget) => setPricePickAction({ orderId: order.order_id, conversion: target })
  const completePricePick = async (price: number) => {
    if (!trading || !pricePickAction) return
    if (!Number.isFinite(price)) { setPricePickAction(null); return }
    if (pricePickAction.missingSl) {
      const pick = pricePickAction.missingSl
      const sessionId = trading.session.session_id
      try {
        await desktopTradingRequest(`${sessionId}/fill-missing-stoploss`, 'POST', { session_id: sessionId, trigger_price: price, request_id: pick.requestId, ...contractPayloadForTile(pick.tile) })
        const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET')
        setTrading(current => current?.session.session_id === sessionId ? snapshot : current)
        setPricePickAction(null)
        clearTradingError()
      } catch (error) {
        const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET').catch(() => null)
        if (snapshot) setTrading(current => current?.session.session_id === sessionId ? snapshot : current)
        if (/409|502|404/.test(String(error))) setPricePickAction(null)
        throw error
      }
      return
    }
    if (pricePickAction.ticket) {
      await placeTicketOrder(pricePickAction.ticket, price)
      setPricePickAction(null)
      return
    }
    if (pricePickAction.orderId && pricePickAction.conversion) {
      const updated = await desktopTradingRequest<DesktopOrder>(`${trading.session.session_id}/orders/${pricePickAction.orderId}/convert`, 'POST', { session_id: trading.session.session_id, new_order_type: pricePickAction.conversion, price })
      setTrading(snapshot => snapshot ? { ...snapshot, open_orders: snapshot.open_orders.map(item => item.order_id === updated.order_id ? updated : item) } : snapshot)
      setPricePickAction(null)
      return
    }
  }
  const placeChartOrder = async (tile: TileConfig, action: OrderAction, price: number, anchor: { x: number; y: number }) => {
    if (!trading) return
    setTradingNotice('')
    if (action === 'FILL_MISSING_SL') {
      const position = positionForTile(tile, trading)
      const payload = contractPayloadForTile(tile)
      const covered = trading.open_orders.filter(o => o.status === 'PENDING' && o.side === (position?.side === 'LONG' ? 'SELL' : 'BUY') && (o.right ?? null) === (payload.right ?? null) && (!payload.right || (o.strike === payload.strike && o.expiry === payload.expiry))).reduce((sum, o) => sum + o.quantity, 0)
      const quantity = Math.max(0, (position?.quantity ?? 0) - covered)
      if (!quantity) throw new Error('Position is already fully covered')
      setPricePickAction({ missingSl: { tile, quantity, requestId: crypto.randomUUID() } })
      return
    }
    if (action === 'START_UNDERLYING_TARGET' || action === 'START_UNDERLYING_SL') {
      setUnderlyingStrategyTicket({ strategyType: action === 'START_UNDERLYING_TARGET' ? 'UnderlyingTargetProfit' : 'UnderlyingStoploss', price, anchor })
      return
    }
    if (action === 'START_TARGET_PROFIT' || action === 'START_LOCK_PROFIT') {
      await startDesktopStrategy(action === 'START_TARGET_PROFIT' ? 'TargetProfit' : 'LockProfit', tile.kind === 'option' ? tile.right as 'CE' | 'PE' : null, price, undefined, tile)
      return
    }
    if (action === 'START_AGGRESSIVE_SL') {
      const right = tile.kind === 'option' ? tile.right as 'CE' | 'PE' : null
      await startDesktopStrategy('AggressiveStoploss', right, undefined, undefined, tile)
      return
    }
    if (action === 'START_BREAKEVEN') {
      const right = tile.kind === 'option' ? tile.right as 'CE' | 'PE' : null
      await startDesktopStrategy('BreakEven', right, undefined, undefined, tile)
      return
    }
    const contractPayload = contractPayloadForTile(tile)
    if (action === 'BULK_LIMIT') {
      const result = await desktopTradingRequest<{ converted: number; orders: DesktopOrder[] }>(`${trading.session.session_id}/orders/bulk-convert`, 'PATCH', { new_order_type: 'LIMIT', ...contractPayload, price })
      if (!result.converted) { reportTradingError('No pending closing orders were eligible to move to a limit.'); return }
      setTrading(await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
      clearTradingError()
      setTradingNotice(`Moved ${result.converted} exit order${result.converted === 1 ? '' : 's'} to limit.`)
      return
    }
    if (action === 'BULK_MOVE_SL') {
      const result = await desktopTradingRequest<{ updated: number; orders: DesktopOrder[] }>(`${trading.session.session_id}/orders/bulk-update-sl`, 'PATCH', { trigger_price: price, ...contractPayload })
      if (!result.updated) { reportTradingError('No pending stop-loss orders were eligible to move.'); return }
      setTrading(await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
      clearTradingError()
      setTradingNotice(`Moved ${result.updated} stop-loss order${result.updated === 1 ? '' : 's'}.`)
      return
    }
    const ticket: TradeTicket = { tile, side: action === 'USE_SL_SELL' ? 'SELL' : 'BUY', slPrice: price, orderType: null, anchor, sessionId: trading.session.session_id, settings: { ...trading.settings } }
    setPricePickAction(null)
    setTradeTicket(ticket)
  }
  const blockTrading = async () => {
    if (!trading || blockPending) return
    setBlockPending(true)
    try {
      const result = await desktopTradingRequest<{ reason: string; snapshot: DesktopTradingSnapshot }>(`${trading.session.session_id}/guardrails/block`, 'POST')
      setTrading(result.snapshot)
      setGuardrailPopup({ type: 'BLOCK', reason: result.reason })
    } catch (error) { reportTradingError(error) } finally { setBlockPending(false) }
  }
  const flattenTrading = async () => {
    if (!trading) return
    if (trading.settings.desktop_confirm_flatten && !window.confirm('Flatten all open positions now?')) return
    const result = await desktopTradingRequest<{ snapshot: DesktopTradingSnapshot }>(`${trading.session.session_id}/flatten`, 'POST', {})
    setTrading(result.snapshot)
  }
  const saveTradeLabel = (roundTrip: DesktopRoundTrip, fields: Partial<DesktopTradeLabel>) => {
    if (!trading) return
    const existing = tradeLabelState?.labels.find(label => label.round_trip_index === roundTrip.index)
    void desktopTradingRequest<DesktopTradeLabelState>(`${trading.session.session_id}/trade-labels`, 'POST', {
      round_trip_index: roundTrip.index,
      expected_category: fields.expected_category ?? existing?.expected_category ?? '',
      expected_strategy: fields.expected_strategy ?? existing?.expected_strategy ?? '',
      actual_category: fields.actual_category ?? existing?.actual_category ?? '',
      actual_strategy: fields.actual_strategy ?? existing?.actual_strategy ?? '',
      entry_tag: fields.entry_tag ?? existing?.entry_tag ?? 'AS_PER_PATTERN',
      exit_tag: fields.exit_tag ?? existing?.exit_tag ?? 'AS_PER_PATTERN',
    }).then(result => {
      setTradeLabelState(result)
      clearTradingError()
      setTradingNotice(`Saved ${roundTrip.exit_trades.length ? 'actual' : 'expected'} strategy for round trip ${roundTrip.index + 1}.`)
    }).catch(reportTradingError)
  }
  const cancelDesktopStrategy = (strategyId: string) => {
    if (!trading) return
    void desktopTradingRequest(`${trading.session.session_id}/strategies/${strategyId}/cancel`, 'POST')
      .then(() => desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
      .then(setTrading)
      .catch(reportTradingError)
  }
  const updateDesktopStrategyPrice = (strategyId: string, value: number) => {
    if (!trading) return
    if (!Number.isFinite(value) || value <= 0) return
    void desktopTradingRequest(`${trading.session.session_id}/strategies/${strategyId}/price`, 'PATCH', { session_id: trading.session.session_id, price: value })
      .then(() => desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
      .then(setTrading)
      .catch(reportTradingError)
  }
  const requestDesktopStrategyPrice = (strategyId: string, currentPrice: number) => {
    const value = Number(window.prompt('New strategy price', String(currentPrice)))
    if (Number.isFinite(value) && value > 0) updateDesktopStrategyPrice(strategyId, value)
  }
  const saveDesktopTradingSettings = async (settings: Record<string, unknown>) => {
    const result = await desktopTradingRequest<Record<string, unknown>>('settings/current', 'PUT', { settings })
    if (trading) setTrading(await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
    return result
  }
  const resetWallet = async () => {
    if (trading || historicalStarting) return
    const amount = Number(walletAmount)
    if (!Number.isFinite(amount) || amount < 0) { reportTradingError('Wallet reset amount must be a positive number'); return }
    const result = await desktopTradingRequest<{ balance: number }>(`wallet/reset?date=${encodeURIComponent(runDate)}&desktop_mode=${encodeURIComponent(mode.toLowerCase())}`, 'POST', { amount })
    setPreStartWallet(result.balance)
    clearTradingError()
    setWalletOpen(false)
  }
  const ticketSizeOptions = () => tradeTicket?.settings?.desktop_order_size_mode === 'quantity' ? ['1', '2', '3'] : ['l', 'm', 'h']
  const ticketSizeLabel = (key: string) => tradeTicket?.settings ? ticketSizingLabel(tradeTicket.settings, key) : ''
  const orderTypeLabel = (orderType: ChartOrderType) => orderType === 'MARKET' ? 'M' : orderType === 'LIMIT' ? 'L' : orderType === 'TARGET' ? 'T' : 'AS'
  const submitTicketWhenReady = (ticket: TradeTicket) => {
    if (!ticket.orderType || !ticket.sizeKey) {
      setTradeTicket(ticket)
      return
    }
    if (ticket.orderType === 'MARKET' || ticket.orderType === 'AUTO_STOP') {
      void placeTicketOrder(ticket).catch(reportTradingError)
    } else {
      setTradeTicket(null)
      setPricePickAction({ ticket })
    }
  }
  const chooseTicketOrderType = (orderType: ChartOrderType) => {
    if (!tradeTicket) return
    submitTicketWhenReady({ ...tradeTicket, orderType })
  }
  const chooseTicketSize = (key: TradeTicket['sizeKey']) => {
    if (!tradeTicket || !key) return
    submitTicketWhenReady({ ...tradeTicket, sizeKey: key })
  }
  const logoutDesktop = () => {
    if (live) stopNativeStream(`browse-live:${activeScreenId}:${live.stream_id}`)
    if (replay) stopNativeStream(`replay:${activeScreenId}:${replay.run_id}`)
    if (trading?.session.session_id) {
      stopNativeStream(`paper:${activeScreenId}:${trading.session.session_id}`)
      delete tradingStreamEventRef.current[`paper:${activeScreenId}:${trading.session.session_id}`]
      delete tradingSnapshotRequiredRef.current[`paper:${activeScreenId}:${trading.session.session_id}`]
    }
    if (hasNativeHost) void invoke('desktop_logout', { baseUrl: serverUrl })
    setBrowserToken('')
    setConnection('authentication_required')
  }
  const popOutScreen = async () => {
    if (!hasNativeHost) {
      setReplayError('Pop-out windows are available in the native desktop app.')
      return
    }
    let transferred = false
    try {
      const token = crypto.randomUUID()
      handoffRef.current = token
      setHandingOff(true)
      if (screenSaveTimerRef.current) window.clearTimeout(screenSaveTimerRef.current)
      await bounded(persistCurrentScreen(), SAVE_TIMEOUT_MS)
      if (handoffRef.current !== token) return
      await bounded(invoke('open_screen_window', { screenId: activeScreen.id, handoffToken: token }), 16000)
      transferred = true
    } catch (error) {
      const token = handoffRef.current
      if (token) void invoke('cancel_screen_handoff', { screenId: activeScreenId, handoffToken: token }).catch(() => {})
      setHandingOff(false)
      setReplayError(String(error))
    } finally { if (!transferred) { handoffRef.current = null; setHandingOff(false) } }
  }
  const cancelHandoff = async () => {
    const token = handoffRef.current
    handoffRef.current = null
    setHandingOff(false)
    if (token) await invoke('cancel_screen_handoff', { screenId: activeScreenId, handoffToken: token }).catch(reportTradingError)
  }
  if (handoffFailed && props.assignedId) return <main role="alert">{handoffError && <p>Unable to restore this screen: {handoffError}</p>}<button onClick={() => void invoke('focus_main_window')}>Main window</button></main>
  if (handingOff) return <main><nav>{screens.map(screen => <button key={screen.id} onClick={() => setActiveScreenId(screen.id)}>{screen.name}</button>)}</nav><p>Opening this screen in its own window…</p><button onClick={() => void cancelHandoff()}>Cancel pop-out</button></main>
  if (!props.loaded && connection !== 'authentication_required') return <main><p>Loading saved screens… {replayError}</p></main>
  if (props.loaded && !restoredReady && connection !== 'authentication_required') return <main><p>Restoring screen… {tradingError || replayError}</p></main>
  if (props.assignedId && connection === 'authentication_required') return <main><p>Sign in in the main window to reconnect this screen.</p><button onClick={() => void invoke('focus_main_window')}>Main window</button></main>
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label>{pendingGoogleToken ? <><p className="login-help">Google sign-in succeeded. Choose an account name to finish creating your Trade Matangi account.</p><label>Account name<input value={googleAccountName} onChange={event => setGoogleAccountName(event.target.value)} placeholder="Your display name" /></label><button className="login-button" disabled={googleLoading || !googleAccountName.trim()} onClick={() => void googleLogin(pendingGoogleToken, googleAccountName.trim())}>{googleLoading ? 'Creating account…' : 'Continue'}</button><button onClick={() => { setPendingGoogleToken(null); setGoogleAccountName('') }}>Use email instead</button></> : <><button className="google-login-button" disabled={googleLoading || (!hasNativeHost && !googleReady)} onClick={beginGoogleLogin}><span className="google-mark">G</span>{googleLoading ? 'Signing in…' : hasNativeHost || googleReady ? 'Continue with Google' : 'Loading Google…'}</button><div className="login-divider"><span />or<span /></div><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="login-button" onClick={login}>Sign in</button></>}{loginError && <p className="login-error">{loginError}</p>}</section></main>
  return <main>
    <header>
      <button className="icon-button panel-toggle" title={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-label={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-pressed={toolPanelOpen} onClick={() => setToolPanelOpen(value => !value)}>{toolPanelOpen ? '◧' : '◨'}</button>
      <nav className="screen-tabs">{(props.assignedId ? [activeScreen] : screens).map(screen => <button key={screen.id} className={screen.id === activeScreenId ? 'active' : ''} onClick={() => { setActiveScreenId(screen.id); setMaximizedTileId(null) }}>{screen.name}{props.external.includes(screen.id) ? ' ↗' : ''}</button>)}{!props.assignedId && <button className="new-screen" onClick={addScreen}>＋</button>}</nav>
      {!props.assignedId && <span className="screen-actions"><button className="icon-button" title="Rename screen" aria-label="Rename screen" onClick={renameScreen}>✎</button><button className="icon-button" title="Duplicate screen" aria-label="Duplicate screen" onClick={duplicateScreen}>⧉</button><button className="icon-button" title="Pop out screen" aria-label="Pop out screen" onClick={() => void popOutScreen()}>⇱</button><button className="icon-button" title="Move screen left" aria-label="Move screen left" onClick={() => moveScreen(-1)}>‹</button><button className="icon-button" title="Move screen right" aria-label="Move screen right" onClick={() => moveScreen(1)}>›</button><button className="icon-button" title="Close screen" aria-label="Close screen" disabled={screens.length <= 1} onClick={() => void closeScreen().catch(reportTradingError)}>×</button></span>}
      {(['Browse', 'Paper', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected mode-button' : 'mode-button'} onClick={() => switchMode(value)} key={value} title={value === 'Paper' ? 'Live' : value} aria-label={value === 'Paper' ? 'Live' : value}><ToolbarIcon name={value} /></button>)}
      {mode === 'Browse' && <span className="run-controls live-controls"><button onClick={() => void (live ? stopLive() : startLive())}>{live ? 'Stop Live' : 'Start Live'}</button><button className="icon-button" title="Refresh live charts" aria-label="Refresh live charts" onClick={refreshLive} disabled={!live}><ToolbarIcon name="Refresh" /></button></span>}
      {mode === 'Paper' && <span className="run-controls"><label>Date <input type="date" value={runDate} onChange={event => setRunDate(event.target.value)} disabled={Boolean(historicalStarting || (trading && trading.session.state !== 'ended'))} /></label><label>Start <input type="time" value={runStartTime} onChange={event => setRunStartTime(event.target.value)} disabled={Boolean(historicalStarting || (trading && trading.session.state !== 'ended'))} step="60" /></label>{!trading || (trading.session.state === 'ended' && trading.paper_status !== 'running') ? <button className="run-start" onClick={startRun} disabled={Boolean(historicalStarting || (trading && (trading.session.date !== paperMarketDate() || paperMarketTime() >= '15:09:00' || trading.paper_status === 'settled')))}>{historicalStarting ? 'Starting…' : trading?.paper_status === 'settled' || (trading && (trading.session.date !== paperMarketDate() || paperMarketTime() >= '15:09:00')) ? 'Closed' : trading?.paper_status === 'stopped' ? 'Resume' : 'Start'}</button> : <button className="run-stop" onClick={() => void stopPaper()}>{sharedTradingSession ? 'Detach' : 'Stop'}</button>}{trading?.settlement_pending && <small role="status">Close settlement pending an exact contract quote</small>}<button className="icon-button" title="Refresh live charts" aria-label="Refresh live charts" onClick={refreshLive} disabled={!live}><ToolbarIcon name="Refresh" /></button></span>}
      {(mode === 'Replay' || mode === 'Stepwise') && <span className="run-controls"><label>Date <input type="date" value={runDate} onChange={event => setRunDate(event.target.value)} disabled={Boolean(historicalStarting || (replay && replay.state !== 'stopped'))} /></label><label>Start <input type="time" value={runStartTime} onChange={event => setRunStartTime(event.target.value)} disabled={Boolean(historicalStarting || (replay && replay.state !== 'stopped'))} step="60" /></label>{mode === 'Replay' && <label>Speed <select value={replaySpeed} onChange={event => updateReplaySpeed(event.target.value)} disabled={historicalStarting}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.1">1.1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select></label>}{!replay || replay.state === 'stopped' ? <button className="run-start" onClick={startRun} disabled={historicalStarting}>{historicalStarting ? 'Starting…' : 'Start'}</button> : <>{mode === 'Replay' && <button className="run-pause" onClick={() => replayAction(replay.state === 'paused' ? 'resume' : 'pause')}>{replay.state === 'paused' ? 'Resume' : 'Pause'}</button>}{mode === 'Stepwise' && <button className="run-next" onClick={() => replayAction('next-bar')}>Next bar</button>}<button className="run-stop" onClick={() => replayAction('stop')}>Stop</button><small>{replay.bar_index} · {new Date(replay.cursor * 1000).toISOString().slice(11, 19)}</small></>}</span>}
      {isTradingMode(mode) && <><span className={`trading-pill session-indicator ${sharedTradingSession ? 'good' : ''}`} title={sharedTradingSession ? 'Shared session' : 'This screen session'} aria-label={sharedTradingSession ? 'Shared session' : 'This screen session'}>{trading ? (sharedTradingSession ? '⇄' : '▣') : '◌'}</span><button className="trading-pill good wallet-button" onClick={() => { setWalletAmount(String(Math.round(trading?.wallet_balance ?? preStartWallet ?? 0))); setWalletOpen(value => !value) }}>Wallet {preStartWallet === null && !trading ? '—' : `₹${Math.round(trading?.wallet_balance ?? preStartWallet ?? 0).toLocaleString('en-IN')}`}</button>{trading && <><span className={`trading-pill ${trading.pnl.day >= 0 ? 'good' : 'bad'}`}>P&L {trading.settings.desktop_pnl_display_mode === 'percent' ? `${trading.pnl.day_pct.toFixed(2)}%` : `₹${Math.round(trading.pnl.day).toLocaleString('en-IN')}`}</span><button className="flatten-button icon-button" title="Flatten" aria-label="Flatten" onClick={() => void flattenTrading().catch(reportTradingError)}><ToolbarIcon name="Flatten" /></button><button className="block-button icon-button" title="Block trading" aria-label="Block trading" disabled={blockPending || trading.guardrails?.ban_active} onClick={() => void blockTrading()}><ToolbarIcon name="Block" /></button></>}</>}
      <label className="layout-control">Layout <select value={activeScreen.layout} onChange={event => setLayout(event.target.value as Layout)}><option value="1">1 chart</option><option value="2-side">2 side-by-side</option><option value="2-stacked">2 stacked</option><option value="3-wide-top">3 wide-top</option><option value="4-grid">4 grid</option><option value="4-one-three">4 panes — 1+3</option><option value="5-equal">5 panes — Equal</option><option value="5-wide-right">5 panes — Wide R</option></select></label>
      <button className="icon-button" title="Chart settings" aria-label="Chart settings" onClick={() => setShowSettings(true)}>⚙</button><span className={`connection ${connection}`}>● {connection}</span><button onClick={logoutDesktop}>Log out</button>
    </header>
    {(strategyError || replayError || liveError || tradingError || drawingError) && <p className="run-error">{strategyError || replayError || liveError || tradingError || drawingError}</p>}
    {!tradingError && tradingNotice && <p className="run-notice">{tradingNotice}</p>}
    {walletOpen && isTradingMode(mode) && <div className="wallet-popover">
      <strong>Wallet</strong>
      <span>Current {trading || preStartWallet !== null ? `₹${Math.round(trading?.wallet_balance ?? preStartWallet ?? 0).toLocaleString('en-IN')}` : '—'}</span>
      {trading || walletLocked ? <><small>{walletLocked ? 'Paper wallet is locked after the first session starts.' : 'Wallet cannot be changed during an active run.'}</small><div><button onClick={() => setWalletOpen(false)}>Close</button></div></> : <><label>Reset to<input type="number" min="0" value={walletAmount} onChange={event => setWalletAmount(event.target.value)} disabled={historicalStarting} /></label><div><button onClick={() => void resetWallet().catch(reportTradingError)} disabled={historicalStarting}>Reset</button><button onClick={() => setWalletOpen(false)}>Close</button></div></>}
    </div>}
    {tradeTicket && <div className="trade-ticket trade-ticket-sizing" style={placeNearPoint(tradeTicket.anchor.x, tradeTicket.anchor.y, 280, 280)}>
      <header><strong>{tradeTicket.side} SL</strong><button onClick={() => { setTradeTicket(null); setPricePickAction(null) }}>x</button></header>
      <div className="ticket-row"><span>Stoploss</span><b>{tradeTicket.slPrice.toFixed(2)}</b></div>
      {tradeTicket.settings.desktop_order_size_mode !== 'quantity' && <div className="ticket-sizing-toggle">
        <span>Risk %</span>
        <button type="button" role="switch" aria-label="Use Capital % instead of Risk % for this order" aria-checked={tradeTicket.settings.desktop_order_size_mode === 'funds_ratio'} onClick={() => setTradeTicket(switchTicketSizing(tradeTicket, tradeTicket.settings.desktop_order_size_mode === 'funds_ratio' ? 'risk_ratio' : 'funds_ratio'))}><span /></button>
        <span>Capital %</span>
      </div>}
      {tradeTicket.settings && <div className="ticket-picker">
        <div className="ticket-buttons">{(['MARKET', 'LIMIT', 'TARGET', 'AUTO_STOP'] as const).map(orderType => <button key={orderType} className={tradeTicket.orderType === orderType ? 'active' : ''} onClick={() => chooseTicketOrderType(orderType)}>{orderTypeLabel(orderType)}</button>)}</div>
        {tradeTicket?.settings?.desktop_order_size_mode === 'quantity' && <label>{tradeTicket.tile.kind === 'option' ? 'Lots' : 'Shares'}<input aria-label="Entry quantity" type="number" min="1" step="1" defaultValue="1" onChange={event => setTradeTicket({ ...tradeTicket, sizeKey: event.target.value })} /><button onClick={() => chooseTicketSize(tradeTicket.sizeKey ?? '1')}>Use quantity</button></label>}
        <div className="ticket-buttons">{ticketSizeOptions().map(key => <button key={key} className={tradeTicket.sizeKey === key ? 'active' : ''} onClick={() => chooseTicketSize(key)}>{tradeTicket.settings.desktop_order_size_mode === 'quantity' ? ticketSizeLabel(key) : <span className="ticket-size-label">{ticketSizeLabel(key).split(' ').map((part, index) => <span key={index}>{part}</span>)}</span>}</button>)}</div>
      </div>}
      {tradeTicket.settings && <div className="ticket-hint">{tradeTicket?.settings?.desktop_order_size_mode === 'risk_ratio' ? 'Risk % is modeled stop-loss loss against session capital.' : tradeTicket?.settings?.desktop_order_size_mode === 'funds_ratio' ? tradeTicket.tile.kind === 'spot' ? 'Capital % sizes equity at 5× exposure: 12% supports 60% of session capital.' : 'Capital % sizes option premium against session capital.' : tradeTicket.tile.kind === 'option' ? 'Quantity is in complete option lots.' : 'Quantity is in whole shares.'}</div>}
      <div className="ticket-hint">{tradeTicket.orderType === 'MARKET' ? `Uses chart quote ${paneCurrentPrice(tradeTicket.tile).toFixed(2)}; proxy set by server` : tradeTicket.orderType === 'AUTO_STOP' ? 'Uses selected SL and saved sizing' : tradeTicket.orderType ? 'Pick price' : 'Type + size'}</div>
    </div>}
    {underlyingStrategyTicket && <div className="trade-ticket" style={placeNearPoint(underlyingStrategyTicket.anchor.x, underlyingStrategyTicket.anchor.y, 260, 150)}>
      <header><strong>{underlyingStrategyTicket.strategyType === 'UnderlyingTargetProfit' ? 'Underlying target' : 'Underlying SL'}</strong><button onClick={() => setUnderlyingStrategyTicket(null)}>x</button></header>
      <div className="ticket-row"><span>Underlying price</span><b>{underlyingStrategyTicket.price.toFixed(2)}</b></div>
      <div className="ticket-hint">Apply to the open option position:</div>
      <div className="ticket-buttons"><button onClick={() => { const picker = underlyingStrategyTicket; void startDesktopStrategy(picker.strategyType, 'CE', picker.price).then(() => setUnderlyingStrategyTicket(null)).catch(reportTradingError) }}>CE</button><button onClick={() => { const picker = underlyingStrategyTicket; void startDesktopStrategy(picker.strategyType, 'PE', picker.price).then(() => setUnderlyingStrategyTicket(null)).catch(reportTradingError) }}>PE</button></div>
    </div>}
    <section className={`workspace-shell ${toolPanelOpen ? '' : 'tools-collapsed'}`}>
      {toolPanelOpen && <WorkspaceToolPanel tiles={activeScreen.tiles} activeTileId={activeToolTile} setActiveTileId={setActiveToolTileId} activeTileLabel={(() => { const tile = activeScreen.tiles.find(item => item.id === activeToolTile) ?? activeScreen.tiles[0]; return tile?.kind === 'option' ? `${tile.symbol} ${tile.strike}${tile.right}` : tile?.symbol ?? 'Chart' })()} activePosition={isTradingMode(mode) ? positionForTile(activeScreen.tiles.find(item => item.id === activeToolTile) ?? activeScreen.tiles[0], trading) : null} sessionCapital={trading?.session.session_capital ?? 0} positionMarginRate={trading?.session.instrument_type === 'equity' && (activeScreen.tiles.find(item => item.id === activeToolTile) ?? activeScreen.tiles[0])?.kind !== 'option' ? 0.2 : 1} indicators={selectedIndicators} toggleIndicator={toggleIndicator} clearIndicators={clearIndicators} sendDrawing={sendDrawing} sendDrawingAction={sendDrawingAction} activeDrawingTool={activeDrawingTool} drawingMode={drawingMode} setDrawingMode={setDrawingMode} tradeHistoryCount={trading?.trades.length ?? 0} onOpenTradeHistory={() => setTradeHistoryOpen(true)} tradingActive={Boolean(trading)} ordersReadOnly={trading?.session.state === 'ended'} openOrders={trading?.open_orders ?? []} onUpdateOrder={updateListedOrder} onCancelOrder={cancelOrderLine} labelState={isTradingMode(mode) ? tradeLabelState : null} labelMetadata={labelMetadata} labelMetadataStatus={labelMetadataStatus} labelMetadataError={labelMetadataError} onReloadLabelMetadata={() => void loadLabelMetadata()} onSaveTradeLabel={saveTradeLabel} strategies={isTradingMode(mode) ? trading?.strategies ?? [] : []} onCancelStrategy={cancelDesktopStrategy} onUpdateStrategyPrice={requestDesktopStrategyPrice} />}
      <section className={`tile-grid tiles-${activeScreen.layout} ${maximizedTileId ? 'has-maximized' : ''}`}>{activeScreen.tiles.map((tile, tileIndex) => { const state = replay?.tile_states.find(item => item.tile_id === tile.id); const liveState = (mode === 'Browse' || mode === 'Paper') ? live?.tiles.find(item => item.tile_id === tile.id) : undefined; const cacheKey = liveState?.instrument ? canonicalKey(liveState.instrument) : instrumentKeyForTile(tile, catalogue); return <DesktopTile key={tile.id} config={tile} catalogue={catalogue} connection={connection} api={api} settings={chartSettings} serverUrl={serverUrl} drawingRequest={drawingRequest} onDrawingError={reportDrawingError} replayCursor={replay?.cursor} replayRunId={replay?.run_id} replayCandle={state?.interval_minutes === Number(tile.interval) ? state.candle : undefined} replayAttached={Boolean(state && state.interval_minutes === Number(tile.interval))} liveTile={liveState} liveTicks={liveTickCache[cacheKey] ?? []} onLiveTick={onLiveTick} maximized={maximizedTileId === tile.id} active={activeToolTile === tile.id} indicators={tileIndicators[tile.id] ?? noIndicators} drawingCommand={drawingCommand} drawingAction={drawingAction} drawingMode={drawingMode} onDrawingComplete={onDrawingComplete} onActivate={() => setActiveToolTileId(tile.id)} onConfigure={() => setPickerTileId(tile.id)} onMaximize={() => setMaximizedTileId(current => current === tile.id ? null : tile.id)} onIntervalChange={interval => saveTile({ ...tile, interval })} tradingSnapshot={isTradingMode(mode) ? trading : null} pricePickAction={activeToolTile === tile.id ? pricePickAction : null} onPricePick={price => void completePricePick(price).catch(error => { setTradingNotice(''); reportTradingError(error) })} onOrderDrag={updateOrderLine} onStrategyDrag={updateDesktopStrategyPrice} onOrderCancel={cancelOrderLine} onOrderConvertRequest={requestOrderConvert} onOrderQuantityUpdate={updateOrderQuantity} onChartOrderAction={(tileForAction, action, price, anchor) => void placeChartOrder(tileForAction, action, price, anchor).catch(error => { setTradingNotice(''); reportTradingError(error) })} swapTargets={swapTargetsForLayout(activeScreen.layout, tileIndex).map(target => ({ dir: target.dir, label: target.label, onClick: () => swapTiles(tileIndex, target.target) }))} />})}</section>
    </section>
    {tradeHistoryOpen && <TradeHistoryModal trades={trading?.trades ?? []} roundTrips={[...(tradeLabelState?.open ?? []), ...(tradeLabelState?.completed ?? [])]} labels={tradeLabelState?.labels ?? []} sessionCapital={trading?.session.session_capital ?? 0} onClose={() => setTradeHistoryOpen(false)} />}
    {guardrailPopup && <div className={guardrailPopup.type === 'BAN' ? 'guardrail-ban-notice' : 'modal-backdrop'}><section className="instrument-modal" role="alertdialog" aria-modal={guardrailPopup.type !== 'BAN'} aria-label="Guardrail active"><header><strong>{guardrailPopup.type === 'BAN' ? 'Trading Suspended' : guardrailPopup.type === 'COOLDOWN' ? 'Cooldown Active' : 'Trading Paused'}</strong></header><p>{guardrailPopup.reason}</p>{guardrailPopup.type === 'BAN' ? <p>Trading is suspended for this session. Start a new session to resume trading.</p> : <footer><button onClick={() => setGuardrailPopup(null)}>Got it</button></footer>}</section></div>}
    {pickerTile && <InstrumentPicker initial={pickerTile} lockedTradingDate={isTradingMode(mode) && trading && trading.session.state !== 'ended' ? trading.session.date : undefined} catalogue={catalogue} api={api} onSave={saveTile} onClose={() => setPickerTileId(null)} />}{showSettings && <ChartSettingsModal settings={chartSettings} tradingSettings={isTradingMode(mode) ? trading?.settings ?? null : null} loadSettings={() => desktopTradingRequest<Record<string, unknown>>('settings/current', 'GET')} loadChartSettings={async () => { const result = await desktopRecordRequest('chart-settings', 'GET') as { settings: Partial<ChartSettings> }; return { ...defaultChartSettings, ...result.settings } }} saveGuardrails={values => desktopTradingRequest<Record<string, unknown>>('guardrails/settings', 'PUT', values)} onSave={saveChartSettings} onSaveTradingSettings={saveDesktopTradingSettings} onClose={() => setShowSettings(false)} />}
  </main>
}
