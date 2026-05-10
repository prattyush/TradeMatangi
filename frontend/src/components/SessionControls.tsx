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

function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function lastWeekday(): string {
  const d = new Date()
  const day = d.getDay()
  if (day === 6) d.setDate(d.getDate() - 1)      // Saturday → Friday
  else if (day === 0) d.setDate(d.getDate() - 2)  // Sunday → Friday
  return formatLocalDate(d)
}

export default function SessionControls({
  sessionState, currentSymbol, currentDate,
  onSymbolChange, onDateChange,
  onStart, onStop, onPause, onResume,
}: Props) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [startTime, setStartTime] = useState('09:15')
  const [speed, setSpeed] = useState(1.0)
  const [loading, setLoading] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const idle = sessionState === 'idle' || sessionState === 'ended'
  const running = sessionState === 'running'
  const paused = sessionState === 'paused'

  const today = formatLocalDate(new Date())

  // Load symbols once on mount, then set default date
  useEffect(() => {
    api.getSymbols()
      .then(list => {
        setSymbols(list)
        if (list.length > 0 && !list.find(s => s.symbol === currentSymbol)) {
          onSymbolChange(list[0].symbol)
        }
      })
      .catch(() => {/* backend may not be up yet */})
    onDateChange(lastWeekday())
  }, [])

  const handleDateChange = (d: string) => {
    if (!d) return
    const [y, mo, day] = d.split('-').map(Number)
    const dow = new Date(y, mo - 1, day).getDay()
    if (dow === 0 || dow === 6) {
      setDateError('Markets are closed on weekends — please choose a weekday')
      return
    }
    setDateError(null)
    onDateChange(d)
  }

  const handleStart = async () => {
    if (!currentDate || dateError) return
    setStartError(null)
    setLoading(true)
    try {
      await onStart(startTime + ':00', speed)
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: '10px 16px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
      <div style={row}>
        <label style={label}>
          Symbol&nbsp;
          <select
            value={currentSymbol}
            onChange={e => onSymbolChange(e.target.value)}
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
          <input
            type="date"
            value={currentDate}
            max={today}
            onChange={e => handleDateChange(e.target.value)}
            style={inputStyle}
            disabled={!idle}
          />
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
          <button
            style={btn('#1f6feb', loading || !currentDate || !!dateError)}
            onClick={handleStart}
            disabled={loading || !currentDate || !!dateError}
          >
            {loading ? 'Loading data…' : 'Start Replay'}
          </button>
        )}
        {running && <button style={btn('#6e40c9')} onClick={onPause}>Pause</button>}
        {paused && <button style={btn('#1f6feb')} onClick={onResume}>Resume</button>}
        {(running || paused) && <button style={btn('#b62324')} onClick={onStop}>Stop</button>}
        {sessionState === 'ended' && (
          <span style={{ ...label, color: '#f85149' }}>Session ended — configure above and restart</span>
        )}
      </div>

      {(dateError || startError) && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#f85149' }}>
          {dateError || startError}
        </div>
      )}
    </div>
  )
}
