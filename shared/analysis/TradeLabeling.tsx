import { useAnalysisApi, useAnalysisEnvironment } from './environment'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisTrade, BehaviorQuestion, TradeLabel } from './api'
import BehaviorManagerModal from './behavior/BehaviorManagerModal'
import { questionIdsByTrip } from './behavior/model'
import { readableError } from './behavior/types'
import LabelChartPanes from './labeling/LabelChartPanes'
import OneByOneLabeling from './labeling/OneByOneLabeling'
import RoundTripLabelForm from './labeling/RoundTripLabelForm'
import { combineSaverStates, LabelSaver, MarkSaver, type MarkEdit, type SaverState } from './labeling/saver'
import {
  blankLabel, finalizeLabel, labelKey, legsText, money, orderRoundTrips, roundTripMarkerText, tradesForRoundTrip, tripKey,
  type LabelView, type LabeledRoundTrip,
} from './labeling/model'
import './labeling/labeling.css'

interface TradeLabelingProps {
  readOnly?: boolean
  symbol: string
  date: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
}

const RT_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f0883e', '#bc8cff', '#f85149', '#79c0ff', '#a371f7', '#f778ba', '#7ee787']
const IDLE: SaverState = { pending: 0, saving: false, error: '', savedCount: 0 }
const NO_MARKS: ReadonlySet<string> = new Set()

export default function TradeLabeling({ readOnly=false, symbol, date, sessionIds, allTrades, historicalDays }: TradeLabelingProps) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const [dirtyAll, setDirtyAll] = useState(false)
  const edits = useRef(0)
  const sessionKey = sessionIds.join('|')
  const notifyDirty = environment.onDirtyChange
  const notifySaving = environment.onLabelSavingChange

  const [roundTrips, setRoundTrips] = useState<LabeledRoundTrip[]>([])
  const [labels, setLabels] = useState<Map<string, TradeLabel>>(new Map())
  const labelsRef = useRef(labels)
  const [strategies, setStrategies] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [entryTags, setEntryTags] = useState<string[]>([])
  const [exitTags, setExitTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  // One at a time (default) auto-saves the edited trade; All together keeps the explicit Save button.
  const [view, setView] = useState<LabelView>(environment.labelView ?? 'one_by_one')
  useEffect(() => { if (environment.labelView) setView(environment.labelView) }, [environment.labelView])
  const [index, setIndex] = useState(0)
  const [navBusy, setNavBusy] = useState(false)
  const [showAllMarkers, setShowAllMarkers] = useState(false)
  const [saverState, setSaverState] = useState<SaverState>(IDLE)
  const saveRef = useRef<(rows: TradeLabel[]) => Promise<unknown>>(async () => undefined)
  const saver = useMemo(() => new LabelSaver(rows => saveRef.current(rows), setSaverState), [])
  const envRef = useRef(environment)
  envRef.current = environment

  // Behavior questions (Phase 23): yes/no marks per trade, saved on their own (always automatically).
  const [questions, setQuestions] = useState<BehaviorQuestion[]>([])
  const [marks, setMarks] = useState<Map<string, Set<string>>>(new Map())
  const marksRef = useRef(marks)
  const [behaviorError, setBehaviorError] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [markState, setMarkState] = useState<SaverState>(IDLE)
  const saveMarksRef = useRef<(edits: MarkEdit[]) => Promise<unknown>>(async () => undefined)
  const markSaver = useMemo(() => new MarkSaver(edits => saveMarksRef.current(edits), setMarkState), [])
  saveMarksRef.current = async edits => { for (const edit of edits) await api.saveBehaviorMarks(edit.session_id, edit.round_trip_index, edit.answers) }
  const flushAll = useCallback(async () => (await Promise.all([saver.flush(), markSaver.flush()])).every(Boolean), [saver, markSaver])
  const reloadQuestions = useCallback(async () => {
    try { const rows = await api.getBehaviorQuestions(true); setQuestions(Array.isArray(rows) ? rows : []); setBehaviorError('') }
    catch (error) { setBehaviorError(readableError(error)) }
  }, [api])

  const refreshTags = useCallback(async () => {
    const [et, xt] = await Promise.all([api.getEntryTags(), api.getExitTags()])
    setEntryTags(et); setExitTags(xt)
  }, [api])
  saveRef.current = async rows => {
    await api.saveLabels(rows)
    // A tag typed for the first time joins the suggestion lists.
    if (rows.some(row => !entryTags.includes(row.entry_tag) || !exitTags.includes(row.exit_tag))) await refreshTags().catch(() => undefined)
  }

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
      setRoundTrips(orderRoundTrips(tripPages.flatMap((rows, i) => rows.map(rt => ({ ...rt, session_id: sessionIds[i] }))), sessionIds))
      const loaded = new Map(labelPages.flat().map(label => [labelKey(label.session_id, label.round_trip_index), label]))
      labelsRef.current = loaded; setLabels(loaded)
      setStrategies(strats.strategies); setCategories(cats.categories); setEntryTags(etags); setExitTags(xtags)
      setDirtyAll(false); setIndex(0); saver.reset(); markSaver.reset()
      // Behavior data failing must not hide the labels: the checklists just stay unavailable.
      const [behaviorQuestions, markPages] = await Promise.all([
        api.getBehaviorQuestions(true).then(rows => ({ rows }), error => ({ error })),
        Promise.all(sessionIds.map(id => api.getBehaviorMarks(id).then(rows => ({ id, rows }), error => ({ id, error })))),
      ])
      if (cancelled) return
      const failed = 'error' in behaviorQuestions ? behaviorQuestions.error : markPages.map(page => 'error' in page ? page.error : null).find(Boolean)
      setBehaviorError(failed ? readableError(failed) : '')
      setQuestions('rows' in behaviorQuestions && Array.isArray(behaviorQuestions.rows) ? behaviorQuestions.rows : [])
      const loadedMarks = new Map<string, Set<string>>()
      for (const page of markPages) if ('rows' in page && Array.isArray(page.rows)) for (const [key, ids] of questionIdsByTrip(page.rows, page.id)) loadedMarks.set(key, ids)
      marksRef.current = loadedMarks; setMarks(loadedMarks)
    }
    void load().catch(error => { if (!cancelled) setLoadError(String(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, sessionKey, retry, saver, markSaver])

  // Leaving Label Trades (tab change, close) saves whatever is still pending, then tells Stats the data changed.
  useEffect(() => () => {
    void flushAll().then(() => { if (saver.snapshot().savedCount > 0 || markSaver.snapshot().savedCount > 0) envRef.current.onDataChanged?.() })
  }, [saver, markSaver, flushAll])

  const markPending = markState.pending > 0 || markState.saving
  const dirty = view === 'all' ? dirtyAll || markPending : saverState.pending > 0 || saverState.saving || markPending
  const busySaving = (view === 'all' ? saving : saverState.saving) || markState.saving
  const combinedState = useMemo(() => combineSaverStates(saverState, markState), [saverState, markState])
  useEffect(() => { notifySaving?.(busySaving); return () => notifySaving?.(false) }, [busySaving, notifySaving])
  useEffect(() => { notifyDirty?.(dirty); return () => notifyDirty?.(false) }, [dirty, notifyDirty])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  const editLabel = useCallback((rt: LabeledRoundTrip, patch: Partial<TradeLabel>) => {
    if (readOnly || loading || loadError || (view === 'all' && saving)) return
    const key = tripKey(rt)
    const next = { ...(labelsRef.current.get(key) ?? blankLabel(rt.session_id, rt.index)), ...patch }
    const map = new Map(labelsRef.current); map.set(key, next)
    labelsRef.current = map; setLabels(map)
    if (view === 'one_by_one') saver.edit(next)
    else { edits.current++; setDirtyAll(true); setSaveMsg(null) }
  }, [readOnly, loading, loadError, view, saving, saver])

  const toggleMark = useCallback((rt: LabeledRoundTrip, questionId: string, showed: boolean) => {
    if (readOnly || loading || loadError) return
    const key = tripKey(rt)
    const ids = new Set(marksRef.current.get(key))
    if (showed) ids.add(questionId); else ids.delete(questionId)
    const map = new Map(marksRef.current); map.set(key, ids)
    marksRef.current = map; setMarks(map)
    markSaver.edit({ session_id: rt.session_id, round_trip_index: rt.index, answers: { [questionId]: showed } })
  }, [readOnly, loading, loadError, markSaver])

  const handleSave = useCallback(async () => {
    const revision = edits.current
    setSaving(true)
    setSaveMsg(null)
    try {
      const labelData: TradeLabel[] = []
      for (const rt of roundTrips) {
        const label = labelsRef.current.get(tripKey(rt))
        if (label) labelData.push(finalizeLabel(label))
      }
      await api.saveLabels(labelData)
      if (revision === edits.current) setDirtyAll(false)
      setSaveMsg('Saved!')
      environment.onDataChanged?.()
      await refreshTags()
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [roundTrips, api, environment.onDataChanged, refreshTags])

  // Persisted immediately: the name joins the user's registry and shows up in every dropdown, including the Pattern Library.
  const addName = useCallback(async (kind: 'category' | 'strategy', name: string) => {
    if (kind === 'category') setCategories((await api.patternAddCategory(name)).categories)
    else setStrategies((await api.patternAddStrategy(name)).strategies)
    return name.trim()
  }, [api])

  const go = useCallback(async (to: number) => {
    if (to < 0 || to >= roundTrips.length || to === index || navBusy) return
    setNavBusy(true)
    const saved = await flushAll()
    setNavBusy(false)
    if (saved) setIndex(to)
  }, [roundTrips.length, index, navBusy, flushAll])

  const switchView = useCallback(async (next: LabelView) => {
    if (next === view) return
    if (view === 'one_by_one') { if (!(await flushAll())) return }
    else if (dirtyAll) return
    setView(next)
    void Promise.resolve(environment.onLabelViewChange?.(next)).catch(() => undefined)
  }, [view, dirtyAll, flushAll, environment])

  const displayedCategories = useMemo(() => [...new Set([...categories, ...[...labels.values()].flatMap(label => [label.expected_category, label.actual_category]).filter(Boolean)])].sort(), [categories, labels])
  const displayedStrategies = useMemo(() => [...new Set([...strategies, ...[...labels.values()].flatMap(label => [label.expected_strategy, label.actual_strategy]).filter(Boolean)])].sort(), [strategies, labels])

  const current = view === 'one_by_one' ? roundTrips[index] : undefined
  const getMarkerText = useCallback((trade: AnalysisTrade) => roundTripMarkerText(roundTrips, trade), [roundTrips])
  // Centre the charts on the viewed trade's entry.
  const focusTime = current?.entry_trades[0]?.timestamp ?? current?.exit_trades[0]?.timestamp
  // One at a time: the chart shows only the viewed trade's executions (unless "All markers" is on).
  const chartTrades = useMemo(() => {
    if (!current || showAllMarkers) return allTrades
    const own = tradesForRoundTrip(current, allTrades)
    return own.length ? own : allTrades
  }, [current, showAllMarkers, allTrades])

  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!maximized) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximized])

  const blankFor = (rt: LabeledRoundTrip) => labels.get(tripKey(rt)) ?? blankLabel(rt.session_id, rt.index)
  const formFor = (rt: LabeledRoundTrip) => (
    <RoundTripLabelForm idPrefix={tripKey(rt)} label={blankFor(rt)} disabled={readOnly || (view === 'all' && saving)}
      categories={displayedCategories} strategies={displayedStrategies} entryTags={entryTags} exitTags={exitTags}
      onChange={patch => editLabel(rt, patch)} onCreateName={addName}
      behavior={behaviorError ? undefined : { questions, marked: marks.get(tripKey(rt)) ?? NO_MARKS, disabled: readOnly, onToggle: (id, showed) => toggleMark(rt, id, showed) }} />
  )

  const modeSwitch = (
    <div className="tl-mode" role="group" aria-label="Label view">
      <button type="button" aria-pressed={view === 'one_by_one'} disabled={view === 'all' && dirtyAll} title={view === 'all' && dirtyAll ? 'Save labels before switching' : undefined} onClick={() => void switchView('one_by_one')}>One at a time</button>
      <button type="button" aria-pressed={view === 'all'} onClick={() => void switchView('all')}>All together</button>
    </div>
  )
  const maximizeButton = (
    <button type="button" className="tl-ghost" onClick={() => setMaximized(!maximized)} aria-pressed={maximized}
      aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore (Esc): one chart with a switcher' : 'Maximize: larger view, Underlying and strike charts stacked'}>{maximized ? '⤡ Restore' : '⤢ Maximize'}</button>
  )

  const LabelCharts = environment.charts?.LabelCharts
  const sessionGroups = new Map<string, LabeledRoundTrip[]>()
  for (const rt of roundTrips) sessionGroups.set(rt.session_id, [...(sessionGroups.get(rt.session_id) ?? []), rt])

  const content = (
    <div className={`tl-root tl-layout ${maximized ? 'maximized' : ''}`}>
      {/* Chart */}
      <div className="label-chart-container tl-chart-col">
        {LabelCharts
          ? <LabelCharts symbol={symbol} date={date} allTrades={chartTrades} historicalDays={historicalDays} getMarkerText={getMarkerText} focusTime={focusTime} labelContractMarkers layout={maximized ? 'split' : 'single'} />
          : <LabelChartPanes symbol={symbol} date={date} trades={chartTrades} historicalDays={historicalDays} getMarkerText={getMarkerText} focusTime={focusTime} maximized={maximized} />}
      </div>

      {/* Round-trip forms */}
      <div className="tl-side-col">
        {behaviorError && <p role="note" className="tl-status">Behavior questions unavailable: {behaviorError}</p>}
        {view === 'one_by_one' ? (
          <OneByOneLabeling
            trips={roundTrips} index={Math.min(index, Math.max(roundTrips.length - 1, 0))} sessionCount={sessionGroups.size} labels={labels}
            busy={navBusy} readOnly={readOnly} save={combinedState} active={environment.active !== false}
            onGo={to => void go(to)} onRetry={() => void flushAll()}
            controls={<>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Show every trade's markers on the chart, not just this trade's">
                <input type="checkbox" checked={showAllMarkers} onChange={event => setShowAllMarkers(event.target.checked)} /> All markers
              </label>
              <button type="button" className="tl-ghost" onClick={() => setManageOpen(true)}>Manage questions</button>
              {modeSwitch}{maximizeButton}
            </>}
          >
            {roundTrips[index] && formFor(roundTrips[index])}
          </OneByOneLabeling>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#8b949e' }}>
                {roundTrips.length} round trip{roundTrips.length !== 1 ? 's' : ''}
              </span>
              <div style={{ flex: 1 }} />
              <button type="button" className="tl-ghost" onClick={() => setManageOpen(true)}>Manage questions</button>
              {modeSwitch}{maximizeButton}
              {readOnly && <span>Shared history · read only</span>}
              {dirtyAll && <span>Unsaved labels</span>}
              {markState.error && <span role="alert" style={{ fontSize: 12, color: '#f85149' }}>{markState.error} <button type="button" className="tl-ghost" onClick={() => void flushAll()}>Retry</button></span>}
              {saveMsg && (
                <span role={saveMsg.startsWith('Saved') ? 'status' : 'alert'} style={{ fontSize: 12, color: saveMsg.startsWith('Saved') ? '#3fb950' : '#f85149' }}>
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
                    fontSize: 11, color: '#6e7681', fontWeight: 700,
                    padding: '4px 0', borderTop: gi > 0 ? '1px dashed #21262d' : undefined,
                    marginTop: gi > 0 ? 4 : 0,
                  }}>
                    Session {gi + 1}
                  </div>
                )}
                {rts.map(rt => {
                  const pnlColor = rt.pnl > 0 ? '#26a641' : rt.pnl < 0 ? '#f85149' : '#8b949e'
                  return (
                    <div key={tripKey(rt)} className="tl-card">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span className="tl-dot" style={{ background: RT_COLORS[rt.index % RT_COLORS.length] }} />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>RT#{rt.index} — {rt.right || 'EQ'}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor }}>{money(rt.pnl)}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--tl-muted, #8b949e)', marginBottom: 8, lineHeight: 1.5 }}>
                        <span style={{ color: 'var(--tl-text, #e6edf3)' }}>{legsText(rt.entry_trades, 'B')}</span>
                        {' → '}
                        <span style={{ color: 'var(--tl-text, #e6edf3)' }}>{legsText(rt.exit_trades, 'S')}</span>
                      </div>
                      {formFor(rt)}
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </div>
      {manageOpen && <BehaviorManagerModal api={api} onClose={() => setManageOpen(false)} onChanged={() => void reloadQuestions()} />}
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
