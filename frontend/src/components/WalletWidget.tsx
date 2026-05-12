import { useEffect, useState } from 'react'
import api from '../services/api'

interface Props {
  date: string
  refreshKey: number
}

function formatINR(amount: number): string {
  return '₹' + amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function WalletWidget({ date, refreshKey }: Props) {
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!date) return
    setLoading(true)
    api.getWallet(date)
      .then(w => setBalance(w.balance))
      .catch(() => {/* backend may not be running */})
      .finally(() => setLoading(false))
  }, [date, refreshKey])

  const color = balance !== null && balance < 0 ? '#f85149' : '#3fb950'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: '#8b949e' }}>Wallet</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: loading ? '#484f58' : color }}>
        {balance === null ? '—' : formatINR(balance)}
      </span>
    </div>
  )
}
