import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import './install.css'

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
const InstallContext = createContext<{ hidden: boolean; busy: boolean; help: boolean; install: () => Promise<void>; closeHelp: () => void } | null>(null)

/** Keep the browser's one-shot prompt across login and workspace navigation. */
export function InstallAppProvider({ children }: { children: ReactNode }) {
  const prompt = useRef<InstallEvent | null>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [standalone, setStandalone] = useState(() => matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  useEffect(() => {
    const available = (event: Event) => { event.preventDefault(); prompt.current = event as InstallEvent }
    const complete = () => { prompt.current = null; setInstalled(true); setHelp(false) }
    const media = matchMedia('(display-mode: standalone)')
    const changed = () => setStandalone(media.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
    window.addEventListener('beforeinstallprompt', available)
    window.addEventListener('appinstalled', complete)
    media.addEventListener('change', changed)
    return () => {
      window.removeEventListener('beforeinstallprompt', available)
      window.removeEventListener('appinstalled', complete)
      media.removeEventListener('change', changed)
    }
  }, [])
  const install = async () => {
    if (pending.current) return
    const event = prompt.current
    if (!event) { setHelp(value => !value); return }
    prompt.current = null
    pending.current = true
    setBusy(true)
    try { await event.prompt(); await event.userChoice; setHelp(false) }
    catch { setHelp(true) }
    finally { pending.current = false; setBusy(false) }
  }
  return <InstallContext.Provider value={{ hidden: installed || standalone, busy, help, install, closeHelp: () => setHelp(false) }}>{children}</InstallContext.Provider>
}

export function InstallAppControl() {
  const state = useContext(InstallContext)
  if (!state || state.hidden) return null
  return <span className="pwa-install">
    <button type="button" className="pwa-install-icon" aria-label="Install app" title={state.busy ? 'Installing…' : 'Install app'} disabled={state.busy} onClick={() => void state.install()}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" /></svg>
    </button>
    {state.help && <span role="dialog" aria-label="Install TradeMatangi" className="pwa-install-help">
      <strong>Install TradeMatangi</strong>
      <p>In Chrome or Edge, use the browser’s Install app menu. On iPad, open the webapp in Safari, then choose Share → Add to Home Screen → Open as Web App.</p>
      <p>The installed app opens /webapp/. This website tab stays here.</p>
      <a href="/webapp/" target="_blank" rel="noopener">Open webapp</a>{' '}
      <button type="button" aria-label="Close installation help" onClick={state.closeHelp}>Close</button>
    </span>}
  </span>
}
