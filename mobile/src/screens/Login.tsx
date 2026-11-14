import { useEffect, useState, type FormEvent } from 'react'
import { useAuth, useServices } from '../app/AppContext'
import { describeError } from '../api/errors'
import { AccountNameRequired, SignInError } from '../api/auth'
import { GoogleSignInError } from '../native/googleSignIn'
import { normalizeServerUrl, ServerUrlError } from '../api/serverConfig'

/** Landscape sign-in: brand on the left, the form on the right. Fits a 360 px tall screen with the keyboard closed. */
export function Login() {
  const { signInWithPassword, signInWithGoogle } = useAuth()
  const { serverConfig, google } = useServices()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [server, setServer] = useState('')
  const [editingServer, setEditingServer] = useState(false)
  /** A Google account the server does not know yet: its ID token waits in memory for the name of the new account. */
  const [newGoogle, setNewGoogle] = useState<{ idToken: string; email?: string } | null>(null)
  const [accountName, setAccountName] = useState('')
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

  async function continueWithGoogle() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const account = await google.signIn()
      try {
        await signInWithGoogle(account.idToken, undefined, account.email)
      } catch (caught) {
        if (!(caught instanceof AccountNameRequired)) throw caught
        setNewGoogle({ idToken: account.idToken, email: account.email })
        setAccountName((account.name ?? '').trim())
        setBusy(false)
      }
    } catch (caught) {
      // Closing Google's chooser is not an error worth showing.
      if (!(caught instanceof GoogleSignInError && caught.reason === 'cancelled'))
        setError(caught instanceof GoogleSignInError || caught instanceof SignInError ? caught.message : describeError(caught))
      setBusy(false)
    }
  }

  async function createGoogleAccount(event: FormEvent) {
    event.preventDefault()
    if (busy || !newGoogle) return
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle(newGoogle.idToken, accountName, newGoogle.email)
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
      {newGoogle ? (
        <form className="login-form" onSubmit={createGoogleAccount} noValidate>
          <p className="login-note">{newGoogle.email ?? 'This Google account'} has no TradeMatangi account yet. Choose a name to create one, or go back.</p>
          <label>
            Account name
            <input type="text" autoComplete="nickname" maxLength={60} value={accountName} onChange={event => setAccountName(event.target.value)} disabled={busy} />
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="login-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setNewGoogle(null); setError(null) }}>Back</button>
          </div>
        </form>
      ) : (
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
        <div className="login-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {google.available() && <button type="button" className="btn" disabled={busy} onClick={() => void continueWithGoogle()}>Continue with Google</button>}
        </div>
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
      )}
    </div>
  )
}
