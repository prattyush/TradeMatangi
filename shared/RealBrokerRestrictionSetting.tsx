import { useEffect, useRef, useState } from 'react'

type Policy = { enabled: boolean }
export default function RealBrokerRestrictionSetting({ request }: {
  request: (method: 'GET' | 'PUT', body?: Policy) => Promise<Policy>
}) {
  const requestRef = useRef(request)
  requestRef.current = request
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void requestRef.current('GET').then(value => {
      if (active) { setEnabled(value.enabled === true); setLoaded(true) }
    }).catch(error => { if (active) setError(String(error)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  const save = async (next: boolean) => {
    setBusy(true); setError('')
    try { const saved = await requestRef.current('PUT', { enabled: next }); setEnabled(saved.enabled === true) }
    catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <section style={{ border: '1px solid #30363d', padding: 12, borderRadius: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={enabled} disabled={busy || !loaded} onChange={event => { void save(event.target.checked) }} />
        Enforce Real broker session restrictions (Day and Swing)
      </label>
      <span
        title="Off by default. DynamoDB records and 3-minute heartbeats remain, but stale or conflicting records do not block Start or stop trading. Enabling applies restrictions when sessions start or resume."
        style={{ color: '#8b949e', cursor: 'help', fontSize: 12 }}
      >ⓘ</span>
    </div>
    {busy && <small role="status">{loaded ? 'Saving…' : 'Loading…'}</small>}
    {error && <p role="alert">{error}</p>}
  </section>
}
