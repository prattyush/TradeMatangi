import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartTile } from './ChartTile'
import { replayCandles } from './chartState'
import { shouldConsumeDrawingCommand } from './drawingState'
import type { Candle, DesktopOrder, DesktopPosition, DesktopTradingSnapshot } from './contracts'
import { aggregateLiveCandles, appendLiveTick } from './liveCandles'
import { applyLiveStreamPayloadToSnapshot, type LiveSnapshot, type LiveTileState } from './liveStreamState'

interface HistoricalPage { candles: Candle[]; available?: boolean; unavailable_reason?: string }
interface Instrument { symbol: string; display_name: string; exchange: string; chart_type?: string; option_eligible: boolean; supported_intervals: number[] }
interface Catalogue { instruments: Instrument[] }
interface OptionMetadata { expiries: string[]; strike_interval: number; rights: string[]; available: boolean; unavailable_reason?: string }
interface TileConfig { id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string; expiry: string; strike: string; right: string }
type Layout = '1' | '2-side' | '2-stacked' | '3-wide-top' | '4-grid'
interface Screen { id: string; persistedId?: string; revision?: number; name: string; tiles: TileConfig[]; layout: Layout }
interface PersistedScreenState { id?: string; layout?: Layout; tiles?: TileConfig[]; indicators?: Record<string, string[]>; activeToolTileId?: string }
interface DesktopScreenRecord { screen_id: string; name: string; state: PersistedScreenState; revision: number; order: number; active?: boolean }
interface ReplaySnapshot { run_id: string; event_id: number; cursor: number; state: string; mode: string; bar_index: number; interval_seconds: number; tile_states: Array<{ tile_id: string; availability: string; candle?: Candle }> }
interface ChartSettings { background: string; textColor: string; gridColor: string; gridOpacity: number; gridStyle: 'solid' | 'dashed'; gridSize: number; movingAverageType: 'MA' | 'EMA'; movingAveragePeriods: string; liveProvider: 'breeze'; horizontalLineColor: string; horizontalLineWidth: number; trendLineColor: string; trendLineWidth: number; drawingLineColor: string; drawingLineWidth: number; drawingFillColor: string; drawingFillOpacity: number }
interface DesktopStreamSnapshot<T> { key: string; last_event_id: number; latest_payload: T | null; connection: 'connected' | 'reconnecting' | 'offline' | 'authentication_required' }
interface DesktopRoundTrip { index: number; right: string | null; strike?: number | null; expiry?: string | null; entry_trades: Array<Record<string, unknown>>; exit_trades: Array<Record<string, unknown>>; pnl: number }
interface DesktopTradeLabel { round_trip_index: number; expected_category: string; expected_strategy: string; actual_category: string; actual_strategy: string; entry_tag: string; exit_tag: string }
interface DesktopTradeLabelState { completed: DesktopRoundTrip[]; open: DesktopRoundTrip[]; labels: DesktopTradeLabel[] }
interface DesktopLabelMetadata { categories: string[]; strategies: string[]; entry_tags: string[]; exit_tags: string[] }
type DesktopLabelMetadataStatus = 'idle' | 'loading' | 'ready' | 'error'
const emptyLabelMetadata: DesktopLabelMetadata = { categories: [], strategies: [], entry_tags: [], exit_tags: [] }
interface DrawingCommand { id: number; tool: string }
interface DrawingAction { id: number; action: 'delete' | 'hide' | 'lock' }
type DrawingMode = 'once' | 'repeat'
type ConversionTarget = 'LIMIT' | 'STOPLOSS' | 'TARGET'
type ChartOrderType = 'MARKET' | 'LIMIT' | 'TARGET' | 'AUTO_STOP'
type OrderAction = 'USE_SL_BUY' | 'USE_SL_SELL' | 'BULK_LIMIT' | 'BULK_MOVE_SL' | 'START_TARGET_PROFIT' | 'START_LOCK_PROFIT' | 'START_UNDERLYING_TARGET' | 'START_UNDERLYING_SL'
interface TradeTicket { tile: TileConfig; side: 'BUY' | 'SELL'; slPrice: number; orderType: ChartOrderType | null; anchor: { x: number; y: number }; sizeKey?: 'l' | 'm' | 'h' | '1' | '2' | '3' | '5' | '10' }
interface UnderlyingStrategyTicket { strategyType: 'UnderlyingTargetProfit' | 'UnderlyingStoploss'; price: number; anchor: { x: number; y: number } }
type PricePickAction = { orderId?: string; conversion?: ConversionTarget; ticket?: TradeTicket }
const isHistoricalTradingMode = (value: string) => value === 'Stepwise' || value === 'Replay'
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
let activeLiveSnapshot: LiveSnapshot | null = null
const historyCache = new Map<string, Promise<Candle[]>>()
type Api = <T,>(path: string, params?: URLSearchParams) => Promise<T>
const GOOGLE_CLIENT_ID = '249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com'
const fallbackCatalogue: Instrument[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }]
const defaultChartSettings: ChartSettings = { background: '#151a23', textColor: '#aeb8ca', gridColor: '#ffffff', gridOpacity: 0.12, gridStyle: 'solid', gridSize: 1, movingAverageType: 'MA', movingAveragePeriods: '5,10,20', liveProvider: 'breeze', horizontalLineColor: '#facc15', horizontalLineWidth: 2, trendLineColor: '#60a5fa', trendLineWidth: 2, drawingLineColor: '#60a5fa', drawingLineWidth: 2, drawingFillColor: '#60a5fa', drawingFillOpacity: 0.16 }
const noIndicators: string[] = []
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

function WorkspaceToolPanel({ tiles, activeTileId, setActiveTileId, indicators, toggleIndicator, clearIndicators, sendDrawing, sendDrawingAction, activeDrawingTool, drawingMode, setDrawingMode, tradeHistoryCount, onOpenTradeHistory, labelState, labelMetadata, labelMetadataStatus, labelMetadataError, onReloadLabelMetadata, onSaveTradeLabel, strategies, onCancelStrategy, onUpdateStrategyPrice }: { tiles: TileConfig[]; activeTileId: string; setActiveTileId: (tileId: string) => void; indicators: string[]; toggleIndicator: (name: string) => void; clearIndicators: () => void; sendDrawing: (tool: string) => void; sendDrawingAction: (action: DrawingAction['action']) => void; activeDrawingTool: string | null; drawingMode: DrawingMode; setDrawingMode: (mode: DrawingMode) => void; tradeHistoryCount: number; onOpenTradeHistory: () => void; labelState: DesktopTradeLabelState | null; labelMetadata: DesktopLabelMetadata; labelMetadataStatus: DesktopLabelMetadataStatus; labelMetadataError: string; onReloadLabelMetadata: () => void; onSaveTradeLabel: (roundTrip: DesktopRoundTrip, fields: Partial<DesktopTradeLabel>) => void; strategies: DesktopTradingSnapshot['strategies']; onCancelStrategy: (strategyId: string) => void; onUpdateStrategyPrice: (strategyId: string, currentPrice: number) => void }) {
  return <aside className="tool-panel" aria-label="Chart tools">
    <label>Chart<select value={activeTileId} onChange={event => setActiveTileId(event.target.value)}>{tiles.map((tile, index) => <option key={tile.id} value={tile.id}>{index + 1}. {tile.kind === 'option' ? `${tile.symbol} ${tile.strike}${tile.right}` : tile.symbol}</option>)}</select></label>
    <section><strong>Draw</strong><div className="segmented"><button className={drawingMode === 'once' ? 'active' : ''} aria-pressed={drawingMode === 'once'} onClick={() => setDrawingMode('once')}>Once</button><button className={drawingMode === 'repeat' ? 'active' : ''} aria-pressed={drawingMode === 'repeat'} onClick={() => setDrawingMode('repeat')}>Repeat</button></div><div className="tool-grid icon-tool-grid">{drawingTools.map(item => <button key={item.tool} className={`tool-icon ${activeDrawingTool === item.tool ? 'active' : ''}`} aria-label={item.label} aria-pressed={activeDrawingTool === item.tool} data-tooltip={item.label} title={item.label} onClick={() => sendDrawing(item.tool)}>{item.icon}</button>)}</div><div className="tool-actions icon-actions"><button className="tool-icon" aria-label="Lock selected drawing" data-tooltip="Lock selected drawing" title="Lock selected drawing" onClick={() => sendDrawingAction('lock')}>🔒</button><button className="tool-icon" aria-label="Hide selected drawing" data-tooltip="Hide selected drawing" title="Hide selected drawing" onClick={() => sendDrawingAction('hide')}>◌</button><button className="tool-icon" aria-label="Delete selected drawing" data-tooltip="Delete selected drawing" title="Delete selected drawing" onClick={() => sendDrawingAction('delete')}>⌫</button></div></section>
    <section><strong>Main indicators</strong><div className="tool-grid">{mainIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '').replace('_Ribbon', ' Ribbon')}</button>)}</div></section>
    <section><strong>Sub indicators</strong><div className="tool-grid">{subIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '')}</button>)}</div></section>
    <section><strong>Trading</strong><button className="panel-clear history-tool-button" title="Trade history" aria-label="Trade history" onClick={onOpenTradeHistory}>History {tradeHistoryCount ? `(${tradeHistoryCount})` : ''}</button><DesktopLabelPanel state={labelState} metadata={labelMetadata} metadataStatus={labelMetadataStatus} metadataError={labelMetadataError} onReloadMetadata={onReloadLabelMetadata} onSave={onSaveTradeLabel} />{strategies.length > 0 && <div className="desktop-strategy-list"><strong>Running strategies</strong>{strategies.map(strategy => <div className="desktop-strategy-row" key={strategy.strategy_id}><span>{strategy.strategy_type} {strategy.right ?? ''}{strategy.strike ? ` ${strategy.strike}` : ''}{strategy.price ? ` @${strategy.price.toFixed(2)}` : ''}</span>{strategy.price !== undefined && strategy.price !== null && <button onClick={() => onUpdateStrategyPrice(strategy.strategy_id, strategy.price ?? 0)}>Move</button>}<button onClick={() => onCancelStrategy(strategy.strategy_id)}>Cancel</button></div>)}</div>}</section>
    <button className="panel-clear" disabled={!indicators.length} onClick={clearIndicators}>Clear indicators</button>
  </aside>
}

function TradeHistoryModal({ trades, roundTrips, labels, sessionCapital, onClose }: { trades: Array<Record<string, unknown>>; roundTrips: DesktopRoundTrip[]; labels: DesktopTradeLabel[]; sessionCapital: number; onClose: () => void }) {
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

function InstrumentPicker({ initial, catalogue, api, onSave, onClose }: { initial: TileConfig; catalogue: Instrument[]; api: Api; onSave: (tile: TileConfig) => void | Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial)
  const [metadata, setMetadata] = useState<OptionMetadata | null>(null)
  const [openingPrice, setOpeningPrice] = useState<number | null>(null)
  const [error, setError] = useState('')
  const instrument = catalogue.find(item => item.symbol === draft.symbol) ?? fallbackCatalogue[0]
  useEffect(() => {
    if (draft.kind !== 'option') return
    let active = true
    const params = new URLSearchParams({ symbol: draft.symbol, trading_date: draft.tradingDate, interval_minutes: '1', context_days: '0' })
    void Promise.all([api<OptionMetadata>('metadata', new URLSearchParams({ symbol: draft.symbol, as_of_date: draft.tradingDate })), api<HistoricalPage>('history', params)]).then(([nextMetadata, page]) => {
      if (!active) return
      setMetadata(nextMetadata)
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
  const strikes = baseStrike ? Array.from({ length: 21 }, (_, index) => baseStrike + (index - 10) * gap).filter(value => value > 0) : []
  return <div className="modal-backdrop" role="presentation"><section className="instrument-modal" role="dialog" aria-modal="true" aria-label="Select chart instrument"><header><strong>Select instrument</strong><button onClick={onClose}>×</button></header><div className="picker-fields"><label>Type<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as TileConfig['kind'], expiry: '', strike: '' })}><option value="spot">Equity / index</option><option value="option" disabled={!instrument.option_eligible}>Option</option></select></label><label>Symbol<select value={draft.symbol} onChange={event => setDraft({ ...draft, symbol: event.target.value, expiry: '', strike: '' })}>{catalogue.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name}</option>)}</select></label><label>Browse date<input type="date" value={draft.tradingDate} onChange={event => setDraft({ ...draft, tradingDate: event.target.value, expiry: '', strike: '' })} /></label>{draft.kind === 'option' && <><label>Expiry<select value={draft.expiry} onChange={event => setDraft({ ...draft, expiry: event.target.value })} disabled={!metadata?.available}>{metadata?.expiries.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Underlying open<input value={openingPrice ?? 'Loading…'} readOnly /></label><label>Strike<select value={draft.strike} onChange={event => setDraft({ ...draft, strike: event.target.value })} disabled={!strikes.length}>{strikes.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Right<select value={draft.right} onChange={event => setDraft({ ...draft, right: event.target.value })}>{metadata?.rights.map(value => <option key={value} value={value}>{value}</option>)}</select></label></>}</div>{metadata && !metadata.available && <p className="tile-notice">{metadata.unavailable_reason}</p>}{error && <p className="tile-notice">{error}</p>}<footer><button onClick={onClose}>Cancel</button><button className="selected" disabled={draft.kind === 'option' && (!draft.expiry || !draft.strike || !metadata?.available)} onClick={() => void onSave(draft)}>Apply to chart</button></footer></section></div>
}

function ChartSettingsModal({ settings, tradingSettings, onSave, onSaveTradingSettings, onClose }: { settings: ChartSettings; tradingSettings: DesktopTradingSnapshot['settings'] | null; onSave: (settings: ChartSettings) => void; onSaveTradingSettings: (settings: Record<string, unknown>) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  const [tradingDraft, setTradingDraft] = useState(tradingSettings)
  useEffect(() => setTradingDraft(tradingSettings), [tradingSettings])
  return <div className="modal-backdrop"><section className="instrument-modal" role="dialog" aria-modal="true" aria-label="Chart display settings"><header><strong>Settings</strong><button onClick={onClose}>×</button></header><div className="settings-scroll"><section className="settings-section"><strong>Chart display</strong><div className="picker-fields"><label>Background<input type="color" value={draft.background} onChange={event => setDraft({ ...draft, background: event.target.value })} /></label><label>Text color<input type="color" value={draft.textColor} onChange={event => setDraft({ ...draft, textColor: event.target.value })} /></label><label>Grid color<input type="color" value={draft.gridColor} onChange={event => setDraft({ ...draft, gridColor: event.target.value })} /></label><label>Grid opacity <input type="range" min="0" max="1" step="0.02" value={draft.gridOpacity} onChange={event => setDraft({ ...draft, gridOpacity: Number(event.target.value) })} />{Math.round(draft.gridOpacity * 100)}%</label><label>Grid style<select value={draft.gridStyle} onChange={event => setDraft({ ...draft, gridStyle: event.target.value as ChartSettings['gridStyle'] })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label><label>Grid thickness<select value={draft.gridSize} onChange={event => setDraft({ ...draft, gridSize: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option></select></label><label>Moving average<select value={draft.movingAverageType} onChange={event => setDraft({ ...draft, movingAverageType: event.target.value as ChartSettings['movingAverageType'] })}><option value="MA">Simple MA</option><option value="EMA">Exponential MA</option></select></label><label>MA/EMA periods<input value={draft.movingAveragePeriods} onChange={event => setDraft({ ...draft, movingAveragePeriods: event.target.value.replace(/[^0-9,]/g, '') })} placeholder="5,10,20" /></label><label>Horizontal line color<input type="color" value={draft.horizontalLineColor} onChange={event => setDraft({ ...draft, horizontalLineColor: event.target.value })} /></label><label>Horizontal line width<select value={draft.horizontalLineWidth} onChange={event => setDraft({ ...draft, horizontalLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Trend line color<input type="color" value={draft.trendLineColor} onChange={event => setDraft({ ...draft, trendLineColor: event.target.value })} /></label><label>Trend line width<select value={draft.trendLineWidth} onChange={event => setDraft({ ...draft, trendLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Other drawing line<input type="color" value={draft.drawingLineColor} onChange={event => setDraft({ ...draft, drawingLineColor: event.target.value })} /></label><label>Other drawing width<select value={draft.drawingLineWidth} onChange={event => setDraft({ ...draft, drawingLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Shape fill color<input type="color" value={draft.drawingFillColor} onChange={event => setDraft({ ...draft, drawingFillColor: event.target.value })} /></label><label>Shape fill opacity <input type="range" min="0" max="0.8" step="0.02" value={draft.drawingFillOpacity} onChange={event => setDraft({ ...draft, drawingFillOpacity: Number(event.target.value) })} />{Math.round(draft.drawingFillOpacity * 100)}%</label></div></section>{tradingDraft && <section className="settings-section trading-settings-section"><strong>Trading</strong><div className="picker-fields"><label><span><input type="checkbox" checked={tradingDraft.desktop_hide_chart_labels} onChange={event => setTradingDraft({ ...tradingDraft, desktop_hide_chart_labels: event.target.checked })} /> Hide chart labels</span></label><label>Size<select value={tradingDraft.desktop_order_size_mode} onChange={event => setTradingDraft({ ...tradingDraft, desktop_order_size_mode: event.target.value as DesktopTradingSnapshot['settings']['desktop_order_size_mode'] })}><option value="quantity">Quantity</option><option value="funds_ratio">Funds ratio</option><option value="risk_ratio">Risk ratio</option></select></label><label>P&amp;L<select value={tradingDraft.desktop_pnl_display_mode} onChange={event => setTradingDraft({ ...tradingDraft, desktop_pnl_display_mode: event.target.value as DesktopTradingSnapshot['settings']['desktop_pnl_display_mode'] })}><option value="currency">Currency</option><option value="percent">Percent</option></select></label><label><span><input type="checkbox" checked={tradingDraft.desktop_confirm_flatten} onChange={event => setTradingDraft({ ...tradingDraft, desktop_confirm_flatten: event.target.checked })} /> Confirm Flatten</span></label></div></section>}</div><footer><button onClick={onClose}>Cancel</button><button className="selected" onClick={() => { onSave(draft); if (tradingDraft) onSaveTradingSettings({ ...tradingDraft }); onClose() }}>Save settings</button></footer></section></div>
}

function DesktopTile({ config, catalogue, connection, api, settings, serverUrl, replayCursor, replayRunId, replayCandle, replayAttached, liveTile, liveTicks, onLiveTick, onConfigure, onMaximize, onIntervalChange, maximized, active, indicators, drawingCommand, drawingAction, drawingMode, onDrawingComplete, onActivate, tradingSnapshot, pricePickAction, onPricePick, onOrderDrag, onOrderCancel, onOrderConvertRequest, onChartOrderAction, onStrategyDrag }: { config: TileConfig; catalogue: Instrument[]; connection: string; api: Api; settings: ChartSettings; serverUrl: string; replayCursor?: number; replayRunId?: string; replayCandle?: Candle; replayAttached?: boolean; liveTile?: LiveTileState; liveTicks: Candle[]; onLiveTick: (key: string, tick: Candle) => void; onConfigure: () => void; onMaximize: () => void; onIntervalChange: (interval: string) => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; drawingMode: DrawingMode; onDrawingComplete: (commandId: number, tool: string) => void; onActivate: () => void; tradingSnapshot?: DesktopTradingSnapshot | null; pricePickAction?: PricePickAction | null; onPricePick?: (price: number) => void; onOrderDrag?: (order: DesktopOrder, price: number) => void; onOrderCancel?: (order: DesktopOrder) => void; onOrderConvertRequest?: (order: DesktopOrder, target: ConversionTarget) => void; onChartOrderAction?: (tile: TileConfig, action: OrderAction, price: number, anchor: { x: number; y: number }) => void; onStrategyDrag?: (strategyId: string, price: number) => void }) {
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
  const subscribedTile = liveTile ?? activeLiveSnapshot?.tiles.find(tile => tile.tile_id === config.id)
  const liveInstrumentKey = subscribedTile ? canonicalKey(subscribedTile.instrument) : null
  const latestTick = subscribedTile?.latest_tick
  useEffect(() => {
    if (latestTick && liveInstrumentKey) onLiveTick(liveInstrumentKey, latestTick)
  }, [latestTick?.close, latestTick?.high, latestTick?.low, latestTick?.open, latestTick?.timestamp, liveInstrumentKey])
  const visibleCandles = subscribedTile ? aggregateLiveCandles(subscribedTile.candles ?? [], liveTicks, Number(config.interval)) : replayCandles(candles, replayCursor, replayCandle, Number(config.interval) * 60)
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
  return <div className={`workspace-tile ${maximized ? 'is-maximized' : ''}`}><ChartTile symbol={label} interval={`${config.interval}m`} supportedIntervals={catalogueInstrument.supported_intervals} onIntervalChange={onIntervalChange} candles={visibleCandles} loading={subscribedTile ? false : loading || replaySyncing} message={subscribedTile && subscribedTile.availability !== 'available' ? (subscribedTile.reason ?? subscribedTile.availability) : replaySyncing ? 'Attaching to replay...' : status} settings={settings} isReplaying={Boolean(replayCursor)} isLive={Boolean(subscribedTile)} replayDatasetKey={replayDatasetKey} instrument={chartInstrument} baseUrl={serverUrl} onConfigure={onConfigure} onMaximize={onMaximize} maximized={maximized} active={active} indicators={indicators} drawingCommand={drawingCommand} drawingAction={drawingAction} drawingMode={drawingMode} onDrawingComplete={onDrawingComplete} onActivate={onActivate} openOrders={tileOrders} strategies={tileStrategies} position={tilePosition} sessionCapital={tradingSnapshot?.session.session_capital ?? 0} tradingSettings={tradingSnapshot?.settings ?? null} tradingEnabled={Boolean(tradingSnapshot) && (config.kind === 'option' || tradingSnapshot?.session.instrument_type === 'options')} orderEntryEnabled={Boolean(tradingSnapshot) && config.kind === 'option'} underlyingStrategyEnabled={Boolean(tradingSnapshot) && config.kind === 'spot' && tradingSnapshot?.session.instrument_type === 'options'} pricePickAction={pricePickAction} onPricePick={onPricePick} onOrderDrag={onOrderDrag} onStrategyDrag={onStrategyDrag} onOrderCancel={onOrderCancel} onOrderConvertRequest={onOrderConvertRequest} onChartOrderAction={(action, price, anchor) => onChartOrderAction?.(config, action, price, anchor)} /></div>
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('desktop-server-url') ?? 'http://localhost:8700'), [email, setEmail] = useState('admin@tradematangi.com'), [password, setPassword] = useState('admin123'), [connection, setConnection] = useState<'connected' | 'reconnecting' | 'offline' | 'authentication_required'>('authentication_required'), [loginError, setLoginError] = useState(''), [browserToken, setBrowserToken] = useState(''), [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse'), [catalogue, setCatalogue] = useState<Instrument[]>(fallbackCatalogue), [screens, setScreens] = useState<Screen[]>([newScreen(1)]), [chartSettings, setChartSettings] = useState<ChartSettings>(defaultChartSettings), [showSettings, setShowSettings] = useState(false), [replay, setReplay] = useState<ReplaySnapshot | null>(null), [replayError, setReplayError] = useState(''), [runDate, setRunDate] = useState('2026-05-06'), [runStartTime, setRunStartTime] = useState('09:15'), [replaySpeed, setReplaySpeed] = useState('1'), [live, setLive] = useState<LiveSnapshot | null>(null), [liveError, setLiveError] = useState('')
  const [trading, setTrading] = useState<DesktopTradingSnapshot | null>(null), [tradingError, setTradingError] = useState(''), [tradingNotice, setTradingNotice] = useState(''), [pricePickAction, setPricePickAction] = useState<{ orderId?: string; conversion?: ConversionTarget; ticket?: TradeTicket } | null>(null), [tradeTicket, setTradeTicket] = useState<TradeTicket | null>(null), [underlyingStrategyTicket, setUnderlyingStrategyTicket] = useState<UnderlyingStrategyTicket | null>(null), [tradeLabelState, setTradeLabelState] = useState<DesktopTradeLabelState | null>(null), [labelMetadata, setLabelMetadata] = useState<DesktopLabelMetadata>(emptyLabelMetadata), [labelMetadataStatus, setLabelMetadataStatus] = useState<DesktopLabelMetadataStatus>('idle'), [labelMetadataError, setLabelMetadataError] = useState(''), [sharedTradingSession, setSharedTradingSession] = useState(false)
  const replayPollInFlight = useRef(false)
  const labelMetadataRequestIdRef = useRef(0)
  const tradingErrorTimerRef = useRef<number | null>(null)
  const screensLoadedRef = useRef(false)
  const screenSaveTimerRef = useRef<number | null>(null)
  const lastScreenPayloadRef = useRef('')
  const [googleLoading, setGoogleLoading] = useState(false), [googleReady, setGoogleReady] = useState(false), [googleAccountName, setGoogleAccountName] = useState(''), [pendingGoogleToken, setPendingGoogleToken] = useState<string | null>(null)
  const [walletOpen, setWalletOpen] = useState(false), [walletAmount, setWalletAmount] = useState('150000'), [tradeHistoryOpen, setTradeHistoryOpen] = useState(false)
  const [activeScreenId, setActiveScreenId] = useState(screens[0].id), [pickerTileId, setPickerTileId] = useState<string | null>(null), [maximizedTileId, setMaximizedTileId] = useState<string | null>(null)
  const [activeToolTileId, setActiveToolTileId] = useState(screens[0].tiles[0].id), [toolPanelOpen, setToolPanelOpen] = useState(true), [tileIndicators, setTileIndicators] = useState<Record<string, string[]>>({}), [drawingCommand, setDrawingCommand] = useState<DrawingCommand | null>(null), [drawingAction, setDrawingAction] = useState<DrawingAction | null>(null), [drawingMode, setDrawingMode] = useState<DrawingMode>('once'), [activeDrawingTool, setActiveDrawingTool] = useState<string | null>(null), [liveTickCache, setLiveTickCache] = useState<Record<string, Candle[]>>({})
  const clearTradingError = useCallback(() => {
    if (tradingErrorTimerRef.current !== null) window.clearTimeout(tradingErrorTimerRef.current)
    tradingErrorTimerRef.current = null
    setTradingError('')
  }, [])
  const reportTradingError = useCallback((error: unknown) => {
    if (tradingErrorTimerRef.current !== null) window.clearTimeout(tradingErrorTimerRef.current)
    setTradingError(String(error))
    tradingErrorTimerRef.current = window.setTimeout(() => {
      tradingErrorTimerRef.current = null
      setTradingError('')
    }, 10_000)
  }, [])
  useEffect(() => () => {
    if (tradingErrorTimerRef.current !== null) window.clearTimeout(tradingErrorTimerRef.current)
  }, [])
  const clearLiveTickCache = () => setLiveTickCache({})
  const setLiveSnapshot = (snapshot: LiveSnapshot | null) => { activeLiveSnapshot = snapshot; setLive(snapshot); if (snapshot) setLiveError('') }
  const updateLiveSnapshot = (updater: (snapshot: LiveSnapshot | null) => LiveSnapshot | null) => {
    setLive(current => {
      const next = updater(current)
      activeLiveSnapshot = next
      if (next) setLiveError('')
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
  }, [serverUrl, hasNativeHost])
  useEffect(() => { localStorage.setItem('desktop-server-url', serverUrl); if (hasNativeHost) void invoke<'connected' | 'offline' | 'authentication_required'>('desktop_connection_state', { baseUrl: serverUrl }).then(setConnection).catch(() => setConnection('offline')) }, [hasNativeHost, serverUrl])
  useEffect(() => { if (connection === 'connected') void api<Catalogue>('catalogue').then(value => setCatalogue(value.instruments)).catch(() => undefined) }, [browserToken, connection, serverUrl])
  useEffect(() => { if (connection !== 'connected') return; if (hasNativeHost) void invoke<{ settings: Partial<ChartSettings> }>('desktop_chart_settings', { baseUrl: serverUrl }).then(value => setChartSettings({ ...defaultChartSettings, ...value.settings })).catch(() => undefined); else void fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/chart-settings`, { headers: { Authorization: `Bearer ${browserToken}` } }).then(response => response.ok ? response.json() as Promise<{ settings: Partial<ChartSettings> }> : Promise.reject()).then(value => setChartSettings({ ...defaultChartSettings, ...value.settings })).catch(() => undefined) }, [browserToken, connection, serverUrl])
  const activeScreen = screens.find(screen => screen.id === activeScreenId) ?? screens[0], pickerTile = activeScreen.tiles.find(tile => tile.id === pickerTileId)
  const activeToolTile = activeScreen.tiles.some(tile => tile.id === activeToolTileId) ? activeToolTileId : activeScreen.tiles[0]?.id
  useEffect(() => {
    if (connection !== 'connected' || screensLoadedRef.current) return
    void desktopRecordRequest<{ screens: DesktopScreenRecord[] }>('screens', 'GET').then(value => {
      if (!value.screens.length) {
        screensLoadedRef.current = true
        return
      }
      const ordered = [...value.screens].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      const restored = ordered.map(normalizeScreen)
      const active = ordered.find(record => record.active) ?? ordered[0]
      const activeState = active.state ?? {}
      setScreens(restored)
      setActiveScreenId(activeState.id ?? active.screen_id)
      setTileIndicators(activeState.indicators ?? {})
      setActiveToolTileId(activeState.activeToolTileId ?? restored[0]?.tiles[0]?.id ?? '')
      screensLoadedRef.current = true
    }).catch(() => { screensLoadedRef.current = true })
  }, [connection, browserToken, serverUrl])
  useEffect(() => {
    if (connection !== 'connected' || !screensLoadedRef.current || !activeScreen) return
    const payloadKey = JSON.stringify(screens.map((screen, index) => ({ id: screen.id, name: screen.name, layout: screen.layout, tiles: screen.tiles, order: index, active: screen.id === activeScreenId, indicators: tileIndicators, activeToolTile })))
    if (payloadKey === lastScreenPayloadRef.current) return
    lastScreenPayloadRef.current = payloadKey
    if (screenSaveTimerRef.current) window.clearTimeout(screenSaveTimerRef.current)
    screenSaveTimerRef.current = window.setTimeout(() => {
      const snapshot = screens.map((screen, index) => ({ screen, index, active: screen.id === activeScreenId, state: screenState(screen) }))
      void Promise.all(snapshot.map(async item => {
        const body = { name: item.screen.name, state: item.state, order: item.index, active: item.active, mutation_id: crypto.randomUUID(), revision: item.screen.revision }
        if (item.screen.persistedId && item.screen.revision) {
          const updated = await desktopRecordRequest<DesktopScreenRecord>(`screens/${item.screen.persistedId}`, 'PUT', body)
          setScreens(current => current.map(screen => screen.id === item.screen.id ? { ...screen, revision: updated.revision } : screen))
        } else {
          const created = await desktopRecordRequest<DesktopScreenRecord>('screens', 'POST', body)
          setScreens(current => current.map(screen => screen.id === item.screen.id ? { ...screen, persistedId: created.screen_id, revision: created.revision } : screen))
        }
      })).catch(error => console.warn('screen persistence failed', error))
    }, 700)
    return () => { if (screenSaveTimerRef.current) window.clearTimeout(screenSaveTimerRef.current) }
  }, [screens, activeScreenId, tileIndicators, activeToolTile, connection, browserToken, serverUrl])
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
  const layoutTileCount: Record<Layout, number> = { '1': 1, '2-side': 2, '2-stacked': 2, '3-wide-top': 3, '4-grid': 4 }
  const setLayout = (layout: Layout) => setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, layout, tiles: layoutTileCount[layout] > screen.tiles.length ? [...screen.tiles, ...Array.from({ length: layoutTileCount[layout] - screen.tiles.length }, newTile)] : screen.tiles.slice(0, layoutTileCount[layout]) } : screen))
  const saveTile = async (tile: TileConfig) => {
    if (isHistoricalTradingMode(mode) && trading) {
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
  const duplicateScreen = () => { const mapped = activeScreen.tiles.map(tile => ({ from: tile.id, tile: { ...tile, id: crypto.randomUUID() } })); const next: Screen = { ...activeScreen, id: crypto.randomUUID(), persistedId: undefined, revision: undefined, name: `${activeScreen.name} Copy`, tiles: mapped.map(item => item.tile) }; setTileIndicators(current => ({ ...current, ...Object.fromEntries(mapped.map(item => [item.tile.id, current[item.from] ?? []])) })); setScreens(current => [...current, next]); setActiveScreenId(next.id); setActiveToolTileId(next.tiles[0]?.id ?? '') }
  const moveScreen = (direction: -1 | 1) => setScreens(current => { const index = current.findIndex(screen => screen.id === activeScreenId); const target = index + direction; if (index < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next })
  const closeScreen = () => {
    if (screens.length <= 1) return
    const closing = activeScreen
    setScreens(current => current.filter(screen => screen.id !== closing.id))
    const next = screens.find(screen => screen.id !== closing.id)
    if (next) setActiveScreenId(next.id)
    if (closing.persistedId) void desktopRecordRequest(`screens/${closing.persistedId}`, 'DELETE').catch(() => undefined)
  }
  const saveChartSettings = (settings: ChartSettings) => { setChartSettings(settings); setShowSettings(false); if (hasNativeHost) void invoke('save_desktop_chart_settings', { baseUrl: serverUrl, settings }); else void fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/chart-settings`, { method: 'PUT', headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) }) }
  const replayRequest = async <T = ReplaySnapshot,>(path: string, method: 'GET' | 'POST' | 'PUT', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_replay_request', { baseUrl: serverUrl, path, method, body })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/replay/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Replay request failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`)
    }
    return response.json() as Promise<T>
  }
  const liveRequest = async (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<LiveSnapshot> => { if (hasNativeHost) return invoke<LiveSnapshot>('desktop_live_request', { baseUrl: serverUrl, path, method, body }); const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/live/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`Live request failed (${response.status})`); return response.json() as Promise<LiveSnapshot> }
  const desktopRecordRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_drawing_request', { baseUrl: serverUrl, path, method, body })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) throw new Error(`Desktop record request failed (${response.status})`)
    return (response.status === 204 ? null : await response.json()) as T
  }
  const desktopTradingRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<T> => {
    if (hasNativeHost) return invoke<T>('desktop_drawing_request', { baseUrl: serverUrl, path: `trading/${path}`, method, body })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/trading/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Trading request failed (${response.status})${detail ? `: ${detail.slice(0, 220)}` : ''}`)
    }
    return (response.status === 204 ? null : await response.json()) as T
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
    if (!isHistoricalTradingMode(mode) || !trading?.session.session_id) {
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
    if (!isHistoricalTradingMode(mode) || !trading?.session.session_id) {
      labelMetadataRequestIdRef.current += 1
      setLabelMetadata(emptyLabelMetadata)
      setLabelMetadataStatus('idle')
      setLabelMetadataError('')
      return
    }
    void loadLabelMetadata()
  }, [mode, trading?.session.session_id])
  const screenState = (screen: Screen): PersistedScreenState => ({ id: screen.id, layout: screen.layout, tiles: screen.tiles, indicators: tileIndicators, activeToolTileId: activeToolTile })
  const normalizeScreen = (record: DesktopScreenRecord): Screen => ({ id: record.state?.id ?? record.screen_id, persistedId: record.screen_id, revision: record.revision, name: record.name, layout: record.state?.layout ?? '1', tiles: record.state?.tiles?.length ? record.state.tiles : [newTile()] })
  const startNativeStream = async (key: string, eventsPath: string, snapshotPath: string) => {
    if (!hasNativeHost) return
    await invoke('start_desktop_stream', { baseUrl: serverUrl, key, eventsPath, snapshotPath })
  }
  const stopNativeStream = (key: string) => {
    if (hasNativeHost) void invoke('stop_desktop_stream', { key })
  }
  const readNativeStream = async <T,>(key: string): Promise<T | null> => {
    if (!hasNativeHost) return null
    const snapshot = await invoke<DesktopStreamSnapshot<T>>('desktop_stream_snapshot', { key })
    if (snapshot.connection === 'authentication_required') {
      setConnection('authentication_required')
      setLoginError('Desktop session expired; please sign in again.')
      return null
    }
    if (snapshot.connection === 'offline' || snapshot.connection === 'reconnecting') setConnection(snapshot.connection)
    else if (connection !== 'connected') setConnection('connected')
    return snapshot.latest_payload
  }
  const applyLiveStreamPayload = (payload: unknown) => updateLiveSnapshot(current => applyLiveStreamPayloadToSnapshot(current, payload))
  const liveTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument, interval_minutes: Number(tile.interval) } }
  const liveTiles = () => activeScreen.tiles.map(liveTile)
  const startLive = async () => { try { setLiveError(''); clearLiveTickCache(); const next = await liveRequest('start', 'POST', { tiles: liveTiles() }); setLiveSnapshot(next); await startNativeStream(`live:${next.stream_id}`, `live/${next.stream_id}/events`, `live/${next.stream_id}/snapshot`) } catch (error) { setLiveError(String(error)) } }
  const stopLive = async () => { if (!live) return; try { stopNativeStream(`live:${live.stream_id}`); await liveRequest(`${live.stream_id}/stop`, 'POST'); setLiveSnapshot(null); clearLiveTickCache() } catch (error) { setLiveError(String(error)) } }
  const refreshLive = async () => { if (!live) return; try { setLiveSnapshot(await liveRequest(`${live.stream_id}/refresh`, 'POST')) } catch (error) { setLiveError(String(error)) } }
  useEffect(() => {
    if (mode !== 'Live' || !live) return
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
        if (!cancelled) setLiveError(String(error))
      }
    }
    void sync()
    return () => { cancelled = true }
  }, [mode, live?.stream_id, activeScreen.id, activeScreen.tiles])
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => {
      if (hasNativeHost) {
        void readNativeStream<unknown>(`live:${live.stream_id}`).then(applyLiveStreamPayload).catch(error => setLiveError(String(error)))
      } else {
        void liveRequest(`${live.stream_id}/snapshot`, 'GET').then(setLiveSnapshot).catch(error => setLiveError(String(error)))
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [live?.stream_id, hasNativeHost, serverUrl])
  useEffect(() => { if (mode === 'Live' && !live && connection === 'connected') void startLive() }, [mode])
  useEffect(() => { if (mode !== 'Live' && live) void stopLive() }, [mode])
  useEffect(() => { if (connection === 'authentication_required') clearLiveTickCache() }, [connection])
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (mode !== 'Live' || !live) return; if (event.key === 'F5') { event.preventDefault(); void refreshLive() } }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown) }, [live?.stream_id, mode])
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
      session_type: mode === 'Replay' ? 'sim' : 'stepwise',
      stepwise: mode === 'Stepwise',
      desktop_mode: mode.toLowerCase(),
    }
  }
  const startRun = async () => {
    try {
      setReplayError('')
      clearTradingError()
      const date = runDate
      setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(tile => ({ ...tile, tradingDate: date })) } : screen))
      const tiles = activeScreen.tiles.map(tile => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument } })
      const backendInterval = isHistoricalTradingMode(mode) ? Math.min(...activeScreen.tiles.map(tile => Number(tile.interval))) : Number(activeScreen.tiles[0].interval)
      const startBody = isHistoricalTradingMode(mode) ? tradingStartBody(date) : null
      let attached: DesktopTradingSnapshot | null = null
      if (startBody) {
        const activeParams = new URLSearchParams({ symbol: String(startBody.symbol), date, instrument_type: String(startBody.instrument_type), desktop_mode: mode.toLowerCase() })
        const active = await desktopTradingRequest<DesktopTradingSnapshot | null>(`active?${activeParams}`, 'GET')
        if (active && window.confirm(`Attach this screen to the active ${active.session.symbol} ${mode} session? Its orders, positions, wallet, and clock will remain shared.`)) attached = active
      }
      let tradeSnapshot: DesktopTradingSnapshot | null = attached
      if (startBody && !tradeSnapshot) {
        tradeSnapshot = await desktopTradingRequest<DesktopTradingSnapshot>('start', 'POST', startBody)
      }
      const attachedStartTime = attached?.current_time ? new Date(attached.current_time * 1000).toISOString().slice(11, 19) : `${runStartTime}:00`
      const initialCursor = tradeSnapshot && tradeSnapshot.current_time > 0 ? tradeSnapshot.current_time : undefined
      const next = await replayRequest('start', 'POST', { mode: mode.toLowerCase(), date, start_time: attachedStartTime, ...(initialCursor !== undefined ? { initial_cursor: initialCursor } : {}), initial_bar_index: tradeSnapshot?.current_bar_index, interval_seconds: backendInterval * 60, speed: Number(replaySpeed), trading_session_id: tradeSnapshot?.session.session_id, owns_trading_session: Boolean(startBody && tradeSnapshot && !attached), tiles })
      setReplay(next)
      await startNativeStream(`replay:${next.run_id}`, `replay/${next.run_id}/events`, `replay/${next.run_id}/snapshot`)
      if (startBody && tradeSnapshot) {
        if (attached) {
          setSharedTradingSession(true)
          setTradingNotice(`Attached to shared ${mode} session ${attached.session.session_id.slice(0, 8)}.`)
        } else {
          setSharedTradingSession(false)
        }
        setTrading(tradeSnapshot)
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
      if (isHistoricalTradingMode(mode)) reportTradingError(error)
    }
  }
  const replayAction = async (action: string) => {
    if (!replay) return
    try {
      const tradingSessionId = trading?.session.session_id
      if (action === 'stop' && mode === 'Stepwise' && tradingSessionId && !sharedTradingSession) {
        await desktopTradingRequest(`${tradingSessionId}/stop`, 'POST')
      }
      if (action === 'next-bar' && mode === 'Stepwise' && tradingSessionId) {
        const combined = await replayRequest<{ replay: ReplaySnapshot; trading: DesktopTradingSnapshot }>(`${replay.run_id}/next-bar`, 'POST', { trading_session_id: tradingSessionId })
        setReplay(combined.replay)
        setTrading(combined.trading)
        return
      }
      const next = await replayRequest(`${replay.run_id}/${action}`, 'POST')
      if (action === 'stop') { stopNativeStream(`replay:${replay.run_id}`); setTrading(null); setSharedTradingSession(false); setTradeTicket(null); setPricePickAction(null); clearTradingError() }
      setReplay(next)
    } catch (error) { setReplayError(String(error)); if (isHistoricalTradingMode(mode)) reportTradingError(error) }
  }
  const updateReplaySpeed = (value: string) => { setReplaySpeed(value); if (replay && replay.mode === 'replay' && replay.state !== 'stopped') void replayRequest(`${replay.run_id}/speed`, 'POST', { speed: Number(value) }).then(setReplay).catch(error => setReplayError(String(error))) }
  const replayTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument } }
  const switchMode = (value: 'Browse' | 'Live' | 'Replay' | 'Stepwise') => {
    if (value === 'Browse' && replay) {
      stopNativeStream(`replay:${replay.run_id}`)
      setReplay(null)
    }
    setMode(value)
    setRunDate(activeScreen.tiles[0].tradingDate)
  }
  useEffect(() => {
    if (!replay || replay.state === 'stopped') return
    let cancelled = false
    void replayRequest(`${replay.run_id}/tiles`, 'PUT', { tiles: activeScreen.tiles.map(replayTile) }).then(next => { if (!cancelled) setReplay(next) }).catch(error => { if (!cancelled) setReplayError(String(error)) })
    return () => { cancelled = true }
  }, [replay?.run_id, replay?.state, activeScreen.id, activeScreen.tiles, catalogue])
  useEffect(() => {
    if (!replay || replay.state === 'stopped') return
    const runId = replay.run_id
    const timer = window.setInterval(() => {
      if (replayPollInFlight.current) return
      replayPollInFlight.current = true
      const request = hasNativeHost && !(mode === 'Replay' && trading?.session.session_id) ? readNativeStream<ReplaySnapshot>(`replay:${runId}`) : replayRequest(`${runId}/snapshot`, 'GET')
      void request
        .then(next => {
          if (!next || next.run_id !== runId) return
          setReplay(next)
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
            setReplayError('Replay update unavailable; retrying…')
          }
        })
        .finally(() => { replayPollInFlight.current = false })
    }, 500)
    return () => window.clearInterval(timer)
  }, [replay?.run_id, replay?.state, hasNativeHost, serverUrl, mode, trading?.session.session_id])
  useEffect(() => {
    if (!isHistoricalTradingMode(mode) || !trading?.session.session_id) return
    const sessionId = trading.session.session_id
    const timer = window.setInterval(() => {
      void desktopTradingRequest<DesktopTradingSnapshot>(`${sessionId}/snapshot`, 'GET')
        .then(snapshot => { if (snapshot.session.session_id === sessionId) setTrading(snapshot) })
        .catch(reportTradingError)
    }, 800)
    return () => window.clearInterval(timer)
  }, [mode, trading?.session.session_id, serverUrl, browserToken])
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
      const key = contractKeyForTile(tile)
      return (key ? trading.contract_quotes?.[key]?.price : 0) || (tile.right === 'PE' ? trading.current_price_pe : trading.current_price_ce) || trading.current_price
    }
    return trading.current_price
  }
  const sizePayload = (ticket: TradeTicket): Record<string, unknown> => {
    if (!trading || !ticket.sizeKey) return { quantity: 1 }
    const settings = trading.settings
    if (settings.desktop_order_size_mode === 'funds_ratio') {
      const key = ticket.sizeKey as 'l' | 'm' | 'h'
      return { funds_ratio_pct: key === 'h' ? settings.funds_ratio_h_pct : key === 'm' ? settings.funds_ratio_m_pct : settings.funds_ratio_l_pct }
    }
    if (settings.desktop_order_size_mode === 'risk_ratio') {
      const key = ticket.sizeKey as 'l' | 'm' | 'h'
      return { risk_pct: key === 'h' ? settings.risk_ratio_h_pct : key === 'm' ? settings.risk_ratio_m_pct : settings.risk_ratio_l_pct }
    }
    return { quantity: Number(ticket.sizeKey) || 1 }
  }
  const startDesktopStrategy = async (strategyType: 'AutoStop' | 'TargetProfit' | 'LockProfit' | 'UnderlyingTargetProfit' | 'UnderlyingStoploss', right: 'CE' | 'PE', price: number, ticket?: TradeTicket) => {
    if (!trading) return
    // The desktop route scopes the URL by session, but it delegates to the
    // shared strategy request model which also requires session_id in its
    // validated request body.
    const body: Record<string, unknown> = { session_id: trading.session.session_id, strategy_type: strategyType, right }
    if (strategyType === 'TargetProfit' || strategyType === 'UnderlyingTargetProfit') body.target_profit_value = price
    if (strategyType === 'LockProfit') body.lock_profit_value = price
    if (strategyType === 'UnderlyingStoploss') body.underlying_sl_price = price
    if (strategyType === 'AutoStop' && ticket) {
      const sizing = sizePayload(ticket)
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
    if (!trading || !ticket.sizeKey || !ticket.orderType) return
    if (ticket.tile.kind !== 'option') throw new Error('Chart entry is available only for options')
    if (ticket.orderType === 'AUTO_STOP') {
      await startDesktopStrategy('AutoStop', ticket.tile.right as 'CE' | 'PE', ticket.slPrice, ticket)
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
  const cancelOrderLine = async (order: DesktopOrder) => {
    if (!trading) return
    await desktopTradingRequest<DesktopOrder | null>(`${trading.session.session_id}/orders/${order.order_id}`, 'DELETE')
    setTrading(snapshot => snapshot ? { ...snapshot, open_orders: snapshot.open_orders.filter(item => item.order_id !== order.order_id) } : snapshot)
  }
  const requestOrderConvert = (order: DesktopOrder, target: ConversionTarget) => setPricePickAction({ orderId: order.order_id, conversion: target })
  const completePricePick = async (price: number) => {
    if (!trading || !pricePickAction) return
    if (!Number.isFinite(price)) { setPricePickAction(null); return }
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
    if (action === 'START_UNDERLYING_TARGET' || action === 'START_UNDERLYING_SL') {
      setUnderlyingStrategyTicket({ strategyType: action === 'START_UNDERLYING_TARGET' ? 'UnderlyingTargetProfit' : 'UnderlyingStoploss', price, anchor })
      return
    }
    if (action === 'START_TARGET_PROFIT' || action === 'START_LOCK_PROFIT') {
      if (tile.kind !== 'option') throw new Error('Option chart required for this strategy')
      await startDesktopStrategy(action === 'START_TARGET_PROFIT' ? 'TargetProfit' : 'LockProfit', tile.right as 'CE' | 'PE', price)
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
    setTradeTicket({ tile, side: action === 'USE_SL_SELL' ? 'SELL' : 'BUY', slPrice: price, orderType: null, anchor })
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
  const saveDesktopTradingSettings = (settings: Record<string, unknown>) => {
    if (!trading) return
    void desktopTradingRequest('settings/current', 'PUT', { settings })
      .then(() => desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET'))
      .then(setTrading)
      .catch(reportTradingError)
  }
  const resetWallet = async () => {
    if (!trading) return
    const amount = Number(walletAmount)
    if (!Number.isFinite(amount) || amount < 0) { reportTradingError('Wallet reset amount must be a positive number'); return }
    await desktopTradingRequest(`${trading.session.session_id}/wallet/reset`, 'POST', { amount })
    const snapshot = await desktopTradingRequest<DesktopTradingSnapshot>(`${trading.session.session_id}/snapshot`, 'GET')
    setTrading(snapshot)
    clearTradingError()
    setWalletOpen(false)
  }
  const ticketSizeOptions = () => {
    if (!trading || trading.settings.desktop_order_size_mode === 'quantity') return ['1', '2', '3'] as const
    return ['l', 'm', 'h'] as const
  }
  const ticketSizeLabel = (key: string) => {
    if (!trading) return key.toUpperCase()
    const settings = trading.settings
    if (settings.desktop_order_size_mode === 'funds_ratio') {
      const pct = key === 'h' ? settings.funds_ratio_h_pct : key === 'm' ? settings.funds_ratio_m_pct : settings.funds_ratio_l_pct
      return `${key.toUpperCase()} ${Math.round(pct * 10000) / 100}%`
    }
    if (settings.desktop_order_size_mode === 'risk_ratio') {
      const pct = key === 'h' ? settings.risk_ratio_h_pct : key === 'm' ? settings.risk_ratio_m_pct : settings.risk_ratio_l_pct
      return `${pct}%`
    }
    return key
  }
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
    if (live) stopNativeStream(`live:${live.stream_id}`)
    if (replay) stopNativeStream(`replay:${replay.run_id}`)
    if (hasNativeHost) void invoke('desktop_logout', { baseUrl: serverUrl })
    setBrowserToken('')
    setLiveSnapshot(null)
    clearLiveTickCache()
    setReplay(null)
    setConnection('authentication_required')
  }
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label>{pendingGoogleToken ? <><p className="login-help">Google sign-in succeeded. Choose an account name to finish creating your Trade Matangi account.</p><label>Account name<input value={googleAccountName} onChange={event => setGoogleAccountName(event.target.value)} placeholder="Your display name" /></label><button className="login-button" disabled={googleLoading || !googleAccountName.trim()} onClick={() => void googleLogin(pendingGoogleToken, googleAccountName.trim())}>{googleLoading ? 'Creating account…' : 'Continue'}</button><button onClick={() => { setPendingGoogleToken(null); setGoogleAccountName('') }}>Use email instead</button></> : <><button className="google-login-button" disabled={googleLoading || (!hasNativeHost && !googleReady)} onClick={beginGoogleLogin}><span className="google-mark">G</span>{googleLoading ? 'Signing in…' : hasNativeHost || googleReady ? 'Continue with Google' : 'Loading Google…'}</button><div className="login-divider"><span />or<span /></div><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="login-button" onClick={login}>Sign in</button></>}{loginError && <p className="login-error">{loginError}</p>}</section></main>
  return <main>
    <header>
      <strong>Trade Matangi Charts</strong>
      <button className="icon-button panel-toggle" title={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-label={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-pressed={toolPanelOpen} onClick={() => setToolPanelOpen(value => !value)}>{toolPanelOpen ? '◧' : '◨'}</button>
      <nav className="screen-tabs">{screens.map(screen => <button key={screen.id} className={screen.id === activeScreenId ? 'active' : ''} onClick={() => { setActiveScreenId(screen.id); setMaximizedTileId(null) }}>{screen.name}</button>)}<button className="new-screen" onClick={addScreen}>＋</button></nav>
      <span className="screen-actions"><button className="icon-button" title="Rename screen" aria-label="Rename screen" onClick={renameScreen}>✎</button><button className="icon-button" title="Duplicate screen" aria-label="Duplicate screen" onClick={duplicateScreen}>⧉</button><button className="icon-button" title="Move screen left" aria-label="Move screen left" onClick={() => moveScreen(-1)}>‹</button><button className="icon-button" title="Move screen right" aria-label="Move screen right" onClick={() => moveScreen(1)}>›</button><button className="icon-button" title="Close screen" aria-label="Close screen" disabled={screens.length <= 1} onClick={closeScreen}>×</button></span>
      {(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected mode-button' : 'mode-button'} onClick={() => switchMode(value)} key={value}>{value}</button>)}
      {(mode === 'Replay' || mode === 'Stepwise') && <span className="run-controls"><label>Date <input type="date" value={runDate} onChange={event => setRunDate(event.target.value)} disabled={Boolean(replay && replay.state !== 'stopped')} /></label><label>Start <input type="time" value={runStartTime} onChange={event => setRunStartTime(event.target.value)} disabled={Boolean(replay && replay.state !== 'stopped')} step="60" /></label>{mode === 'Replay' && <label>Speed <select value={replaySpeed} onChange={event => updateReplaySpeed(event.target.value)}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.1">1.1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select></label>}{!replay || replay.state === 'stopped' ? <button className="run-start" onClick={startRun}>Start</button> : <>{mode === 'Replay' && <button className="run-pause" onClick={() => replayAction(replay.state === 'paused' ? 'resume' : 'pause')}>{replay.state === 'paused' ? 'Resume' : 'Pause'}</button>}{mode === 'Stepwise' && <button className="run-next" onClick={() => replayAction('next-bar')}>Next bar</button>}<button className="run-stop" onClick={() => replayAction('stop')}>Stop</button><small>{replay.bar_index} · {new Date(replay.cursor * 1000).toISOString().slice(11, 19)}</small></>}</span>}
      {mode === 'Live' && <span className="run-controls live-controls"><button onClick={live ? stopLive : startLive}>{live ? 'Stop' : 'Start'}</button><button onClick={refreshLive} disabled={!live}>Refresh Live charts</button></span>}
      {isHistoricalTradingMode(mode) && trading && <><span className="trading-pill">{sharedTradingSession ? 'Shared session' : 'This screen session'}</span><button className="trading-pill good wallet-button" onClick={() => { setWalletAmount(String(Math.round(trading.wallet_balance))); setWalletOpen(value => !value) }}>Wallet ₹{Math.round(trading.wallet_balance).toLocaleString('en-IN')}</button><span className={`trading-pill ${trading.pnl.day >= 0 ? 'good' : 'bad'}`}>P&L {trading.settings.desktop_pnl_display_mode === 'percent' ? `${trading.pnl.day_pct.toFixed(2)}%` : `₹${Math.round(trading.pnl.day).toLocaleString('en-IN')}`}</span><button className="flatten-button" onClick={flattenTrading}>Flatten</button></>}
      <label className="layout-control">Layout <select value={activeScreen.layout} onChange={event => setLayout(event.target.value as Layout)}><option value="1">1 chart</option><option value="2-side">2 side-by-side</option><option value="2-stacked">2 stacked</option><option value="3-wide-top">3 wide-top</option><option value="4-grid">4 grid</option></select></label>
      <button className="icon-button" title="Chart settings" aria-label="Chart settings" onClick={() => setShowSettings(true)}>⚙</button><span className={`connection ${connection}`}>● {connection}</span><button onClick={logoutDesktop}>Log out</button>
    </header>
    {(replayError || liveError || tradingError) && <p className="run-error">{replayError || liveError || tradingError}</p>}
    {!tradingError && tradingNotice && <p className="run-notice">{tradingNotice}</p>}
    {walletOpen && trading && <div className="wallet-popover">
      <strong>Wallet</strong>
      <span>Current ₹{Math.round(trading.wallet_balance).toLocaleString('en-IN')}</span>
      <label>Reset to<input type="number" min="0" value={walletAmount} onChange={event => setWalletAmount(event.target.value)} /></label>
      <div><button onClick={() => void resetWallet().catch(reportTradingError)}>Reset</button><button onClick={() => setWalletOpen(false)}>Close</button></div>
    </div>}
    {tradeTicket && <div className="trade-ticket" style={placeNearPoint(tradeTicket.anchor.x, tradeTicket.anchor.y, 260, 190)}>
      <header><strong>{tradeTicket.side} SL</strong><button onClick={() => { setTradeTicket(null); setPricePickAction(null) }}>x</button></header>
      <div className="ticket-row"><span>Stoploss</span><b>{tradeTicket.slPrice.toFixed(2)}</b></div>
      <div className="ticket-picker">
        <div className="ticket-buttons">{(['MARKET', 'LIMIT', 'TARGET', 'AUTO_STOP'] as const).map(orderType => <button key={orderType} className={tradeTicket.orderType === orderType ? 'active' : ''} onClick={() => chooseTicketOrderType(orderType)}>{orderTypeLabel(orderType)}</button>)}</div>
        <div className="ticket-buttons">{ticketSizeOptions().map(key => <button key={key} className={tradeTicket.sizeKey === key ? 'active' : ''} onClick={() => chooseTicketSize(key)}>{ticketSizeLabel(key)}</button>)}</div>
      </div>
      <div className="ticket-hint">{tradeTicket.orderType === 'MARKET' ? `Uses chart quote ${paneCurrentPrice(tradeTicket.tile).toFixed(2)}; proxy set by server` : tradeTicket.orderType === 'AUTO_STOP' ? 'Uses selected SL and saved sizing' : tradeTicket.orderType ? 'Pick price' : 'Type + size'}</div>
    </div>}
    {underlyingStrategyTicket && <div className="trade-ticket" style={placeNearPoint(underlyingStrategyTicket.anchor.x, underlyingStrategyTicket.anchor.y, 260, 150)}>
      <header><strong>{underlyingStrategyTicket.strategyType === 'UnderlyingTargetProfit' ? 'Underlying target' : 'Underlying SL'}</strong><button onClick={() => setUnderlyingStrategyTicket(null)}>x</button></header>
      <div className="ticket-row"><span>Underlying price</span><b>{underlyingStrategyTicket.price.toFixed(2)}</b></div>
      <div className="ticket-hint">Apply to the open option position:</div>
      <div className="ticket-buttons"><button onClick={() => { const picker = underlyingStrategyTicket; void startDesktopStrategy(picker.strategyType, 'CE', picker.price).then(() => setUnderlyingStrategyTicket(null)).catch(reportTradingError) }}>CE</button><button onClick={() => { const picker = underlyingStrategyTicket; void startDesktopStrategy(picker.strategyType, 'PE', picker.price).then(() => setUnderlyingStrategyTicket(null)).catch(reportTradingError) }}>PE</button></div>
    </div>}
    <section className={`workspace-shell ${toolPanelOpen ? '' : 'tools-collapsed'}`}>
      {toolPanelOpen && <WorkspaceToolPanel tiles={activeScreen.tiles} activeTileId={activeToolTile} setActiveTileId={setActiveToolTileId} indicators={selectedIndicators} toggleIndicator={toggleIndicator} clearIndicators={clearIndicators} sendDrawing={sendDrawing} sendDrawingAction={sendDrawingAction} activeDrawingTool={activeDrawingTool} drawingMode={drawingMode} setDrawingMode={setDrawingMode} tradeHistoryCount={trading?.trades.length ?? 0} onOpenTradeHistory={() => setTradeHistoryOpen(true)} labelState={isHistoricalTradingMode(mode) ? tradeLabelState : null} labelMetadata={labelMetadata} labelMetadataStatus={labelMetadataStatus} labelMetadataError={labelMetadataError} onReloadLabelMetadata={() => void loadLabelMetadata()} onSaveTradeLabel={saveTradeLabel} strategies={isHistoricalTradingMode(mode) ? trading?.strategies ?? [] : []} onCancelStrategy={cancelDesktopStrategy} onUpdateStrategyPrice={requestDesktopStrategyPrice} />}
      <section className={`tile-grid tiles-${activeScreen.layout} ${maximizedTileId ? 'has-maximized' : ''}`}>{activeScreen.tiles.map(tile => { const state = replay?.tile_states.find(item => item.tile_id === tile.id); const liveState = live?.tiles.find(item => item.tile_id === tile.id); const cacheKey = liveState?.instrument ? canonicalKey(liveState.instrument) : instrumentKeyForTile(tile, catalogue); return <DesktopTile key={tile.id} config={tile} catalogue={catalogue} connection={connection} api={api} settings={chartSettings} serverUrl={serverUrl} replayCursor={replay?.cursor} replayRunId={replay?.run_id} replayCandle={state?.candle} replayAttached={Boolean(state)} liveTile={liveState} liveTicks={liveTickCache[cacheKey] ?? []} onLiveTick={onLiveTick} maximized={maximizedTileId === tile.id} active={activeToolTile === tile.id} indicators={tileIndicators[tile.id] ?? noIndicators} drawingCommand={drawingCommand} drawingAction={drawingAction} drawingMode={drawingMode} onDrawingComplete={onDrawingComplete} onActivate={() => setActiveToolTileId(tile.id)} onConfigure={() => setPickerTileId(tile.id)} onMaximize={() => setMaximizedTileId(current => current === tile.id ? null : tile.id)} onIntervalChange={interval => saveTile({ ...tile, interval })} tradingSnapshot={isHistoricalTradingMode(mode) ? trading : null} pricePickAction={activeToolTile === tile.id ? pricePickAction : null} onPricePick={price => void completePricePick(price).catch(error => { setTradingNotice(''); reportTradingError(error) })} onOrderDrag={updateOrderLine} onStrategyDrag={updateDesktopStrategyPrice} onOrderCancel={cancelOrderLine} onOrderConvertRequest={requestOrderConvert} onChartOrderAction={(tileForAction, action, price, anchor) => void placeChartOrder(tileForAction, action, price, anchor).catch(error => { setTradingNotice(''); reportTradingError(error) })} />})}</section>
    </section>
    {tradeHistoryOpen && <TradeHistoryModal trades={trading?.trades ?? []} roundTrips={[...(tradeLabelState?.open ?? []), ...(tradeLabelState?.completed ?? [])]} labels={tradeLabelState?.labels ?? []} sessionCapital={trading?.session.session_capital ?? 0} onClose={() => setTradeHistoryOpen(false)} />}
    {pickerTile && <InstrumentPicker initial={pickerTile} catalogue={catalogue} api={api} onSave={saveTile} onClose={() => setPickerTileId(null)} />}{showSettings && <ChartSettingsModal settings={chartSettings} tradingSettings={isHistoricalTradingMode(mode) ? trading?.settings ?? null : null} onSave={saveChartSettings} onSaveTradingSettings={saveDesktopTradingSettings} onClose={() => setShowSettings(false)} />}
  </main>
}
