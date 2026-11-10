import { useNav, type Tab } from '../app/Nav'
import { TabIcon } from './icons'

export const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'stats', label: 'Stats' },
  { id: 'browse', label: 'Browse' },
  { id: 'videos', label: 'Videos' },
  { id: 'more', label: 'More' },
]

/** 56 px rail on the left; respects the display cutout through the shell's safe-area padding. */
export function NavRail() {
  const { tab, setTab } = useNav()
  return (
    <nav className="nav-rail" aria-label="Main">
      {TABS.map(item => (
        <button
          key={item.id}
          type="button"
          className="nav-item"
          aria-label={item.label}
          aria-current={tab === item.id ? 'page' : undefined}
          onClick={() => setTab(item.id)}
        >
          <TabIcon tab={item.id} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}
