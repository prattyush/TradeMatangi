import { useState, useRef, useEffect } from 'react'
import api from '../services/api'

interface Props {
  onSuccess: () => void
  onCancel: () => void
}

export default function KotakTOTPModal({ onSuccess, onCancel }: Props) {
  const [totp, setTotp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async () => {
    if (totp.length !== 6) {
      setError('Enter the 6-digit TOTP from your authenticator app')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await api.kotakLogin(totp)
      onSuccess()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 10,
        padding: 28, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3' }}>Kotak Neo Login</span>
          <button
            onClick={onCancel}
            style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 16 }}
          >✕</button>
        </div>

        <p style={{ margin: 0, fontSize: 13, color: '#8b949e', lineHeight: 1.5 }}>
          Enter the 6-digit TOTP from your authenticator app to connect to Kotak Neo for real trading.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12, color: '#8b949e', fontWeight: 600 }}>TOTP</label>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={totp}
            onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="000000"
            style={{
              background: '#0d1117', border: '1px solid #30363d', borderRadius: 6,
              color: '#e6edf3', padding: '8px 12px', fontSize: 20, letterSpacing: 8,
              textAlign: 'center', outline: 'none', width: '100%', boxSizing: 'border-box',
            }}
          />
        </div>

        {error && (
          <div style={{
            background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
            borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#f85149',
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: '1px solid #30363d', borderRadius: 6,
              color: '#8b949e', padding: '7px 16px', cursor: 'pointer', fontSize: 13,
            }}
          >Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={loading || totp.length !== 6}
            style={{
              background: loading ? '#1f2937' : '#d4a017',
              border: 'none', borderRadius: 6,
              color: loading ? '#8b949e' : '#0d1117',
              padding: '7px 20px', cursor: loading ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 600,
              opacity: totp.length !== 6 ? 0.5 : 1,
            }}
          >{loading ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}
