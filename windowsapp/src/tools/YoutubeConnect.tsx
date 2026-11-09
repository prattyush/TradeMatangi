import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface Status { connected: boolean; message?: string | null }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Connects the app to the user's YouTube account (upload permission only). The sign-in happens in the
 * system browser; the token stays in Windows Credential Manager and never reaches the server.
 */
export default function YoutubeConnect({ baseUrl }: { baseUrl: string }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try { setStatus(await invoke<Status>('youtube_status')); setError('') } catch (e) { setStatus({ connected: false }); setError(errorText(e)) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const connect = async () => {
    setBusy(true); setError('')
    try { await invoke('youtube_connect', { baseUrl }); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true); setError('')
    try { await invoke('youtube_disconnect'); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return <section className="vm-card" aria-label="YouTube">
    <div className="vm-step"><span className={`vm-num ${status?.connected ? 'done' : ''}`}>▶</span>YouTube</div>
    {status === null && <span className="vm-muted">Checking the YouTube connection…</span>}
    {status && !status.connected && <>
      <span className="vm-muted">Connect your YouTube account so finished videos can be uploaded from here. The app asks only for permission to upload; it cannot edit or delete your videos. Your browser opens so you can sign in to Google.</span>
      {status.message && <p className="vm-warn" role="status">{status.message}</p>}
      <div className="vm-row"><button className="vm-primary" onClick={() => void connect()} disabled={busy}>{busy ? 'Waiting for Google… finish in your browser' : 'Connect YouTube'}</button></div>
    </>}
    {status?.connected && <div className="vm-row">
      <span className="vm-ok" role="status">YouTube is connected.</span>
      <button onClick={() => void disconnect()} disabled={busy}>Disconnect</button>
    </div>}
    {error && <p className="vm-error" role="alert">{error}</p>}
  </section>
}
