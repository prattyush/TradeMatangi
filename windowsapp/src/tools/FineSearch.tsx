import { useCallback, useEffect, useState } from 'react'
import DesktopAnalysisChart from '../AnalysisChart'
import { otmStrikes, PATTERN_ATM_TIME, roundToStrike } from '../../../frontend/src/patternStrikes'
import type { FineDefinition, FineQueryStep, FineSearchResult, PatternsClient, StructureCandle } from '../patternsClient'
import type { PatternSettings } from './usePatternsRuntime'
import { IntervalBridge } from './IntervalBridge'
import { STRIKE_INTERVALS } from './patternLibraryModel'
import { isMatchStep, queryStep, stepAnnotations, stepLabel, type Pane } from './fineStructuresModel'

interface Props { client: PatternsClient; definitions: FineDefinition[]; settings: PatternSettings; active: boolean }
interface Shown { result: FineSearchResult; strike?: number; expiry?: string; pane: Pane }
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const clock = (time: number) => new Date(time * 1000).toLocaleTimeString('en-IN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })

/** Search saved flows for a sequence of structures (with wildcards), then open a match on the chart with its transition bars. */
export function FineSearch({ client, definitions, settings, active }: Props) {
  const [query, setQuery] = useState<FineQueryStep[]>([])
  const [results, setResults] = useState<FineSearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [instrumentFilter, setInstrumentFilter] = useState('')
  const [error, setError] = useState('')
  const [addDefId, setAddDefId] = useState('')
  const [addType, setAddType] = useState('')
  const [addDirection, setAddDirection] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [candles, setCandles] = useState<StructureCandle[]>([])
  const [interval, setIntervalMinutes] = useState(3)
  const [requestedInterval, setRequestedInterval] = useState<number | null>(null)
  const addDef = definitions.find(d => d.definition_id === addDefId) ?? null

  const addQueryStep = () => {
    const step = queryStep(addDef, addDefId === '*', addType, addDirection)
    if (!step) return
    setQuery(prev => [...prev, step]); setAddDefId(''); setAddType(''); setAddDirection('')
  }
  const search = async () => {
    if (!query.length) return
    setSearching(true); setError(''); setSelected(null); setShown(null)
    try { setResults(await client.searchFlows({ query_steps: query, instrument_type: instrumentFilter || undefined })); setSearched(true) }
    catch (e) { setError(errorText(e)) } finally { setSearching(false) }
  }

  // Options flows keep the right but not the strike, so the chart shows the ATM contract of that day.
  const open = useCallback(async (index: number) => {
    const result = results[index]
    if (!result) return
    setSelected(index); setShown(null); setCandles([]); setError('')
    try {
      const { flow } = result
      setRequestedInterval(flow.interval_minutes ?? 3)
      if (flow.instrument_type === 'options' && flow.right) {
        const spacing = STRIKE_INTERVALS[flow.symbol] ?? 50
        const { price } = await client.getPriceAt(flow.symbol, flow.date, PATTERN_ATM_TIME)
        const atm = roundToStrike(price, spacing)
        const strike = flow.right === 'CE' ? otmStrikes(atm, 0, spacing).ce : otmStrikes(atm, 0, spacing).pe
        const { expiry } = await client.getExpiry(flow.symbol, flow.date)
        setShown({ result, strike, expiry, pane: flow.right as Pane })
      } else setShown({ result, pane: 'underlying' })
    } catch (e) { setError(errorText(e)) }
  }, [client, results])

  useEffect(() => {
    if (!shown || !active) return
    let cancelled = false
    const { flow } = shown.result
    const load = shown.strike !== undefined
      ? client.fineOptionsOhlc(flow.symbol, flow.date, shown.strike, shown.pane as 'CE' | 'PE', interval, settings.historicalDays)
      : client.fineOhlc(flow.symbol, flow.date, interval, settings.historicalDays)
    void load.then(list => { if (!cancelled) setCandles(list) }).catch(() => { if (!cancelled) setCandles([]) })
    return () => { cancelled = true }
  }, [shown, interval, active, client, settings.historicalDays])

  const flow = shown?.result.flow
  return <div className="fs-search">
    <IntervalBridge requested={requestedInterval} onChange={setIntervalMinutes} />
    <section className="fs-query">
      <strong>Search by sequence</strong>
      <div className="fs-query-steps">{query.length === 0 ? <span className="pl-muted">Add structures to search</span> : query.map((s, i) => <span key={i} className="fs-chip">
        {i > 0 && '→ '}{s.name === '*' ? '✱ Any' : s.name}{s.type && ` (${s.type})`}{s.direction && <span className={s.direction === 'Bull' ? 'fs-bull' : 'fs-bear'}> {s.direction}</span>}
        <button aria-label="Remove query step" onClick={() => setQuery(prev => prev.filter((_, j) => j !== i))}>✕</button>
      </span>)}</div>
      <div className="pl-bar">
        <select value={addDefId} onChange={e => { setAddDefId(e.target.value); setAddType('') }} aria-label="Structure"><option value="">— Structure —</option><option value="*">✱ Any (wildcard)</option>{definitions.map(d => <option key={d.definition_id} value={d.definition_id}>{d.name}</option>)}</select>
        {addDefId !== '*' && addDef && addDef.sub_types.length > 0 && <select value={addType} onChange={e => setAddType(e.target.value)} aria-label="Type"><option value="">— Type —</option>{addDef.sub_types.map(t => <option key={t}>{t}</option>)}</select>}
        {addDefId !== '*' && <select value={addDirection} onChange={e => setAddDirection(e.target.value)} aria-label="Direction"><option value="">Dir</option><option>Bull</option><option>Bear</option></select>}
        <button onClick={addQueryStep} disabled={!addDefId}>Add</button>
      </div>
      <div className="pl-bar">
        <select value={instrumentFilter} onChange={e => setInstrumentFilter(e.target.value)} aria-label="Instrument filter"><option value="">All types</option><option value="equity">Equity only</option><option value="options">Options only</option></select>
        <button className="pl-primary" onClick={() => void search()} disabled={!query.length || searching}>{searching ? 'Searching…' : 'Search'}</button>
      </div>
      {error && <p className="pl-error" role="alert">{error}</p>}
      <div className="fs-results">
        {results.length === 0 && !searching && <p className="pl-muted">{searched ? 'No results found' : query.length ? 'Press Search' : 'Build a query above'}</p>}
        {results.map((r, i) => <button key={r.flow.flow_id} className={selected === i ? 'fs-result active' : 'fs-result'} onClick={() => void open(i)}>
          <span><strong>{r.flow.symbol}</strong> <span className="pl-muted">{r.flow.date}{r.flow.right ? ` · ${r.flow.right}` : ''}</span></span>
          <span>{r.flow.steps.map((s, si) => <span key={si} className={isMatchStep(si, r.match_start_index, query.length) ? 'fs-chip match' : 'fs-chip'}>{si > 0 && '→'}{s.name}</span>)}</span>
        </button>)}
      </div>
    </section>
    <section className="fs-result-view">
      {!shown || !flow ? <p className="pl-muted">{selected === null ? 'Select a result to view its chart' : 'Loading chart…'}</p> : <>
        <div className="pl-bar"><strong>{flow.symbol}</strong><span className="pl-muted">{flow.date}{shown.strike !== undefined ? ` · ${shown.pane} ${shown.strike} (ATM)` : ''} · candle {interval}m (set on the chart)</span></div>
        <div className="fs-chart"><DesktopAnalysisChart key={`${flow.flow_id}-${shown.strike ?? ''}`} symbol={flow.symbol} date={flow.date} title={`${flow.symbol} · ${flow.date}`}
          strike={shown.strike} right={shown.strike === undefined ? undefined : shown.pane} expiry={shown.expiry} historicalDays={settings.historicalDays}
          annotations={stepAnnotations(flow.steps, shown.pane, candles, interval)} activeStrategy={null} activeCategory={null} /></div>
        <ol className="fs-flow">{flow.steps.map((s, i) => <li key={i} className={isMatchStep(i, shown.result.match_start_index, query.length) ? 'fs-step active' : 'fs-step'}>
          <span>{i + 1}</span><strong>{stepLabel(s)}</strong>{s.direction && <span className={s.direction === 'Bull' ? 'fs-bull' : 'fs-bear'}>{s.direction}</span>}{s.transition_bar_time && <span className="fs-time">{clock(s.transition_bar_time)}</span>}
        </li>)}</ol>
      </>}
    </section>
  </div>
}
