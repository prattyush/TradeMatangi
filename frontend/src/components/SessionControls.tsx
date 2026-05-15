import { useState, useEffect, CSSProperties, ReactNode } from 'react'
import { SessionState } from '../hooks/useSimulation'
import api, { SymbolInfo } from '../services/api'
import { InstrumentConfig } from '../hooks/useSimulation'

interface Props {
  sessionState: SessionState
  currentSymbol: string
  currentDate: string
  onSymbolChange: (symbol: string) => void
  onDateChange: (date: string) => void
  onStart: (startTime: string, speed: number, instrumentConfig: InstrumentConfig) => Promise<void>
  onStop: () => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onOptionsReady: (cfg: OptionsReadyConfig | null) => void
  extraControls?: ReactNode
}

export interface OptionsReadyConfig {
  strike: number
  ceStrike: number
  peStrike: number
  expiry: string
  atmStrike: number
  underlyingPrice: number
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

function toggleBtn(active: boolean, disabled = false): CSSProperties {
  return {
    background: active ? '#1f6feb' : '#21262d',
    color: active ? '#fff' : (disabled ? '#484f58' : '#8b949e'),
    border: `1px solid ${active ? '#1f6feb' : '#30363d'}`,
    borderRadius: 6, padding: '5px 12px', fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: active ? 600 : 400,
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
  if (day === 6) d.setDate(d.getDate() - 1)
  else if (day === 0) d.setDate(d.getDate() - 2)
  return formatLocalDate(d)
}

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

const STRIKE_INTERVALS: Record<string, number> = {
  NIFTY: 50, BSESEN: 100, RELIND: 5, TATMOT: 5, TATPOW: 5,
}

const OPTIONS_ONLY_SYMBOLS = new Set(['NIFTY', 'BSESEN'])

export default function SessionControls({
  sessionState, currentSymbol, currentDate,
  onSymbolChange, onDateChange,
  onStart, onStop, onPause, onResume,
  onOptionsReady,
  extraControls,
}: Props) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [startTime, setStartTime] = useState('09:15')
  const [speed, setSpeed] = useState(1.0)
  const [loading, setLoading] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>(
    OPTIONS_ONLY_SYMBOLS.has(currentSymbol) ? 'options' : 'equity'
  )
  const [optionsOffset, setOptionsOffset] = useState(0)

  const idle = sessionState === 'idle' || sessionState === 'ended'
  const running = sessionState === 'running'
  const paused = sessionState === 'paused'
  const today = formatLocalDate(new Date())
  const isPaperMode = currentDate === todayIST()

  // Load symbols once on mount; set date to last weekday
  useEffect(() => {
    api.getSymbols()
      .then(list => {
        setSymbols(list)
        if (list.length > 0 && !list.find(s => s.symbol === currentSymbol)) {
          onSymbolChange(list[0].symbol)
        }
      })
      .catch(() => {})
    onDateChange(lastWeekday())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Force options when NIFTY is selected
  useEffect(() => {
    if (OPTIONS_ONLY_SYMBOLS.has(currentSymbol) && instrumentType !== 'options') {
      setInstrumentType('options')
    }
  }, [currentSymbol]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDateChange = (d: string) => {
    if (!d) return
    const [y, mo, day] = d.split('-').map(Number)
    const dow = new Date(y, mo - 1, day).getDay()
    if (dow === 0 || dow === 6) {
      setDateError('Markets are closed on weekends — please choose a weekday')
      return
    }
    setDateError(null)
    setStartError(null)
    onDateChange(d)
  }

  const handleSymbolChange = (sym: string) => {
    setStartError(null)
    onSymbolChange(sym)
    if (OPTIONS_ONLY_SYMBOLS.has(sym)) setInstrumentType('options')
  }

  const handleStart = async () => {
    if (!currentDate || dateError) return
    setStartError(null)
    setLoading(true)
    try {
      let config: InstrumentConfig = { instrument_type: 'equity' }

      if (instrumentType === 'options') {
        // Fetch ATM price + expiry only when the user actually starts
        try {
          const [priceRes, expiryRes] = await Promise.all([
            api.getPriceAt(currentSymbol, currentDate, '09:15'),
            api.getExpiry(currentSymbol, currentDate),
          ])
          const interval = STRIKE_INTERVALS[currentSymbol] ?? 50
          const atmStrike = Math.round(priceRes.price / interval) * interval
          const ceStrike = atmStrike + optionsOffset * interval
          const peStrike = atmStrike - optionsOffset * interval
          const cfg: OptionsReadyConfig = {
            strike: atmStrike,
            ceStrike,
            peStrike,
            expiry: expiryRes.expiry,
            atmStrike,
            underlyingPrice: priceRes.price,
          }
          onOptionsReady(cfg)
          config = {
            instrument_type: 'options',
            strike: cfg.strike,
            expiry: cfg.expiry,
            strike_ce: cfg.ceStrike,
            strike_pe: cfg.peStrike,
            session_type: isPaperMode ? 'paper' : 'sim',
          }
        } catch (e) {
          setStartError(e instanceof Error ? e.message : 'Could not fetch options data — check backend connection')
          setLoading(false)
          return
        }
      } else {
        onOptionsReady(null)
        config = { instrument_type: 'equity', session_type: isPaperMode ? 'paper' : 'sim' }
      }

      // Paper mode always replays from market open (09:15) to "now", then streams live
      await onStart(isPaperMode ? '09:15:00' : startTime + ':00', isPaperMode ? 1.0 : speed, config)
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session')
    } finally {
      setLoading(false)
    }
  }

  const canStart = idle && !loading && !!currentDate && !dateError

  return (
    <div style={{ padding: '10px 16px', background: '#161b22', borderBottom: '1px solid #30363d' }}>
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
              : symbols.map(s => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)
            }
          </select>
        </label>

        {/* Instrument type toggle */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            style={toggleBtn(instrumentType === 'equity', !idle || OPTIONS_ONLY_SYMBOLS.has(currentSymbol))}
            onClick={() => idle && !OPTIONS_ONLY_SYMBOLS.has(currentSymbol) && setInstrumentType('equity')}
            title={OPTIONS_ONLY_SYMBOLS.has(currentSymbol) ? 'NIFTY can only trade options' : undefined}
          >
            Equity
          </button>
          <button
            style={toggleBtn(instrumentType === 'options', !idle)}
            onClick={() => idle && setInstrumentType('options')}
          >
            Options
          </button>
        </div>

        <label style={label}>
          Date&nbsp;
          <input
            type="date" value={currentDate} max={today}
            onChange={e => handleDateChange(e.target.value)}
            style={inputStyle} disabled={!idle}
          />
        </label>

        {!isPaperMode && (
          <label style={label}>
            Start Time&nbsp;
            <input
              type="time" step="60" value={startTime}
              onChange={e => setStartTime(e.target.value)}
              style={inputStyle} disabled={!idle}
            />
          </label>
        )}

        {isPaperMode ? (
          <span style={{
            background: '#0d4f2e', color: '#3fb950', border: '1px solid #3fb950',
            borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700,
            letterSpacing: 1,
          }}>● LIVE</span>
        ) : (
          <label style={label}>
            Speed&nbsp;
            <input
              type="number" min={0.05} max={100} step={0.5} value={speed}
              onChange={e => setSpeed(parseFloat(e.target.value) || 1)}
              style={{ ...inputStyle, width: 70 }} disabled={!idle}
            />
            <span style={{ marginLeft: 4 }}>x</span>
          </label>
        )}

        {/* OTM offset — always visible; disabled when equity or session active */}
        <label style={{ ...label, fontSize: 12, opacity: instrumentType === 'equity' ? 0.4 : 1 }}>
          OTM&nbsp;
          <input
            type="number"
            value={optionsOffset}
            onChange={e => setOptionsOffset(parseInt(e.target.value) || 0)}
            style={{ ...inputStyle, width: 55, fontSize: 12 }}
            min={-10} max={10}
            disabled={instrumentType === 'equity' || !idle}
          />
          <span style={{ marginLeft: 4, fontSize: 11, color: '#484f58' }}>(0=ATM)</span>
        </label>

        {idle && (
          <button
            style={btn(isPaperMode ? '#1a7f37' : '#1f6feb', !canStart)}
            onClick={handleStart}
            disabled={!canStart}
          >
            {loading
              ? (instrumentType === 'options' ? 'Fetching strike…' : 'Loading data…')
              : (isPaperMode ? 'Start Paper Trading' : 'Start Replay')}
          </button>
        )}
        {running && (
          <button
            style={btn('#6e40c9', isPaperMode)}
            onClick={isPaperMode ? undefined : onPause}
            disabled={isPaperMode}
            title={isPaperMode ? 'Pause not available in live paper trading' : undefined}
          >Pause</button>
        )}
        {paused && <button style={btn('#1f6feb')} onClick={onResume}>Resume</button>}
        {(running || paused) && <button style={btn('#b62324')} onClick={onStop}>Stop</button>}
        {sessionState === 'ended' && (
          <span style={{ ...label, color: '#f85149' }}>Session ended — configure above and restart</span>
        )}

        {extraControls}
      </div>

      {(dateError || startError) && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#f85149' }}>
          {dateError || startError}
        </div>
      )}
    </div>
  )
}
