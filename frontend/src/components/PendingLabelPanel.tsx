/**
 * PendingLabelPanel — compact in-session trade labeling surface.
 *
 * Shows two sub-sections:
 *  - "Pending exit labels": closed round-trips that haven't been exit-labeled yet.
 *    Each row is a compact button that opens a popup modal with Actual pattern + exit tag.
 *  - "Label current open trade": each currently-open leg with a button that opens a
 *    popup modal with Expected pattern + entry tag.
 *
 * All data is sent via the existing `api.saveLabels` endpoint with the
 * `(session_id, round_trip_index)` composite key — the backend upsert preserves
 * whichever fields are already saved, so partial saves (entry-only or
 * exit-only) work without clobbering prior data.
 */
import { useState, useEffect } from 'react'
import api from '../services/api'
import type { PendingExitRt } from '../hooks/useSimulation'

interface Props {
  sessionId: string
  pendingExitLabels: PendingExitRt[]
  openLegs: { right: string | null; rtIndex: number; label: string }[]
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
  width: '100%', padding: '6px 8px',
  background: '#0d1117', border: '1px solid #30363d',
  borderRadius: 4, color: '#e6edf3', fontSize: 12,
  boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = {
  flex: 1, padding: '6px 6px',
  background: '#0d1117', border: '1px solid #30363d',
  borderRadius: 4, color: '#e6edf3', fontSize: 12,
}

const rtKey = (sessionId: string, rtIndex: number, right: string | null) =>
  `${sessionId}#${rtIndex}#${right ?? 'EQ'}`

export default function PendingLabelPanel({
  sessionId,
  pendingExitLabels,
  openLegs,
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

  const [openPopup, setOpenPopup] = useState<{
    mode: 'entry' | 'exit'
    rtIndex: number
    right: string | null
    label: string
    pnl?: number
    closedAt?: number
  } | null>(null)

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
    const key = rtKey(sessionId, o.rtIndex, o.right)
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
      setOpenPopup(null)
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
      setOpenPopup(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <>
      <div style={{
        borderTop: '1px solid #30363d', paddingTop: 8,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {hasPendingExits && (
          <div style={{ fontSize: 10, color: '#8b949e', fontWeight: 600, marginBottom: 2 }}>
            📝 Pending exit ({pendingExitLabels.length})
          </div>
        )}
        {pendingExitLabels.map(rt => {
          const ageMin = Math.max(1, Math.round((Date.now() - rt.closed_at) / 60000))
          return (
            <button
              key={rtKey(sessionId, rt.round_trip_index, rt.right)}
              onClick={() => setOpenPopup({
                mode: 'exit', rtIndex: rt.round_trip_index, right: rt.right,
                label: rt.right || 'EQ', pnl: rt.pnl, closedAt: rt.closed_at,
              })}
              disabled={savingKey === rtKey(sessionId, rt.round_trip_index, rt.right)}
              style={{
                background: '#161b22', border: '1px solid #30363d',
                borderRadius: 4, padding: '6px 10px', cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 11, color: '#e6edf3', textAlign: 'left',
              }}
              data-testid="pendingexit-btn"
            >
              <span>{rt.right || 'EQ'} <span style={{ color: '#484f58' }}>{ageMin}m ago</span></span>
              <span style={{ color: rt.pnl >= 0 ? '#26a641' : '#f85149' }}>
                {rt.pnl >= 0 ? '+' : ''}{rt.pnl.toFixed(2)}
              </span>
            </button>
          )
        })}

        {hasOpenEntries && (
          <div style={{ fontSize: 10, color: '#8b949e', fontWeight: 600, marginTop: hasPendingExits ? 4 : 0, marginBottom: 2 }}>
            🏷 Label open trade
          </div>
        )}
        {openLegsNeedingLabel.map(o => (
          <button
            key={rtKey(sessionId, o.rtIndex, o.right)}
            onClick={() => setOpenPopup({
              mode: 'entry', rtIndex: o.rtIndex, right: o.right,
              label: o.label,
            })}
            disabled={savingKey === rtKey(sessionId, o.rtIndex, o.right)}
            style={{
              background: '#161b22', border: '1px solid #30363d',
              borderRadius: 4, padding: '6px 10px', cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 11, color: '#e6edf3', textAlign: 'left',
            }}
            data-testid="entry-btn"
          >
            <span>{o.label}</span>
            <span style={{ color: '#58a6ff' }}>🏷</span>
          </button>
        ))}

        {error && (
          <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>
        )}
      </div>

      {openPopup && (
        <LabelPopup
          mode={openPopup.mode}
          rtIndex={openPopup.rtIndex}
          right={openPopup.right}
          label={openPopup.label}
          pnl={openPopup.pnl}
          closedAt={openPopup.closedAt}
          categories={categories}
          strategies={strategies}
          entryTags={entryTags}
          exitTags={exitTags}
          saving={savingKey === rtKey(sessionId, openPopup.rtIndex, openPopup.right)}
          onClose={() => setOpenPopup(null)}
          onSaveEntry={handleSaveEntry}
          onSaveExit={handleSaveExit}
        />
      )}
    </>
  )
}

function LabelPopup({
  mode,
  rtIndex,
  right,
  label,
  pnl,
  closedAt,
  categories,
  strategies,
  entryTags,
  exitTags,
  saving,
  onClose,
  onSaveEntry,
  onSaveExit,
}: {
  mode: 'entry' | 'exit'
  rtIndex: number
  right: string | null
  label: string
  pnl?: number
  closedAt?: number
  categories: string[]
  strategies: string[]
  entryTags: string[]
  exitTags: string[]
  saving: boolean
  onClose: () => void
  onSaveEntry: (rtIndex: number, right: string | null, expCat: string, expStrat: string, entryTag: string) => void
  onSaveExit: (rtIndex: number, right: string | null, actCat: string, actStrat: string, exitTag: string) => void
}) {
  const [cat, setCat] = useState('')
  const [strat, setStrat] = useState('')
  const [tag, setTag] = useState('AS_PER_PATTERN')

  const isEntry = mode === 'entry'
  const ageMin = closedAt ? Math.max(1, Math.round((Date.now() - closedAt) / 60000)) : null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 440, maxHeight: '80vh', overflow: 'auto',
        padding: 20, background: '#161b22',
        border: '1px solid #30363d', borderRadius: 10,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: isEntry ? '#58a6ff' : '#f0883e', marginBottom: 4 }}>
          {isEntry ? '🏷 Label Entry' : '📝 Label Exit'}
        </div>
        <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 16 }}>
          {label}
          {pnl !== undefined && (
            <span style={{ marginLeft: 8, color: pnl >= 0 ? '#26a641' : '#f85149' }}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
            </span>
          )}
          {ageMin !== null && (
            <span style={{ marginLeft: 8, color: '#484f58' }}>closed {ageMin}m ago</span>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: '#484f58', marginBottom: 4 }}>
            {isEntry ? 'Expected' : 'Actual'} Pattern
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={cat} onChange={e => setCat(e.target.value)} style={selectStyle}>
              <option value="">— Category —</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={strat} onChange={e => setStrat(e.target.value)} style={selectStyle}>
              <option value="">— Strategy —</option>
              {strategies.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: '#484f58', marginBottom: 4 }}>
            {isEntry ? 'Entry' : 'Exit'} Tag
          </div>
          <input
            list={`tag-${rtIndex}-${right ?? 'EQ'}-${mode}`}
            value={tag}
            onChange={e => setTag(e.target.value)}
            placeholder={isEntry ? 'Entry tag' : 'Exit tag'}
            style={inputStyle}
          />
          <datalist id={`tag-${rtIndex}-${right ?? 'EQ'}-${mode}`}>
            {(isEntry ? entryTags : exitTags).map(t => <option key={t} value={t} />)}
          </datalist>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              background: '#21262d', border: '1px solid #30363d',
              color: '#8b949e', borderRadius: 6, padding: '7px 14px',
              fontSize: 12, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (isEntry) onSaveEntry(rtIndex, right, cat, strat, tag)
              else onSaveExit(rtIndex, right, cat, strat, tag)
            }}
            disabled={saving}
            style={{
              background: '#1f6feb', border: 'none',
              color: '#fff', borderRadius: 6, padding: '7px 14px',
              fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}