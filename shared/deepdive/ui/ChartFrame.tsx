import { useCallback, useState, type ReactNode } from 'react'

interface FrameProps {
  /** The box's own class (`dd-chartbox` or `td-chartbox`). */
  className: string
  /** What the chart is, for the bar and the button's name ("NIFTY", "CE 24500"). */
  label: string
  isMaximized: boolean
  /** Hidden while the other chart is maximized: it stays mounted (no reload, nothing lost) and only disappears. */
  isHidden: boolean
  onToggle: () => void
  children: ReactNode
}

/** A chart with a thin bar above it holding its name and a Maximize / Restore button. Maximizing one chart gives it the whole chart area. */
export default function ChartFrame({ className, label, isMaximized, isHidden, onToggle, children }: FrameProps) {
  return <div className={className} hidden={isHidden} data-maximized={isMaximized ? 'true' : undefined}>
    <div className="dd-frame-bar">
      <span className="dd-frame-name">{label}</span>
      <button type="button" aria-pressed={isMaximized} aria-label={`${isMaximized ? 'Restore' : 'Maximize'} ${label} chart`}
        title={isMaximized ? 'Show both charts again' : 'Give this chart the whole chart area'} onClick={onToggle}>
        {isMaximized ? '⤡ Restore' : '⤢ Maximize'}
      </button>
    </div>
    {children}
  </div>
}

/** What each screen last had maximized, kept while the app is open so stepping to the next day or trade keeps the chosen chart big. */
const remembered: Record<string, string | null> = {}

/**
 * Which of a screen's charts is maximized. `available` lists the charts the current day or trade has; a remembered choice that is
 * not there (an underlying-only trade after maximizing the contract chart) simply counts as none.
 */
export function useMaximizedChart<K extends string>(scope: string, available: readonly K[]) {
  const [value, setValue] = useState<string | null>(remembered[scope] ?? null)
  const maximized = value !== null && (available as readonly string[]).includes(value) ? (value as K) : null
  const toggle = useCallback((which: K) => setValue(current => { const next = current === which ? null : which; remembered[scope] = next; return next }), [scope])
  return { maximized, toggle }
}
