import type { ReactNode } from 'react'
import { useBackHandler } from '../app/Nav'

/** A panel that slides in from the right edge (landscape has width to spare, height it does not). Back closes it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useBackHandler(() => { onClose(); return true })
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <header className="sheet-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-link" aria-label={`Close ${title}`} onClick={onClose}>Close</button>
        </header>
        <div className="sheet-body">{children}</div>
      </aside>
    </div>
  )
}
