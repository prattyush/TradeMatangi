import type { CSSProperties } from 'react'
import PatternNameSelect from '../PatternNameSelect'
import type { TradeLabel } from '../api'

interface Props {
  idPrefix: string
  label: TradeLabel
  disabled: boolean
  categories: string[]
  strategies: string[]
  entryTags: string[]
  exitTags: string[]
  onChange: (patch: Partial<TradeLabel>) => void
  /** Persists a new registry name immediately and resolves to the stored name. */
  onCreateName: (kind: 'category' | 'strategy', name: string) => Promise<string>
}

const selectStyle: CSSProperties = {
  background: 'var(--tl-bg, #0d1117)', border: '1px solid var(--tl-border, #30363d)', color: 'var(--tl-text, #e6edf3)',
  borderRadius: 4, padding: '4px 6px', fontSize: 12, maxWidth: 160,
}

/** Category / strategy / tag fields of one round trip; shared by the one-at-a-time panel and the all-together list. */
export default function RoundTripLabelForm({ idPrefix, label, disabled, categories, strategies, entryTags, exitTags, onChange, onCreateName }: Props) {
  const patternRow = (kind: 'expected' | 'actual') => (
    <div className="tl-field-row">
      <PatternNameSelect noun="category" placeholder="— Category —" disabled={disabled} value={label[`${kind}_category`]}
        options={categories} style={selectStyle} onChange={value => onChange({ [`${kind}_category`]: value })} onCreate={name => onCreateName('category', name)} />
      <PatternNameSelect noun="strategy" placeholder="— Strategy —" disabled={disabled} value={label[`${kind}_strategy`]}
        options={strategies} style={selectStyle} onChange={value => onChange({ [`${kind}_strategy`]: value })} onCreate={name => onCreateName('strategy', name)} />
    </div>
  )
  return (
    <div className="tl-form">
      <div className="tl-field"><span className="tl-label">Expected Pattern</span>{patternRow('expected')}</div>
      <div className="tl-field"><span className="tl-label">Actual Pattern</span>{patternRow('actual')}</div>
      <div className="tl-field">
        <label htmlFor={`et-in-${idPrefix}`}>Entry Tag</label>
        <input id={`et-in-${idPrefix}`} className="tl-input" disabled={disabled} list={`et-${idPrefix}`} value={label.entry_tag}
          placeholder="AS_PER_PATTERN" onChange={event => onChange({ entry_tag: event.target.value })} />
        <datalist id={`et-${idPrefix}`}>{entryTags.map(tag => <option key={tag} value={tag} />)}</datalist>
      </div>
      <div className="tl-field">
        <label htmlFor={`xt-in-${idPrefix}`}>Exit Tag</label>
        <input id={`xt-in-${idPrefix}`} className="tl-input" disabled={disabled} list={`xt-${idPrefix}`} value={label.exit_tag}
          placeholder="AS_PER_PATTERN" onChange={event => onChange({ exit_tag: event.target.value })} />
        <datalist id={`xt-${idPrefix}`}>{exitTags.map(tag => <option key={tag} value={tag} />)}</datalist>
      </div>
    </div>
  )
}
