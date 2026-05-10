import { useState, CSSProperties } from 'react'
import { SessionState } from '../hooks/useSimulation'

interface Props {
  sessionState: SessionState
  onStart: (startTime: string, speed: number) => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }
const label: CSSProperties = { fontSize: 13, color: '#8b949e' }
const inputStyle: CSSProperties = {
  background: '#161b22', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 6, padding: '5px 10px', fontSize: 13, width: 110,
}

function btn(color: string, disabled = false): CSSProperties {
  return {
    background: disabled ? '#21262d' : color,
    color: disabled ? '#484f58' : '#fff',
    border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600,
  }
}

export default function SessionControls({ sessionState, onStart, onPause, onResume }: Props) {
  const [startTime, setStartTime] = useState('09:15')
  const [speed, setSpeed] = useState(1.0)
  const [loading, setLoading] = useState(false)

  const idle = sessionState === 'idle' || sessionState === 'ended'
  const running = sessionState === 'running'
  const paused = sessionState === 'paused'

  const handleStart = async () => {
    setLoading(true)
    try { await onStart(startTime + ':00', speed) } finally { setLoading(false) }
  }

  return (
    <div style={{ padding: '12px 16px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
      <div style={row}>
        <span style={label}>Symbol: <strong style={{ color: '#e6edf3' }}>NIFTY</strong></span>
        <span style={label}>Date: <strong style={{ color: '#e6edf3' }}>2026-05-06</strong></span>

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
          <button style={btn('#1f6feb', loading)} onClick={handleStart} disabled={loading}>
            {loading ? 'Starting…' : 'Start Replay'}
          </button>
        )}
        {running && (
          <button style={btn('#6e40c9')} onClick={onPause}>Pause</button>
        )}
        {paused && (
          <button style={btn('#1f6feb')} onClick={onResume}>Resume</button>
        )}
        {sessionState === 'ended' && (
          <span style={{ ...label, color: '#f85149' }}>Session ended</span>
        )}
      </div>
    </div>
  )
}
