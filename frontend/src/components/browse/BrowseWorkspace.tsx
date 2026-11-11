import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SymbolChoice } from '../../../../shared/SymbolSearch'
import { latestBrowseDate } from '../../../../shared/browse/browseModel.ts'
import api from '../../services/api'
import {
  LAYOUT_LABEL, LAYOUT_PRESETS, layoutRows, parseState, storageKey, updatePane, withLayout,
  type BrowsePane as Pane, type BrowseState, type LayoutPreset,
} from '../../services/browseWorkspace'
import { BrowsePane } from './BrowsePane'
import { BROWSE_HEADER_SLOT } from './browseSlot'


const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

function readSaved(userId: string): string | null {
  try { return localStorage.getItem(storageKey(userId)) } catch { return null }
}

/**
 * Browse on the website: read-only charts, each pane with its own symbol, day and contract (spot, or a CE / PE by strike or by
 * premium cap), in the layouts the trading screen has. For exploring and comparing symbols across days; no session, no orders.
 * The panes are saved per user in this browser and come back next time.
 */
export default function BrowseWorkspace({ userId }: { userId: string }) {
  const fallbackDay = useMemo(() => latestBrowseDate(), [])
  const today = useMemo(istToday, [])
  const [state, setState] = useState<BrowseState>(() => parseState(readSaved(userId), fallbackDay))
  const [symbols, setSymbols] = useState<Array<SymbolChoice & { strike_interval?: number }>>([])
  const [top, setTop] = useState(0)
  const [slot, setSlot] = useState<HTMLElement | null>(null)

  useEffect(() => { try { localStorage.setItem(storageKey(userId), JSON.stringify(state)) } catch { /* private mode: not remembered */ } }, [state, userId])
  useEffect(() => {
    let cancelled = false
    api.getSymbols().then(list => { if (!cancelled) setSymbols(list) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  // Sit right under the website header, whatever its height (it wraps on narrow screens).
  useLayoutEffect(() => {
    const header = document.querySelector('.website-header') as HTMLElement | null
    const measure = () => { setTop(header?.getBoundingClientRect().bottom ?? 0); setSlot(document.getElementById(BROWSE_HEADER_SLOT)) }
    measure()
    const observer = header ? new ResizeObserver(measure) : null
    if (header) observer?.observe(header)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const onPatch = useCallback((id: number, change: Partial<Pane>) => setState(current => updatePane(current, id, change)), [])
  const setLayout = (layout: LayoutPreset) => setState(current => withLayout(current, layout))
  const toggleMaximize = (id: number) => setState(current => ({ ...current, maximized: current.maximized === id ? null : id }))

  const rows = layoutRows(state.layout)
  const maximized = state.maximized
  const layoutSelect = (
    <select aria-label="Browse layout" value={state.layout} onChange={event => setLayout(Number(event.target.value) as LayoutPreset)}
      style={{ background: '#161b22', border: '1px solid #30363d', color: '#8b949e', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
      {LAYOUT_PRESETS.map(preset => <option key={preset} value={preset}>{LAYOUT_LABEL[preset]}</option>)}
    </select>
  )

  return (
    <>
      {slot && createPortal(layoutSelect, slot)}
      <section aria-label="Browse" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, top, zIndex: 20, background: '#0d1117', display: 'flex', flexDirection: 'column', gap: 4, padding: 4, boxSizing: 'border-box' }}>
        {rows.map((row, index) => {
          const rowHidden = maximized !== null && !row.panes.some(i => state.panes[i]?.id === maximized)
          return (
            <div key={index} style={{ display: rowHidden ? 'none' : 'flex', gap: 4, flex: 1, minHeight: 0 }}>
              {row.panes.map((paneIndex, at) => {
                const pane = state.panes[paneIndex]
                if (!pane) return null
                const hidden = maximized !== null && maximized !== pane.id
                return (
                  <div key={pane.id} data-pane={pane.id} style={{ flex: row.flex[at], display: hidden ? 'none' : 'flex', minWidth: 0, minHeight: 0, border: '1px solid #30363d', overflow: 'hidden', position: 'relative' }}>
                    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                      <BrowsePane pane={pane} symbols={symbols.length ? symbols : [{ symbol: pane.symbol, display_name: pane.symbol }]} today={today} onPatch={onPatch}
                        onMaximize={() => toggleMaximize(pane.id)} isMaximized={maximized === pane.id} />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </section>
    </>
  )
}
