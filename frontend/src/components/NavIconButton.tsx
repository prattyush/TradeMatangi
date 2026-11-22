import type { ReactNode } from 'react'

/** Header navigation as icon buttons: one 30x30 box, one 18px line-icon style, a tooltip that shows at once. */
export type NavIconName = 'browse' | 'trading' | 'swing' | 'analysis' | 'patterns' | 'structures'

const ICONS: Record<NavIconName, ReactNode> = {
  // candlesticks: a chart to look at
  browse: <><path d="M7 3v3M7 14v3M5 6h4v8H5zM15 5v2M15 15v3M13 7h4v8h-4z" /><path d="M3 21h18" /></>,
  // a left arrow into a candle: back to the trading screen
  trading: <><path d="M10 7l-5 5 5 5M5 12h9" /><path d="M19 5v3M19 16v3M17 8h4v8h-4z" /></>,
  // stacked layers: positions held across days
  swing: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5M3 17.5l9 5 9-5" opacity=".6" /></>,
  // bars over a baseline: trade analysis
  analysis: <><path d="M5 20v-6M12 20V5M19 20v-10" /><path d="M3 20.5h18" /></>,
  // an open book: the pattern library
  patterns: <><path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14" /></>,
  // a stepped line: market structure (highs and lows)
  structures: <><path d="M3 18l5-7 4 4 4-9 5 6" /><path d="M3 21h18" /></>,
}

export default function NavIconButton({ icon, label, onClick, active = false }: {
  icon: NavIconName
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button type="button" className={`nav-icon-btn${active ? ' nav-icon-btn--active' : ''}`}
      onClick={onClick} aria-label={label} aria-pressed={active || undefined} data-tooltip={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[icon]}</svg>
    </button>
  )
}
