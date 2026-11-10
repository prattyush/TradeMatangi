import type { ReactElement } from 'react'
import type { Tab } from '../app/Nav'

const paths: Record<Tab, ReactElement> = {
  sessions: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  stats: <><path d="M5 20V10M12 20V4M19 20v-7" /></>,
  browse: <><path d="M7 4v16M7 8h-2v6h2M17 4v16M17 6h-2v8h2M12 9v8M12 11h-1.5v4H12" /></>,
  positions: <><rect x="4" y="7" width="16" height="12" rx="2" /><path d="M9 7V5h6v2M4 12h16" /></>,
  videos: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M10 9.5v5l4.5-2.5z" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
}

export function TabIcon({ tab }: { tab: Tab }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[tab]}
    </svg>
  )
}
