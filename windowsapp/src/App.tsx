import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartTile } from './ChartTile'
export default function App() {
  const [serverUrl, setServerUrl] = useState('http://localhost:8700')
  const [email, setEmail] = useState('admin@tradematangi.com')
  const [password, setPassword] = useState('admin123')
  const [connection, setConnection] = useState<'connected' | 'offline' | 'authentication_required'>('authentication_required')
  const [loginError, setLoginError] = useState('')
  const [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse')
  const [tiles, setTiles] = useState(1)
  const [screen, setScreen] = useState('New Screen')
  const hasNativeHost = '__TAURI_INTERNALS__' in window
  const login = async () => {
    try {
      setLoginError('')
      if (hasNativeHost) {
        await invoke('desktop_login', { baseUrl: serverUrl, email, password })
      } else {
        // Browser fallback is for rapid UI iteration only. Production desktop
        // login always uses the native host and Windows Credential Manager.
        const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/desktop/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, device_name: 'Browser development preview' }) })
        if (!response.ok) throw new Error('Login failed: check your email and password')
      }
      setConnection('connected')
    } catch (error) { setConnection('authentication_required'); setLoginError(String(error)) }
  }
  const logout = async () => { if (hasNativeHost) await invoke('desktop_logout'); setConnection('authentication_required') }
  if (connection === 'authentication_required') return <main className="login-page"><section className="login-card"><h1>Trade Matangi Charts</h1><p>Sign in to the chart-only desktop companion.</p><label>Server URL<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><label>Email<input value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>{loginError && <p className="login-error">{loginError}</p>}<button className="login-button" onClick={login}>Sign in</button></section></main>
  return <main><header><strong>Trade Matangi Charts</strong><label className="server">Server <input value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><span className={`connection ${connection}`}>● {connection}</span><button onClick={logout}>Log out</button></header><nav><button className="active">{screen}</button><button onClick={() => setScreen(`Screen ${Date.now()}`)}>＋</button></nav><section className="toolbar"><label>⌕ <input defaultValue="NIFTY 50" aria-label="Symbol" /></label><select defaultValue="1m" aria-label="Interval"><option>1m</option><option>3m</option><option>5m</option></select><input type="date" defaultValue="2026-05-06" aria-label="Browse date" />{(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} key={value}>{value}</button>)}<select value={tiles} onChange={event => setTiles(Number(event.target.value))} aria-label="Layout"><option value="1">1 tile</option><option value="2">2 tiles</option><option value="4">4 tiles</option></select></section><section className={`tile-grid tiles-${tiles}`}>{Array.from({ length: tiles }, (_, index) => <ChartTile key={index} symbol={index ? 'RELIANCE' : 'NIFTY 50'} interval="1m" />)}</section><footer>{mode} · chart-only desktop prototype · no trading capabilities</footer></main>
}
