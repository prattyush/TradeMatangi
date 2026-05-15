import { useState, useEffect } from 'react'
import api from '../services/api'

export interface FundsRatios {
  l: number  // percentage 0-100
  m: number
  h: number
}

const DEFAULT_FUNDS_RATIOS: FundsRatios = { l: 3, m: 6, h: 12 }
const FUNDS_RATIO_MODE_KEY = 'fundsRatioMode'
const FUNDS_RATIOS_KEY = 'fundsRatios'
const TARGET_DEVIATION_KEY = 'targetDeviationPct'
const BROKERAGE_KEY = 'brokeragePerOrder'
const STRATEGY_INTERVAL_KEY = 'strategyIntervalSecs'
const AUTOSTOP_TRIGGER_TYPE_KEY = 'autostopTriggerType'
const AUTOSTOP_DEVIATION_PCT_KEY = 'autostopDeviationPct'
const HISTORICAL_DAYS_KEY = 'historicalDays'

export function loadFundsRatioMode(): boolean {
  return localStorage.getItem(FUNDS_RATIO_MODE_KEY) === 'true'
}

export function loadFundsRatios(): FundsRatios {
  try {
    const stored = localStorage.getItem(FUNDS_RATIOS_KEY)
    if (stored) return { ...DEFAULT_FUNDS_RATIOS, ...JSON.parse(stored) }
  } catch { /* ignore */ }
  return { ...DEFAULT_FUNDS_RATIOS }
}

// Returns deviation as a fraction (0.01 = 1%)
export function loadTargetDeviationPct(): number {
  const v = parseFloat(localStorage.getItem(TARGET_DEVIATION_KEY) ?? '')
  return isNaN(v) || v < 0 ? 0.01 : v / 100
}

// Returns brokerage per order in rupees (default ₹1)
export function loadBrokeragePerOrder(): number {
  const v = parseFloat(localStorage.getItem(BROKERAGE_KEY) ?? '')
  return isNaN(v) || v < 0 ? 1 : v
}

// Strategy interval in seconds (180 = 3min, 300 = 5min)
export function loadStrategyIntervalSecs(): number {
  const v = parseInt(localStorage.getItem(STRATEGY_INTERVAL_KEY) ?? '')
  return isNaN(v) ? 180 : v
}

// AutoStop trigger type: "bar" (high/low) or "deviation" (% from close)
export function loadAutostopTriggerType(): 'bar' | 'deviation' {
  const v = localStorage.getItem(AUTOSTOP_TRIGGER_TYPE_KEY)
  return v === 'deviation' ? 'deviation' : 'bar'
}

// AutoStop deviation % (used when trigger type = deviation; e.g. 1.0 = 1%)
export function loadAutostopDeviationPct(): number {
  const v = parseFloat(localStorage.getItem(AUTOSTOP_DEVIATION_PCT_KEY) ?? '')
  return isNaN(v) || v < 0 ? 1.0 : v
}

// Historical days for chart context (default 2)
export function loadHistoricalDays(): number {
  const v = parseInt(localStorage.getItem(HISTORICAL_DAYS_KEY) ?? '')
  return isNaN(v) || v < 1 || v > 5 ? 2 : v
}

interface Props {
  date: string
  onWalletReset: () => void
  onFundsRatioChange: (mode: boolean, ratios: FundsRatios) => void
  onTargetDeviationChange: (pct: number) => void  // fraction e.g. 0.01
  onBrokerageChange: (brokerage: number) => void  // rupees per order
  onStrategySettingsChange: (intervalSecs: number, triggerType: 'bar' | 'deviation', deviationPct: number) => void
  onHistoricalDaysChange?: (days: number) => void
}

export default function SettingsModal({ date, onWalletReset, onFundsRatioChange, onTargetDeviationChange, onBrokerageChange, onStrategySettingsChange, onHistoricalDaysChange }: Props) {
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const [fundsRatioMode, setFundsRatioMode] = useState(loadFundsRatioMode)
  const [ratios, setRatios] = useState<FundsRatios>(loadFundsRatios)
  const [ratioInputs, setRatioInputs] = useState<{ l: string; m: string; h: string }>(() => {
    const r = loadFundsRatios()
    return { l: String(r.l), m: String(r.m), h: String(r.h) }
  })

  // TARGET deviation state (stored as % 0-100 in localStorage, exposed as fraction)
  const [deviationInput, setDeviationInput] = useState<string>(() => {
    const stored = parseFloat(localStorage.getItem(TARGET_DEVIATION_KEY) ?? '')
    return String(isNaN(stored) ? 1 : stored)
  })

  // Brokerage per order in rupees
  const [brokerageInput, setBrokerageInput] = useState<string>(() => {
    const v = parseFloat(localStorage.getItem(BROKERAGE_KEY) ?? '')
    return String(isNaN(v) || v < 0 ? 1 : v)
  })

  // Strategy settings
  const [stratIntervalSecs, setStratIntervalSecs] = useState(loadStrategyIntervalSecs)
  const [autostopTriggerType, setAutostopTriggerType] = useState(loadAutostopTriggerType)
  const [autostopDeviationPctInput, setAutostopDeviationPctInput] = useState<string>(() =>
    String(loadAutostopDeviationPct())
  )

  // Historical days
  const [historicalDays, setHistoricalDays] = useState(loadHistoricalDays)

  useEffect(() => {
    // Sync from backend on open
    if (open) {
      api.getUserSettings().then(s => {
        setHistoricalDays(s.historical_days)
        localStorage.setItem(HISTORICAL_DAYS_KEY, String(s.historical_days))
      }).catch(() => {})
    }
  }, [open])

  // Persist + notify parent whenever mode or ratios change
  useEffect(() => {
    localStorage.setItem(FUNDS_RATIO_MODE_KEY, String(fundsRatioMode))
    localStorage.setItem(FUNDS_RATIOS_KEY, JSON.stringify(ratios))
    onFundsRatioChange(fundsRatioMode, ratios)
  }, [fundsRatioMode, ratios])

  const toggleMode = () => setFundsRatioMode(m => !m)

  const saveRatios = () => {
    const l = parseFloat(ratioInputs.l)
    const m = parseFloat(ratioInputs.m)
    const h = parseFloat(ratioInputs.h)
    if ([l, m, h].some(v => isNaN(v) || v <= 0 || v > 100)) {
      setStatus('Ratios must be 1–100')
      return
    }
    setRatios({ l, m, h })
    setStatus('Saved')
    setTimeout(() => setStatus(null), 2000)
  }

  const saveDeviation = () => {
    const pct = parseFloat(deviationInput)
    if (isNaN(pct) || pct < 0 || pct > 10) {
      setStatus('Deviation must be 0–10%')
      return
    }
    localStorage.setItem(TARGET_DEVIATION_KEY, String(pct))
    onTargetDeviationChange(pct / 100)
    setStatus(`Deviation saved: ${pct}%`)
    setTimeout(() => setStatus(null), 2000)
  }

  const saveStrategySettings = () => {
    const devPct = parseFloat(autostopDeviationPctInput)
    if (isNaN(devPct) || devPct < 0 || devPct > 20) {
      setStatus('Deviation must be 0–20%')
      return
    }
    localStorage.setItem(STRATEGY_INTERVAL_KEY, String(stratIntervalSecs))
    localStorage.setItem(AUTOSTOP_TRIGGER_TYPE_KEY, autostopTriggerType)
    localStorage.setItem(AUTOSTOP_DEVIATION_PCT_KEY, String(devPct))
    onStrategySettingsChange(stratIntervalSecs, autostopTriggerType, devPct)
    setStatus('Strategy settings saved')
    setTimeout(() => setStatus(null), 2000)
  }

  const saveBrokerage = () => {
    const val = parseFloat(brokerageInput)
    if (isNaN(val) || val < 0) {
      setStatus('Brokerage must be ≥ 0')
      return
    }
    localStorage.setItem(BROKERAGE_KEY, String(val))
    onBrokerageChange(val)
    setStatus(`Brokerage saved: ₹${val}`)
    setTimeout(() => setStatus(null), 2000)
  }

  const reset = async (amount?: number) => {
    try {
      await api.resetWallet(date, amount)
      setStatus(amount ? `Reset to ₹${amount.toLocaleString('en-IN')}` : 'Reset to ₹1,50,000')
      onWalletReset()
      setTimeout(() => setStatus(null), 2000)
    } catch {
      setStatus('Reset failed')
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        style={{
          background: 'none', border: 'none', color: '#8b949e',
          cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 4px',
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{
            background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
            padding: 24, minWidth: 340, display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3' }}>Settings</span>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 16 }}
              >✕</button>
            </div>

            {/* Trading Mode */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>TRADING MODE</div>
              <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d' }}>
                {(['Quantity', 'FundsRatio'] as const).map(mode => {
                  const isActive = mode === 'FundsRatio' ? fundsRatioMode : !fundsRatioMode
                  return (
                    <button
                      key={mode}
                      onClick={toggleMode}
                      style={{
                        flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                        border: 'none', cursor: 'pointer',
                        background: isActive ? '#1f3a5f' : '#161b22',
                        color: isActive ? '#79c0ff' : '#484f58',
                        transition: 'background 0.15s',
                      }}
                    >
                      {mode}
                    </button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                {fundsRatioMode
                  ? 'Orders sized by % of session capital (L/M/H)'
                  : 'Orders sized by explicit quantity'}
              </div>
            </div>

            {/* FundsRatio % settings */}
            {fundsRatioMode && (
              <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
                <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                  FUNDS RATIO (% of session capital)
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  {(['l', 'm', 'h'] as const).map(key => (
                    <div key={key} style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3, textAlign: 'center' }}>
                        {key.toUpperCase()}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <input
                          type="number"
                          value={ratioInputs[key]}
                          onChange={e => setRatioInputs(r => ({ ...r, [key]: e.target.value }))}
                          min={1} max={100} step={1}
                          style={{
                            width: '100%', padding: '5px 6px', background: '#0d1117',
                            border: '1px solid #30363d', borderRadius: 6,
                            color: '#e6edf3', fontSize: 13, textAlign: 'center',
                          }}
                        />
                        <span style={{ fontSize: 11, color: '#484f58' }}>%</span>
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={saveRatios}
                    style={{
                      marginTop: 16, padding: '5px 12px', background: '#1f6feb',
                      border: 'none', borderRadius: 6, color: '#fff',
                      cursor: 'pointer', fontSize: 12, alignSelf: 'flex-end',
                    }}
                  >
                    Save
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#484f58' }}>
                  Current: L={ratios.l}% · M={ratios.m}% · H={ratios.h}%
                </div>
              </div>
            )}

            {/* TARGET Order Deviation */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                TARGET ORDER DEVIATION
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={deviationInput}
                  onChange={e => setDeviationInput(e.target.value)}
                  min={0} max={10} step={0.1}
                  style={{
                    width: 80, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                <button
                  onClick={saveDeviation}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Auto-limit = trigger ± {deviationInput || '1'}% for TARGET orders
              </div>
            </div>

            {/* Brokerage */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                BROKERAGE
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#8b949e' }}>₹</span>
                <input
                  type="number"
                  value={brokerageInput}
                  onChange={e => setBrokerageInput(e.target.value)}
                  min={0} step={0.5}
                  style={{
                    width: 80, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>per order</span>
                <button
                  onClick={saveBrokerage}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Flat brokerage per order + exchange charges (STT, GST) computed per trade
              </div>
            </div>

            {/* Historical Days */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>
                HISTORICAL DAYS
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={historicalDays}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    if (!isNaN(v) && v >= 1 && v <= 5) setHistoricalDays(v)
                  }}
                  min={1} max={5} step={1}
                  style={{
                    width: 70, padding: '5px 8px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13, textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: 12, color: '#8b949e' }}>days (1–5)</span>
                <button
                  onClick={() => {
                    localStorage.setItem(HISTORICAL_DAYS_KEY, String(historicalDays))
                    api.updateUserSettings({ historical_days: historicalDays }).catch(() => {})
                    onHistoricalDaysChange?.(historicalDays)
                    setStatus(`Historical days saved: ${historicalDays}`)
                    setTimeout(() => setStatus(null), 2000)
                  }}
                  style={{
                    padding: '5px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  Save
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#484f58', marginTop: 6 }}>
                Prior trading days of chart context loaded at session start
              </div>
            </div>

            {/* Strategy Settings */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>STRATEGY SETTINGS</div>

              {/* Strategy Candle Interval */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>Strategy Candle Interval</div>
                <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #30363d', width: 'fit-content' }}>
                  {([{ label: '3 min', value: 180 }, { label: '5 min', value: 300 }] as const).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setStratIntervalSecs(opt.value)}
                      style={{
                        padding: '5px 16px', fontSize: 12, fontWeight: 600,
                        border: 'none', cursor: 'pointer',
                        background: stratIntervalSecs === opt.value ? '#1f3a5f' : '#161b22',
                        color: stratIntervalSecs === opt.value ? '#79c0ff' : '#484f58',
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* AutoStop Trigger Type */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>AutoStop Trigger</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {([
                    { value: 'bar', label: 'Bar High / Low' },
                    { value: 'deviation', label: '% from Close' },
                  ] as const).map(opt => (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="autostopTrigger"
                        checked={autostopTriggerType === opt.value}
                        onChange={() => setAutostopTriggerType(opt.value)}
                        style={{ accentColor: '#79c0ff' }}
                      />
                      <span style={{ fontSize: 12, color: autostopTriggerType === opt.value ? '#e6edf3' : '#8b949e' }}>
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Deviation % — shown only in deviation mode */}
              {autostopTriggerType === 'deviation' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: '#8b949e' }}>Deviation</span>
                  <input
                    type="number"
                    value={autostopDeviationPctInput}
                    onChange={e => setAutostopDeviationPctInput(e.target.value)}
                    min={0} max={20} step={0.1}
                    style={{
                      width: 70, padding: '4px 8px', background: '#0d1117',
                      border: '1px solid #30363d', borderRadius: 6,
                      color: '#e6edf3', fontSize: 13, textAlign: 'center',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                </div>
              )}

              <button
                onClick={saveStrategySettings}
                style={{
                  padding: '5px 14px', background: '#1f6feb',
                  border: 'none', borderRadius: 6, color: '#fff',
                  cursor: 'pointer', fontSize: 12,
                }}
              >
                Save
              </button>
            </div>

            {/* Wallet */}
            <div style={{ borderTop: '1px solid #21262d', paddingTop: 16 }}>
              <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10, fontWeight: 600 }}>WALLET</div>
              <button
                onClick={() => reset()}
                style={{
                  width: '100%', padding: '8px 12px', background: '#21262d',
                  border: '1px solid #30363d', borderRadius: 6, color: '#e6edf3',
                  cursor: 'pointer', fontSize: 13, marginBottom: 10,
                }}
              >
                Reset to ₹1,50,000
              </button>

              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number"
                  value={customAmount}
                  onChange={e => setCustomAmount(e.target.value)}
                  placeholder="Custom amount"
                  style={{
                    flex: 1, padding: '6px 10px', background: '#0d1117',
                    border: '1px solid #30363d', borderRadius: 6,
                    color: '#e6edf3', fontSize: 13,
                  }}
                />
                <button
                  onClick={() => {
                    const amt = parseFloat(customAmount)
                    if (amt > 0) reset(amt)
                  }}
                  disabled={!customAmount || parseFloat(customAmount) <= 0}
                  style={{
                    padding: '6px 12px', background: '#1f6feb',
                    border: 'none', borderRadius: 6, color: '#fff',
                    cursor: 'pointer', fontSize: 13,
                  }}
                >
                  Set
                </button>
              </div>
            </div>

            {status && (
              <div style={{ fontSize: 12, color: '#3fb950' }}>{status}</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
