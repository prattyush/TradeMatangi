import { useEffect, useState, type FormEvent } from 'react'
import { useAuth, useServices } from '../app/AppContext'
import { describeError } from '../api/errors'
import { SignInError } from '../api/auth'
import { normalizeServerUrl, ServerUrlError } from '../api/serverConfig'

/** Landscape sign-in: brand on the left, the form on the right. Fits a 360 px tall screen with the keyboard closed. */
export function Login() {
  const { signInWithPassword } = useAuth()
  const { serverConfig } = useServices()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [server, setServer] = useState('')
  const [editingServer, setEditingServer] = useState(false)
  const [serverInput, setServerInput] = useState('')

  useEffect(() => { void serverConfig.get().then(setServer) }, [serverConfig])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signInWithPassword(email, password)
    } catch (caught) {
      setError(caught instanceof SignInError ? caught.message : describeError(caught))
      setBusy(false)
    }
  }

  async function saveServer() {
    try {
      setServer(await serverConfig.set(serverInput))
      setEditingServer(false)
      setError(null)
    } catch (caught) {
      setError(caught instanceof ServerUrlError ? caught.message : describeError(caught))
    }
  }

  const host = (() => { try { return new URL(normalizeServerUrl(server || 'x.invalid', { allowHttp: true })).host } catch { return server } })()

  return (
    <div className="login">
      <div className="login-brand">
        <h1>TradeMatangi</h1>
        <p>Review your trades, habits and charts.</p>
      </div>
      <form className="login-form" onSubmit={submit} noValidate>
        <label>
          Email
          <input type="email" autoComplete="username" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="login-server">
          {editingServer ? (
            <>
              <input aria-label="Server address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" value={serverInput}
                onChange={event => setServerInput(event.target.value)} placeholder="https://tradematangi.co.in" />
              <button type="button" className="btn" onClick={saveServer}>Save</button>
              <button type="button" className="btn" onClick={() => { setEditingServer(false); setError(null) }}>Cancel</button>
            </>
          ) : (
            <>
              <span>Server: <strong>{host}</strong></span>
              <button type="button" className="btn btn-link" onClick={() => { setServerInput(server); setEditingServer(true) }}>Change</button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
