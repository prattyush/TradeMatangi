import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useAuth, useCapabilities, useServices } from '../app/AppContext'
import { summarizeCapabilities } from '../api/capabilities'
import { describeError } from '../api/errors'
import { ServerUrlError } from '../api/serverConfig'
import { useToast } from '../shell/Toast'

export function More() {
  const { account, signOut } = useAuth()
  const { serverConfig, diagnostics } = useServices()
  const { capabilities, checking, refresh } = useCapabilities()
  const toast = useToast()
  const [server, setServer] = useState('')
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  useEffect(() => { void serverConfig.get().then(setServer) }, [serverConfig])

  async function save() {
    try {
      const url = await serverConfig.set(input)
      setServer(url); setEditing(false); setError(null)
      await refresh()
      toast('Server changed')
    } catch (caught) {
      setError(caught instanceof ServerUrlError ? caught.message : describeError(caught))
    }
  }

  async function reset() {
    setServer(await serverConfig.reset()); setEditing(false); setError(null)
    await refresh()
    toast('Using the default server')
  }

  async function copyDiagnostics() {
    const lines = [
      `TradeMatangi phone app ${__APP_VERSION__}`,
      `platform: ${Capacitor.getPlatform()}`,
      `server: ${server}`,
      `server status: ${summarizeCapabilities(capabilities)}`,
      `online: ${navigator.onLine}`,
      `user agent: ${navigator.userAgent}`,
      '--- recent problems ---',
      ...diagnostics.entries().map(entry => `${entry.at} ${entry.what}`),
    ]
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('Diagnostics copied') }
    catch { toast('Could not copy diagnostics') }
  }

  return (
    <section className="screen">
      <header className="screen-title"><h2>More</h2></header>
      <div className="cards">
        <div className="card">
          <h3>Account</h3>
          <p>{account ?? 'Signed in'}</p>
          {confirmSignOut ? (
            <div className="row">
              <button type="button" className="btn btn-danger" onClick={() => void signOut()}>Sign out</button>
              <button type="button" className="btn" onClick={() => setConfirmSignOut(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmSignOut(true)}>Sign out…</button>
          )}
        </div>
        <div className="card">
          <h3>Server</h3>
          {editing ? (
            <>
              <input aria-label="Server address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" value={input} onChange={event => setInput(event.target.value)} />
              {error && <div className="form-error" role="alert">{error}</div>}
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={save}>Save</button>
                <button type="button" className="btn" onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="mono">{server}</p>
              <div className="row">
                <button type="button" className="btn" onClick={() => { setInput(server); setEditing(true) }}>Change</button>
                <button type="button" className="btn" onClick={() => void reset()}>Use default</button>
              </div>
            </>
          )}
        </div>
        <div className="card">
          <h3>About</h3>
          <dl>
            <dt>App</dt><dd>{__APP_VERSION__}</dd>
            <dt>Server</dt><dd>{checking ? 'Checking…' : summarizeCapabilities(capabilities)}</dd>
          </dl>
          <div className="row">
            <button type="button" className="btn" onClick={() => void refresh()} disabled={checking}>Check server</button>
            <button type="button" className="btn" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
          </div>
        </div>
      </div>
    </section>
  )
}
