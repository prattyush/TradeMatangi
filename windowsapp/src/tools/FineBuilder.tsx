import { useCallback, useEffect, useMemo, useState } from 'react'
import DesktopAnalysisChart from '../AnalysisChart'
import type { FineDefinition, FlowStep, PatternsClient, StructureCandle } from '../patternsClient'
import type { PatternSettings } from './usePatternsRuntime'
import { IntervalBridge } from './IntervalBridge'
import { defaultPatternDate, resolveStrikes } from './patternLibraryModel'
import { clearLastTransition, findFlow, moveStep, newStep, removeStep, setTransition, stepAnnotations, stepColor, flowStepsToSave, type Pane } from './fineStructuresModel'

interface Props { client: PatternsClient; definitions: FineDefinition[]; settings: PatternSettings; active: boolean }
interface Loaded { symbol: string; date: string; instrumentType: 'equity' | 'options'; strikes: { ce: number; pe: number } | null; expiry: string | null }
interface PaneState { steps: FlowStep[]; flowId: string | null }
const empty: PaneState = { steps: [], flowId: null }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const clock = (time: number) => new Date(time * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })

/** Build a flow: choose a day, add structure steps in order, then click the chart to place each step's transition bar. */
export function FineBuilder({ client, definitions, settings, active }: Props) {
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState(() => defaultPatternDate())
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>('equity')
  const [offset, setOffset] = useState(2)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [panes, setPanes] = useState<Record<Pane, PaneState>>({ underlying: empty, CE: empty, PE: empty })
  const [candles, setCandles] = useState<Record<Pane, StructureCandle[]>>({ underlying: [], CE: [], PE: [] })
  const [activePane, setActivePane] = useState<Pane>('underlying')
  const [activeStep, setActiveStep] = useState<number | null>(null)
  const [interval, setIntervalMinutes] = useState(3)
  const [requestedInterval, setRequestedInterval] = useState<number | null>(null)
  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')
  const addDef = definitions.find(d => d.definition_id === addDefId)
  const fail = useCallback((e: unknown) => setMessage({ kind: 'error', text: errorText(e) }), [])

  const paneList: Array<{ pane: Pane; title: string; strike?: number }> = loaded ? [
    { pane: 'underlying', title: loaded.symbol },
    ...(loaded.strikes ? [{ pane: 'CE' as const, title: `CE ${loaded.strikes.ce}`, strike: loaded.strikes.ce }, { pane: 'PE' as const, title: `PE ${loaded.strikes.pe}`, strike: loaded.strikes.pe }] : []),
  ] : []

  const load = async () => {
    setLoading(true); setMessage(null); setLoaded(null); setActiveStep(null); setActivePane('underlying')
    setPanes({ underlying: empty, CE: empty, PE: empty }); setCandles({ underlying: [], CE: [], PE: [] })
    try {
      const strikes = instrumentType === 'options' ? await resolveStrikes(client, symbol, date, offset, settings) : null
      const flows = await client.listFlows({ symbol, start_date: date, end_date: date })
      const next: Record<Pane, PaneState> = { underlying: empty, CE: empty, PE: empty }
      let restored: number | null = null
      for (const pane of ['underlying', ...(strikes ? ['CE', 'PE'] : [])] as Pane[]) {
        const flow = findFlow(flows, instrumentType, pane)
        if (flow) { next[pane] = { steps: flow.steps, flowId: flow.flow_id }; restored = restored ?? flow.interval_minutes }
      }
      setPanes(next)
      if (restored) setRequestedInterval(restored)
      setLoaded({ symbol, date, instrumentType, strikes: strikes ? { ce: strikes.ce, pe: strikes.pe } : null, expiry: strikes?.expiry ?? null })
    } catch (e) { fail(e) } finally { setLoading(false) }
  }

  // Marker heights come from the candles at the chart's interval (the chart itself loads its own copy to draw).
  useEffect(() => {
    if (!loaded || !active) return
    let cancelled = false
    const days = settings.historicalDays
    const fetch = (pane: Pane) => pane === 'underlying'
      ? client.fineOhlc(loaded.symbol, loaded.date, interval, days)
      : client.fineOptionsOhlc(loaded.symbol, loaded.date, pane === 'CE' ? loaded.strikes!.ce : loaded.strikes!.pe, pane, interval, days)
    for (const { pane } of paneList) {
      void fetch(pane).then(list => { if (!cancelled) setCandles(prev => ({ ...prev, [pane]: list })) }).catch(() => { if (!cancelled) setCandles(prev => ({ ...prev, [pane]: [] })) })
    }
    return () => { cancelled = true }
  }, [loaded, interval, active, client, settings.historicalDays]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = panes[activePane]
  const update = (pane: Pane, patch: Partial<PaneState>) => setPanes(prev => ({ ...prev, [pane]: { ...prev[pane], ...patch } }))
  const addStep = () => {
    if (!addDef) return
    update(activePane, { steps: [...current.steps, newStep(addDef, addType, addDirection)] })
    setAddDefId(''); setAddType(''); setAddDirection('')
  }
  const pick = useCallback((point: { time: number }) => {
    if (activeStep === null) return
    setPanes(prev => ({ ...prev, [activePane]: { ...prev[activePane], steps: setTransition(prev[activePane].steps, activeStep, point.time) } }))
  }, [activePane, activeStep])
  const save = async () => {
    if (!loaded || !current.steps.length) return
    try {
      const steps = flowStepsToSave(current.steps)
      if (current.flowId) await client.updateFlow(current.flowId, steps, interval)
      else {
        const flow = await client.createFlow({ symbol: loaded.symbol, date: loaded.date, steps, instrument_type: loaded.instrumentType, right: activePane === 'underlying' ? null : activePane, interval_minutes: interval })
        update(activePane, { flowId: flow.flow_id })
      }
      setMessage({ kind: 'ok', text: `${activePane === 'underlying' ? 'Underlying' : activePane} flow saved` })
    } catch (e) { fail(e) }
  }
  const stepsEdited = useMemo(() => current.steps.some(s => s.transition_bar_time), [current.steps])

  return <div className="fs-builder">
    <IntervalBridge requested={requestedInterval} onChange={setIntervalMinutes} />
    <div className="pl-bar">
      <label>Symbol <input list="fs-symbols" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} size={10} /></label>
      <datalist id="fs-symbols"><option value="NIFTY" /><option value="BSESEN" /></datalist>
      <label>Date <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Instrument <select value={instrumentType} onChange={e => setInstrumentType(e.target.value as 'equity' | 'options')}><option value="equity">Underlying only</option><option value="options">Underlying + CE/PE</option></select></label>
      {instrumentType === 'options' && (settings.mode === 'threshold' && ['NIFTY', 'BSESEN'].includes(symbol)
        ? <span className="pl-muted">Max Price CE {settings.ceCap} / PE {settings.peCap}</span>
        : <label>OTM <input type="number" value={offset} onChange={e => setOffset(Number(e.target.value) || 0)} style={{ width: 56 }} /></label>)}
      <button className="pl-primary" onClick={() => void load()} disabled={loading || !date || !symbol}>{loading ? 'Loading…' : 'Load'}</button>
      <span className="pl-muted">candle {interval}m (set on a chart)</span>
    </div>
    {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    {loaded && <div className="fs-main">
      <div className="fs-charts" style={{ gridTemplateColumns: `repeat(${paneList.length}, minmax(0, 1fr))` }}>
        {paneList.map(({ pane, title, strike }) => <div key={`${loaded.symbol}-${loaded.date}-${pane}-${strike ?? ''}`} className={`pl-pane ${pane === activePane ? 'fs-active' : ''}`} onMouseDown={() => { if (pane !== activePane) { setActivePane(pane); setActiveStep(null) } }}>
          <DesktopAnalysisChart
            symbol={loaded.symbol} date={loaded.date} title={`${title} · ${panes[pane].steps.filter(s => s.transition_bar_time).length} bars`}
            strike={strike} right={strike === undefined ? undefined : pane} expiry={strike === undefined ? undefined : loaded.expiry ?? undefined}
            historicalDays={settings.historicalDays}
            annotations={stepAnnotations(panes[pane].steps, pane, candles[pane], interval)} activeStrategy={null} activeCategory={null}
            pickMode={pane === activePane && activeStep !== null} onPick={pick}
            pickHint={activeStep === null ? undefined : `Click the candle where “${current.steps[activeStep]?.name ?? ''}” transitions`}
          />
        </div>)}
      </div>
      <aside className="fs-steps">
        <div className="pl-bar"><strong>Flow steps</strong>{paneList.length > 1 && <span className="pl-muted">— {activePane === 'underlying' ? 'Underlying' : activePane}</span>}
          <button className="pl-save" onClick={() => void save()} disabled={!current.steps.length}>{current.flowId ? 'Update flow' : 'Save flow'}</button></div>
        {activeStep !== null && <p className="pl-ok">⊕ Click a candle to set the transition bar for “{current.steps[activeStep]?.name}”. Click the step again to stop picking and draw.</p>}
        <ol>{current.steps.map((step, index) => <li key={index} className={activeStep === index ? 'fs-step active' : 'fs-step'} onClick={() => setActiveStep(activeStep === index ? null : index)}>
          <span className="fs-chip" style={{ color: stepColor(index), borderColor: stepColor(index) }}>{step.name}</span>
          {step.type && <span className="fs-chip">{step.type}</span>}
          {step.direction && <span className={step.direction === 'Bull' ? 'fs-bull' : 'fs-bear'}>{step.direction}</span>}
          {step.transition_bar_time && <span className="fs-time">{clock(step.transition_bar_time)}</span>}
          <span className="fs-step-actions">
            <button aria-label="Move up" onClick={e => { e.stopPropagation(); const r = moveStep(current.steps, index, -1, activeStep); update(activePane, { steps: r.steps }); setActiveStep(r.active) }}>↑</button>
            <button aria-label="Move down" onClick={e => { e.stopPropagation(); const r = moveStep(current.steps, index, 1, activeStep); update(activePane, { steps: r.steps }); setActiveStep(r.active) }}>↓</button>
            <button aria-label="Remove step" onClick={e => { e.stopPropagation(); const r = removeStep(current.steps, index, activeStep); update(activePane, { steps: r.steps }); setActiveStep(r.active) }}>✕</button>
          </span>
        </li>)}</ol>
        {!current.steps.length && <p className="pl-muted">Add structures below to build the flow.</p>}
        {stepsEdited && <button onClick={() => update(activePane, { steps: clearLastTransition(current.steps) })}>Clear last transition bar</button>}
        <div className="pl-bar">
          <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} aria-label="Structure"><option value="">— Structure —</option>{definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}</select>
          {addDef && addDef.sub_types.length > 0 && <select value={addType} onChange={e => setAddType(e.target.value)} aria-label="Type"><option value="">— Type (optional) —</option>{addDef.sub_types.map(t => <option key={t}>{t}</option>)}</select>}
          <select value={addDirection} onChange={e => setAddDirection(e.target.value)} aria-label="Direction"><option value="">Dir</option><option>Bull</option><option>Bear</option></select>
          <button onClick={addStep} disabled={!addDefId}>+ Add step</button>
        </div>
      </aside>
    </div>}
  </div>
}
