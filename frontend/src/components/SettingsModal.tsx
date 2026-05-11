import { useState } from 'react'
import api from '../services/api'

interface Props {
  date: string
  onWalletReset: () => void
}

export default function SettingsModal({ date, onWalletReset }: Props) {
  const [open, setOpen] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [status, setStatus] = useState<string | null>(null)

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
            padding: 24, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3' }}>Settings</span>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 16 }}
              >✕</button>
            </div>

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

              {status && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#3fb950' }}>{status}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
