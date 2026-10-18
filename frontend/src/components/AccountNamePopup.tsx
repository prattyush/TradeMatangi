import { useRef, useState, type FormEvent } from 'react'
import type { AccountProfile } from '../hooks/useAccountProfile'

export default function AccountNamePopup({ user, onSave }: { user: AccountProfile; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  if (user.accountName?.trim()) return null
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    if (!name.trim()) { setError('Enter an account name.'); return }
    pending.current = true; setSaving(true); setError('')
    try { await onSave(name.trim()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save your account name. Please retry.') }
    finally { pending.current = false; setSaving(false) }
  }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', padding: 16, overflowY: 'auto' }}>
    <div role="dialog" aria-modal="true" aria-labelledby="account-name-title" style={{ width: '100%', maxWidth: 380, boxSizing: 'border-box', padding: 28, background: '#161b22', border: '1px solid #30363d', borderRadius: 12 }}>
      <h2 id="account-name-title" style={{ fontSize: 18, color: '#58a6ff', margin: '0 0 6px' }}>Set Account Name</h2>
      <p style={{ fontSize: 13, color: '#8b949e', marginBottom: 18 }}>Your account ({user.email}) needs a display name. This will be shown in the app instead of your email.</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input aria-label="Account name" aria-describedby={error ? 'account-name-error' : undefined} value={name} onChange={event => { setName(event.target.value); setError('') }} placeholder="Your display name" required autoFocus disabled={saving} style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 8, color: '#e6edf3', fontSize: 16, boxSizing: 'border-box' }} />
        {error && <p id="account-name-error" role="alert" style={{ color: '#f85149', margin: 0, overflowWrap: 'anywhere' }}>{error}</p>}
        <button type="submit" disabled={saving} style={{ padding: 10, background: '#238636', border: 0, borderRadius: 8, color: '#fff', fontSize: 14, fontWeight: 600, cursor: saving ? 'wait' : 'pointer' }}>{saving ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  </div>
}
