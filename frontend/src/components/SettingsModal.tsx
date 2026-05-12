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

interface Props {
  date: string
  onWalletReset: () => void
  onFundsRatioChange: (mode: boolean, ratios: FundsRatios) => void
}

export default function SettingsModal({ date, onWalletReset, onFundsRatioChange }: Props) {
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const [fundsRatioMode, setFundsRatioMode] = useState(loadFundsRatioMode)
  const [ratios, setRatios] = useState<FundsRatios>(loadFundsRatios)
  const [ratioInputs, setRatioInputs] = useState<{ l: string; m: string; h: string }>(() => {
    const r = loadFundsRatios()
    return { l: String(r.l), m: String(r.m), h: String(r.h) }
  })

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
