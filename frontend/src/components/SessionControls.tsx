import { useState, useEffect, useCallback, CSSProperties } from 'react'
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
  // Options config callback — fires when options ATM data is resolved
  onOptionsReady: (cfg: OptionsReadyConfig | null) => void
}

export interface OptionsReadyConfig {
  strike: number
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

const STRIKE_INTERVALS: Record<string, number> = {
  NIFTY: 50, RELIND: 5, TATMOT: 5, TATPOW: 5,
}

// Indices cannot be traded as equity — must use options
const OPTIONS_ONLY_SYMBOLS = new Set(['NIFTY'])

export default function SessionControls({
  sessionState, currentSymbol, currentDate,
  onSymbolChange, onDateChange,
  onStart, onStop, onPause, onResume,
  onOptionsReady,
}: Props) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [startTime, setStartTime] = useState('09:15')
  const [speed, setSpeed] = useState(1.0)
  const [loading, setLoading] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  // Instrument type — NIFTY forces options
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>(
    OPTIONS_ONLY_SYMBOLS.has(currentSymbol) ? 'options' : 'equity'
  )

  // Options config state
  const [optionsOffset, setOptionsOffset] = useState(0)
  const [optionsConfig, setOptionsConfig] = useState<OptionsReadyConfig | null>(null)
  const [fetchingOptions, setFetchingOptions] = useState(false)
  const [optionsError, setOptionsError] = useState<string | null>(null)

  const idle = sessionState === 'idle' || sessionState === 'ended'
  const running = sessionState === 'running'
  const paused = sessionState === 'paused'
  const today = formatLocalDate(new Date())

  // Load symbols once
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
  }, [])

  // Force options when NIFTY is selected
  useEffect(() => {
    if (OPTIONS_ONLY_SYMBOLS.has(currentSymbol) && instrumentType !== 'options') {
      setInstrumentType('options')
    }
  }, [currentSymbol])

  // Fetch ATM price + expiry whenever we're in options mode and symbol/date changes
  const fetchOptionsData = useCallback(async (symbol: string, date: string, offset: number) => {
    if (!date) return
    setFetchingOptions(true)
    setOptionsError(null)
    try {
      const [priceRes, expiryRes] = await Promise.all([
        api.getPriceAt(symbol, date, '09:15'),
        api.getExpiry(symbol, date),
      ])
      const interval = STRIKE_INTERVALS[symbol] ?? 50
      const atmStrike = Math.round(priceRes.price / interval) * interval
      const strike = atmStrike + offset * interval
      const cfg: OptionsReadyConfig = {
        strike,
        expiry: expiryRes.expiry,
        atmStrike,
        underlyingPrice: priceRes.price,
      }
      setOptionsConfig(cfg)
      onOptionsReady(cfg)
    } catch {
      setOptionsError('Could not fetch options data — check backend connection')
      setOptionsConfig(null)
      onOptionsReady(null)
    } finally {
      setFetchingOptions(false)
    }
  }, [onOptionsReady])

  useEffect(() => {
    if (instrumentType === 'options' && currentDate && idle) {
      fetchOptionsData(currentSymbol, currentDate, optionsOffset)
    }
    if (instrumentType === 'equity') {
      setOptionsConfig(null)
      onOptionsReady(null)
    }
  }, [instrumentType, currentSymbol, currentDate])

  const handleOffsetChange = (newOffset: number) => {
    setOptionsOffset(newOffset)
    if (instrumentType === 'options' && currentDate) {
      fetchOptionsData(currentSymbol, currentDate, newOffset)
    }
  }

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

  const handleSymbolChange = (sym: string) => {
    onSymbolChange(sym)
    if (OPTIONS_ONLY_SYMBOLS.has(sym)) {
      setInstrumentType('options')
    }
  }

  const handleStart = async () => {
    if (!currentDate || dateError) return
    setStartError(null)
    setLoading(true)
    try {
      const config: InstrumentConfig = instrumentType === 'options' && optionsConfig
        ? { instrument_type: 'options', strike: optionsConfig.strike, expiry: optionsConfig.expiry }
        : { instrument_type: 'equity' }
      await onStart(startTime + ':00', speed, config)
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start session')
    } finally {
      setLoading(false)
    }
  }

  const canStart = idle && !loading && !!currentDate && !dateError &&
    (instrumentType === 'equity' || (!!optionsConfig && !fetchingOptions))

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
            style={btn('#1f6feb', !canStart)}
            onClick={handleStart}
            disabled={!canStart}
          >
            {loading ? 'Loading data…' : fetchingOptions ? 'Fetching strike…' : 'Start Replay'}
          </button>
        )}
        {running && <button style={btn('#6e40c9')} onClick={onPause}>Pause</button>}
        {paused && <button style={btn('#1f6feb')} onClick={onResume}>Resume</button>}
        {(running || paused) && <button style={btn('#b62324')} onClick={onStop}>Stop</button>}
        {sessionState === 'ended' && (
          <span style={{ ...label, color: '#f85149' }}>Session ended — configure above and restart</span>
        )}
      </div>

      {/* Options configurator row */}
      {instrumentType === 'options' && idle && (
        <div style={{ ...row, marginTop: 8 }}>
          <span style={{ fontSize: 12, color: '#58a6ff' }}>Options:</span>
          <label style={{ ...label, fontSize: 12 }}>
            OTM/ITM offset&nbsp;
            <input
              type="number"
              value={optionsOffset}
              onChange={e => handleOffsetChange(parseInt(e.target.value) || 0)}
              style={{ ...inputStyle, width: 60, fontSize: 12 }}
              min={-10} max={10}
            />
            <span style={{ marginLeft: 4, fontSize: 11, color: '#484f58' }}>(0=ATM, +n=OTM, -n=ITM)</span>
          </label>

          {fetchingOptions && (
            <span style={{ fontSize: 12, color: '#8b949e' }}>Fetching…</span>
          )}
          {optionsConfig && !fetchingOptions && (
            <span style={{ fontSize: 12, color: '#3fb950' }}>
              Strike: {optionsConfig.strike} &nbsp;|&nbsp;
              Expiry: {optionsConfig.expiry} &nbsp;|&nbsp;
              Underlying: ₹{optionsConfig.underlyingPrice.toFixed(0)}
            </span>
          )}
          {optionsError && (
            <span style={{ fontSize: 12, color: '#f85149' }}>{optionsError}</span>
          )}
        </div>
      )}

      {(dateError || startError) && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#f85149' }}>
          {dateError || startError}
        </div>
      )}
    </div>
  )
}
