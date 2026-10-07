import { useAnalysisApi, useAnalysisEnvironment } from './environment'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisChart, OptionsChart } from './TradeAnalysis'
import { AnalysisTrade, RoundTrip, TradeLabel } from './api'

interface TradeLabelingProps {
  readOnly?: boolean
  symbol: string
  date: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
}

const RT_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787']

function fmtHHMM(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('en-IN', {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
  })
}

interface OptionTab {
  key: string
  label: string
  right: string
  strike: number
  expiry: string
  trades: AnalysisTrade[]
}

export default function TradeLabeling({ readOnly=false, symbol, date, sessionIds, allTrades, historicalDays }: TradeLabelingProps) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [dirty, setDirty] = useState(false)
  const edits = useRef(0)
  const sessionKey = sessionIds.join('|')
  const notifyDirty = environment.onDirtyChange
  const notifySaving = environment.onLabelSavingChange

  const [roundTrips, setRoundTrips] = useState<(RoundTrip & { session_id: string })[]>([])
  const [labels, setLabels] = useState<Map<string, TradeLabel>>(new Map())
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [exitTags, setExitTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setLoadError('')
    const load = async () => {
      const [tripPages, labelPages, strats, cats, etags, xtags] = await Promise.all([
        Promise.all(sessionIds.map(id => api.getRoundTrips(id))),
        Promise.all(sessionIds.map(id => api.getLabels(id))),
        api.patternListStrategies(), api.patternListCategories(), api.getEntryTags(), api.getExitTags(),
      ])
      if (cancelled) return
      setRoundTrips(tripPages.flatMap((rows,i) => rows.map(rt => ({...rt,session_id:sessionIds[i]}))))
      setLabels(new Map(labelPages.flat().map(label => [`${label.session_id}#${label.round_trip_index}`,label])))
      setStrategies(strats.strategies); setCategories(cats.categories); setEntryTags(etags); setExitTags(xtags)
      setDirty(false)
    }
    void load().catch(error => { if (!cancelled) setLoadError(String(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, sessionKey, retry])
  useEffect(() => { notifySaving?.(saving); return () => notifySaving?.(false) }, [saving, notifySaving])
  useEffect(() => { notifyDirty?.(dirty); return () => notifyDirty?.(false) }, [dirty, notifyDirty])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload',beforeUnload)
    return () => window.removeEventListener('beforeunload',beforeUnload)
  }, [dirty])

  const updateLabel = useCallback((key: string, patch: Partial<TradeLabel>) => {
    if (readOnly || loading || saving || loadError) return
    edits.current++; setDirty(true); setSaveMsg(null)
    setLabels(prev => {
      const next = new Map(prev)
      const existing = next.get(key) || { session_id: key.split('#')[0], round_trip_index: parseInt(key.split('#')[1]), expected_category: '', expected_strategy: '', actual_category: '', actual_strategy: '', entry_tag: '', exit_tag: '' }
      next.set(key, { ...existing, ...patch })
      return next
    })
  }, [readOnly, loading, saving, loadError])

  const handleSave = useCallback(async () => {
    const revision = edits.current
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
      if (revision === edits.current) setDirty(false)
      setSaveMsg('Saved!')
      environment.onDataChanged?.()
      const [et, xt] = await Promise.all([api.getEntryTags(), api.getExitTags()])
      setEntryTags(et)
      setExitTags(xt)
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)

    }
  }, [roundTrips, labels, environment.onDataChanged])

  // Group round-trips by session for header display
  const sessionGroups = new Map<string, (RoundTrip & { session_id: string })[]>()
  for (const rt of roundTrips) {
    const existing = sessionGroups.get(rt.session_id) || []
    existing.push(rt)
    sessionGroups.set(rt.session_id, existing)
  }

  const displayedCategories = [...new Set([...categories,...[...labels.values()].flatMap(label=>[label.expected_category,label.actual_category]).filter(Boolean)])].sort()
  const displayedStrategies = [...new Set([...strategies,...[...labels.values()].flatMap(label=>[label.expected_strategy,label.actual_strategy]).filter(Boolean)])].sort()
  const selectStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 4, padding: '3px 6px', fontSize: 11, maxWidth: 140,
  }

  const inputStyle: React.CSSProperties = {
    background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
    borderRadius: 4, padding: '3px 6px', fontSize: 11, maxWidth: 140,
  }

  // Option tabs: derived from allTrades, same as AnalysisChartPanel
  const optionTabs = useMemo<OptionTab[]>(() => {
    const tabMap = new Map<string, OptionTab>()
    for (const t of allTrades) {
      if (!t.right || t.strike == null || !t.expiry) continue
      const key = `${t.right}-${t.strike}-${t.expiry}`
      if (!tabMap.has(key)) {
        tabMap.set(key, { key, label: `${t.right} ${t.strike}`, right: t.right, strike: t.strike, expiry: t.expiry, trades: [] })
      }
      tabMap.get(key)!.trades.push(t)
    }
    return Array.from(tabMap.values()).sort((a, b) => {
      if (a.right !== b.right) return a.right === 'CE' ? -1 : 1
      return a.strike - b.strike
    })
  }, [allTrades])

  const [chartView, setChartView] = useState<'underlying' | string>('underlying')
  const [maximized, setMaximized] = useState(false)
  const activeOptionTab = optionTabs.find(t => t.key === chartView) ?? null

  useEffect(() => {
    if (!maximized) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximized])

  const LabelCharts = environment.charts?.LabelCharts
  const content = (
    <div style={{ display: 'flex', gap: 12, minHeight: maximized ? 0 : 400, flex: maximized ? 1 : undefined, overflow: maximized ? 'hidden' : undefined }}>
      {/* Chart */}
      <div className="label-chart-container" style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {LabelCharts ? <LabelCharts symbol={symbol} date={date} allTrades={allTrades} historicalDays={historicalDays} getMarkerText={(trade: AnalysisTrade) => { const trips = roundTrips.filter(row => [...row.entry_trades,...row.exit_trades].some(t => [trade.trade_id,trade.execution_id,trade.stored_trade_id].some(identity => Boolean(identity) && (identity === t.trade_id || identity === t.execution_id))) && row.session_id === trade.session_id); return trips.length ? `${trips.map(rt=>`#${rt.index}`).join('/')} ${trade.side}` : trade.side }} /> : chartView === 'underlying' ? (
          <AnalysisChart
            symbol={symbol}
            date={date}
            trades={allTrades}
            historicalDays={historicalDays}
            title={symbol}
          />
        ) : activeOptionTab ? (
          <OptionsChart
            symbol={symbol}
            date={date}
            strike={activeOptionTab.strike}
            expiry={activeOptionTab.expiry}
            right={activeOptionTab.right}
            trades={activeOptionTab.trades}
            historicalDays={historicalDays}
          />
        ) : null}
        {!LabelCharts && optionTabs.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              onClick={() => setChartView('underlying')}
              style={{
                padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                cursor: 'pointer', border: 'none',
                background: chartView === 'underlying' ? '#58a6ff' : '#21262d',
                color: chartView === 'underlying' ? '#0d1117' : '#8b949e',
              }}
            >
              Underlying
            </button>
            {optionTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setChartView(tab.key)}
                style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', border: 'none',
                  background: tab.key === chartView ? '#58a6ff' : '#21262d',
                  color: tab.key === chartView ? '#0d1117' : '#8b949e',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Round-trip forms */}
      <div style={{ flex: 2, minWidth: 0, display: 'flex', flexDirection: 'column', maxHeight: maximized ? undefined : 500, overflowY: 'auto', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#8b949e' }}>
            {roundTrips.length} round trip{roundTrips.length !== 1 ? 's' : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setMaximized(!maximized)}
            title={maximized ? 'Restore' : 'Maximize'}
            style={{
              background: '#21262d', border: 'none', color: '#8b949e',
              borderRadius: 4, padding: '4px 8px', fontSize: 13,
              cursor: 'pointer', fontWeight: 600,
            }}
          >
            {maximized ? '⤡' : '⤢'}
          </button>
          {readOnly && <span>Shared history · read only</span>}
          {dirty && <span>Unsaved labels</span>}
          {saveMsg && (
            <span role={saveMsg.startsWith('Saved')?'status':'alert'} style={{ fontSize: 12, color: saveMsg.startsWith('Saved') ? '#3fb950' : '#f85149' }}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={readOnly || saving || loading || Boolean(loadError) || roundTrips.length === 0}
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
                      {rt.entry_trades.map(t => `B ${t.quantity}@${t.price.toFixed(2)} ${fmtHHMM(t.timestamp)}`).join(', ')}
                    </span>
                    {' → '}
                    <span style={{ color: '#e6edf3' }}>
                      {rt.exit_trades.map(t => `S ${t.quantity}@${t.price.toFixed(2)} ${fmtHHMM(t.timestamp)}`).join(', ')}
                    </span>
                  </div>

                  {/* Label fields */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Expected Pattern</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <select disabled={readOnly || saving}
                          value={l.expected_category}
                          onChange={e => updateLabel(key, { expected_category: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Category —</option>
                          {displayedCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select disabled={readOnly || saving}
                          value={l.expected_strategy}
                          onChange={e => updateLabel(key, { expected_strategy: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Strategy —</option>
                          {displayedStrategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Actual Pattern</div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <select disabled={readOnly || saving}
                          value={l.actual_category}
                          onChange={e => updateLabel(key, { actual_category: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Category —</option>
                          {displayedCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select disabled={readOnly || saving}
                          value={l.actual_strategy}
                          onChange={e => updateLabel(key, { actual_strategy: e.target.value })}
                          style={selectStyle}
                        >
                          <option value="">— Strategy —</option>
                          {displayedStrategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#484f58', marginBottom: 2 }}>Entry Tag</div>
                      <input disabled={readOnly || saving}
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
                      <input disabled={readOnly || saving}
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

  if (loading) return <p role="status">Loading round trips and saved labels…</p>
  if (loadError) return <p role="alert">{loadError}<button onClick={() => setRetry(n => n + 1)}>Retry labels</button></p>
  if (environment.desktop) return <div className={`desktop-label-workflow ${maximized ? 'labels-maximized' : ''}`}>{content}</div>
  if (maximized) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0d1117', display: 'flex', flexDirection: 'column', padding: 12 }}>
        {content}
      </div>
    )
  }

  return content
}
