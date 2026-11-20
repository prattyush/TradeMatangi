import { lazy, Suspense, useLayoutEffect, useState } from 'react'
import { websiteGamesRequest } from '../../services/gamesRequest'
import type { SessionKind } from '../../../../shared/games/ui/GamesApp'

const GamesApp = lazy(() => import('../../../../shared/games/ui/GamesApp'))

/**
 * Games on the website, laid out like Browse: a fixed overlay under the header. The trading screen is never unmounted or hidden
 * with `display: none` while a session runs, so streams, alerts and notifications keep working beneath it. The overlay sits at
 * z-index 20, below every modal, popup and notification (all 1000 and above). Games get one prop from the page, `sessionKind`,
 * and import nothing from trading.
 */
export default function GamesWorkspace({ sessionKind }: { sessionKind: SessionKind }) {
  const [top, setTop] = useState(0)
  const [left, setLeft] = useState(0)
  // Sit right under the website header and beside the shared drawing rail, whatever their size.
  useLayoutEffect(() => {
    const header = document.querySelector('.website-header') as HTMLElement | null
    const tools = document.querySelector('.website-chart-tools') as HTMLElement | null
    const measure = () => {
      setTop(header?.getBoundingClientRect().bottom ?? 0)
      setLeft(tools && !tools.hidden ? tools.getBoundingClientRect().right : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (header) observer.observe(header)
    if (tools) observer.observe(tools)
    const mutations = tools ? new MutationObserver(measure) : null
    if (tools) mutations?.observe(tools, { attributes: true, attributeFilter: ['hidden', 'class'] })
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); mutations?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  return (
    <section aria-label="Games" style={{ position: 'fixed', left, right: 0, bottom: 0, top, zIndex: 20, background: '#0d1117', overflow: 'auto' }}>
      <Suspense fallback={<p role="status" style={{ color: '#8b949e', padding: 16 }}>Loading Games…</p>}>
        <GamesApp request={websiteGamesRequest} sessionKind={sessionKind} />
      </Suspense>
    </section>
  )
}
