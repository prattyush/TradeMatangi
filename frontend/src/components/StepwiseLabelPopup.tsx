/**
 * StepwiseLabelPopup — trade labeling popup shown when a round-trip completes
 * in stepwise mode. Collects expected/actual pattern, entry/exit tags and persists
 * via the TradeLabels API.
 */
import { useState, useEffect } from 'react'
import api from '../services/api'

interface PendingRoundTrip {
  right: string
  pnl: number
}

interface Props {
  sid: string
  date: string
  symbol: string
  roundTrips: PendingRoundTrip[]
  onDone: () => void
}

export default function StepwiseLabelPopup({ sid, date, symbol, roundTrips, onDone }: Props) {
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [exitTags, setExitTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [fields, setFields] = useState(roundTrips.map(() => ({
    expCat: '', expStrat: '', actCat: '', actStrat: '', entryTag: 'AS_PER_PATTERN', exitTag: 'AS_PER_PATTERN',
  })))

  useEffect(() => {
    Promise.all([
      api.patternListStrategies().catch(() => ({ strategies: [] })),
      api.patternListCategories().catch(() => ({ categories: [] })),
      api.getEntryTags().catch(() => []),
      api.getExitTags().catch(() => []),
    ]).then(([ss, cs, ets, xts]) => {
      setStrategies((ss as { strategies: string[] }).strategies)
      setCategories((cs as { categories: string[] }).categories)
      setEntryTags(ets as string[])
      setExitTags(xts as string[])
    }).catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const labels = roundTrips.map((_rt, i) => ({
        session_id: sid,
        round_trip_index: i,
        expected_category: fields[i].expCat,
        expected_strategy: fields[i].expStrat,
        actual_category: fields[i].actCat || fields[i].expCat,
        actual_strategy: fields[i].actStrat || fields[i].expStrat,
        entry_tag: fields[i].entryTag,
        exit_tag: fields[i].exitTag,
      }))
      await api.saveLabels(labels)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save labels')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
    }}>
      <div style={{
        width: 500, maxHeight: '90vh', overflow: 'auto',
        padding: 24, background: '#161b22',
        border: '1px solid #30363d', borderRadius: 12,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#f0883e', marginBottom: 8 }}>
          📝 Label Trade{roundTrips.length > 1 ? 's' : ''}
        </div>
        <div style={{ fontSize: 12, color: '#484f58', marginBottom: 16 }}>
          {roundTrips.length} round-trip{roundTrips.length > 1 ? 's' : ''} completed in {symbol} on {date}. Fill in the pattern details below.
        </div>

        {roundTrips.map((rt, i) => (
          <div key={i} style={{
            marginBottom: 16, padding: 12, background: '#0d1117',
            border: '1px solid #21262d', borderRadius: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>
              RT#{i + 1} — {rt.right || 'EQ'}
              <span style={{ marginLeft: 8, color: rt.pnl >= 0 ? '#26a641' : '#f85149', fontSize: 12 }}>
                {rt.pnl >= 0 ? '+' : ''}{rt.pnl.toFixed(2)}
              </span>
            </div>
            <Field label="Expected Category" options={categories} value={fields[i].expCat} onChange={v => updateField(i, 'expCat', v)} />
            <Field label="Expected Strategy" options={strategies} value={fields[i].expStrat} onChange={v => updateField(i, 'expStrat', v)} />
            <Field label="Actual Category" options={categories} value={fields[i].actCat} onChange={v => updateField(i, 'actCat', v)} />
            <Field label="Actual Strategy" options={strategies} value={fields[i].actStrat} onChange={v => updateField(i, 'actStrat', v)} />
            <Field label="Entry Tag" options={entryTags} value={fields[i].entryTag} onChange={v => updateField(i, 'entryTag', v)} allowCreate />
            <Field label="Exit Tag" options={exitTags} value={fields[i].exitTag} onChange={v => updateField(i, 'exitTag', v)} allowCreate />
          </div>
        ))}

        {error && <div style={{ color: '#f85149', fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onDone} style={{
            background: '#21262d', border: '1px solid #30363d',
            color: '#8b949e', borderRadius: 6, padding: '8px 16px',
            fontSize: 13, cursor: 'pointer',
          }}>Skip</button>
          <button onClick={handleSave} disabled={saving} style={{
            background: '#1f6feb', border: 'none',
            color: '#fff', borderRadius: 6, padding: '8px 16px',
            fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}>{saving ? 'Saving…' : 'Save & Continue'}</button>
        </div>
      </div>
    </div>
  )

  function updateField(i: number, key: string, value: string) {
    setFields(prev => {
      const next = [...prev]
      ;(next[i] as any)[key] = value
      return next
    })
  }
}

function Field({
  label, options, value, onChange, allowCreate,
}: {
  label: string; options: string[]; value: string; onChange: (v: string) => void; allowCreate?: boolean
}) {
  const [local, setLocal] = useState(value || '')
  const existing = [...new Set(options)].sort()

  const optionId = `field-${label.replace(/\s/g, '')}`

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 3 }}>{label}</div>
      {allowCreate ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            value={local}
            onChange={e => { setLocal(e.target.value); onChange(e.target.value) }}
            list={optionId}
            placeholder={label}
            style={{
              flex: 1, padding: '5px 8px',
              background: '#161b22', border: '1px solid #30363d',
              borderRadius: 4, color: '#e6edf3', fontSize: 12,
            }}
          />
          <datalist id={optionId}>
            {existing.map(o => <option key={o} value={o} />)}
          </datalist>
        </div>
      ) : (
        <select
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          style={{
            width: '100%', padding: '5px 8px',
            background: '#161b22', border: '1px solid #30363d',
            borderRadius: 4, color: '#e6edf3', fontSize: 12,
          }}
        >
          <option value="">— select —</option>
          {existing.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
    </div>
  )
}
