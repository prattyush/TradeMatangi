import { useState } from 'react'
import { premiumPresetsFor } from '../../../../shared/optionPremiumPresets'
import { Sheet } from '../../shell/Sheet'
import { parseCap, type OptionRight } from './browseModel'

/**
 * Max Price for one side: the strike is the first one (from the money outwards) whose premium is at or below the cap,
 * found for each day by the server, as in the desktop picker. Nothing changes until Use.
 */
export function MaxPriceSheet({ symbol, right, cap, active, onUse, onManual, onClose }: {
  symbol: string; right: OptionRight; cap: number | null; active: boolean
  onUse: (cap: number) => void; onManual: () => void; onClose: () => void
}) {
  const [text, setText] = useState(cap === null ? '' : String(cap))
  const value = parseCap(text)
  return (
    <Sheet title={`${right} max price`} onClose={onClose}>
      <p className="muted">
        Picks the {right} strike whose premium at 9:30 is at or below the cap, closest to the money. It is looked up again for every day you open.
      </p>
      <div className="chips" role="group" aria-label="Premium cap presets">
        {premiumPresetsFor(symbol).map(preset => (
          <button key={preset} type="button" className="chip" aria-pressed={value === preset} onClick={() => setText(String(preset))}>₹{preset}</button>
        ))}
      </div>
      <label>
        Premium cap (₹)
        <input inputMode="decimal" value={text} placeholder="e.g. 60" onChange={event => setText(event.target.value)} />
      </label>
      <div className="sheet-actions">
        {active && <button type="button" className="btn" onClick={onManual}>Manual strike</button>}
        <button type="button" className="btn btn-primary" disabled={value === null} onClick={() => value !== null && onUse(value)}>Use</button>
      </div>
    </Sheet>
  )
}
