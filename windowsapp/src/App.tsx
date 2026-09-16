import { useState } from 'react'
import { ChartTile } from './ChartTile'
export default function App() {
  const [mode, setMode] = useState<'Browse' | 'Live' | 'Replay' | 'Stepwise'>('Browse')
  const [tiles, setTiles] = useState(1)
  const [screen, setScreen] = useState('New Screen')
  return <main><header><strong>Trade Matangi Charts</strong><label className="server">Server <input defaultValue="http://localhost:8700" /></label><span className="connection">● Reconnecting</span></header><nav><button className="active">{screen}</button><button onClick={() => setScreen(`Screen ${Date.now()}`)}>＋</button></nav><section className="toolbar"><label>⌕ <input defaultValue="NIFTY 50" aria-label="Symbol" /></label><select defaultValue="1m" aria-label="Interval"><option>1m</option><option>3m</option><option>5m</option></select><input type="date" defaultValue="2026-05-06" aria-label="Browse date" />{(['Browse', 'Live', 'Replay', 'Stepwise'] as const).map(value => <button className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} key={value}>{value}</button>)}<select value={tiles} onChange={event => setTiles(Number(event.target.value))} aria-label="Layout"><option value="1">1 tile</option><option value="2">2 tiles</option><option value="4">4 tiles</option></select></section><section className={`tile-grid tiles-${tiles}`}>{Array.from({ length: tiles }, (_, index) => <ChartTile key={index} symbol={index ? 'RELIANCE' : 'NIFTY 50'} interval="1m" />)}</section><footer>{mode} · chart-only desktop prototype · no trading capabilities</footer></main>
}
