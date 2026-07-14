import { useCallback, useEffect, useState } from 'react'
import { AnalysisChart } from './TradeAnalysis'
import api, { AnalysisTrade, RoundTrip, TradeLabel } from '../services/api'

interface TradeLabelingProps {
  symbol: string
  date: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
}

const RT_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787']

export default function TradeLabeling({ symbol, date, sessionIds, allTrades, historicalDays }: TradeLabelingProps) {
  const [roundTrips, setRoundTrips] = useState<(RoundTrip & { session_id: string })[]>([])
  const [labels, setLabels] = useState<Map<string, TradeLabel>>(new Map())
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [exitTags, setExitTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const allRTs: (RoundTrip & { session_id: string })[] = []
      const allLabels: Map<string, TradeLabel> = new Map()

      for (const sid of sessionIds) {
        try {
          const rts = await api.getRoundTrips(sid)
          rts.forEach(rt => allRTs.push({ ...rt, session_id: sid }))
        } catch { /* ignore */ }
        try {
          const lbls = await api.getLabels(sid)
          lbls.forEach(l => allLabels.set(`${l.session_id}#${l.round_trip_index}`, l))
        } catch { /* ignore */ }
      }

      setRoundTrips(allRTs)
      setLabels(allLabels)

      try {
        const [strats, cats, etags, xtags] = await Promise.all([
          api.patternListStrategies().then(r => r.strategies),
          api.patternListCategories().then(r => r.categories),
          api.getEntryTags(),
          api.getExitTags(),
        ])
        setStrategies(strats)
        setCategories(cats)
        setEntryTags(etags)
        setExitTags(xtags)
      } catch { /* ignore */ }
    }
    load()
  }, [sessionIds])

  const updateLabel = useCallback((key: string, patch: Partial<TradeLabel>) => {
    setLabels(prev => {
      const next = new Map(prev)
      const existing = next.get(key) || { session_id: key.split('#')[0], round_trip_index: parseInt(key.split('#')[1]), expected_category: '', expected_strategy: '', actual_category: '', actual_strategy: '', entry_tag: '', exit_tag: '' }
      next.set(key, { ...existing, ...patch })
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      const labelData: TradeLabel[] = []
      for (const rt of roundTrips) {
        const key = `${rt.session_id}#${rt.index}`
        const l = labels.get(key)
        if (l) {
          labelData.push({
            ...l,
            actual_category: l.actual_category || l.expected_category,
            actual_strategy: l.actual_strategy || l.expected_strategy,
            entry_tag: l.entry_tag || 'AS_PER_PATTERN',
            exit_tag: l.exit_tag || 'AS_PER_PATTERN',
          })
        }
      }
      await api.saveLabels(labelData)
      setSaveMsg('Saved!')
      const [et, xt] = await Promise.all([api.getEntryTags(), api.getExitTags()])
      setEntryTags(et)
      setExitTags(xt)
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 2000)
    }
  }, [roundTrips, labels])

  // Group round-trips by session for header display
  const sessionGroups = new Map<string, (RoundTrip & { session_id: string })[]>()
  for (const rt of roundTrips) {
    const existing = sessionGroups.get(rt.session_id) || []
    existing.push(rt)
    sessionGroups.set(rt.session_id, existing)
  }

  const selectStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 4, padding: '3px 6px', fontSize: 11, maxWidth: 140,
  }

  const inputStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 4, padding: '3px 6px', fontSize: 11, maxWidth: 140,
  }

  return (
    <div style={{ display: 'flex', gap: 12, minHeight: 400 }}>
      {/* Chart */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <AnalysisChart
          symbol={symbol}
          date={date}
          trades={allTrades}
          historicalDays={historicalDays}
          title={symbol}
        />
      </div>

      {/* Round-trip forms */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', maxHeight: 500, overflowY: 'auto', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#8b949e' }}>
            {roundTrips.length} round trip{roundTrips.length !== 1 ? 's' : ''}
          </span>
          <div style={{ flex: 1 }} />
          {saveMsg && (
            <span style={{ fontSize: 12, color: saveMsg.startsWith('Saved') ? '#3fb950' : '#f85149' }}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || roundTrips.length === 0}
            style={{
              background: '#238636', border: 'none', color: '#fff',
              borderRadius: 4, padding: '5px 14px', fontSize: 12,
              cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save Labels'}
          </button>
        </div>

        {Array.from(sessionGroups.entries()).map(([sid, rts], gi) => (
          <div key={sid}>
            {sessionGroups.size > 1 && (
              <div style={{
                fontSize: 11, color: '#484f58', fontWeight: 700,
                padding: '4px 0', borderTop: gi > 0 ? '1px dashed #21262d' : undefined,
                marginTop: gi > 0 ? 4 : 0,
              }}>
                Session {gi + 1}
              </div>
            )}
            {rts.map(rt => {
              const key = `${sid}#${rt.index}`
              const l = labels.get(key) || { session_id: sid, round_trip_index: rt.index, expected_category: '', expected_strategy: '', actual_category: '', actual_strategy: '', entry_tag: '', exit_tag: '' }
              const pnlColor = rt.pnl > 0 ? '#26a641' : rt.pnl < 0 ? '#f85149' : '#8b949e'
              const pnlSign = rt.pnl >= 0 ? '+' : ''

              return (
                <div key={key} style={{
                  background: '#0d1117', border: '1px solid #21262d',
                  borderRadius: 6, padding: 10, marginBottom: 8,
                }}>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                      background: RT_COLORS[rt.index % RT_COLORS.length], flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3' }}>
                      RT#{rt.index} — {rt.right || 'EQ'}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor }}>
                      {pnlSign}₹{Math.abs(rt.pnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>

                  {/* Entry/Exit summary */}
                  <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8, lineHeight: 1.5 }}>
                    <span style={{ color: '#e6edf3' }}>
                      {rt.entry_trades.map(t => `B ${t.quantity}@${t.price.toFixed(2)}`).join(', ')}
                    </span>
                    {' → '}
                    <span style={{ color: '#e6edf3' }}>
                      {rt.exit_trades.map(t => `S ${t.quantity}@${t.price.toFixed(2)}`).join(', ')}
                    </span>
                  </div>

                  {/* Label fields */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Expected Pattern</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <select
                          value={l.expected_category}
                          onChange={e => updateLabel(key, { expected_category: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Category —</option>
                          {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select
                          value={l.expected_strategy}
                          onChange={e => updateLabel(key, { expected_strategy: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Strategy —</option>
                          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Actual Pattern</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <select
                          value={l.actual_category}
                          onChange={e => updateLabel(key, { actual_category: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Category —</option>
                          {categories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select
                          value={l.actual_strategy}
                          onChange={e => updateLabel(key, { actual_strategy: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Strategy —</option>
                          {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Entry Tag</div>
                      <input
                        list={`et-${key}`}
                        value={l.entry_tag}
                        onChange={e => updateLabel(key, { entry_tag: e.target.value })}
                        placeholder="AS_PER_PATTERN"
                        style={inputStyle}
                      />
                      <datalist id={`et-${key}`}>
                        {entryTags.map(t => <option key={t} value={t} />)}
                      </datalist>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Exit Tag</div>
                      <input
                        list={`xt-${key}`}
                        value={l.exit_tag}
                        onChange={e => updateLabel(key, { exit_tag: e.target.value })}
                        placeholder="AS_PER_PATTERN"
                        style={inputStyle}
                      />
                      <datalist id={`xt-${key}`}>
                        {exitTags.map(t => <option key={t} value={t} />)}
                      </datalist>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
