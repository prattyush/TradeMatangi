import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { isNativeApp } from '../api/storage'
import { useToast } from '../shell/Toast'

export type Tab = 'sessions' | 'stats' | 'browse' | 'positions' | 'videos' | 'more'
export const ROOT_TAB: Tab = 'sessions'

/** A back handler returns true when it dealt with the press (for example a sheet closed). */
export type BackHandler = () => boolean

interface NavValue {
  tab: Tab
  setTab(tab: Tab): void
  /** Screens opened on top of the current tab (a session, a trade). Back pops one. */
  stack: string[]
  push(screen: string): void
  pop(): void
  /** Register a handler for the back button while a component is mounted. Newest handler runs first. */
  addBackHandler(handler: BackHandler): () => void
}
const NavContext = createContext<NavValue | null>(null)

export function useNav(): NavValue {
  const value = useContext(NavContext)
  if (!value) throw new Error('useNav must be used inside <NavProvider>')
  return value
}

/** Let a screen intercept the Android back button while it is mounted (closing a sheet, leave-guards). */
export function useBackHandler(handler: BackHandler | null): void {
  const { addBackHandler } = useNav()
  const latest = useRef(handler)
  latest.current = handler
  const active = handler !== null
  useEffect(() => {
    if (!active) return
    return addBackHandler(() => latest.current?.() ?? false)
  }, [active, addBackHandler])
}

const EXIT_WINDOW_MS = 2000

export function NavProvider({ children, onExit }: { children: ReactNode; onExit?: () => void }) {
  const [tab, setTabState] = useState<Tab>(ROOT_TAB)
  const [stack, setStack] = useState<string[]>([])
  const handlers = useRef<BackHandler[]>([])
  const lastBack = useRef(0)
  const toast = useToast()
  const state = useRef({ tab, stack })
  state.current = { tab, stack }

  const setTab = useCallback((next: Tab) => { setTabState(next); setStack([]) }, [])
  const push = useCallback((screen: string) => setStack(current => [...current, screen]), [])
  const pop = useCallback(() => setStack(current => current.slice(0, -1)), [])
  const addBackHandler = useCallback((handler: BackHandler) => {
    handlers.current.push(handler)
    return () => { handlers.current = handlers.current.filter(item => item !== handler) }
  }, [])

  const handleBack = useCallback(() => {
    for (let i = handlers.current.length - 1; i >= 0; i--) if (handlers.current[i]()) return
    const { tab: current, stack: pending } = state.current
    if (pending.length) { setStack(pending.slice(0, -1)); return }
    if (current !== ROOT_TAB) { setTabState(ROOT_TAB); return }
    const now = Date.now()
    if (now - lastBack.current < EXIT_WINDOW_MS) { (onExit ?? (() => { void CapacitorApp.exitApp() }))(); return }
    lastBack.current = now
    toast('Press back again to exit')
  }, [toast, onExit])

  useEffect(() => {
    if (!isNativeApp()) return
    const subscription = CapacitorApp.addListener('backButton', () => handleBack())
    return () => { void subscription.then(handle => handle.remove()) }
  }, [handleBack])

  const value = useMemo(() => ({ tab, setTab, stack, push, pop, addBackHandler }), [tab, setTab, stack, push, pop, addBackHandler])
  return (
    <NavContext.Provider value={value}>
      {children}
      <BackProbe onBack={handleBack} />
    </NavContext.Provider>
  )
}

/** Browsers (and UI tests) have no hardware back button: the Escape key stands in for it. */
function BackProbe({ onBack }: { onBack: () => void }) {
  useEffect(() => {
    if (isNativeApp()) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onBack() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])
  return null
}
