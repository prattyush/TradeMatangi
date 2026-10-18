import { InstallAppControl } from './InstallApp'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function AppShell({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLElement>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement))
  const [message, setMessage] = useState('')

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    const updateFullscreen = () => setFullscreen(Boolean(document.fullscreenElement))
    const resize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--app-bar-height', `${bar.current?.getBoundingClientRect().height ?? 0}px`)
    })
    if (bar.current) resize.observe(bar.current)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => {
      resize.disconnect()
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
      document.removeEventListener('fullscreenchange', updateFullscreen)
    }
  }, [])

  const toggleFullscreen = async () => {
    setMessage('')
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch { setMessage('Full screen is unavailable. You can open the installed app in its own window.') }
  }

  return <div className="webapp-shell">
    <header className="webapp-bar" ref={bar}>
      <span className="webapp-name">TradeMatangi app</span>
      <span className="webapp-connection" role="status">{online ? '' : 'Offline · live data unavailable. Check your connection.'}</span>
      <InstallAppControl />
      {document.fullscreenEnabled && <button onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}>{fullscreen ? 'Exit full screen' : 'Full screen'}</button>}
      {message && <div role="status" className="webapp-help">{message}</div>}
    </header>
    <main className="webapp-workspace">{children}</main>
  </div>
}
