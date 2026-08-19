/**
 * PendingLabelPanel — in-session trade labeling surface.
 *
 * Renders two sub-sections when present:
 *  - "Pending exit labels": closed round-trips that haven't been exit-labeled yet.
 *    Each row has Actual pattern + exit tag inputs and a Save button.
 *  - "Label current open trade": each currently-open leg with Expected pattern
 *    + entry tag inputs and a Save button.
 *
 * All data is sent via the existing `api.saveLabels` endpoint with the
 * `(session_id, round_trip_index)` composite key — the backend upsert preserves
 * whichever fields are already saved, so partial saves (entry-only or
 * exit-only) work without clobbering prior data.
 */
import { useState, useEffect } from 'react'
import api from '../services/api'
import type { PendingExitRt, CurrentOpenEntry } from '../hooks/useSimulation'

interface Props {
  sessionId: string
  symbol: string
  pendingExitLabels: PendingExitRt[]
  openLegs: CurrentOpenEntry[]
  openLegLabels: Record<string, string>     // key "right|null" → display label
  savedEntryRtKeys: string[]
  onSaveEntry: (
    rtIndex: number,
    right: string | null,
    fields: { expected_category: string; expected_strategy: string; entry_tag: string },
  ) => Promise<void> | void
  onSaveExit: (
    rtIndex: number,
    right: string | null,
    fields: { actual_category: string; actual_strategy: string; exit_tag: string },
  ) => Promise<void> | void
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px',
  background: '#0d1117', border: '1px solid #30363d',
  borderRadius: 4, color: '#e6edf3', fontSize: 11,
  boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = {
  flex: 1, padding: '5px 6px',
  background: '#0d1117', border: '1px solid #30363d',
  borderRadius: 4, color: '#e6edf3', fontSize: 11,
}

const buttonStyle: React.CSSProperties = {
  background: '#1f6feb', border: 'none', color: '#fff',
  borderRadius: 4, padding: '5px 10px', fontSize: 11,
  fontWeight: 600, cursor: 'pointer',
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11, color: '#8b949e', fontWeight: 600, marginBottom: 6,
}

const rowStyle: React.CSSProperties = {
  marginBottom: 8, padding: 8,
  background: '#0d1117', border: '1px solid #21262d',
  borderRadius: 6,
}

const rowHeaderStyle: React.CSSProperties = {
  fontSize: 11, color: '#e6edf3', fontWeight: 600, marginBottom: 4,
  display: 'flex', justifyContent: 'space-between',
}

const rtKey = (sessionId: string, rtIndex: number, right: string | null) =>
  `${sessionId}#${rtIndex}#${right ?? 'EQ'}`

export default function PendingLabelPanel({
  sessionId,
  symbol,
  pendingExitLabels,
  openLegs,
  openLegLabels,
  savedEntryRtKeys,
  onSaveEntry,
  onSaveExit,
}: Props) {
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [exitTags, setExitTags] = useState<string[]>([])
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const hasPendingExits = pendingExitLabels.length > 0
  const openLegsNeedingLabel = openLegs.filter(o => {
    const key = rtKey(sessionId, o.round_trip_index, o.right)
    return !savedEntryRtKeys.includes(key)
  })
  const hasOpenEntries = openLegsNeedingLabel.length > 0

  if (!hasPendingExits && !hasOpenEntries) {
    return null
  }

  const handleSaveEntry = async (
    rtIndex: number,
    right: string | null,
    expCat: string,
    expStrat: string,
    entryTag: string,
  ) => {
    const key = rtKey(sessionId, rtIndex, right)
    setSavingKey(key)
    setError(null)
    try {
      await onSaveEntry(rtIndex, right, {
        expected_category: expCat,
        expected_strategy: expStrat,
        entry_tag: entryTag,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  const handleSaveExit = async (
    rtIndex: number,
    right: string | null,
    actCat: string,
    actStrat: string,
    exitTag: string,
  ) => {
    const key = rtKey(sessionId, rtIndex, right)
    setSavingKey(key)
    setError(null)
    try {
      await onSaveExit(rtIndex, right, {
        actual_category: actCat,
        actual_strategy: actStrat,
        exit_tag: exitTag,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div style={{
      borderTop: '1px solid #30363d', paddingTop: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {hasPendingExits && (
        <div>
          <div style={sectionHeaderStyle}>
            📝 Pending exit labels ({pendingExitLabels.length})
          </div>
          {pendingExitLabels.map(rt => (
            <ExitRow
              key={rtKey(sessionId, rt.round_trip_index, rt.right)}
              sessionId={sessionId}
              symbol={symbol}
              rt={rt}
              categories={categories}
              strategies={strategies}
              exitTags={exitTags}
              saving={savingKey === rtKey(sessionId, rt.round_trip_index, rt.right)}
              onSave={handleSaveExit}
            />
          ))}
        </div>
      )}

      {hasOpenEntries && (
        <div>
          <div style={sectionHeaderStyle}>
            🏷 Label current open trade
          </div>
          {openLegsNeedingLabel.map(o => {
            const key = o.right ?? 'EQ'
            return (
              <EntryRow
                key={rtKey(sessionId, o.round_trip_index, o.right)}
                rtIndex={o.round_trip_index}
                right={o.right}
                label={openLegLabels[key] ?? symbol}
                categories={categories}
                strategies={strategies}
                entryTags={entryTags}
                saving={savingKey === rtKey(sessionId, o.round_trip_index, o.right)}
                onSave={handleSaveEntry}
              />
            )
          })}
        </div>
      )}

      {error && (
        <div style={{ color: '#f85149', fontSize: 11 }}>{error}</div>
      )}
    </div>
  )
}

function ExitRow({
  sessionId: _sessionId,
  symbol: _symbol,
  rt,
  categories,
  strategies,
  exitTags,
  saving,
  onSave,
}: {
  sessionId: string
  symbol: string
  rt: PendingExitRt
  categories: string[]
  strategies: string[]
  exitTags: string[]
  saving: boolean
  onSave: (
    rtIndex: number,
    right: string | null,
    actCat: string,
    actStrat: string,
    exitTag: string,
  ) => void
}) {
  const [actCat, setActCat] = useState('')
  const [actStrat, setActStrat] = useState('')
  const [exitTag, setExitTag] = useState('AS_PER_PATTERN')

  const ageMin = Math.max(1, Math.round((Date.now() - rt.closed_at) / 60000))

  return (
    <div style={rowStyle} data-testid="pendingexit-label">
      <div style={rowHeaderStyle}>
        <span>{rt.right || 'EQ'} <span style={{ color: '#484f58' }}>closed {ageMin}m ago</span></span>
        <span style={{ color: rt.pnl >= 0 ? '#26a641' : '#f85149' }}>
          {rt.pnl >= 0 ? '+' : ''}{rt.pnl.toFixed(2)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        <select value={actCat} onChange={e => setActCat(e.target.value)} style={selectStyle}>
          <option value="">— Category —</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={actStrat} onChange={e => setActStrat(e.target.value)} style={selectStyle}>
          <option value="">— Strategy —</option>
          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <input
        list={`xt-${rt.round_trip_index}-${rt.right ?? 'EQ'}`}
        value={exitTag}
        onChange={e => setExitTag(e.target.value)}
        placeholder="Exit tag"
        style={{ ...inputStyle, marginBottom: 4 }}
      />
      <datalist id={`xt-${rt.round_trip_index}-${rt.right ?? 'EQ'}`}>
        {exitTags.map(t => <option key={t} value={t} />)}
      </datalist>
      <button
        onClick={() => onSave(rt.round_trip_index, rt.right, actCat, actStrat, exitTag)}
        disabled={saving}
        style={{ ...buttonStyle, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? 'Saving…' : 'Save exit label'}
      </button>
    </div>
  )
}

function EntryRow({
  rtIndex,
  right,
  label,
  categories,
  strategies,
  entryTags,
  saving,
  onSave,
}: {
  rtIndex: number
  right: string | null
  label: string
  categories: string[]
  strategies: string[]
  entryTags: string[]
  saving: boolean
  onSave: (
    rtIndex: number,
    right: string | null,
    expCat: string,
    expStrat: string,
    entryTag: string,
  ) => void
}) {
  const [expCat, setExpCat] = useState('')
  const [expStrat, setExpStrat] = useState('')
  const [entryTag, setEntryTag] = useState('AS_PER_PATTERN')

  return (
    <div style={rowStyle} data-testid="entry-row">
      <div style={rowHeaderStyle}>
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        <select value={expCat} onChange={e => setExpCat(e.target.value)} style={selectStyle}>
          <option value="">— Category —</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={expStrat} onChange={e => setExpStrat(e.target.value)} style={selectStyle}>
          <option value="">— Strategy —</option>
          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <input
        list={`et-${rtIndex}-${right ?? 'EQ'}`}
        value={entryTag}
        onChange={e => setEntryTag(e.target.value)}
        placeholder="Entry tag"
        style={{ ...inputStyle, marginBottom: 4 }}
      />
      <datalist id={`et-${rtIndex}-${right ?? 'EQ'}`}>
        {entryTags.map(t => <option key={t} value={t} />)}
      </datalist>
      <button
        onClick={() => onSave(rtIndex, right, expCat, expStrat, entryTag)}
        disabled={saving}
        style={{ ...buttonStyle, opacity: saving ? 0.6 : 1 }}
      >
        {saving ? 'Saving…' : 'Save entry label'}
      </button>
    </div>
  )
}