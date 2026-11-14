import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppServices } from './services'
import { EMPTY_CAPABILITIES, probeCapabilities, type Capabilities } from '../api/capabilities'
import { isAbort } from '../api/transport'

const ServicesContext = createContext<AppServices | null>(null)

export function useServices(): AppServices {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useServices must be used inside <AppProviders>')
  return services
}

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut'

interface AuthValue {
  status: AuthStatus
  account: string | null
  signInWithPassword(email: string, password: string): Promise<void>
  signInWithGoogle(idToken: string, accountName?: string, label?: string): Promise<void>
  signOut(): Promise<void>
}
const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AppProviders>')
  return value
}

interface CapabilitiesValue {
  capabilities: Capabilities
  checking: boolean
  refresh(): Promise<void>
}
const CapabilitiesContext = createContext<CapabilitiesValue | null>(null)

export function useCapabilities(): CapabilitiesValue {
  const value = useContext(CapabilitiesContext)
  if (!value) throw new Error('useCapabilities must be used inside <AppProviders>')
  return value
}

function AuthProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [account, setAccount] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    services.auth.restore().then(async state => {
      const label = await services.auth.accountLabel()
      if (cancelled) return
      setAccount(label)
      setStatus(state)
    })
    const unsubscribe = services.onAuthLost(() => { setStatus('signedOut'); setAccount(null) })
    return () => { cancelled = true; unsubscribe() }
  }, [services])

  const value = useMemo<AuthValue>(() => ({
    status,
    account,
    async signInWithPassword(email, password) {
      await services.auth.signInWithPassword(email, password)
      setAccount(await services.auth.accountLabel())
      setStatus('signedIn')
    },
    async signInWithGoogle(idToken, accountName, label) {
      await services.auth.signInWithGoogle(idToken, accountName, label)
      setAccount(await services.auth.accountLabel())
      setStatus('signedIn')
    },
    async signOut() {
      await services.auth.signOut()
      setAccount(null)
      setStatus('signedOut')
    },
  }), [services, status, account])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function CapabilitiesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  const { status } = useAuth()
  const [capabilities, setCapabilities] = useState<Capabilities>(EMPTY_CAPABILITIES)
  const [checking, setChecking] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setChecking(true)
    try {
      setCapabilities(await probeCapabilities(services.client, next.signal))
    } catch (error) {
      if (!isAbort(error)) setCapabilities({ ...EMPTY_CAPABILITIES, status: 'unknown' })
    } finally {
      if (controller.current === next) setChecking(false)
    }
  }, [services])

  useEffect(() => {
    if (status === 'signedIn') void refresh()
    else setCapabilities(EMPTY_CAPABILITIES)
    return () => controller.current?.abort()
  }, [status, refresh])

  const value = useMemo(() => ({ capabilities, checking, refresh }), [capabilities, checking, refresh])
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>
}

export function AppProviders({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <ServicesContext.Provider value={services}>
      <AuthProvider services={services}>
        <CapabilitiesProvider services={services}>{children}</CapabilitiesProvider>
      </AuthProvider>
    </ServicesContext.Provider>
  )
}
