import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartTile } from './ChartTile'
import type { Candle } from './contracts'

interface HistoricalPage { candles: Candle[]; available?: boolean; unavailable_reason?: string }
interface Instrument { symbol: string; display_name: string; option_eligible: boolean; supported_intervals: number[] }
interface Catalogue { instruments: Instrument[] }
interface OptionMetadata { expiries: string[]; strike_interval: number; rights: string[]; available: boolean; unavailable_reason?: string }
interface TileConfig { id: string; kind: 'spot' | 'option'; symbol: string; interval: string; tradingDate: string; expiry: string; strike: string; right: string }
interface Screen { id: string; name: string; tiles: TileConfig[] }
type Api = <T,>(path: string, params?: URLSearchParams) => Promise<T>
const fallbackCatalogue: Instrument[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }]
const newTile = (): TileConfig => ({ id: crypto.randomUUID(), kind: 'spot', symbol: 'NIFTY', interval: '1', tradingDate: '2026-05-06', expiry: '', strike: '', right: 'CE' })
const newScreen = (number: number): Screen => ({ id: crypto.randomUUID(), name: `Screen ${number}`, tiles: [newTile()] })

function DesktopTile({ config, catalogue, connection, api, onChange }: { config: TileConfig; catalogue: Instrument[]; connection: string; api: Api; onChange: (next: TileConfig) => void }) {
  const [metadata, setMetadata] = useState<OptionMetadata | null>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [status, setStatus] = useState('')
  const instrument = catalogue.find(item => item.symbol === config.symbol) ?? fallbackCatalogue[0]
  useEffect(() => {
    if (connection !== 'connected' || config.kind !== 'option') return
    let active = true
    void api<OptionMetadata>('metadata', new URLSearchParams({ symbol: config.symbol, as_of_date: config.tradingDate })).then(value => {
      if (!active) return
      setMetadata(value)
      onChange({ ...config, expiry: value.expiries.includes(config.expiry) ? config.expiry : (value.expiries[0] ?? ''), right: value.rights.includes(config.right) ? config.right : (value.rights[0] ?? 'CE'), strike: value.strike_interval && Number(config.strike) % value.strike_interval === 0 ? config.strike : String(value.strike_interval * 100) })
    }).catch(error => active && setStatus(`Option metadata unavailable: ${String(error)}`))
  // A tile owns its option contract, so metadata follows only this tile's symbol/date.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.kind, config.symbol, config.tradingDate, connection])
  useEffect(() => {
    if (connection !== 'connected') return
    if (config.kind === 'option' && (!config.expiry || !config.strike || !metadata?.available)) { setCandles([]); return }
    let active = true; setStatus('Loading…')
    const params = new URLSearchParams({ symbol: config.symbol, trading_date: config.tradingDate, interval_minutes: config.interval, context_days: '5' })
    if (config.kind === 'option') { params.set('expiry', config.expiry); params.set('strike', config.strike); params.set('right', config.right) }
    void api<HistoricalPage>(config.kind === 'option' ? 'optionHistory' : 'history', params).then(page => {
      if (!active) return
      setCandles(page.candles); setStatus(page.available === false ? (page.unavailable_reason ?? 'Option unavailable') : `${page.candles.length} candles`)
    }).catch(error => active && (setCandles([]), setStatus(String(error))))
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.expiry, config.interval, config.kind, config.right, config.strike, config.symbol, config.tradingDate, connection, metadata?.available])
  const update = (changes: Partial<TileConfig>) => onChange({ ...config, ...changes })
  const label = config.kind === 'option' ? `${config.symbol} ${config.expiry} ${config.strike} ${config.right}` : config.symbol
  return <div className="workspace-tile"><div className="tile-controls"><select value={config.kind} onChange={event => update({ kind: event.target.value as TileConfig['kind'] })}><option value="spot">Equity / index</option><option value="option" disabled={!instrument.option_eligible}>Option</option></select><select value={config.symbol} onChange={event => update({ symbol: event.target.value, expiry: '', strike: '' })} aria-label="Tile symbol">{catalogue.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name}</option>)}</select><select value={config.interval} onChange={event => update({ interval: event.target.value })} aria-label="Tile interval">{instrument.supported_intervals.map(value => <option key={value} value={value}>{value}m</option>)}</select><input type="date" value={config.tradingDate} onChange={event => update({ tradingDate: event.target.value })} aria-label="Tile date" />{config.kind === 'option' && <><select value={config.expiry} onChange={event => update({ expiry: event.target.value })} disabled={!metadata?.available} aria-label="Option expiry">{metadata?.expiries.map(value => <option key={value} value={value}>{value}</option>)}</select><input value={config.strike} inputMode="numeric" placeholder={`Strike ${metadata?.strike_interval ?? ''}`} onChange={event => update({ strike: event.target.value.replace(/\D/g, '') })} aria-label="Option strike" /><select value={config.right} onChange={event => update({ right: event.target.value })} aria-label="Option right">{metadata?.rights.map(value => <option key={value} value={value}>{value}</option>)}</select></>}</div>{config.kind === 'option' && metadata && !metadata.available && <p className="tile-notice">{metadata.unavailable_reason}</p>}<ChartTile symbol={label} interval={`${config.interval}m`} candles={candles} /><small className="tile-status">{status}</small></div>
}

export default function App() {
  const [serverUrl, setServerUrl] = useState('http://localhost:8700')
  const [email, setEmail] = useState('admin@tradematangi.com')
  const [password, setPassword] = useState('admin123')
  const [connection, setConnection] = useState<'connected' | 'offline' | 'authentication_required'>('authentication_required')
  const [loginError, setLoginError] = useState('')
  const [browserToken, setBrowserToken] = useState('')
  const [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse')
  const [catalogue, setCatalogue] = useState<Instrument[]>(fallbackCatalogue)
  const [screens, setScreens] = useState<Screen[]>([newScreen(1)])
  const [activeScreenId, setActiveScreenId] = useState(screens[0].id)
  const hasNativeHost = '__TAURI_INTERNALS__' in window
  const api: Api = async (path, params) => {
    if (hasNativeHost) {
      const commands: Record<string, string> = { catalogue: 'desktop_catalogue', metadata: 'desktop_option_metadata', history: 'desktop_historical_page', optionHistory: 'desktop_option_historical_page' }
      const values = Object.fromEntries((params ?? new URLSearchParams()).entries())
      return invoke(commands[path], { baseUrl: serverUrl, ...values, intervalMinutes: Number(values.interval_minutes), strike: Number(values.strike) })
    }
    const route = path === 'catalogue' ? 'catalogue' : path === 'metadata' ? 'option-metadata' : path === 'history' ? 'historical/pages' : 'options/historical/pages'
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/${route}${params ? `?${params}` : ''}`, { headers: { Authorization: `Bearer ${browserToken}` } })
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    return response.json()
  }
  const login = async () => { try { setLoginError(''); if (hasNativeHost) await invoke('desktop_login', { baseUrl: serverUrl, email, password }); else { const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/desktop/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device_name: 'Browser development preview' }) }); if (!response.ok) throw new Error('Login failed: check your email and password'); setBrowserToken((await response.json() as { access_token: string }).access_token) }; setConnection('connected') } catch (error) { setConnection('authentication_required'); setLoginError(String(error)) } }
  const logout = async () => { if (hasNativeHost) await invoke('desktop_logout'); setBrowserToken(''); setConnection('authentication_required') }
  useEffect(() => { if (connection === 'connected') void api<Catalogue>('catalogue').then(value => setCatalogue(value.instruments)).catch(() => undefined) }, [browserToken, connection, serverUrl])
  const activeScreen = screens.find(screen => screen.id === activeScreenId) ?? screens[0]
  const setTileCount = (count: number) => setScreens(current => current.map(screen => screen.id !== activeScreenId ? screen : { ...screen, tiles: count > screen.tiles.length ? [...screen.tiles, ...Array.from({ length: count - screen.tiles.length }, newTile)] : screen.tiles.slice(0, count) }))
  const updateTile = (tile: TileConfig) => setScreens(current => current.map(screen => screen.id !== activeScreenId ? screen : { ...screen, tiles: screen.tiles.map(item => item.id === tile.id ? tile : item) }))
  const addScreen = () => { const next = newScreen(screens.length + 1); setScreens(current => [...current, next]); setActiveScreenId(next.id) }
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>{loginError && <p className="login-error">{loginError}</p>}<button className="login-button" onClick={login}>Sign in</button></section></main>
  return <main><header><strong>Trade Matangi Charts</strong><label className="server">Server <input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><span className={`connection ${connection}`}>● {connection}</span><button onClick={logout}>Log out</button></header><nav className="screen-tabs">{screens.map(screen => <button key={screen.id} className={screen.id === activeScreenId ? 'active' : ''} onClick={() => setActiveScreenId(screen.id)}>{screen.name}</button>)}<button className="new-screen" onClick={addScreen} aria-label="New screen">＋</button></nav><section className="toolbar"><strong>{mode}</strong>{(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} key={value}>{value}</button>)}<label className="layout-control">Layout <select value={activeScreen.tiles.length} onChange={event => setTileCount(Number(event.target.value))}><option value="1">1 tile</option><option value="2">2 tiles</option><option value="4">4 tiles</option></select></label></section><section className={`tile-grid tiles-${activeScreen.tiles.length}`}>{activeScreen.tiles.map(tile => <DesktopTile key={tile.id} config={tile} catalogue={catalogue} connection={connection} api={api} onChange={updateTile} />)}</section><footer>{mode} · {activeScreen.name} · chart-only desktop prototype · no trading capabilities</footer></main>
}
