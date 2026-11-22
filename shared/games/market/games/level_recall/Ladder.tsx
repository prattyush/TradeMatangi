import { useRef } from 'react'
import { priceTicks } from '../../../chart/chartModel'

export interface LadderLine { label: string; value: number; tone: 'placed' | 'truth' | 'now' | 'pending' }

const HEIGHT = 420

/** A blank price ladder: the player clicks where a level is. It draws absolute prices on a vertical axis, the current price, and any lines it is given. */
export function Ladder({ lo, hi, lines, onPlace, disabled, label }: { lo: number; hi: number; lines: LadderLine[]; onPlace?: (price: number) => void; disabled?: boolean; label: string }) {
  const box = useRef<HTMLDivElement>(null)
  const y = (price: number): number => (1 - (price - lo) / (hi - lo)) * HEIGHT
  const click = (event: React.MouseEvent) => {
    if (disabled || !onPlace || !box.current) return
    const rect = box.current.getBoundingClientRect()
    const fraction = (event.clientY - rect.top) / rect.height
    onPlace(Math.round((hi - fraction * (hi - lo)) * 20) / 20)
  }
  return (
    <div ref={box} className="games-ladder" role="application" aria-label={label} style={{ height: HEIGHT }} onClick={click} data-disabled={disabled || undefined}>
      {priceTicks([lo, hi], 8).map(tick => <div key={tick} className="games-ladder-tick" style={{ top: y(tick) }}><span>{tick}</span></div>)}
      {lines.map(line => <div key={`${line.tone}-${line.label}`} className={`games-ladder-line is-${line.tone}`} style={{ top: y(line.value) }}><span>{line.label}</span></div>)}
    </div>
  )
}
