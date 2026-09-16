import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartTile } from './ChartTile'
import type { Candle } from './contracts'

interface HistoricalPage { candles: Candle[]; available?: boolean; unavailable_reason?: string }
interface Instrument { symbol: string; display_name: string; chart_type: string; option_eligible: boolean; supported_intervals: number[] }
interface Catalogue { instruments: Instrument[] }
interface OptionMetadata { expiries: string[]; strike_interval: number; rights: string[]; available: boolean; unavailable_reason?: string }
const fallbackCatalogue: Instrument[] = [{ symbol: 'NIFTY', display_name: 'NIFTY 50', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] }]

export default function App() {
  const [serverUrl, setServerUrl] = useState('http://localhost:8700')
  const [email, setEmail] = useState('admin@tradematangi.com')
  const [password, setPassword] = useState('admin123')
  const [connection, setConnection] = useState<'connected' | 'offline' | 'authentication_required'>('authentication_required')
  const [loginError, setLoginError] = useState('')
  const [browserToken, setBrowserToken] = useState('')
  const [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse')
  const [tiles, setTiles] = useState(1)
  const [screen, setScreen] = useState('New Screen')
  const [catalogue, setCatalogue] = useState<Instrument[]>(fallbackCatalogue)
  const [instrumentType, setInstrumentType] = useState<'spot' | 'option'>('spot')
  const [symbol, setSymbol] = useState('NIFTY')
  const [interval, setInterval] = useState('1')
  const [tradingDate, setTradingDate] = useState('2026-05-06')
  const [optionMetadata, setOptionMetadata] = useState<OptionMetadata | null>(null)
  const [expiry, setExpiry] = useState('')
  const [strike, setStrike] = useState('')
  const [right, setRight] = useState('CE')
  const [candles, setCandles] = useState<Candle[]>([])
  const [historyStatus, setHistoryStatus] = useState('')
  const hasNativeHost = '__TAURI_INTERNALS__' in window
  const api = async <T,>(path: string, params?: URLSearchParams): Promise<T> => {
    if (hasNativeHost) {
      const commands: Record<string, string> = { catalogue: 'desktop_catalogue', metadata: 'desktop_option_metadata', history: 'desktop_historical_page', optionHistory: 'desktop_option_historical_page' }
      const values = Object.fromEntries((params ?? new URLSearchParams()).entries())
      return invoke<T>(commands[path], { baseUrl: serverUrl, ...values, intervalMinutes: Number(values.interval_minutes ?? interval), strike: Number(values.strike ?? strike) })
    }
    const route = path === 'catalogue' ? 'catalogue' : path === 'metadata' ? 'option-metadata' : path === 'history' ? 'historical/pages' : 'options/historical/pages'
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/desktop/v1/${route}${params ? `?${params}` : ''}`, { headers: { Authorization: `Bearer ${browserToken}` } })
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    return response.json() as Promise<T>
  }
  const login = async () => {
    try {
      setLoginError('')
      if (hasNativeHost) await invoke('desktop_login', { baseUrl: serverUrl, email, password })
      else {
        const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/desktop/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device_name: 'Browser development preview' }) })
        if (!response.ok) throw new Error('Login failed: check your email and password')
        setBrowserToken((await response.json() as { access_token: string }).access_token)
      }
      setConnection('connected')
    } catch (error) { setConnection('authentication_required'); setLoginError(String(error)) }
  }
  const logout = async () => { if (hasNativeHost) await invoke('desktop_logout'); setBrowserToken(''); setConnection('authentication_required') }
  useEffect(() => {
    if (connection !== 'connected') return
    void api<Catalogue>('catalogue').then(value => setCatalogue(value.instruments)).catch(error => setHistoryStatus(`Catalogue unavailable: ${String(error)}`))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserToken, connection, serverUrl])
  useEffect(() => {
    if (instrumentType !== 'option' || connection !== 'connected') return
    let active = true
    void api<OptionMetadata>('metadata', new URLSearchParams({ symbol, as_of_date: tradingDate })).then(value => {
      if (!active) return
      setOptionMetadata(value); setExpiry(value.expiries[0] ?? ''); setRight(value.rights[0] ?? 'CE')
      if (value.strike_interval && (!strike || Number(strike) % value.strike_interval !== 0)) setStrike(String(value.strike_interval * 100))
    }).catch(error => active && setHistoryStatus(`Option metadata unavailable: ${String(error)}`))
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserToken, connection, instrumentType, serverUrl, symbol, tradingDate])
  useEffect(() => {
    if (connection !== 'connected' || mode !== 'Browse') return
    if (instrumentType === 'option' && (!expiry || !strike || !optionMetadata?.available)) { setCandles([]); return }
    let active = true; setHistoryStatus('Loading history…')
    const params = new URLSearchParams({ symbol, trading_date: tradingDate, interval_minutes: interval, context_days: '5' })
    if (instrumentType === 'option') { params.set('expiry', expiry); params.set('strike', strike); params.set('right', right) }
    void api<HistoricalPage>(instrumentType === 'option' ? 'optionHistory' : 'history', params).then(page => {
      if (!active) return
      setCandles(page.candles); setHistoryStatus(page.available === false ? (page.unavailable_reason ?? 'This option is unavailable') : `${page.candles.length} candles loaded`)
    }).catch(error => active && (setCandles([]), setHistoryStatus(String(error))))
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserToken, connection, expiry, instrumentType, interval, mode, optionMetadata?.available, right, serverUrl, strike, symbol, tradingDate])
  const selectedInstrument = catalogue.find(item => item.symbol === symbol) ?? fallbackCatalogue[0]
  const chartLabel = instrumentType === 'option' ? `${symbol} ${expiry} ${strike} ${right}` : symbol
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>{loginError && <p className="login-error">{loginError}</p>}<button className="login-button" onClick={login}>Sign in</button></section></main>
  return <main><header><strong>Trade Matangi Charts</strong><label className="server">Server <input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><span className={`connection ${connection}`}>● {connection}</span><button onClick={logout}>Log out</button></header><nav><button className="active">{screen}</button><button onClick={() => setScreen(`Screen ${Date.now()}`)}>＋</button></nav><section className="toolbar"><select value={instrumentType} onChange={event => setInstrumentType(event.target.value as 'spot' | 'option')}><option value="spot">Equity / index</option><option value="option" disabled={!selectedInstrument.option_eligible}>Option</option></select><label>Symbol <select value={symbol} onChange={event => setSymbol(event.target.value)} aria-label="Symbol">{catalogue.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name} ({item.symbol})</option>)}</select></label><select value={interval} onChange={event => setInterval(event.target.value)} aria-label="Interval">{selectedInstrument.supported_intervals.map(value => <option key={value} value={value}>{value}m</option>)}</select><input type="date" value={tradingDate} onChange={event => setTradingDate(event.target.value)} aria-label="Browse date" />{instrumentType === 'option' && <><select value={expiry} onChange={event => setExpiry(event.target.value)} aria-label="Option expiry" disabled={!optionMetadata?.available}>{optionMetadata?.expiries.map(value => <option key={value} value={value}>{value}</option>)}</select><input value={strike} inputMode="numeric" onChange={event => setStrike(event.target.value.replace(/\D/g, ''))} aria-label="Option strike" placeholder={`Strike (${optionMetadata?.strike_interval ?? ''} steps)`} /><select value={right} onChange={event => setRight(event.target.value)} aria-label="Option right">{optionMetadata?.rights.map(value => <option key={value} value={value}>{value}</option>)}</select></>}{(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} key={value}>{value}</button>)}<select value={tiles} onChange={event => setTiles(Number(event.target.value))} aria-label="Layout"><option value="1">1 tile</option><option value="2">2 tiles</option><option value="4">4 tiles</option></select></section>{instrumentType === 'option' && optionMetadata && !optionMetadata.available && <p className="notice">{optionMetadata.unavailable_reason}</p>}<section className={`tile-grid tiles-${tiles}`}>{Array.from({ length: tiles }, (_, index) => <ChartTile key={index} symbol={index ? `${chartLabel} · Tile ${index + 1}` : chartLabel} interval={`${interval}m`} candles={candles} />)}</section><footer>{historyStatus || `${mode} · chart-only desktop prototype`} · no trading capabilities</footer></main>
}
