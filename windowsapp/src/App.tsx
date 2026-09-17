import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartTile } from './ChartTile'
import { replayCandles } from './chartState'
import type { Candle } from './contracts'

interface HistoricalPage { candles: Candle[]; available?: boolean; unavailable_reason?: string }
interface Instrument { symbol: string; display_name: string; exchange: string; chart_type?: string; option_eligible: boolean; supported_intervals: number[] }
interface Catalogue { instruments: Instrument[] }
interface OptionMetadata { expiries: string[]; strike_interval: number; rights: string[]; available: boolean; unavailable_reason?: string }
interface TileConfig { id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string; expiry: string; strike: string; right: string }
type Layout = '1' | '2-side' | '2-stacked' | '3-wide-top' | '4-grid'
interface Screen { id: string; name: string; tiles: TileConfig[]; layout: Layout }
interface ReplaySnapshot { run_id: string; event_id: number; cursor: number; state: string; mode: string; bar_index: number; interval_seconds: number; tile_states: Array<{ tile_id: string; availability: string; candle?: Candle }> }
interface ChartSettings { background: string; textColor: string; gridColor: string; gridOpacity: number; gridStyle: 'solid' | 'dashed'; gridSize: number; movingAverageType: 'MA' | 'EMA'; movingAveragePeriods: string; liveProvider: 'breeze'; horizontalLineColor: string; horizontalLineWidth: number; trendLineColor: string; trendLineWidth: number; drawingLineColor: string; drawingLineWidth: number; drawingFillColor: string; drawingFillOpacity: number }
interface LiveTileState { tile_id: string; availability: string; reason?: string; candles?: Candle[]; instrument?: Record<string, unknown>; interval_minutes?: number }
interface LiveSnapshot { stream_id: string; event_id: number; tiles: LiveTileState[] }
interface DrawingCommand { id: number; tool: string }
interface DrawingAction { id: number; action: 'delete' | 'hide' | 'lock' }
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
type Api = <T,>(path: string, params?: URLSearchParams) => Promise<T>
const GOOGLE_CLIENT_ID = '249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com'
const fallbackCatalogue: Instrument[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }]
const defaultChartSettings: ChartSettings = { background: '#151a23', textColor: '#aeb8ca', gridColor: '#ffffff', gridOpacity: 0.12, gridStyle: 'solid', gridSize: 1, movingAverageType: 'MA', movingAveragePeriods: '5,10,20', liveProvider: 'breeze', horizontalLineColor: '#facc15', horizontalLineWidth: 2, trendLineColor: '#60a5fa', trendLineWidth: 2, drawingLineColor: '#60a5fa', drawingLineWidth: 2, drawingFillColor: '#60a5fa', drawingFillOpacity: 0.16 }
const noIndicators: string[] = []
const newTile = (): TileConfig => ({ id: crypto.randomUUID(), kind: 'spot', symbol: 'NIFTY', interval: '3', tradingDate: '2026-05-06', expiry: '', strike: '', right: 'CE' })
const newScreen = (number: number): Screen => ({ id: crypto.randomUUID(), name: `Screen ${number}`, layout: '1', tiles: [newTile()] })
const mainIndicators = ['MA', 'EMA', 'BOLL_TV', 'VWAP', 'SuperTrend', 'Ichimoku', 'MA_Ribbon', 'HMA', 'PivotPoints']
const subIndicators = ['RSI_TV', 'MACD_TV', 'Stochastic', 'CCI_TV']
const drawingTools = [
  { label: 'Horizontal', tool: 'Horizontal' },
  { label: 'Trend', tool: 'Trend' },
  { label: 'Ray', tool: 'ray' },
  { label: 'Arrow', tool: 'arrow' },
  { label: 'Rect', tool: 'rect' },
  { label: 'Brush', tool: 'brush' },
  { label: 'Fib', tool: 'Fib Retracement' },
  { label: 'Fib Ext', tool: 'fibonacciExtension' },
  { label: 'Fib Fan', tool: 'fibonacciSpeedResistanceFan' },
  { label: 'Parallel', tool: 'parallelChannel' },
  { label: 'Measure', tool: 'measure' },
  { label: 'Gann Box', tool: 'gannBox' },
  { label: 'Long', tool: 'longPosition' },
  { label: 'Short', tool: 'shortPosition' },
]

function WorkspaceToolPanel({ tiles, activeTileId, setActiveTileId, indicators, toggleIndicator, clearIndicators, sendDrawing, sendDrawingAction }: { tiles: TileConfig[]; activeTileId: string; setActiveTileId: (tileId: string) => void; indicators: string[]; toggleIndicator: (name: string) => void; clearIndicators: () => void; sendDrawing: (tool: string) => void; sendDrawingAction: (action: DrawingAction['action']) => void }) {
  return <aside className="tool-panel" aria-label="Chart tools">
    <label>Chart<select value={activeTileId} onChange={event => setActiveTileId(event.target.value)}>{tiles.map((tile, index) => <option key={tile.id} value={tile.id}>{index + 1}. {tile.kind === 'option' ? `${tile.symbol} ${tile.strike}${tile.right}` : tile.symbol}</option>)}</select></label>
    <section><strong>Draw</strong><div className="tool-grid">{drawingTools.map(item => <button key={item.tool} title={item.tool} onClick={() => sendDrawing(item.tool)}>{item.label}</button>)}</div><div className="tool-actions"><button onClick={() => sendDrawingAction('lock')}>Lock</button><button onClick={() => sendDrawingAction('hide')}>Hide</button><button onClick={() => sendDrawingAction('delete')}>Delete</button></div></section>
    <section><strong>Main indicators</strong><div className="tool-grid">{mainIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '').replace('_Ribbon', ' Ribbon')}</button>)}</div></section>
    <section><strong>Sub indicators</strong><div className="tool-grid">{subIndicators.map(name => <button key={name} className={indicators.includes(name) ? 'active' : ''} onClick={() => toggleIndicator(name)}>{name.replace('_TV', '')}</button>)}</div></section>
    <button className="panel-clear" disabled={!indicators.length} onClick={clearIndicators}>Clear indicators</button>
  </aside>
}

function InstrumentPicker({ initial, catalogue, api, onSave, onClose }: { initial: TileConfig; catalogue: Instrument[]; api: Api; onSave: (tile: TileConfig) => void; onClose: () => void }) {
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
  return <div className="modal-backdrop" role="presentation"><section className="instrument-modal" role="dialog" aria-modal="true" aria-label="Select chart instrument"><header><strong>Select instrument</strong><button onClick={onClose}>×</button></header><div className="picker-fields"><label>Type<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as TileConfig['kind'], expiry: '', strike: '' })}><option value="spot">Equity / index</option><option value="option" disabled={!instrument.option_eligible}>Option</option></select></label><label>Symbol<select value={draft.symbol} onChange={event => setDraft({ ...draft, symbol: event.target.value, expiry: '', strike: '' })}>{catalogue.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name}</option>)}</select></label><label>Browse date<input type="date" value={draft.tradingDate} onChange={event => setDraft({ ...draft, tradingDate: event.target.value, expiry: '', strike: '' })} /></label>{draft.kind === 'option' && <><label>Expiry<select value={draft.expiry} onChange={event => setDraft({ ...draft, expiry: event.target.value })} disabled={!metadata?.available}>{metadata?.expiries.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Underlying open<input value={openingPrice ?? 'Loading…'} readOnly /></label><label>Strike<select value={draft.strike} onChange={event => setDraft({ ...draft, strike: event.target.value })} disabled={!strikes.length}>{strikes.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>Right<select value={draft.right} onChange={event => setDraft({ ...draft, right: event.target.value })}>{metadata?.rights.map(value => <option key={value} value={value}>{value}</option>)}</select></label></>}</div>{metadata && !metadata.available && <p className="tile-notice">{metadata.unavailable_reason}</p>}{error && <p className="tile-notice">{error}</p>}<footer><button onClick={onClose}>Cancel</button><button className="selected" disabled={draft.kind === 'option' && (!draft.expiry || !draft.strike || !metadata?.available)} onClick={() => onSave(draft)}>Apply to chart</button></footer></section></div>
}

function ChartSettingsModal({ settings, onSave, onClose }: { settings: ChartSettings; onSave: (settings: ChartSettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  return <div className="modal-backdrop"><section className="instrument-modal" role="dialog" aria-modal="true" aria-label="Chart display settings"><header><strong>Chart display</strong><button onClick={onClose}>×</button></header><div className="picker-fields"><label>Background<input type="color" value={draft.background} onChange={event => setDraft({ ...draft, background: event.target.value })} /></label><label>Text color<input type="color" value={draft.textColor} onChange={event => setDraft({ ...draft, textColor: event.target.value })} /></label><label>Grid color<input type="color" value={draft.gridColor} onChange={event => setDraft({ ...draft, gridColor: event.target.value })} /></label><label>Grid opacity <input type="range" min="0" max="1" step="0.02" value={draft.gridOpacity} onChange={event => setDraft({ ...draft, gridOpacity: Number(event.target.value) })} />{Math.round(draft.gridOpacity * 100)}%</label><label>Grid style<select value={draft.gridStyle} onChange={event => setDraft({ ...draft, gridStyle: event.target.value as ChartSettings['gridStyle'] })}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></label><label>Grid thickness<select value={draft.gridSize} onChange={event => setDraft({ ...draft, gridSize: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option></select></label><label>Moving average<select value={draft.movingAverageType} onChange={event => setDraft({ ...draft, movingAverageType: event.target.value as ChartSettings['movingAverageType'] })}><option value="MA">Simple MA</option><option value="EMA">Exponential MA</option></select></label><label>MA/EMA periods<input value={draft.movingAveragePeriods} onChange={event => setDraft({ ...draft, movingAveragePeriods: event.target.value.replace(/[^0-9,]/g, '') })} placeholder="5,10,20" /></label><label>Horizontal line color<input type="color" value={draft.horizontalLineColor} onChange={event => setDraft({ ...draft, horizontalLineColor: event.target.value })} /></label><label>Horizontal line width<select value={draft.horizontalLineWidth} onChange={event => setDraft({ ...draft, horizontalLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Trend line color<input type="color" value={draft.trendLineColor} onChange={event => setDraft({ ...draft, trendLineColor: event.target.value })} /></label><label>Trend line width<select value={draft.trendLineWidth} onChange={event => setDraft({ ...draft, trendLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Other drawing line<input type="color" value={draft.drawingLineColor} onChange={event => setDraft({ ...draft, drawingLineColor: event.target.value })} /></label><label>Other drawing width<select value={draft.drawingLineWidth} onChange={event => setDraft({ ...draft, drawingLineWidth: Number(event.target.value) })}><option value="1">1px</option><option value="2">2px</option><option value="3">3px</option><option value="4">4px</option></select></label><label>Shape fill color<input type="color" value={draft.drawingFillColor} onChange={event => setDraft({ ...draft, drawingFillColor: event.target.value })} /></label><label>Shape fill opacity <input type="range" min="0" max="0.8" step="0.02" value={draft.drawingFillOpacity} onChange={event => setDraft({ ...draft, drawingFillOpacity: Number(event.target.value) })} />{Math.round(draft.drawingFillOpacity * 100)}%</label></div><footer><button onClick={onClose}>Cancel</button><button className="selected" onClick={() => onSave(draft)}>Save settings</button></footer></section></div>
}

function DesktopTile({ config, catalogue, connection, api, settings, serverUrl, replayCursor, replayRunId, replayCandle, replayAttached, liveTile, onConfigure, onMaximize, onIntervalChange, maximized, active, indicators, drawingCommand, drawingAction, onActivate }: { config: TileConfig; catalogue: Instrument[]; connection: string; api: Api; settings: ChartSettings; serverUrl: string; replayCursor?: number; replayRunId?: string; replayCandle?: Candle; replayAttached?: boolean; liveTile?: LiveTileState; onConfigure: () => void; onMaximize: () => void; onIntervalChange: (interval: string) => void; maximized: boolean; active: boolean; indicators: string[]; drawingCommand: DrawingCommand | null; drawingAction: DrawingAction | null; onActivate: () => void }) {
  const [metadata, setMetadata] = useState<OptionMetadata | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyVersion, setHistoryVersion] = useState(0)
  useEffect(() => { if (config.kind === 'option' && connection === 'connected') void api<OptionMetadata>('metadata', new URLSearchParams({ symbol: config.symbol, as_of_date: config.tradingDate })).then(setMetadata).catch(error => setStatus(String(error))) }, [config.kind, config.symbol, config.tradingDate, connection])
  useEffect(() => { if (connection !== 'connected' || (config.kind === 'option' && (!config.expiry || !config.strike || !metadata?.available))) return; let active = true; setCandles([]); setStatus(''); setLoading(true); const params = new URLSearchParams({ symbol: config.symbol, trading_date: config.tradingDate, interval_minutes: config.interval, context_days: '5' }); if (config.kind === 'option') { params.set('expiry', config.expiry); params.set('strike', config.strike); params.set('right', config.right) }; void api<HistoricalPage>(config.kind === 'option' ? 'optionHistory' : 'history', params).then(page => { if (active) { setCandles(page.candles); setHistoryVersion(version => version + 1); setStatus(page.available === false ? (page.unavailable_reason ?? 'Option unavailable') : '') } }).catch(error => active && setStatus(String(error))).finally(() => active && setLoading(false)); return () => { active = false } }, [config.expiry, config.interval, config.kind, config.right, config.strike, config.symbol, config.tradingDate, connection, metadata?.available])
  const label = config.kind === 'option' ? `${config.symbol} ${config.expiry} ${config.strike} ${config.right}` : config.symbol
  const catalogueInstrument = catalogue.find(item => item.symbol === config.symbol) ?? fallbackCatalogue[0]
  const chartInstrument = config.kind === 'option' ? { kind: 'option', exchange: catalogueInstrument.exchange, underlying: config.symbol, expiry: config.expiry, strike: Number(config.strike), right: config.right } : { kind: catalogueInstrument.chart_type ?? 'equity', exchange: catalogueInstrument.exchange, symbol: config.symbol }
  const subscribedTile = liveTile ?? activeLiveSnapshot?.tiles.find(tile => tile.tile_id === config.id)
  const visibleCandles = subscribedTile?.candles ?? replayCandles(candles, replayCursor, replayCandle, Number(config.interval) * 60)
  const replayDatasetKey = replayCursor ? `${replayRunId ?? 'pending'}:${historyVersion}` : undefined
  const replaySyncing = Boolean(replayCursor && !replayAttached)
  return <div className={`workspace-tile ${maximized ? 'is-maximized' : ''}`}><ChartTile symbol={label} interval={`${config.interval}m`} supportedIntervals={catalogueInstrument.supported_intervals} onIntervalChange={onIntervalChange} candles={visibleCandles} loading={subscribedTile ? false : loading || replaySyncing} message={subscribedTile && subscribedTile.availability !== 'available' ? (subscribedTile.reason ?? subscribedTile.availability) : replaySyncing ? 'Attaching to replay…' : status} settings={settings} isReplaying={Boolean(replayCursor)} replayDatasetKey={replayDatasetKey} instrument={chartInstrument} baseUrl={serverUrl} onConfigure={onConfigure} onMaximize={onMaximize} maximized={maximized} active={active} indicators={indicators} drawingCommand={drawingCommand} drawingAction={drawingAction} onActivate={onActivate} /></div>
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('desktop-server-url') ?? 'http://localhost:8700'), [email, setEmail] = useState('admin@tradematangi.com'), [password, setPassword] = useState('admin123'), [connection, setConnection] = useState<'connected' | 'offline' | 'authentication_required'>('authentication_required'), [loginError, setLoginError] = useState(''), [browserToken, setBrowserToken] = useState(''), [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse'), [catalogue, setCatalogue] = useState<Instrument[]>(fallbackCatalogue), [screens, setScreens] = useState<Screen[]>([newScreen(1)]), [chartSettings, setChartSettings] = useState<ChartSettings>(defaultChartSettings), [showSettings, setShowSettings] = useState(false), [replay, setReplay] = useState<ReplaySnapshot | null>(null), [replayError, setReplayError] = useState(''), [runDate, setRunDate] = useState('2026-05-06'), [runStartTime, setRunStartTime] = useState('09:15'), [replaySpeed, setReplaySpeed] = useState('1'), [live, setLive] = useState<LiveSnapshot | null>(null), [liveError, setLiveError] = useState('')
  const replayPollInFlight = useRef(false)
  const [googleLoading, setGoogleLoading] = useState(false), [googleReady, setGoogleReady] = useState(false), [googleAccountName, setGoogleAccountName] = useState(''), [pendingGoogleToken, setPendingGoogleToken] = useState<string | null>(null)
  const [activeScreenId, setActiveScreenId] = useState(screens[0].id), [pickerTileId, setPickerTileId] = useState<string | null>(null), [maximizedTileId, setMaximizedTileId] = useState<string | null>(null)
  const [activeToolTileId, setActiveToolTileId] = useState(screens[0].tiles[0].id), [toolPanelOpen, setToolPanelOpen] = useState(true), [tileIndicators, setTileIndicators] = useState<Record<string, string[]>>({}), [drawingCommand, setDrawingCommand] = useState<DrawingCommand | null>(null), [drawingAction, setDrawingAction] = useState<DrawingAction | null>(null)
  const setLiveSnapshot = (snapshot: LiveSnapshot | null) => { activeLiveSnapshot = snapshot; setLive(snapshot); if (snapshot) setLiveError('') }
  const hasNativeHost = '__TAURI_INTERNALS__' in window
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
  useEffect(() => { if (activeToolTile && activeToolTile !== activeToolTileId) setActiveToolTileId(activeToolTile) }, [activeToolTile, activeToolTileId])
  const selectedIndicators = tileIndicators[activeToolTile] ?? []
  const toggleIndicator = (name: string) => setTileIndicators(current => ({ ...current, [activeToolTile]: (current[activeToolTile] ?? []).includes(name) ? (current[activeToolTile] ?? []).filter(item => item !== name) : [...(current[activeToolTile] ?? []), name] }))
  const clearIndicators = () => setTileIndicators(current => ({ ...current, [activeToolTile]: [] }))
  const sendDrawing = (tool: string) => setDrawingCommand(command => ({ id: (command?.id ?? 0) + 1, tool }))
  const sendDrawingAction = (action: DrawingAction['action']) => setDrawingAction(command => ({ id: (command?.id ?? 0) + 1, action }))
  const layoutTileCount: Record<Layout, number> = { '1': 1, '2-side': 2, '2-stacked': 2, '3-wide-top': 3, '4-grid': 4 }
  const setLayout = (layout: Layout) => setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, layout, tiles: layoutTileCount[layout] > screen.tiles.length ? [...screen.tiles, ...Array.from({ length: layoutTileCount[layout] - screen.tiles.length }, newTile)] : screen.tiles.slice(0, layoutTileCount[layout]) } : screen))
  const saveTile = (tile: TileConfig) => { setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(item => item.id === tile.id ? tile : item) } : screen)); setPickerTileId(null) }
  const addScreen = () => { const next = newScreen(screens.length + 1); setScreens(current => [...current, next]); setActiveScreenId(next.id) }
  const saveChartSettings = (settings: ChartSettings) => { setChartSettings(settings); setShowSettings(false); if (hasNativeHost) void invoke('save_desktop_chart_settings', { baseUrl: serverUrl, settings }); else void fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/chart-settings`, { method: 'PUT', headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) }) }
  const replayRequest = async (path: string, method: 'GET' | 'POST' | 'PUT', body: Record<string, unknown> = {}): Promise<ReplaySnapshot> => {
    if (hasNativeHost) return invoke<ReplaySnapshot>('desktop_replay_request', { baseUrl: serverUrl, path, method, body })
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/replay/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Replay request failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`)
    }
    return response.json() as Promise<ReplaySnapshot>
  }
  const liveRequest = async (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}): Promise<LiveSnapshot> => { if (hasNativeHost) return invoke<LiveSnapshot>('desktop_live_request', { baseUrl: serverUrl, path, method, body }); const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/live/${path}`, { method, headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`Live request failed (${response.status})`); return response.json() as Promise<LiveSnapshot> }
  const liveTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument, interval_minutes: Number(tile.interval) } }
  const liveTiles = () => activeScreen.tiles.map(liveTile)
  const startLive = async () => { try { setLiveError(''); setLiveSnapshot(await liveRequest('start', 'POST', { tiles: liveTiles() })) } catch (error) { setLiveError(String(error)) } }
  const stopLive = async () => { if (!live) return; try { await liveRequest(`${live.stream_id}/stop`, 'POST'); setLiveSnapshot(null) } catch (error) { setLiveError(String(error)) } }
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
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => { void liveRequest(`${live.stream_id}/snapshot`, 'GET').then(setLiveSnapshot).catch(error => setLiveError(String(error))) }, 1000); return () => window.clearInterval(timer) }, [live?.stream_id])
  useEffect(() => { if (mode === 'Live' && !live && connection === 'connected') void startLive() }, [mode])
  useEffect(() => { if (mode !== 'Live' && live) void stopLive() }, [mode])
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (mode !== 'Live' || !live) return; if (event.key === 'F5') { event.preventDefault(); void refreshLive() } }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown) }, [live?.stream_id, mode])
  const startRun = async () => { try { setReplayError(''); const date = runDate; setScreens(current => current.map(screen => screen.id === activeScreenId ? { ...screen, tiles: screen.tiles.map(tile => ({ ...tile, tradingDate: date })) } : screen)); const tiles = activeScreen.tiles.map(tile => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument } }); const next = await replayRequest('start', 'POST', { mode: mode.toLowerCase(), date, start_time: `${runStartTime}:00`, interval_seconds: Number(activeScreen.tiles[0].interval) * 60, speed: Number(replaySpeed), tiles }); setReplay(next) } catch (error) { setReplayError(String(error)) } }
  const replayAction = async (action: string) => { if (!replay) return; try { const next = await replayRequest(`${replay.run_id}/${action}`, 'POST'); setReplay(action === 'stop' ? null : next) } catch (error) { setReplayError(String(error)) } }
  const replayTile = (tile: TileConfig) => { const item = catalogue.find(entry => entry.symbol === tile.symbol) ?? fallbackCatalogue[0]; const instrument = tile.kind === 'option' ? { kind: 'option', exchange: item.exchange, underlying: tile.symbol, expiry: tile.expiry, strike: Number(tile.strike), right: tile.right } : { kind: item.chart_type ?? 'equity', exchange: item.exchange, symbol: tile.symbol }; return { tile_id: tile.id, instrument } }
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
      void replayRequest(`${runId}/snapshot`, 'GET')
        .then(next => {
          if (next.run_id !== runId) return
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
  }, [replay?.run_id, replay?.state])
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label>{pendingGoogleToken ? <><p className="login-help">Google sign-in succeeded. Choose an account name to finish creating your Trade Matangi account.</p><label>Account name<input value={googleAccountName} onChange={event => setGoogleAccountName(event.target.value)} placeholder="Your display name" /></label><button className="login-button" disabled={googleLoading || !googleAccountName.trim()} onClick={() => void googleLogin(pendingGoogleToken, googleAccountName.trim())}>{googleLoading ? 'Creating account…' : 'Continue'}</button><button onClick={() => { setPendingGoogleToken(null); setGoogleAccountName('') }}>Use email instead</button></> : <><button className="google-login-button" disabled={googleLoading || (!hasNativeHost && !googleReady)} onClick={beginGoogleLogin}><span className="google-mark">G</span>{googleLoading ? 'Signing in…' : hasNativeHost || googleReady ? 'Continue with Google' : 'Loading Google…'}</button><div className="login-divider"><span />or<span /></div><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="login-button" onClick={login}>Sign in</button></>}{loginError && <p className="login-error">{loginError}</p>}</section></main>
  return <main>
    <header>
      <strong>Trade Matangi Charts</strong>
      <button className="icon-button panel-toggle" title={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-label={toolPanelOpen ? 'Hide chart tools' : 'Show chart tools'} aria-pressed={toolPanelOpen} onClick={() => setToolPanelOpen(value => !value)}>{toolPanelOpen ? '◧' : '◨'}</button>
      <nav className="screen-tabs">{screens.map(screen => <button key={screen.id} className={screen.id === activeScreenId ? 'active' : ''} onClick={() => { setActiveScreenId(screen.id); setMaximizedTileId(null) }}>{screen.name}</button>)}<button className="new-screen" onClick={addScreen}>＋</button></nav>
      {(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected mode-button' : 'mode-button'} onClick={() => { setMode(value); setRunDate(activeScreen.tiles[0].tradingDate); if (value === 'Browse') setReplay(null) }} key={value}>{value}</button>)}
      {(mode === 'Replay' || mode === 'Stepwise') && <span className="run-controls"><label>Date <input type="date" value={runDate} onChange={event => setRunDate(event.target.value)} disabled={Boolean(replay && replay.state !== 'stopped')} /></label><label>Start <input type="time" value={runStartTime} onChange={event => setRunStartTime(event.target.value)} disabled={Boolean(replay && replay.state !== 'stopped')} step="60" /></label>{mode === 'Replay' && <label>Speed <select value={replaySpeed} onChange={event => setReplaySpeed(event.target.value)} disabled={Boolean(replay && replay.state !== 'stopped')}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select></label>}{!replay || replay.state === 'stopped' ? <button onClick={startRun}>Start</button> : <>{mode === 'Replay' && <button onClick={() => replayAction(replay.state === 'paused' ? 'resume' : 'pause')}>{replay.state === 'paused' ? 'Resume' : 'Pause'}</button>}{mode === 'Stepwise' && <button onClick={() => replayAction('next-bar')}>Next bar</button>}<button onClick={() => replayAction('stop')}>Stop</button><small>{replay.bar_index} · {new Date(replay.cursor * 1000).toISOString().slice(11, 19)}</small></>}</span>}
      {mode === 'Live' && <span className="run-controls live-controls"><button onClick={live ? stopLive : startLive}>{live ? 'Stop' : 'Start'}</button><button onClick={refreshLive} disabled={!live}>Refresh Live charts</button></span>}
      <label className="layout-control">Layout <select value={activeScreen.layout} onChange={event => setLayout(event.target.value as Layout)}><option value="1">1 chart</option><option value="2-side">2 side-by-side</option><option value="2-stacked">2 stacked</option><option value="3-wide-top">3 wide-top</option><option value="4-grid">4 grid</option></select></label>
      <button className="icon-button" title="Chart settings" aria-label="Chart settings" onClick={() => setShowSettings(true)}>⚙</button><span className={`connection ${connection}`}>● {connection}</span><button onClick={() => { if (hasNativeHost) void invoke('desktop_logout'); setBrowserToken(''); setConnection('authentication_required') }}>Log out</button>
    </header>
    {(replayError || liveError) && <p className="run-error">{replayError || liveError}</p>}
    <section className={`workspace-shell ${toolPanelOpen ? '' : 'tools-collapsed'}`}>
      {toolPanelOpen && <WorkspaceToolPanel tiles={activeScreen.tiles} activeTileId={activeToolTile} setActiveTileId={setActiveToolTileId} indicators={selectedIndicators} toggleIndicator={toggleIndicator} clearIndicators={clearIndicators} sendDrawing={sendDrawing} sendDrawingAction={sendDrawingAction} />}
      <section className={`tile-grid tiles-${activeScreen.layout} ${maximizedTileId ? 'has-maximized' : ''}`}>{activeScreen.tiles.map(tile => { const state = replay?.tile_states.find(item => item.tile_id === tile.id); return <DesktopTile key={tile.id} config={tile} catalogue={catalogue} connection={connection} api={api} settings={chartSettings} serverUrl={serverUrl} replayCursor={replay?.cursor} replayRunId={replay?.run_id} replayCandle={state?.candle} replayAttached={Boolean(state)} maximized={maximizedTileId === tile.id} active={activeToolTile === tile.id} indicators={tileIndicators[tile.id] ?? noIndicators} drawingCommand={drawingCommand} drawingAction={drawingAction} onActivate={() => setActiveToolTileId(tile.id)} onConfigure={() => setPickerTileId(tile.id)} onMaximize={() => setMaximizedTileId(current => current === tile.id ? null : tile.id)} onIntervalChange={interval => saveTile({ ...tile, interval })} />})}</section>
    </section>
    {pickerTile && <InstrumentPicker initial={pickerTile} catalogue={catalogue} api={api} onSave={saveTile} onClose={() => setPickerTileId(null)} />}{showSettings && <ChartSettingsModal settings={chartSettings} onSave={saveChartSettings} onClose={() => setShowSettings(false)} />}
  </main>
}
