import { useEffect, useState } from 'react'
import api, { WalletResponse } from '../services/api'

interface Props {
  date: string
  refreshKey: number
  sessionId?: string | null
}

function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function WalletWidget({ date, refreshKey, sessionId }: Props) {
  const [wallet, setWallet] = useState<WalletResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!date) return
    let cancelled = false
    setLoading(true)
    api.getWallet(date, sessionId)
      .then(w => { if (!cancelled) setWallet(w) })
      .catch(() => {/* backend may not be running */})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [date, refreshKey, sessionId])

  const balance = wallet?.balance ?? null
  const color = balance !== null && balance < 0 ? '#f85149' : '#3fb950'
  const showLeverage = wallet?.buying_power != null && wallet?.margin_rate === 0.2

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#8b949e' }}>Wallet</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: loading ? '#484f58' : color }}>
          {balance === null ? '—' : formatINR(balance)}
        </span>
      </div>
      {showLeverage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8b949e' }}>
          <span>5x BP</span>
          <span style={{ color: '#e6edf3', fontWeight: 600 }}>
            {formatINR(wallet!.buying_power ?? 0)}
          </span>
          {wallet?.exposure != null && wallet.exposure > 0 && (
            <>
              <span style={{ color: '#484f58' }}>Exposure</span>
              <span style={{ color: '#e6edf3', fontWeight: 600 }}>{formatINR(wallet.exposure)}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
