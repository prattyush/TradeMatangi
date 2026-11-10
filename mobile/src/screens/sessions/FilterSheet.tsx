import { useState } from 'react'
import { Sheet } from '../../shell/Sheet'
import { customRangeProblem, DEFAULT_FILTERS, RANGE_LABELS, type RangePreset, type SessionFilters } from './filters'

const RANGES: RangePreset[] = ['7d', '30d', '90d', '1y', 'custom']
const STYLES: Array<[SessionFilters['style'], string]> = [['', 'All'], ['intraday', 'Day'], ['swing', 'Swing']]
const MODES: Array<[SessionFilters['mode'], string]> = [['', 'All'], ['sim', 'Replay'], ['stepwise', 'Stepwise'], ['paper', 'Paper'], ['real', 'Real']]
const INSTRUMENTS: Array<[SessionFilters['instrument'], string]> = [['', 'All'], ['equity', 'Equity'], ['options', 'Options']]

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (next: T) => void }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="chips">
        {options.map(([id, text]) => (
          <button key={id || 'all'} type="button" className="chip" aria-pressed={value === id} onClick={() => onChange(id)}>{text}</button>
        ))}
      </div>
    </div>
  )
}

/** Edits a copy of the filters; nothing changes on the list until Apply. */
export function FilterSheet({ filters, symbols, onApply, onClose }: { filters: SessionFilters; symbols: string[]; onApply: (next: SessionFilters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(filters)
  const patch = (change: Partial<SessionFilters>) => setDraft(current => ({ ...current, ...change }))
  const problem = customRangeProblem(draft)
  return (
    <Sheet title="Filters" onClose={onClose}>
      <div className="field" role="group" aria-label="Period">
        <span className="field-label">Period</span>
        <div className="chips">
          {RANGES.map(range => (
            <button key={range} type="button" className="chip" aria-pressed={draft.range === range} onClick={() => patch({ range })}>
              {range === 'custom' ? 'Custom' : RANGE_LABELS[range]}
            </button>
          ))}
        </div>
      </div>
      {draft.range === 'custom' && (
        <div className="field-row">
          <label>From<input type="date" value={draft.start} max={draft.end || undefined} onChange={event => patch({ start: event.target.value })} /></label>
          <label>To<input type="date" value={draft.end} min={draft.start || undefined} onChange={event => patch({ end: event.target.value })} /></label>
        </div>
      )}
      {problem && <div className="form-error" role="alert">{problem}</div>}
      <Chips label="Style" value={draft.style} options={STYLES} onChange={style => patch({ style })} />
      <Chips label="Mode" value={draft.mode} options={MODES} onChange={mode => patch({ mode })} />
      <Chips label="Instrument" value={draft.instrument} options={INSTRUMENTS} onChange={instrument => patch({ instrument })} />
      <label>
        Symbol
        <input type="text" list="session-symbols" autoCapitalize="characters" autoCorrect="off" value={draft.symbol} placeholder="All symbols" onChange={event => patch({ symbol: event.target.value.toUpperCase() })} />
        <datalist id="session-symbols">{symbols.map(symbol => <option key={symbol} value={symbol} />)}</datalist>
      </label>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={() => setDraft(DEFAULT_FILTERS)}>Reset</button>
        <button type="button" className="btn btn-primary" disabled={problem !== null} onClick={() => onApply(draft)}>Apply</button>
      </div>
    </Sheet>
  )
}
