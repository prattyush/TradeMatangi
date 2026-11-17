import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisProvider } from '../../../shared/analysis/environment'
import DesktopAnalysisChart from '../AnalysisChart'
import { usePatternsRuntime } from './usePatternsRuntime'
import DeepDive from '../../../shared/deepdive/ui/DeepDive'
import { useDesktopDeepDiveHost } from './deepdive/desktopHost'
import { PATTERN_SYMBOLS } from '../../../shared/deepdive/symbols'
import TradedPatterns from '../../../shared/traded/ui/TradedPatterns'
import Practice from '../../../shared/practice/ui/Practice'
import { useDesktopPracticeHost } from './practice/desktopPractice'
import type { PracticeLaunch } from './practice/launch'
import type { TradedHost } from '../../../shared/traded/ui/host'
import type { DiveChartProps } from '../../../shared/deepdive/ui/host'
import { IntervalBridge } from './IntervalBridge'
import type { PatternAnnotation, PatternChartMeta } from '../../../shared/analysis/api'
import { cleanTopPatterns } from '../../../shared/analysis/patternMarkers'
import '../../../shared/analysis/kline/desktopAnalysis.css'
import './patternTools.css'
import { RANKS, TOOL_OPTIONS, buildSaveBody, defaultPatternDate, resolveStrikes, riskRewardKey, savedStrikePair, setRank, setRiskReward, strikesOf, toggleAnnotation, uniquePatterns, type ExtraPane, type OptionStrikes } from './patternLibraryModel'

interface Props {
  baseUrl: string; token: string; onUnauthorized: () => void; active: boolean
  /** Strategy Practice: starts a replay on a workspace screen (rejects with a sentence when it cannot). */
  onStartPractice?: (launch: PracticeLaunch) => Promise<void>
  /** A practice run whose review should open now (the workspace's Review button after Stop). */
  practiceReviewId?: string | null
  onPracticeReviewOpened?: () => void
}
interface Loaded { symbol: string; date: string; instrumentType: 'equity' | 'options'; strikes: { ce: number; pe: number } | null; expiry: string | null }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Pattern Library on the desktop: mark entries and exits on the underlying and CE/PE charts, rank the top patterns,
 * note an R:R per pattern, add or remove strike panes, draw on the charts, save per day and browse the saved charts.
 * Built on the Analysis KLine chart (it already draws the saved markers and can pick a point).
 */
export default function PatternLibrary({ baseUrl, token, onUnauthorized, active, onStartPractice, practiceReviewId = null, onPracticeReviewOpened }: Props) {
  const { client, environment, settings } = usePatternsRuntime(baseUrl, token, onUnauthorized, active)
  // The Deep Dive puts its own header controls in this row (a portal into the slot below), so the charts get the height.
  const [deepDiveSlot, setDeepDiveSlot] = useState<HTMLElement | null>(null)
  const deepDiveHost = useDesktopDeepDiveHost(client, settings, deepDiveSlot)

  const [view, setView] = useState<'create' | 'view' | 'deepdive' | 'traded' | 'practice'>(practiceReviewId ? 'practice' : 'create')
  useEffect(() => { if (practiceReviewId) setView('practice') }, [practiceReviewId])
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
  const [riskReward, setRiskRewardRatios] = useState<Record<string, string>>({})
  const [extraPanes, setExtraPanes] = useState<ExtraPane[]>([])
  const paneId = useRef(1)
  const [addRight, setAddRight] = useState<'CE' | 'PE'>('CE')
  const [addStrike, setAddStrike] = useState('')
  const [maximizedPane, setMaximizedPane] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)

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

  const resetChart = () => { setAnnotations([]); setChartId(null); setNotes(''); setTopPatterns({}); setRiskRewardRatios({}); setExtraPanes([]); setMaximizedPane(null); setMessage(null) }
  const panesFor = (strikes: { ce: number; pe: number } | null): ExtraPane[] => strikes ? [{ id: paneId.current++, right: 'CE', strike: strikes.ce }, { id: paneId.current++, right: 'PE', strike: strikes.pe }] : []

  const loadDay = useCallback(async () => {
    setLoading(true); resetChart(); setLoaded(null)
    try {
      let strikes: OptionStrikes | null = null
      if (instrumentType === 'options') strikes = await resolveStrikes(client, symbol, date, offset, settings)
      const existing = await client.getChartByDate(symbol, date, instrumentType, strikes ? 'CE' : undefined)
      if (existing) {
        setAnnotations(existing.annotations); setChartId(existing.chart_id); setNotes(existing.notes ?? '')
        setTopPatterns(cleanTopPatterns(existing.top_patterns || {})); setRiskRewardRatios(existing.risk_reward_ratios ?? {})
        const first = existing.annotations[0]
        if (first) { setStrategy(first.strategy_name); setCategory(first.category || '') }
        if (existing.interval_minutes) setRequestedInterval(existing.interval_minutes)
      }
      const saved = existing && instrumentType === 'options' ? strikesOf(existing) : null
      setExtraPanes(panesFor(saved ?? (strikes ? { ce: strikes.ce, pe: strikes.pe } : null)))
      setLoaded({ symbol, date, instrumentType, strikes: saved ?? (strikes ? { ce: strikes.ce, pe: strikes.pe } : null), expiry: strikes?.expiry ?? null })
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
      setTopPatterns(cleanTopPatterns(chart.top_patterns || {})); setRiskRewardRatios(chart.risk_reward_ratios ?? {})
      setExtraPanes(panesFor(strikes))
      const first = chart.annotations[0]
      if (first) { setStrategy(first.strategy_name); setCategory(first.category || '') }
      setRequestedInterval(chart.interval_minutes ?? 3)
      setLoaded({ symbol: chart.symbol, date: chart.date, instrumentType: type, strikes, expiry })
      setView('create')
    } catch (error) { fail(error) } finally { setLoading(false) }
  }, [client, fail])

  // "From your trades" (Phase 26, S10): the labelled trades as pattern material. Edit opens the saved chart in Annotate.
  const tradedHost = useMemo<TradedHost>(() => ({
    api: client.traded, Chart: DesktopAnalysisChart as unknown as TradedHost['Chart'] & ((props: DiveChartProps) => unknown),
    historicalDays: settings.historicalDays, onEdit: async chartId => { await openSaved({ chart_id: chartId } as PatternChartMeta) },
  }), [client, settings.historicalDays, openSaved])

  const noPractice = useCallback(async () => { throw new Error('Practice can only start from the desktop workspace.') }, [])
  const practiceHost = useDesktopPracticeHost(client, settings, onStartPractice ?? noPractice, { sessionId: practiceReviewId, onOpened: onPracticeReviewOpened ?? (() => undefined) })

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
      const body = buildSaveBody({ symbol: loaded.symbol, date: loaded.date, instrumentType: loaded.instrumentType, annotations, notes, intervalMinutes: interval, strikes: savedStrikePair(extraPanes) })
      const top = Object.keys(topPatterns).length ? topPatterns : undefined
      const ratios = Object.keys(riskReward).length ? riskReward : undefined
      const saved = chartId
        ? await client.updateChart(chartId, { annotations, notes, right: body.right, strike: body.strike, strike_pe: body.strike_pe, interval_minutes: interval, top_patterns: top, risk_reward_ratios: ratios })
        : await client.createChart({ ...body, top_patterns: top, risk_reward_ratios: ratios })
      setChartId(saved.chart_id)
      setMessage({ kind: 'ok', text: 'Saved' })
      if (!strategy && newStrategy.trim()) { setStrategy(newStrategy.trim()); setNewStrategy('') }
      if (!category && newCategory.trim()) { setCategory(newCategory.trim()); setNewCategory('') }
      await Promise.all([names(), refreshGallery()])
    } catch (error) { fail(error) }
  }, [loaded, effectiveCategory, effectiveStrategy, annotations, notes, interval, chartId, client, topPatterns, riskReward, extraPanes, strategy, newStrategy, category, newCategory, names, refreshGallery, fail])

  const remove = useCallback(async (id: string) => {
    try {
      await client.deleteChart(id)
      if (chartId === id) { resetChart(); setLoaded(null) }
      setConfirmDelete(null)
      await Promise.all([names(), refreshGallery()])
    } catch (error) { fail(error) }
  }, [client, chartId, names, refreshGallery, fail])

  const panes: Array<{ key: string; id: number | null; title: string; instrument: 'underlying' | 'CE' | 'PE'; strike?: number; right?: string }> = loaded ? [
    { key: 'ul', id: null, title: loaded.symbol, instrument: 'underlying' },
    ...extraPanes.map(p => ({ key: `p${p.id}`, id: p.id, title: `${p.right} ${p.strike}`, instrument: p.right, strike: p.strike, right: p.right })),
  ] : []
  const hasRight = (right: 'CE' | 'PE') => extraPanes.some(p => p.right === right)
  const patterns = uniquePatterns(annotations)
  const ratioKey = riskRewardKey(effectiveCategory, effectiveStrategy)
  const addPane = () => {
    const strike = Number.parseInt(addStrike, 10)
    if (!Number.isFinite(strike) || strike <= 0) { setMessage({ kind: 'error', text: 'Enter a valid strike price.' }); return }
    if (extraPanes.some(p => p.right === addRight && p.strike === strike)) { setMessage({ kind: 'error', text: `${addRight} ${strike} is already shown.` }); return }
    setMessage(null); setExtraPanes(prev => [...prev, { id: paneId.current++, right: addRight, strike }]); setAddStrike('')
  }
  const removePane = (id: number) => { setExtraPanes(prev => prev.filter(p => p.id !== id)); setMaximizedPane(prev => prev === id ? null : prev) }
  const deletable = gallery.filter(c => c.can_delete !== false)
  const bulkDelete = async () => {
    const ids = deletable.filter(c => selected.has(c.chart_id)).map(c => c.chart_id)
    if (!ids.length) return
    try {
      const result = await client.bulkDeleteCharts(ids)
      if (chartId && result.deleted.includes(chartId)) { resetChart(); setLoaded(null) }
      setSelected(new Set()); setConfirmBulk(false)
      setMessage(result.failed.length ? { kind: 'error', text: `${result.failed.length} chart(s) could not be deleted.` } : { kind: 'ok', text: `Deleted ${result.deleted.length} chart(s).` })
      await Promise.all([names(), refreshGallery()])
    } catch (error) { fail(error) }
  }
  const marks = (instrument: string) => annotations.filter(a => a.instrument === instrument).length

  return <AnalysisProvider value={environment}>
    <div className="pl">
      <IntervalBridge requested={requestedInterval} onChange={setIntervalMinutes} />
      <header className="pl-head">
        <h2>Pattern Library</h2>
        <div className="pl-tabs" role="tablist">
          <button role="tab" aria-selected={view === 'create'} onClick={() => setView('create')}>Annotate</button>
          <button role="tab" aria-selected={view === 'view'} onClick={() => setView('view')}>Saved charts ({gallery.length})</button>
          <button role="tab" aria-selected={view === 'deepdive'} onClick={() => setView('deepdive')}>Deep dive</button>
          <button role="tab" aria-selected={view === 'traded'} onClick={() => setView('traded')}>From your trades</button>
          {onStartPractice && <button role="tab" aria-selected={view === 'practice'} onClick={() => setView('practice')}>Practice</button>}
        </div>
        {view === 'deepdive' && <span ref={setDeepDiveSlot} className="pl-head-slot" />}
      </header>
      {view === 'create' && <>
        <div className="pl-bar">
          <label>Symbol <input list="pl-symbols" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} size={10} /></label>
          <datalist id="pl-symbols">{PATTERN_SYMBOLS.map(item => <option key={item.symbol} value={item.symbol}>{item.name}</option>)}</datalist>
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
            {effectiveCategory && effectiveStrategy && <label title="Reward per 1 of risk for this pattern; shown on its markers">R:R 1: <input value={riskReward[ratioKey] ?? ''} onChange={e => setRiskRewardRatios(prev => setRiskReward(prev, ratioKey, e.target.value))} placeholder="1.5" size={5} /></label>}
          </div>
          <div className="pl-bar" aria-label="Top patterns">
            <span className="pl-muted">🏆 Top patterns:</span>
            {patterns.length === 0 ? <span className="pl-muted">Mark candles to rank their patterns</span> : RANKS.map(({ rank, label }) => {
              const chosen = topPatterns[rank]
              return <label key={rank}>{label} <select value={chosen ? `${chosen.strategy_name}::${chosen.category}` : ''} onChange={e => setTopPatterns(prev => setRank(prev, rank, e.target.value))}>
                <option value="">— none —</option>{patterns.map(p => <option key={p.identity} value={p.identity}>{p.category}/{p.strategy_name}</option>)}
              </select></label>
            })}
          </div>
          {loaded.instrumentType === 'options' && <div className="pl-bar" aria-label="Strike panes">
            <span className="pl-muted">Strike panes:</span>
            <select value={addRight} onChange={e => setAddRight(e.target.value as 'CE' | 'PE')} aria-label="Right"><option>CE</option><option>PE</option></select>
            <input type="number" value={addStrike} onChange={e => setAddStrike(e.target.value)} placeholder="Strike" style={{ width: 80 }} aria-label="Strike" onKeyDown={e => { if (e.key === 'Enter') addPane() }} />
            <button onClick={addPane} disabled={!addStrike}>Add pane</button>
          </div>}
          <div className="pl-bar">
            <span className="pl-muted">Mark:</span>
            {TOOL_OPTIONS.filter(t => t.instrument === 'underlying' || hasRight(t.instrument)).map(t =>
              <button key={t.key} aria-pressed={toolKey === t.key} className={`pl-tool ${t.type}`} onClick={() => setToolKey(t.key)}>{t.label}</button>)}
            <button onClick={() => setAnnotations(a => a.slice(0, -1))} disabled={!annotations.length}>Undo</button>
            <button onClick={() => setAnnotations([])} disabled={!annotations.length}>Clear marks</button>
            <span className="pl-muted">{annotations.length} marks · candle {interval}m (set on a chart)</span>
            <button className="pl-save" onClick={() => void save()}>{chartId ? 'Update' : 'Save'}</button>
          </div>
          <div className="pl-charts" style={{ gridTemplateColumns: maximizedPane == null ? `repeat(${panes.length}, minmax(0, 1fr))` : '1fr' }}>
            {panes.map(pane => <div className="pl-pane" key={`${loaded.symbol}-${loaded.date}-${pane.key}-${pane.strike ?? ''}`} hidden={maximizedPane != null && maximizedPane !== pane.id}>
              {pane.id != null && <div className="pl-pane-tools">
                <button onClick={() => setMaximizedPane(prev => prev === pane.id ? null : pane.id)} title="Maximize or restore">{maximizedPane === pane.id ? '⤡' : '⤢'}</button>
                <button onClick={() => removePane(pane.id!)} title="Remove this pane" aria-label={`Remove ${pane.title}`}>✕</button>
              </div>}
              <DesktopAnalysisChart
                symbol={loaded.symbol} date={loaded.date} title={`${pane.title} · ${marks(pane.instrument)} marks`}
                strike={pane.strike} right={pane.right} expiry={pane.right ? loaded.expiry ?? undefined : undefined}
                historicalDays={settings.historicalDays}
                annotations={annotations.filter(a => a.instrument === pane.instrument)} activeStrategy={effectiveStrategy || null} activeCategory={effectiveCategory || null}
                topPatterns={topPatterns} riskRewardRatios={riskReward}
                pickMode={tool.instrument === pane.instrument} onPick={pick} pickHint={`${tool.label} — click a candle (click the same candle again to remove)`}
              />
            </div>)}
          </div>
          <label className="pl-notes">Notes <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="What made this setup work or fail?" /></label>
        </>}
      </>}
      {view === 'deepdive' && <DeepDive host={deepDiveHost} />}
      {view === 'traded' && <TradedPatterns host={tradedHost} />}
      {view === 'practice' && onStartPractice && <Practice host={practiceHost} />}
      {view === 'view' && <div className="pl-gallery">
        <div className="pl-bar">
          <label>Strategy <select value={filterStrategy} onChange={e => setFilterStrategy(e.target.value)}><option value="">All</option>{strategies.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>Category <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}><option value="">All</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
          <label><input type="checkbox" checked={topOnly} onChange={e => setTopOnly(e.target.checked)} /> Top patterns only</label>
          {selected.size > 0 && (confirmBulk
            ? <><button className="pl-danger" onClick={() => void bulkDelete()}>Confirm delete {selected.size}</button><button onClick={() => setConfirmBulk(false)}>Cancel</button></>
            : <button onClick={() => setConfirmBulk(true)}>Delete selected ({selected.size})</button>)}
        </div>
        {message && <p className={message.kind === 'error' ? 'pl-error' : 'pl-ok'}>{message.text}</p>}
        {gallery.length === 0 ? <p className="pl-muted">No saved charts match.</p> : <table>
          <thead><tr><th><input type="checkbox" aria-label="Select all" checked={deletable.length > 0 && deletable.every(c => selected.has(c.chart_id))} onChange={e => { setConfirmBulk(false); setSelected(e.target.checked ? new Set(deletable.map(c => c.chart_id)) : new Set()) }} /></th><th>Date</th><th>Symbol</th><th>Type</th><th>Strikes</th><th>Strategies</th><th>Categories</th><th>▲</th><th>▼</th><th /></tr></thead>
          <tbody>{gallery.map(chart => { const strikes = chart.instrument_type === 'options' ? strikesOf(chart) : null; return <tr key={chart.chart_id}>
            <td>{chart.can_delete !== false && <input type="checkbox" aria-label={`Select ${chart.date} ${chart.symbol}`} checked={selected.has(chart.chart_id)} onChange={e => { setConfirmBulk(false); setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(chart.chart_id); else next.delete(chart.chart_id); return next }) }} />}</td><td>{chart.date}</td><td>{chart.symbol}</td><td>{chart.instrument_type}</td>
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
