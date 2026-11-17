import { useEffect, useRef } from 'react'
import { formatDay, setupId } from '../model'
import type { DiveSetup } from '../types'

interface Props { setups: DiveSetup[]; index: number; onSelect: (index: number) => void }

/**
 * One chip per marked day, in walking order: green when every tag is marked, amber when some are not. It is a tab list: one tab
 * stop, and the arrow keys (Home and End too) move to the previous or next day, so a long dive can be walked from the keyboard.
 */
export default function DayStrip({ setups, index, onSelect }: Props) {
  const chips = useRef<Array<HTMLButtonElement | null>>([])
  const moved = useRef(false)
  // After a key moved the selection, the new chip takes focus (a click already has it).
  useEffect(() => { if (moved.current) { moved.current = false; chips.current[index]?.focus() } }, [index])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = setups.length - 1
    const target = event.key === 'ArrowRight' ? Math.min(last, index + 1) : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (target === null) return
    event.preventDefault()
    if (target !== index) { moved.current = true; onSelect(target) }
  }

  return <div className="dd-strip" role="tablist" aria-label="Marked days" onKeyDown={onKeyDown}>
    {setups.map((setup, position) => <button key={setupId(setup)} role="tab" aria-selected={position === index} tabIndex={position === index ? 0 : -1}
      ref={element => { chips.current[position] = element }}
      className={`dd-chip ${setup.complete ? 'complete' : 'incomplete'} ${setup.side}`} onClick={() => onSelect(position)}
      title={setup.complete ? 'All tags marked' : `${setup.missing.length} tag${setup.missing.length === 1 ? '' : 's'} not marked`}>
      {formatDay(setup.date).replace(/ \d{4}$/, '')} <b>{setup.side === 'buy' ? 'B' : 'S'}</b>
    </button>)}
  </div>
}
