import { useEffect, useState } from 'react'
import api, { WalletResponse } from '../services/api'

interface Props {
  date: string
  refreshKey: number
  sessionId?: string | null
  onWalletSnapshot?: (sessionId: string, wallet: WalletResponse) => void
}

function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function WalletWidget({ date, refreshKey, sessionId, onWalletSnapshot }: Props) {
  const [snapshot, setSnapshot] = useState<{ context: string; wallet: WalletResponse } | null>(null)
  const context = `${date}:${sessionId ?? ''}`
  const wallet = snapshot?.context === context ? snapshot.wallet : null
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!date) return
    let cancelled = false
    setLoading(true)
    api.getWallet(date, sessionId)
      .then(w => { if (!cancelled) { setSnapshot({ context, wallet: w }); if (sessionId) onWalletSnapshot?.(sessionId, w) } })
      .catch(() => {/* backend may not be running */})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [date, refreshKey, sessionId, context, onWalletSnapshot])

  const balance = wallet?.display_balance ?? wallet?.capital_balance ?? wallet?.balance ?? null
  const color = balance !== null && balance < 0 ? '#f85149' : '#3fb950'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#8b949e' }}>{wallet?.capital_balance != null ? 'Capital' : 'Wallet'}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: loading ? '#484f58' : color }}>
          {balance === null ? '—' : formatINR(balance)}
        </span>
      </div>
    </div>
  )
}
