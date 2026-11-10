import type { ReactNode } from 'react'
import { NavRail } from './NavRail'
import { OfflineBanner } from './OfflineBanner'

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <NavRail />
      <main className="content">
        <OfflineBanner />
        {children}
      </main>
    </div>
  )
}
