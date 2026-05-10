import { useState, useEffect, CSSProperties } from 'react'
import { SessionState } from '../hooks/useSimulation'
import api, { SymbolInfo } from '../services/api'

interface Props {
  sessionState: SessionState
  onStart: (symbol: string, date: string, startTime: string, speed: number) => Promise<void>
  onStop: () => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }
const label: CSSProperties = { fontSize: 13, color: '#8b949e' }
const selectStyle: CSSProperties = {
  background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 6, padding: '5px 10px', fontSize: 13,
}
const inputStyle: CSSProperties = { ...selectStyle, width: 110 }

function btn(color: string, disabled = false): CSSProperties {
  return {
    background: disabled ? '#21262d' : color,
    color: disabled ? '#484f58' : '#fff',
    border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600,
  }
}

export default function SessionControls({ sessionState, onStart, onStop, onPause, onResume }: Props) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [symbol, setSymbol] = useState('NIFTY')
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('09:15')
  const [speed, setSpeed] = useState(1.0)
  const [loading, setLoading] = useState(false)

  const idle = sessionState === 'idle' || sessionState === 'ended'
  const running = sessionState === 'running'
  const paused = sessionState === 'paused'

  // Load symbols once on mount
  useEffect(() => {
    api.getSymbols()
      .then(list => {
        setSymbols(list)
        if (list.length > 0 && !list.find(s => s.symbol === symbol)) {
          setSymbol(list[0].symbol)
        }
      })
      .catch(() => {/* backend may not be up yet */})
  }, [])

  // Load available dates whenever symbol changes
  useEffect(() => {
    if (!symbol) return
    api.getAvailableDates(symbol).then(dates => {
      setAvailableDates(dates)
      // Default to the latest available date
      if (dates.length > 0) setDate(dates[dates.length - 1])
    }).catch(() => setAvailableDates([]))
  }, [symbol])

  const handleStart = async () => {
    if (!date) return
    setLoading(true)
    try { await onStart(symbol, date, startTime + ':00', speed) } finally { setLoading(false) }
  }

  return (
    <div style={{ padding: '12px 16px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
      <div style={row}>
        <label style={label}>
          Symbol&nbsp;
          <select
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            style={selectStyle}
            disabled={!idle}
          >
            {symbols.length === 0
              ? <option value="NIFTY">NIFTY</option>
              : symbols.map(s => (
                <option key={s.symbol} value={s.symbol}>{s.display_name}</option>
              ))
            }
          </select>
        </label>

        <label style={label}>
          Date&nbsp;
          <select
            value={date}
            onChange={e => setDate(e.target.value)}
            style={selectStyle}
            disabled={!idle || availableDates.length === 0}
          >
            {availableDates.length === 0
              ? <option value="">No data</option>
              : availableDates.map(d => (
                <option key={d} value={d}>{d}</option>
              ))
            }
          </select>
        </label>

        <label style={label}>
          Start Time&nbsp;
          <input
            type="time" step="60" value={startTime}
            onChange={e => setStartTime(e.target.value)}
            style={inputStyle} disabled={!idle}
          />
        </label>

        <label style={label}>
          Speed&nbsp;
          <input
            type="number" min={0.05} max={100} step={0.5} value={speed}
            onChange={e => setSpeed(parseFloat(e.target.value) || 1)}
            style={{ ...inputStyle, width: 70 }} disabled={!idle}
          />
          <span style={{ marginLeft: 4 }}>x</span>
        </label>

        {idle && (
          <button style={btn('#1f6feb', loading || !date)} onClick={handleStart} disabled={loading || !date}>
            {loading ? 'Starting…' : 'Start Replay'}
          </button>
        )}
        {running && <button style={btn('#6e40c9')} onClick={onPause}>Pause</button>}
        {paused && <button style={btn('#1f6feb')} onClick={onResume}>Resume</button>}
        {(running || paused) && <button style={btn('#b62324')} onClick={onStop}>Stop</button>}
        {sessionState === 'ended' && (
          <span style={{ ...label, color: '#f85149' }}>Session ended — configure above and restart</span>
        )}
      </div>
    </div>
  )
}
