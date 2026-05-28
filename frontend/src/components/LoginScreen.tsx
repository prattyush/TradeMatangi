import { useState } from 'react'
import api from '../services/api'

interface Props {
  onLogin: (userId: string, email: string, isAdmin?: boolean) => void
}

type Mode = 'login' | 'register'

export default function LoginScreen({ onLogin }: Props) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = mode === 'login'
        ? await api.login(email.trim(), password)
        : await api.register(email.trim(), password)
      onLogin(result.user_id, result.email, result.is_admin ?? false)
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
