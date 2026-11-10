import { useEffect, useRef, useState } from 'react'
import { useBackHandler } from '../app/Nav'

export interface MenuItem<T extends string> { id: T; label: string; detail?: string }

/**
 * A button that opens a short list over whatever is below it. Landscape has width but not height, so choices live in a
 * popover instead of taking a row. Back or a tap outside closes it; items are 44 px tall.
 */
export function PopoverMenu<T extends string>({ ariaLabel, value, items, onChange, buttonLabel, align = 'left' }: {
  ariaLabel: string; value: T; items: Array<MenuItem<T>>; onChange: (next: T) => void; buttonLabel?: string; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  // A long list (the strikes) opens with the current choice in view.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'center' })
  }, [open])
  useBackHandler(open ? () => { setOpen(false); return true } : null)
  const current = items.find(item => item.id === value)
  return (
    <div className="popover-menu">
      <button type="button" className="menu-button" aria-haspopup="menu" aria-expanded={open} aria-label={`${ariaLabel}: ${current?.label ?? ''}`} onClick={() => setOpen(state => !state)}>
        <span>{buttonLabel ?? current?.label}</span>
        <span aria-hidden="true" className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <ul ref={list} className={`menu-list menu-${align}`} role="menu" aria-label={ariaLabel}>
            {items.map(item => (
              <li key={item.id} role="none">
                <button type="button" role="menuitemradio" aria-checked={item.id === value} onClick={() => { onChange(item.id); setOpen(false) }}>
                  <span>{item.label}</span>
                  {item.detail && <small>{item.detail}</small>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
