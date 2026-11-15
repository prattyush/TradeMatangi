import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AnalysisProvider, useAnalysisEnvironment, type AnalysisEnvironment } from '../../../shared/analysis/environment'
import DesktopAnalysisChart from '../AnalysisChart'
import { analysisRequest, createAnalysisApi, type AnalysisRequest } from '../analysisApi'
import { createPatternsClient } from '../patternsClient'
import { patternsRequest, type PatternsRequest } from '../patternsApi'
import type { PatternAnnotation, PatternChartMeta } from '../../../shared/analysis/api'
import { cleanTopPatterns } from '../../../shared/analysis/patternMarkers'
import '../../../shared/analysis/kline/desktopAnalysis.css'
import './patternTools.css'
import { TOOL_OPTIONS, buildSaveBody, defaultPatternDate, resolveStrikes, strikesOf, toggleAnnotation, type OptionStrikes } from './patternLibraryModel'

interface Props { baseUrl: string; token: string; onUnauthorized: () => void; active: boolean }
interface Loaded { symbol: string; date: string; instrumentType: 'equity' | 'options'; strikes: { ce: number; pe: number } | null; expiry: string | null }

const native = '__TAURI_INTERNALS__' in window
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Reports the shared candle interval upward and lets the host set it (a saved chart restores its own). */
function IntervalBridge({ requested, onChange }: { requested: number | null; onChange: (minutes: number) => void }) {
  const env = useAnalysisEnvironment()
  useEffect(() => { onChange(env.intervalMinutes ?? 3) }, [env.intervalMinutes, onChange])
  useEffect(() => { if (requested != null) env.setIntervalMinutes?.(requested) }, [requested]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

/**
 * Pattern Library on the desktop: mark entries and exits on the underlying and CE/PE charts, save them per day and
 * browse the saved charts. Built on the Analysis KLine chart (it already draws the saved markers and can pick a point).
 * Drawing tools, R:R, Top Patterns, extra panes and bulk delete come in a follow-up.
 */
export default function PatternLibrary({ baseUrl, token, onUnauthorized, active }: Props) {
  const client = useMemo(() => {
    const request: PatternsRequest = patternsRequest(baseUrl, (command, args) => invoke(command, args))
    return createPatternsClient(request)
  }, [baseUrl])
  const adapter = useMemo(() => {
    const nativeRequest: AnalysisRequest | undefined = native
      ? <T,>(path: string, method: string, body?: unknown) => invoke<T>('desktop_analysis_request', { baseUrl, path, method, body: body ?? {} }) : undefined
    return createAnalysisApi(analysisRequest(baseUrl, token, nativeRequest, onUnauthorized))
  }, [baseUrl, token, onUnauthorized])
  useEffect(() => () => adapter.dispose(), [adapter])

  const [settings, setSettings] = useState({ mode: 'otm', ceCap: 0, peCap: 0, historicalDays: 2 })
  useEffect(() => {
    if (!active || !native) return
    let cancelled = false
    void invoke<Record<string, unknown>>('desktop_drawing_request', { baseUrl, path: 'trading/settings/current', method: 'GET', body: {} }).then(value => {
      if (cancelled) return
      setSettings({ mode: String(value.max_price_mode ?? 'otm'), ceCap: Number(value.max_price_threshold_ce) || 0, peCap: Number(value.max_price_threshold_pe) || 0, historicalDays: Number(value.historical_days) || 2 })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [baseUrl, active])

  const environment: AnalysisEnvironment = useMemo(() => ({
    api: adapter.api, performance: adapter.performance, desktop: true, active, historicalDays: settings.historicalDays,
  }), [adapter, active, settings.historicalDays])

  const [view, setView] = useState<'create' | 'view'>('create')
  const [symbol, setSymbol] = useState('NIFTY')
  const [date, setDate] = useState(() => defaultPatternDate())
  const [instrumentType, setInstrumentType] = useState<'equity' | 'options'>('equity')
  const [offset, setOffset] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  const [annotations, setAnnotations] = useState<PatternAnnotation[]>([])
  const [toolKey, setToolKey] = useState<string>('entry-CE')
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [strategy, setStrategy] = useState('')
  const [category, setCategory] = useState('')
  const [newStrategy, setNewStrategy] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [chartId, setChartId] = useState<string | null>(null)
  const [interval, setIntervalMinutes] = useState(3)
  const [requestedInterval, setRequestedInterval] = useState<number | null>(null)
  const [topPatterns, setTopPatterns] = useState<ReturnType<typeof cleanTopPatterns>>({})

  const [gallery, setGallery] = useState<PatternChartMeta[]>([])
  const [filterStrategy, setFilterStrategy] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [topOnly, setTopOnly] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const fail = useCallback((error: unknown) => setMessage({ kind: 'error', text: errorText(error) }), [])
  const names = useCallback(async () => {
    const [s, c] = await Promise.all([client.listStrategies(), client.listCategories()])
    setStrategies(s.strategies); setCategories(c.categories)
  }, [client])
  const refreshGallery = useCallback(async () => {
    try { setGallery((await client.listCharts(filterStrategy || undefined, filterCategory || undefined, topOnly)).charts) } catch { /* non-fatal */ }
  }, [client, filterStrategy, filterCategory, topOnly])
  useEffect(() => { if (active) void names().catch(() => undefined) }, [active, names])
  useEffect(() => { if (active) void refreshGallery() }, [active, refreshGallery])

  const resetChart = () => { setAnnotations([]); setChartId(null); setNotes(''); setTopPatterns({}); setMessage(null) }

  const loadDay = useCallback(async () => {
    setLoading(true); resetChart(); setLoaded(null)
    try {
      let strikes: OptionStrikes | null = null
      if (instrumentType === 'options') strikes = await resolveStrikes(client, symbol, date, offset, settings)
      const existing = await client.getChartByDate(symbol, date, instrumentType, strikes ? 'CE' : undefined)
      if (existing) {
        setAnnotations(existing.annotations); setChartId(existing.chart_id); setNotes(existing.notes ?? '')
        setTopPatterns(cleanTopPatterns(existing.top_patterns || {}))
        const first = existing.annotations[0]
        if (first) { setStrategy(first.strategy_name); setCategory(first.category || '') }
        if (existing.interval_minutes) setRequestedInterval(existing.interval_minutes)
      }
      setLoaded({ symbol, date, instrumentType, strikes: strikes ? { ce: strikes.ce, pe: strikes.pe } : null, expiry: strikes?.expiry ?? null })
    } catch (error) { fail(error) } finally { setLoading(false) }
  }, [client, symbol, date, instrumentType, offset, settings, fail])

  const openSaved = useCallback(async (meta: PatternChartMeta) => {
    setLoading(true); resetChart(); setLoaded(null)
    try {
      const chart = await client.getChart(meta.chart_id)
      const type = chart.instrument_type === 'options' ? 'options' : 'equity'
      const strikes = type === 'options' ? strikesOf(chart) : null
      const expiry = strikes ? (await client.getExpiry(chart.symbol, chart.date)).expiry : null
      setSymbol(chart.symbol); setDate(chart.date); setInstrumentType(type)
      setAnnotations(chart.annotations); setChartId(chart.chart_id); setNotes(chart.notes ?? '')
      setTopPatterns(cleanTopPatterns(chart.top_patterns || {}))
      const first = chart.annotations[0]
      if (first) { setStrategy(first.strategy_name); setCategory(first.category || '') }
      setRequestedInterval(chart.interval_minutes ?? 3)
      setLoaded({ symbol: chart.symbol, date: chart.date, instrumentType: type, strikes, expiry })
      setView('create')
    } catch (error) { fail(error) } finally { setLoading(false) }
  }, [client, fail])

  const tool = TOOL_OPTIONS.find(t => t.key === toolKey)!
  const effectiveStrategy = strategy || newStrategy.trim()
  const effectiveCategory = category || newCategory.trim()
  const pick = useCallback((point: { time: number; price: number }) => {
    if (!effectiveCategory) { setMessage({ kind: 'error', text: 'Select or type a category before marking.' }); return }
    if (!effectiveStrategy) { setMessage({ kind: 'error', text: 'Select or type a strategy before marking.' }); return }
    setMessage(null)
    setAnnotations(prev => toggleAnnotation(prev, tool, point.time, point.price, effectiveStrategy, effectiveCategory, crypto.randomUUID()))
  }, [tool, effectiveStrategy, effectiveCategory])

  const save = useCallback(async () => {
    if (!loaded) return
    if (!effectiveCategory || !effectiveStrategy) { setMessage({ kind: 'error', text: 'Specify a category and a strategy before saving.' }); return }
    try {
      const body = buildSaveBody({ symbol: loaded.symbol, date: loaded.date, instrumentType: loaded.instrumentType, annotations, notes, intervalMinutes: interval, strikes: loaded.strikes })
      const saved = chartId
        ? await client.updateChart(chartId, { annotations, notes, right: body.right, strike: body.strike, strike_pe: body.strike_pe, interval_minutes: interval, top_patterns: Object.keys(topPatterns).length ? topPatterns : undefined })
        : await client.createChart({ ...body, top_patterns: Object.keys(topPatterns).length ? topPatterns : undefined })
      setChartId(saved.chart_id)
      setMessage({ kind: 'ok', text: 'Saved' })
      if (!strategy && newStrategy.trim()) { setStrategy(newStrategy.trim()); setNewStrategy('') }
      if (!category && newCategory.trim()) { setCategory(newCategory.trim()); setNewCategory('') }
      await Promise.all([names(), refreshGallery()])
    } catch (error) { fail(error) }
  }, [loaded, effectiveCategory, effectiveStrategy, annotations, notes, interval, chartId, client, topPatterns, strategy, newStrategy, category, newCategory, names, refreshGallery, fail])

  const remove = useCallback(async (id: string) => {
    try {
      await client.deleteChart(id)
      if (chartId === id) { resetChart(); setLoaded(null) }
      setConfirmDelete(null)
      await Promise.all([names(), refreshGallery()])
    } catch (error) { fail(error) }
  }, [client, chartId, names, refreshGallery, fail])

  const panes: Array<{ key: string; title: string; instrument: 'underlying' | 'CE' | 'PE'; strike?: number; right?: string }> = loaded ? [
    { key: 'ul', title: loaded.symbol, instrument: 'underlying' },
    ...(loaded.strikes ? [
      { key: 'ce', title: `CE ${loaded.strikes.ce}`, instrument: 'CE' as const, strike: loaded.strikes.ce, right: 'CE' },
      { key: 'pe', title: `PE ${loaded.strikes.pe}`, instrument: 'PE' as const, strike: loaded.strikes.pe, right: 'PE' },
    ] : []),
  ] : []
  const marks = (instrument: string) => annotations.filter(a => a.instrument === instrument).length

  return <AnalysisProvider value={environment}>
    <div className="pl">
      <IntervalBridge requested={requestedInterval} onChange={setIntervalMinutes} />
      <header className="pl-head">
        <h2>Pattern Library</h2>
        <div className="pl-tabs" role="tablist">
          <button role="tab" aria-selected={view === 'create'} onClick={() => setView('create')}>Annotate</button>
          <button role="tab" aria-selected={view === 'view'} onClick={() => setView('view')}>Saved charts ({gallery.length})</button>
        </div>
      </header>
      {view === 'create' && <>
        <div className="pl-bar">
          <label>Symbol <input list="pl-symbols" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} size={10} /></label>
          <datalist id="pl-symbols"><option value="NIFTY" /><option value="BSESEN" /></datalist>
          <label>Date <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <label>Instrument <select value={instrumentType} onChange={e => setInstrumentType(e.target.value as 'equity' | 'options')}><option value="equity">Underlying only</option><option value="options">Underlying + CE/PE</option></select></label>
          {instrumentType === 'options' && <label title={settings.mode === 'threshold' ? 'Max Price from Settings' : 'OTM offset in strikes'}>
            {settings.mode === 'threshold' && ['NIFTY', 'BSESEN'].includes(symbol) ? `Max Price CE ${settings.ceCap} / PE ${settings.peCap}` : <>OTM <input type="number" value={offset} onChange={e => setOffset(Number(e.target.value) || 0)} style={{ width: 56 }} /></>}
          </label>}
          <button className="pl-primary" onClick={() => void loadDay()} disabled={loading || !date || !symbol}>{loading ? 'Loading…' : 'Load chart'}</button>
        </div>
        {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
        {loaded && <>
          <div className="pl-bar">
            <label>Category <select value={category} onChange={e => setCategory(e.target.value)}><option value="">— new —</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
            {!category && <input placeholder="New category" value={newCategory} onChange={e => setNewCategory(e.target.value)} size={14} />}
            <label>Strategy <select value={strategy} onChange={e => setStrategy(e.target.value)}><option value="">— new —</option>{strategies.map(s => <option key={s}>{s}</option>)}</select></label>
            {!strategy && <input placeholder="New strategy" value={newStrategy} onChange={e => setNewStrategy(e.target.value)} size={14} />}
          </div>
          <div className="pl-bar">
            <span className="pl-muted">Mark:</span>
            {TOOL_OPTIONS.filter(t => t.instrument === 'underlying' || loaded.strikes).map(t =>
              <button key={t.key} aria-pressed={toolKey === t.key} className={`pl-tool ${t.type}`} onClick={() => setToolKey(t.key)}>{t.label}</button>)}
            <button onClick={() => setAnnotations(a => a.slice(0, -1))} disabled={!annotations.length}>Undo</button>
            <button onClick={() => setAnnotations([])} disabled={!annotations.length}>Clear marks</button>
            <span className="pl-muted">{annotations.length} marks · candle {interval}m (set on a chart)</span>
            <button className="pl-save" onClick={() => void save()}>{chartId ? 'Update' : 'Save'}</button>
          </div>
          <div className="pl-charts" data-panes={panes.length}>
            {panes.map(pane => <div className="pl-pane" key={`${loaded.symbol}-${loaded.date}-${pane.key}-${pane.strike ?? ''}`}>
              <DesktopAnalysisChart
                symbol={loaded.symbol} date={loaded.date} title={`${pane.title} · ${marks(pane.instrument)} marks`}
                strike={pane.strike} right={pane.right} expiry={pane.right ? loaded.expiry ?? undefined : undefined}
                historicalDays={settings.historicalDays}
                annotations={annotations.filter(a => a.instrument === pane.instrument)} activeStrategy={effectiveStrategy || null} activeCategory={effectiveCategory || null}
                topPatterns={topPatterns}
                pickMode={tool.instrument === pane.instrument} onPick={pick} pickHint={`${tool.label} — click a candle (click the same candle again to remove)`}
              />
            </div>)}
          </div>
          <label className="pl-notes">Notes <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What made this setup work or fail?" /></label>
        </>}
      </>}
      {view === 'view' && <div className="pl-gallery">
        <div className="pl-bar">
          <label>Strategy <select value={filterStrategy} onChange={e => setFilterStrategy(e.target.value)}><option value="">All</option>{strategies.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Category <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}><option value="">All</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
          <label><input type="checkbox" checked={topOnly} onChange={e => setTopOnly(e.target.checked)} /> Top patterns only</label>
        </div>
        {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'}>{message.text}</p>}
        {gallery.length === 0 ? <p className="pl-muted">No saved charts match.</p> : <table>
          <thead><tr><th>Date</th><th>Symbol</th><th>Type</th><th>Strikes</th><th>Strategies</th><th>Categories</th><th>▲</th><th>▼</th><th /></tr></thead>
          <tbody>{gallery.map(chart => { const strikes = chart.instrument_type === 'options' ? strikesOf(chart) : null; return <tr key={chart.chart_id}>
            <td>{chart.date}</td><td>{chart.symbol}</td><td>{chart.instrument_type}</td>
            <td>{strikes ? (strikes.ce === strikes.pe ? strikes.ce : `CE ${strikes.ce} / PE ${strikes.pe}`) : '—'}</td>
            <td>{chart.strategy_names.join(', ')}</td><td>{chart.categories.join(', ')}</td><td>{chart.entry_count}</td><td>{chart.exit_count}</td>
            <td className="pl-actions">
              <button onClick={() => void openSaved(chart)} disabled={loading}>Open</button>
              {chart.can_delete !== false && (confirmDelete === chart.chart_id
                ? <><button className="pl-danger" onClick={() => void remove(chart.chart_id)}>Confirm delete</button><button onClick={() => setConfirmDelete(null)}>Cancel</button></>
                : <button onClick={() => setConfirmDelete(chart.chart_id)}>Delete</button>)}
            </td></tr> })}</tbody>
        </table>}
      </div>}
    </div>
  </AnalysisProvider>
}
