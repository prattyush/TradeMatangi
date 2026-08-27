import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import api, { FineDefinition, FlowStep, FineSearchResult, OHLCCandle } from '../services/api'

const STEP_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff',
  '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787',
]

const btnStyle = (active = false): React.CSSProperties => ({
  padding: '4px 12px', fontSize: 12, borderRadius: 4,
  border: `1px solid ${active ? '#f0883e' : '#30363d'}`,
  background: active ? '#2a1a0a' : '#161b22',
  color: active ? '#f0883e' : '#8b949e', cursor: 'pointer',
})

const inputStyle: React.CSSProperties = {
  background: '#0d1117', border: '1px solid #30363d', color: '#e6edf3',
  borderRadius: 4, padding: '4px 8px', fontSize: 12,
}

const selectStyle: React.CSSProperties = {
  ...inputStyle, maxWidth: 180,
}

// ── Definitions Sub-tab ──────────────────────────────────────────────────────

function DefinitionsView({ definitions, onRefresh }: {
  definitions: FineDefinition[]
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState<FineDefinition | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [subTypes, setSubTypes] = useState('')

  const startCreate = () => {
    setName('')
    setSubTypes('')
    setEditing(null)
    setCreating(true)
  }

  const startEdit = (d: FineDefinition) => {
    setName(d.name)
    setSubTypes(d.sub_types.join(', '))
    setCreating(false)
    setEditing(d)
  }

  const handleSave = async () => {
    const types = subTypes.split(',').map(s => s.trim()).filter(Boolean)
    if (!name.trim()) return
    try {
      if (editing) {
        await api.fineStructureUpdateDefinition(editing.definition_id, { name: name.trim(), sub_types: types })
      } else {
        await api.fineStructureCreateDefinition({ name: name.trim(), sub_types: types })
      }
      setCreating(false)
      setEditing(null)
      onRefresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const handleDelete = async (d: FineDefinition) => {
    if (!confirm(`Delete "${d.name}"?`)) return
    try {
      await api.fineStructureDeleteDefinition(d.definition_id)
      onRefresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, flex: 1, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>Structure Definitions</span>
        <button onClick={startCreate} style={btnStyle()}>+ Add Definition</button>
      </div>

      {(creating || editing) && (
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Structure name"
              style={{ ...inputStyle, flex: 1 }}
            />
            <input
              value={subTypes}
              onChange={e => setSubTypes(e.target.value)}
              placeholder="Sub-types (comma separated)"
              style={{ ...inputStyle, flex: 2 }}
            />
            <button onClick={handleSave} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>Save</button>
            <button onClick={() => { setCreating(false); setEditing(null) }} style={btnStyle()}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {definitions.map(d => (
          <div key={d.definition_id} style={{
            background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
            padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
            opacity: d.is_predefined ? 0.8 : 1,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', minWidth: 140 }}>
              {d.name}
            </span>
            <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap' }}>
              {d.sub_types.map(st => (
                <span key={st} style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 10,
                  background: '#21262d', color: '#8b949e',
                }}>{st}</span>
              ))}
              {d.sub_types.length === 0 && (
                <span style={{ fontSize: 10, color: '#484f58' }}>no sub-types</span>
              )}
            </div>
            {d.is_predefined && (
              <span style={{ fontSize: 10, color: '#484f58' }}>system</span>
            )}
            {d.can_delete && (
              <>
                <button onClick={() => startEdit(d)} style={{ ...btnStyle(), padding: '2px 8px', fontSize: 11 }}>Edit</button>
                <button onClick={() => handleDelete(d)} style={{ ...btnStyle(), padding: '2px 8px', fontSize: 11, color: '#f85149', borderColor: '#f85149' }}>Delete</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Builder Sub-tab ──────────────────────────────────────────────────────────

function BuilderView({ definitions }: { definitions: FineDefinition[] }) {
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState('')
  const [candles, setCandles] = useState<OHLCCandle[]>([])
  const [steps, setSteps] = useState<(FlowStep & { color: string })[]>([])
  const [flowId, setFlowId] = useState<string | null>(null)
  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // Add step form
  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')

  const addDef = definitions.find(d => d.definition_id === addDefId)

  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerSeriesRefs = useRef<ISeriesApi<'Line'>[]>([])

  const loadChart = useCallback(async () => {
    if (!symbol || !date) return
    setLoading(true)
    try {
      const res = await api.fineStructureGetOHLC(symbol, date)
      setCandles(res.candles)
      if (res.flow) {
        setFlowId(res.flow.flow_id)
        setSteps(res.flow.steps.map((s, i) => ({ ...s, color: STEP_COLORS[i % STEP_COLORS.length] })))
      } else {
        setFlowId(null)
        setSteps([])
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load OHLC')
    } finally {
      setLoading(false)
    }
  }, [symbol, date])

  useEffect(() => {
    if (!chartContainerRef.current || candles.length === 0) return

    // Clean up old chart
    if (chartRef.current) {
      markerSeriesRefs.current = []
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 400,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    })

    const series = chart.addCandlestickSeries({
      upColor: '#26a641', downColor: '#f85149',
      borderUpColor: '#26a641', borderDownColor: '#f85149',
      wickUpColor: '#26a641', wickDownColor: '#f85149',
    })
    series.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))

    chartRef.current = chart
    seriesRef.current = series

    // Click handler for setting transition bars
    chart.subscribeClick(param => {
      if (!param.time || activeStepIdx === null) return
      setSteps(prev => {
        const next = [...prev]
        next[activeStepIdx] = { ...next[activeStepIdx], transition_bar_time: param.time as number }
        return next
      })
    })

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) chart.applyOptions({ width, height })
    })
    ro.observe(chartContainerRef.current)

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [candles]) // eslint-disable-line react-hooks/exhaustive-deps

  // Update markers when steps change
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return
    // Remove old marker series
    for (const s of markerSeriesRefs.current) {
      try { chartRef.current.removeSeries(s) } catch { /* disposed */ }
    }
    markerSeriesRefs.current = []

    const markers: { time: Time; position: 'belowBar' | 'aboveBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string; size: number }[] = []
    for (const step of steps) {
      if (!step.transition_bar_time) continue
      markers.push({
        time: step.transition_bar_time as Time,
        position: 'belowBar',
        color: step.color,
        shape: 'arrowUp',
        text: step.name + (step.type ? `(${step.type})` : ''),
        size: 1,
      })
    }
    if (markers.length > 0) {
      markers.sort((a, b) => (a.time as number) - (b.time as number))
      seriesRef.current.setMarkers(markers)
    } else {
      seriesRef.current.setMarkers([])
    }
  }, [steps])

  const addStep = () => {
    if (!addDefId || !addDef) return
    const step: FlowStep & { color: string } = {
      definition_id: addDefId,
      name: addDef.name,
      type: addType || undefined,
      direction: addDirection || undefined,
      color: STEP_COLORS[steps.length % STEP_COLORS.length],
    }
    setSteps(prev => [...prev, step])
    setAddDefId('')
    setAddType('')
    setAddDirection('')
  }

  const removeStep = (idx: number) => {
    setSteps(prev => prev.filter((_, i) => i !== idx))
    if (activeStepIdx === idx) setActiveStepIdx(null)
    else if (activeStepIdx !== null && activeStepIdx > idx) setActiveStepIdx(activeStepIdx - 1)
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= steps.length) return
    setSteps(prev => {
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
    if (activeStepIdx === idx) setActiveStepIdx(target)
    else if (activeStepIdx === target) setActiveStepIdx(idx)
  }

  const handleSave = async () => {
    if (!symbol || !date || steps.length === 0) return
    const flowSteps: FlowStep[] = steps.map(({ color, ...s }) => s)
    try {
      if (flowId) {
        await api.fineStructureUpdateFlow(flowId, flowSteps)
      } else {
        const f = await api.fineStructureCreateFlow({ symbol, date, steps: flowSteps })
        setFlowId(f.flow_id)
      }
      setSaveMsg('Saved!')
      setTimeout(() => setSaveMsg(null), 2000)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center', flexShrink: 0, borderBottom: '1px solid #21262d' }}>
        <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" style={{ ...inputStyle, width: 100 }} />
        <input value={date} onChange={e => setDate(e.target.value)} type="date" style={{ ...inputStyle, width: 140 }} />
        <button onClick={loadChart} disabled={loading} style={btnStyle()}>{loading ? 'Loading...' : 'Load'}</button>
        <div style={{ flex: 1 }} />
        {saveMsg && <span style={{ fontSize: 12, color: '#3fb950' }}>{saveMsg}</span>}
        <button onClick={handleSave} disabled={steps.length === 0} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>
          {flowId ? 'Update Flow' : 'Save Flow'}
        </button>
      </div>

      {/* Main area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chart - left 60% */}
        <div style={{ flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={chartContainerRef} style={{ flex: 1, minHeight: 0 }} />
          {activeStepIdx !== null && (
            <div style={{ padding: '4px 8px', fontSize: 11, color: '#f0883e', flexShrink: 0 }}>
              Click chart to set transition bar for: {steps[activeStepIdx]?.name}
            </div>
          )}
        </div>

        {/* Steps panel - right 40% */}
        <div style={{ flex: 2, minWidth: 0, borderLeft: '1px solid #21262d', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>Flow Steps</span>
          </div>

          {/* Steps list */}
          <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
            {steps.map((step, idx) => (
              <div
                key={idx}
                onClick={() => setActiveStepIdx(activeStepIdx === idx ? null : idx)}
                style={{
                  background: activeStepIdx === idx ? '#2a1a0a' : '#0d1117',
                  border: `1px solid ${activeStepIdx === idx ? '#f0883e' : '#21262d'}`,
                  borderRadius: 6, padding: '6px 10px', marginBottom: 6,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span style={{ fontSize: 10, color: '#484f58', width: 16 }}>{idx + 1}</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: step.color,
                  padding: '1px 6px', borderRadius: 8, background: step.color + '20',
                }}>{step.name}</span>
                {step.type && (
                  <span style={{ fontSize: 10, color: '#8b949e', padding: '1px 5px', borderRadius: 8, background: '#21262d' }}>{step.type}</span>
                )}
                {step.direction && (
                  <span style={{ fontSize: 10, color: step.direction === 'Bull' ? '#3fb950' : '#f85149' }}>{step.direction}</span>
                )}
                {step.transition_bar_time && (
                  <span style={{ fontSize: 10, color: '#58a6ff' }}>
                    {new Date(step.transition_bar_time * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={e => { e.stopPropagation(); moveStep(idx, -1) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10 }}>↑</button>
                <button onClick={e => { e.stopPropagation(); moveStep(idx, 1) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10 }}>↓</button>
                <button onClick={e => { e.stopPropagation(); removeStep(idx) }} style={{ ...btnStyle(), padding: '1px 5px', fontSize: 10, color: '#f85149' }}>✕</button>
              </div>
            ))}
            {steps.length === 0 && (
              <div style={{ fontSize: 12, color: '#484f58', padding: 16, textAlign: 'center' }}>
                Add structures below to build the flow
              </div>
            )}
          </div>

          {/* Add step form */}
          <div style={{ padding: 8, borderTop: '1px solid #21262d', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} style={{ ...selectStyle, flex: 1 }}>
                <option value="">— Structure —</option>
                {definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}
              </select>
              {addDef && addDef.sub_types.length > 0 && (
                <select value={addType} onChange={e => setAddType(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">— Type (optional) —</option>
                  {addDef.sub_types.map(st => <option key={st} value={st}>{st}</option>)}
                </select>
              )}
              <select value={addDirection} onChange={e => setAddDirection(e.target.value)} style={{ ...selectStyle, width: 80 }}>
                <option value="">Dir</option>
                <option value="Bull">Bull</option>
                <option value="Bear">Bear</option>
              </select>
            </div>
            <button onClick={addStep} disabled={!addDefId} style={btnStyle()}>+ Add Step</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Search Sub-tab ───────────────────────────────────────────────────────────

function SearchView({ definitions, onLoadInBuilder }: {
  definitions: FineDefinition[]
  onLoadInBuilder: (symbol: string, date: string) => void
}) {
  const [querySteps, setQuerySteps] = useState<{ name: string; type?: string; direction?: string }[]>([])
  const [results, setResults] = useState<FineSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Add query step form
  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')

  const addDef = definitions.find(d => d.definition_id === addDefId)

  const addQueryStep = () => {
    if (!addDefId || !addDef) return
    setQuerySteps(prev => [...prev, {
      name: addDef.name,
      type: addType || undefined,
      direction: addDirection || undefined,
    }])
    setAddDefId('')
    setAddType('')
    setAddDirection('')
  }

  const removeQueryStep = (idx: number) => {
    setQuerySteps(prev => prev.filter((_, i) => i !== idx))
  }

  const handleSearch = async () => {
    if (querySteps.length === 0) return
    setSearching(true)
    try {
      const res = await api.fineStructureSearch({ query_steps: querySteps })
      setResults(res)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Query builder */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3', marginBottom: 8 }}>Search by Sequence</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {querySteps.map((qs, idx) => (
            <span key={idx} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, padding: '3px 8px', borderRadius: 12,
              background: '#21262d', color: '#e6edf3',
            }}>
              {idx > 0 && <span style={{ color: '#484f58', marginRight: 2 }}>→</span>}
              {qs.name}
              {qs.type && <span style={{ color: '#8b949e' }}>({qs.type})</span>}
              {qs.direction && <span style={{ color: qs.direction === 'Bull' ? '#3fb950' : '#f85149' }}>{qs.direction}</span>}
              <button onClick={() => removeQueryStep(idx)} style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 11, padding: 0 }}>✕</button>
            </span>
          ))}
          {querySteps.length === 0 && <span style={{ fontSize: 11, color: '#484f58' }}>Add structures to search for</span>}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} style={selectStyle}>
            <option value="">— Structure —</option>
            {definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}
          </select>
          {addDef && addDef.sub_types.length > 0 && (
            <select value={addType} onChange={e => setAddType(e.target.value)} style={selectStyle}>
              <option value="">— Type (optional) —</option>
              {addDef.sub_types.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
          )}
          <select value={addDirection} onChange={e => setAddDirection(e.target.value)} style={{ ...selectStyle, width: 80 }}>
            <option value="">Dir</option>
            <option value="Bull">Bull</option>
            <option value="Bear">Bear</option>
          </select>
          <button onClick={addQueryStep} disabled={!addDefId} style={btnStyle()}>Add</button>
          <button onClick={handleSearch} disabled={querySteps.length === 0 || searching} style={{ ...btnStyle(), background: '#238636', color: '#fff', border: 'none' }}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {results.length === 0 && !searching && (
          <div style={{ fontSize: 12, color: '#484f58', textAlign: 'center', padding: 32 }}>
            {querySteps.length === 0 ? 'Build a query above to search' : 'No results found'}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {results.map((r, idx) => (
            <div
              key={idx}
              onClick={() => onLoadInBuilder(r.flow.symbol, r.flow.date)}
              style={{
                background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
                padding: 12, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>{r.flow.symbol}</span>
                <span style={{ fontSize: 12, color: '#8b949e' }}>{r.flow.date}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {r.flow.steps.map((s, si) => (
                  <span key={si} style={{
                    fontSize: 10, padding: '1px 5px', borderRadius: 8,
                    background: si >= r.match_start_index && si < r.match_start_index + querySteps.length
                      ? '#2a1a0a' : '#21262d',
                    color: si >= r.match_start_index && si < r.match_start_index + querySteps.length
                      ? '#f0883e' : '#8b949e',
                    fontWeight: si >= r.match_start_index && si < r.match_start_index + querySteps.length ? 600 : 400,
                  }}>
                    {si > 0 && '→ '}{s.name}{s.type ? `(${s.type})` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main FineStructures Component ────────────────────────────────────────────

export default function FineStructures() {
  const [activeSubTab, setActiveSubTab] = useState<'definitions' | 'builder' | 'search'>('builder')
  const [definitions, setDefinitions] = useState<FineDefinition[]>([])

  const loadDefinitions = useCallback(async () => {
    try {
      const defs = await api.fineStructureListDefinitions()
      setDefinitions(defs)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadDefinitions() }, [loadDefinitions])

  // For search → builder navigation
  const [builderNav, setBuilderNav] = useState<{ symbol: string; date: string } | null>(null)

  const handleLoadInBuilder = (symbol: string, date: string) => {
    setBuilderNav({ symbol, date })
    setActiveSubTab('builder')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 0, padding: '0 16px', borderBottom: '1px solid #21262d', flexShrink: 0 }}>
        {(['definitions', 'builder', 'search'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveSubTab(tab)}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 600,
              background: 'transparent', border: 'none',
              borderBottom: activeSubTab === tab ? '2px solid #f0883e' : '2px solid transparent',
              color: activeSubTab === tab ? '#f0883e' : '#8b949e',
              cursor: 'pointer',
            }}
          >
            {tab === 'definitions' ? 'Definitions' : tab === 'builder' ? 'Builder' : 'Search'}
          </button>
        ))}
      </div>

      {activeSubTab === 'definitions' && <DefinitionsView definitions={definitions} onRefresh={loadDefinitions} />}
      {activeSubTab === 'builder' && <BuilderView key={builderNav ? `${builderNav.symbol}-${builderNav.date}` : 'default'} definitions={definitions} />}
      {activeSubTab === 'search' && <SearchView definitions={definitions} onLoadInBuilder={handleLoadInBuilder} />}
    </div>
  )
}
