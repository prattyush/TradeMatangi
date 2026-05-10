import { useState, useEffect, CSSProperties } from 'react'
import { SessionState } from '../hooks/useSimulation'
import api, { SymbolInfo } from '../services/api'

interface Props {
  sessionState: SessionState
  currentSymbol: string
  currentDate: string
  onSymbolChange: (symbol: string) => void
  onDateChange: (date: string) => void
  onStart: (startTime: string, speed: number) => Promise<void>
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

export default function SessionControls({
  sessionState, currentSymbol, currentDate,
  onSymbolChange, onDateChange,
  onStart, onStop, onPause, onResume,
}: Props) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
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
        // If current symbol not in the list, default to first
        if (list.length > 0 && !list.find(s => s.symbol === currentSymbol)) {
          onSymbolChange(list[0].symbol)
        }
      })
      .catch(() => {/* backend may not be up yet */})
  }, [])

  // Load available dates whenever currentSymbol changes, notify parent of default date
  useEffect(() => {
    if (!currentSymbol) return
    api.getAvailableDates(currentSymbol).then(dates => {
      setAvailableDates(dates)
      if (dates.length > 0) onDateChange(dates[dates.length - 1])
    }).catch(() => setAvailableDates([]))
  }, [currentSymbol])

  const handleSymbolChange = (sym: string) => {
    onSymbolChange(sym)
  }

  const handleDateChange = (d: string) => {
    onDateChange(d)
  }

  const handleStart = async () => {
    if (!currentDate) return
    setLoading(true)
    try { await onStart(startTime + ':00', speed) } finally { setLoading(false) }
  }

  return (
    <div style={{ padding: '12px 16px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
      <div style={row}>
        <label style={label}>
          Symbol&nbsp;
          <select
            value={currentSymbol}
            onChange={e => handleSymbolChange(e.target.value)}
            style={selectStyle}
            disabled={!idle}
          >
            {symbols.length === 0
              ? <option value={currentSymbol}>{currentSymbol}</option>
              : symbols.map(s => (
                <option key={s.symbol} value={s.symbol}>{s.display_name}</option>
              ))
            }
          </select>
        </label>

        <label style={label}>
          Date&nbsp;
          <select
            value={currentDate}
            onChange={e => handleDateChange(e.target.value)}
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
          <button style={btn('#1f6feb', loading || !currentDate)} onClick={handleStart} disabled={loading || !currentDate}>
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
