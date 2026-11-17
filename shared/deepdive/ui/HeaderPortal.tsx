import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDeepDiveHost } from './host'

/**
 * Puts the Deep Dive's own header controls (back to the list, the deep dive's name, its steps, and in the in-depth step the
 * Prev and Next walk) into the same row as the Pattern Library's tabs, when the host gives it a slot there: one row less, so the
 * charts get the height. Without a slot (a host that has none) the controls render in their own row, as they always did.
 */
export default function HeaderPortal({ children }: { children: ReactNode }) {
  const { headerSlot } = useDeepDiveHost()
  return headerSlot
    ? createPortal(<div className="dd-head-group in-header">{children}</div>, headerSlot)
    : <div className="pl-bar dd-head-group">{children}</div>
}
