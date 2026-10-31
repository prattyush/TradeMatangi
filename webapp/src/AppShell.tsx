import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppWindowControlsContext } from '../../shared/AppWindowControls'
import { flashError } from '../../shared/notifications'

export function AppShell({ children }: { children: ReactNode }) {
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement))
  const [exitVisible, setExitVisible] = useState(false)
  const exitButton = useRef<HTMLButtonElement>(null)
  const exitHovered = useRef(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const clearHide = () => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = undefined
  }
  const hideLater = () => {
    if (hideTimer.current !== undefined || exitHovered.current || document.activeElement === exitButton.current) return
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined
      setExitVisible(false)
    }, 1500)
  }

  useEffect(() => {
    const changed = () => {
      setFullscreen(Boolean(document.fullscreenElement))
      setExitVisible(false)
      exitHovered.current = false
      clearHide()
    }
    const offline = () => flashError('Offline · live data unavailable. Check your connection.', 'Connection')
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
    document.addEventListener('fullscreenchange', changed)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('offline', offline)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('offline', offline)
      clearHide()
    }
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      if (event.clientY <= 8) { clearHide(); setExitVisible(true) }
      else if (exitVisible) hideLater()
    }
    // Observe the edge without an invisible hit area over the chart/header.
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      clearHide()
    }
  }, [fullscreen, exitVisible])

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      flashError('Full screen is unavailable. You can open the installed app in its own window.', 'Full screen')
    }
  }
  const controls = document.fullscreenEnabled ? <button type="button"
    className={`app-fullscreen-button${fullscreen ? ' is-fullscreen' : ''}`}
    aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
    title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen}
    onClick={() => void toggleFullscreen()}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d={fullscreen ? 'M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5' : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'} />
    </svg>
  </button> : null

  return <AppWindowControlsContext.Provider value={controls}>
    <div className="webapp-shell">
      <main className="webapp-workspace">{children}</main>
      {fullscreen && <button ref={exitButton} type="button" className="webapp-fullscreen-exit"
        aria-label="Exit full screen" title="Exit full screen (Esc)" data-visible={exitVisible}
        onPointerEnter={() => { exitHovered.current = true; clearHide(); setExitVisible(true) }}
        onPointerLeave={() => { exitHovered.current = false; hideLater() }}
        onFocus={() => { clearHide(); setExitVisible(true) }} onBlur={hideLater}
        onClick={() => void toggleFullscreen()}>×</button>}
    </div>
  </AppWindowControlsContext.Provider>
}
