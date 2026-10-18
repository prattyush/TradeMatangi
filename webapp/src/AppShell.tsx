import { useEffect, useRef, useState, type ReactNode } from 'react'

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function AppShell({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLElement>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement))
  const [install, setInstall] = useState<InstallEvent | null>(null)
  const [standalone, setStandalone] = useState(() => matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  const [help, setHelp] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    const updateFullscreen = () => setFullscreen(Boolean(document.fullscreenElement))
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent) }
    const installed = () => { setInstall(null); setStandalone(true); setHelp(false) }
    const media = matchMedia('(display-mode: standalone)')
    const displayChanged = () => setStandalone(media.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
    const resize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--app-bar-height', `${bar.current?.getBoundingClientRect().height ?? 0}px`)
    })
    if (bar.current) resize.observe(bar.current)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    document.addEventListener('fullscreenchange', updateFullscreen)
    window.addEventListener('beforeinstallprompt', prompt)
    window.addEventListener('appinstalled', installed)
    media.addEventListener('change', displayChanged)
    return () => {
      resize.disconnect()
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
      document.removeEventListener('fullscreenchange', updateFullscreen)
      window.removeEventListener('beforeinstallprompt', prompt)
      window.removeEventListener('appinstalled', installed)
      media.removeEventListener('change', displayChanged)
    }
  }, [])

  const toggleFullscreen = async () => {
    setMessage('')
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch { setMessage('Full screen is unavailable. You can open the installed app in its own window.') }
  }
  const installApp = async () => {
    if (!install) { setHelp(value => !value); return }
    try {
      await install.prompt()
      await install.userChoice
    } catch { setHelp(true) }
    finally { setInstall(null) }
  }

  return <div className="webapp-shell">
    <header className="webapp-bar" ref={bar}>
      <span className="webapp-name">TradeMatangi app</span>
      <span className="webapp-connection" role="status">{online ? '' : 'Offline · live data unavailable. Check your connection.'}</span>
      {!standalone && <button onClick={() => void installApp()}>{install ? 'Install app' : 'How to install'}</button>}
      {document.fullscreenEnabled && <button onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}>{fullscreen ? 'Exit full screen' : 'Full screen'}</button>}
      {help && <div className="webapp-help">In Chrome or Edge, use the browser’s Install app menu. On iPad, open in Safari and choose Share → Add to Home Screen → Open as Web App.</div>}
      {message && <div role="status" className="webapp-help">{message}</div>}
    </header>
    <main className="webapp-workspace">{children}</main>
  </div>
}
