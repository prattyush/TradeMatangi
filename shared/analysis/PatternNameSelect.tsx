import { useState, type CSSProperties } from 'react'

const ADD_NEW = '__add_new__'
// Mirrors the backend rules in pattern_logger_service._validate_name, so the user gets feedback without a round trip.
const MAX_NAME_LENGTH = 60

function validate(name: string): string {
  if (name.length > MAX_NAME_LENGTH) return `At most ${MAX_NAME_LENGTH} characters`
  if (name.includes('::')) return "Must not contain '::'"
  return ''
}

interface PatternNameSelectProps {
  noun: 'category' | 'strategy'
  value: string
  options: string[]
  placeholder: string
  disabled?: boolean
  style: CSSProperties
  onChange: (value: string) => void
  /** Persists a new name and resolves to the stored name. */
  onCreate: (name: string) => Promise<string>
}

/** Dropdown of existing pattern names with a trailing "+ Add new…" entry that reveals an inline input. */
export default function PatternNameSelect({ noun, value, options, placeholder, disabled, style, onChange, onCreate }: PatternNameSelectProps) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const close = () => { setAdding(false); setDraft(''); setError('') }

  const submit = async () => {
    const name = draft.trim()
    if (!name || busy) return
    const invalid = validate(name)
    if (invalid) { setError(invalid); return }
    if (options.includes(name)) { onChange(name); close(); return }
    setBusy(true); setError('')
    try {
      onChange(await onCreate(name))
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not add ${noun}`)
    } finally {
      setBusy(false)
    }
  }

  if (!adding) {
    return (
      <select disabled={disabled} value={value} style={style}
        onChange={e => e.target.value === ADD_NEW ? setAdding(true) : onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
        <option value={ADD_NEW}>+ Add new…</option>
      </select>
    )
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: 'inline-flex', gap: 2 }}>
        <input autoFocus disabled={busy} value={draft} placeholder={`New ${noun}…`}
          style={{ ...style, width: 110 }}
          onChange={e => { setDraft(e.target.value); setError('') }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void submit() }
            else if (e.key === 'Escape') close()
          }} />
        <button type="button" disabled={busy || !draft.trim()} title={`Add ${noun}`} aria-label={`Add ${noun}`}
          style={{ ...style, cursor: 'pointer', maxWidth: 'none' }} onClick={() => void submit()}>✓</button>
        <button type="button" disabled={busy} title="Cancel" aria-label="Cancel"
          style={{ ...style, cursor: 'pointer', maxWidth: 'none' }} onClick={close}>✕</button>
      </span>
      {error && <span style={{ color: '#f85149', fontSize: 10 }}>{error}</span>}
    </span>
  )
}
