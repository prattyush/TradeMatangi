import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'

interface Props {
  onLogin: (userId: string, email: string, isAdmin?: boolean, accountName?: string) => void
}

type Mode = 'login' | 'register'

const GOOGLE_CLIENT_ID = '249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void
          prompt: (callback?: (notification: { isNotDisplayed: () => boolean }) => void) => void
          renderButton: (el: HTMLElement, config: Record<string, unknown>) => void
          disableAutoSelect: () => void
          cancel: () => void
          revoke: (hint: string, callback?: () => void) => void
        }
      }
    }
  }
}

export default function LoginScreen({ onLogin }: Props) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accountName, setAccountName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [accountNamePopup, setAccountNamePopup] = useState<{ idToken: string } | null>(null)

  const doGoogleAuth = useCallback(async (idToken: string, name?: string) => {
    setError(null)
    setGoogleLoading(true)
    try {
      const result = await api.googleAuth(idToken, name)
      onLogin(result.user_id, result.email, result.is_admin ?? false, result.account_name ?? undefined)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed'
      if (!name && msg.includes('account_name')) {
        setAccountNamePopup({ idToken })
      } else {
        setError(msg)
      }
    } finally {
      setGoogleLoading(false)
    }
  }, [onLogin])

  const handleAccountNameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!accountNamePopup || !accountName.trim()) return
    await doGoogleAuth(accountNamePopup.idToken, accountName.trim())
    setAccountNamePopup(null)
  }

  useEffect(() => {
    if (!window.google) return
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response: { credential: string }) => {
        doGoogleAuth(response.credential)
      },
      auto_select: false,
    })
  }, [doGoogleAuth])

  const handleGoogleClick = () => {
    setError(null)
    window.google?.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed()) {
        setError('Google Sign-In popup was blocked. Please allow popups for this site.')
      }
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = mode === 'login'
        ? await api.login(email.trim(), password)
        : await api.register(email.trim(), password, accountName.trim() || undefined)
      onLogin(result.user_id, result.email, result.is_admin ?? false, result.account_name ?? undefined)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 8,
    color: '#e6edf3',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  }

  const btnStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px',
    background: '#238636',
    border: 'none',
    borderRadius: 8,
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 600,
    cursor: loading ? 'not-allowed' : 'pointer',
    opacity: loading ? 0.7 : 1,
  }

  const googleBtnStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px',
    background: '#ffffff',
    border: '1px solid #30363d',
    borderRadius: 8,
    color: '#1f1f1f',
    fontSize: 14,
    fontWeight: 500,
    cursor: googleLoading ? 'not-allowed' : 'pointer',
    opacity: googleLoading ? 0.7 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  }

  // Account name popup for new Google sign-in
  if (accountNamePopup) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#0d1117',
      }}>
        <div style={{
          width: 360, padding: 32,
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: 12,
        }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#58a6ff' }}>Welcome to TradeMatangi</div>
            <div style={{ fontSize: 13, color: '#484f58', marginTop: 8 }}>
              Please choose an account name to continue
            </div>
          </div>
          <form onSubmit={handleAccountNameSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
                Account Name
              </label>
              <input
                type="text"
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder="Your display name"
                required
                autoFocus
                style={inputStyle}
              />
            </div>
            <button type="submit" style={btnStyle} disabled={googleLoading}>
              {googleLoading ? 'Creating account…' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#0d1117',
    }}>
      <div style={{
        width: 360, padding: 32,
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: 12,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#58a6ff' }}>TradeMatangi</div>
          <div style={{ fontSize: 13, color: '#484f58', marginTop: 4 }}>
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </div>
        </div>

        {/* Google Sign-In button */}
        <button type="button" onClick={handleGoogleClick} style={googleBtnStyle} disabled={googleLoading}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          {googleLoading ? 'Signing in…' : 'Continue with Google'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', margin: '18px 0', gap: 10 }}>
          <div style={{ flex: 1, height: 1, background: '#30363d' }} />
          <span style={{ fontSize: 12, color: '#484f58' }}>or</span>
          <div style={{ flex: 1, height: 1, background: '#30363d' }} />
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              style={inputStyle}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Min 6 characters' : '••••••••'}
              required
              style={inputStyle}
            />
          </div>

          {mode === 'register' && (
            <div>
              <label style={{ fontSize: 12, color: '#8b949e', display: 'block', marginBottom: 6 }}>
                Account Name
              </label>
              <input
                type="text"
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder="Your display name"
                required
                style={inputStyle}
              />
            </div>
          )}

          {error && (
            <div style={{
              padding: '8px 12px', background: '#3d1f1f',
              border: '1px solid #f85149', borderRadius: 6,
              color: '#f85149', fontSize: 13,
            }}>
              {error}
            </div>
          )}

          <button type="submit" style={btnStyle} disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 13, color: '#484f58' }}>
          {mode === 'login' ? (
            <>
              New user?{' '}
              <button
                onClick={() => { setMode('register'); setError(null) }}
                style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', fontSize: 13, padding: 0 }}
              >
                Create account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('login'); setError(null) }}
                style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', fontSize: 13, padding: 0 }}
              >
                Sign in
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
