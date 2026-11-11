import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisTrade } from '../api'
import { useAnalysisApi, useAnalysisEnvironment } from '../environment'
import type { PerformanceCycle } from '../performance'
import { orderRoundTripsByEntry, tripKey, type LabeledRoundTrip } from '../labeling/model'
import OneByOneLabeling from '../labeling/OneByOneLabeling'
import RoundTripSplitLayout from '../labeling/RoundTripSplitLayout'
import { useMaximized, useRoundTripView } from '../labeling/useRoundTripView'
import CompareDays from './CompareDays'
import type { WhatIfChartExtras } from './chartExtras'
import type { WhatIfScenario } from './scenarios'
import WhatIfPanel from './WhatIfPanel'
import { buildWhatIfTrips, dayBrokerage, evaluateDay, fromSavedEdits, summaryOf, toSavedEdits, whatIfMarkers, type DayEdits, type LegEdit } from './whatIfModel'

const NO_LABELS = new Map()
const IDLE = { pending: 0, saving: false, error: '', savedCount: 0 }
const noop = () => undefined
const NAME_MAX = 60

/** The scenario id the server derives from a name (whatif_service.scenario_slug). */
export const scenarioSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '')

interface Status { text: string; kind: 'ok' | 'bad' | '' }

/**
 * What If: Label Trades' layout with the day editable. Charts on the left; on the right the day and the viewed trade, actual
 * against what-if, and that trade's fills (price and quantity to change, price also by clicking the chart). A what-if can be
 * saved under a name for the day, loaded again later, reverted, deleted, and compared across days. Nothing here touches a trade.
 */
export default function TradeWhatIf({ symbol, date, sessionIds, allTrades, historicalDays, cycles, capitals, sessionTypes, readOnly = false, compact = false, onPickingChange }: {
  symbol: string
  date: string
  sessionIds: string[]
  allTrades: AnalysisTrade[]
  historicalDays: number
  cycles: PerformanceCycle[]
  capitals: Map<string, number>
  sessionTypes: Map<string, string>
  /** Shared history: edits work as a playground, but nothing can be saved. */
  readOnly?: boolean
  /** A phone: the saved what-ifs bar starts collapsed to one line so the fills get the height. */
  compact?: boolean
  /** Told when a price is being picked on the chart (so a host's Back button can cancel the pick first). */
  onPickingChange?: (picking: boolean) => void
}) {
  const api = useAnalysisApi()
  const environment = useAnalysisEnvironment()
  const source = environment.whatIf
  const [trips, setTrips] = useState<LabeledRoundTrip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [index, setIndex] = useState(0)
  const [showAllMarkers, setShowAllMarkers] = useState(false)
  const [maximized, setMaximized] = useMaximized()
  const sessionKey = sessionIds.join('|')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    void Promise.all(sessionIds.map(id => api.getRoundTrips(id)))
      .then(pages => {
        if (cancelled) return
        setTrips(orderRoundTripsByEntry(pages.flatMap((rows, i) => rows.map(rt => ({ ...rt, session_id: sessionIds[i] }))), sessionIds))
        setIndex(0)
      })
      .catch(cause => { if (!cancelled) setError(String(cause)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionKey, retry])

  const whatIfTrips = useMemo(() => buildWhatIfTrips(trips, cycles, sessionTypes), [trips, cycles, sessionTypes])
  const brokerage = useMemo(() => dayBrokerage(whatIfTrips), [whatIfTrips])
  const [edits, setEdits] = useState<DayEdits>(new Map())
  const evaluation = useMemo(() => evaluateDay(whatIfTrips, edits, capitals, brokerage), [whatIfTrips, edits, capitals, brokerage])
  const current = trips[index]
  const currentKey = current ? tripKey(current) : ''
  const result = evaluation.results.get(currentKey)
  const { getMarkerText, focusTime, chartTrades } = useRoundTripView(trips, current, allTrades, showAllMarkers)

  // ── saved what-ifs ──
  const [saved, setSaved] = useState<Record<string, WhatIfScenario[]>>({})
  const [savedLoaded, setSavedLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>({ text: '', kind: '' })
  const [busy, setBusy] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const snapshotOf = useCallback((value: DayEdits) => JSON.stringify(sessionIds.map(id => toSavedEdits(whatIfTrips, value, id))), [sessionIds, whatIfTrips])
  const [snapshot, setSnapshot] = useState(() => JSON.stringify(sessionIds.map(() => [])))
  const dirty = snapshotOf(edits) !== snapshot

  const reloadSaved = useCallback(async () => {
    if (!source) return {}
    const pages = await Promise.all(sessionIds.map(id => source.list(id).catch(() => [] as WhatIfScenario[])))
    const next = Object.fromEntries(sessionIds.map((id, i) => [id, pages[i]]))
    setSaved(next)
    return next
  }, [source, sessionIds])

  const apply = useCallback((id: string, from: Record<string, WhatIfScenario[]>) => {
    const merged: DayEdits = new Map()
    let missing = 0, label = id
    for (const sessionId of sessionIds) {
      const row = from[sessionId]?.find(item => item.scenario_id === id)
      if (!row) continue
      label = row.name
      const loaded = fromSavedEdits(whatIfTrips, row.edits ?? [], sessionId)
      missing += loaded.missing
      for (const [key, tripEdits] of loaded.edits) merged.set(key, tripEdits)
    }
    setEdits(merged); setSnapshot(snapshotOf(merged)); setSelectedId(id); setName(label); setPicking(null)
    setStatus(missing ? { text: `${missing} edited ${missing === 1 ? 'leg' : 'legs'} could not be applied: not in this day any more.`, kind: 'bad' } : { text: `Showing “${label}”.`, kind: 'ok' })
  }, [sessionIds, whatIfTrips, snapshotOf])

  // Load the day's saved what-ifs once; the most recently saved one is shown, so a refresh does not lose the work.
  const bootstrapped = useRef(false)
  useEffect(() => { bootstrapped.current = false; setSavedLoaded(false); setSelectedId(''); setName(''); setEdits(new Map()) }, [sessionKey])
  useEffect(() => {
    if (!source || loading || bootstrapped.current) return
    bootstrapped.current = true
    void reloadSaved().then(next => {
      setSavedLoaded(true)
      const all = Object.values(next).flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      if (all.length && whatIfTrips.length) apply(all[0].scenario_id, next)
    }).catch(cause => { setSavedLoaded(true); setStatus({ text: cause instanceof Error ? cause.message : String(cause), kind: 'bad' }) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, loading, whatIfTrips])

  const names = useMemo(() => {
    const byId = new Map<string, string>()
    for (const rows of Object.values(saved)) for (const row of rows) byId.set(row.scenario_id, row.name)
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [saved])

  const confirmLeave = () => !dirty || window.confirm('Discard the unsaved what-if changes?')
  const reset = () => { setEdits(new Map()); setSnapshot(snapshotOf(new Map())); setSelectedId(''); setName(''); setPicking(null); setStatus({ text: 'Back to the real day.', kind: '' }) }
  const select = (id: string) => { if (id === selectedId || !confirmLeave()) return; if (!id) reset(); else apply(id, saved) }

  const save = async () => {
    if (!source || readOnly) return
    const cleaned = name.replace(/\s+/g, ' ').trim()
    const id = scenarioSlug(cleaned)
    if (!cleaned || !id) { setStatus({ text: 'Give this what-if a name first.', kind: 'bad' }); return }
    if (cleaned.length > NAME_MAX) { setStatus({ text: `The name must be at most ${NAME_MAX} characters.`, kind: 'bad' }); return }
    if (!sessionIds.some(sid => toSavedEdits(whatIfTrips, edits, sid).length)) { setStatus({ text: 'Nothing to save yet: change a price or a quantity first.', kind: 'bad' }); return }
    setBusy(true)
    try {
      for (const sid of sessionIds) {
        const savedEdits = toSavedEdits(whatIfTrips, edits, sid)
        if (savedEdits.length) {
          const day = evaluateDay(whatIfTrips.filter(trip => trip.sessionId === sid), edits, capitals, brokerage).day
          await source.save({ sessionId: sid, name: cleaned, edits: savedEdits, summary: summaryOf(day) })
        } else if (saved[sid]?.some(row => row.scenario_id === id)) await source.remove(sid, id)
      }
      await reloadSaved()
      setSelectedId(id); setName(cleaned); setSnapshot(snapshotOf(edits))
      setStatus({ text: `Saved “${cleaned}”.`, kind: 'ok' })
    } catch (cause) { setStatus({ text: cause instanceof Error ? cause.message : String(cause), kind: 'bad' }) }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!source || readOnly || !selectedId) return
    if (!window.confirm(`Delete the saved what-if “${names.find(([id]) => id === selectedId)?.[1] ?? selectedId}”?`)) return
    setBusy(true)
    try {
      for (const sid of sessionIds) if (saved[sid]?.some(row => row.scenario_id === selectedId)) await source.remove(sid, selectedId)
      await reloadSaved()
      setEdits(new Map()); setSnapshot(snapshotOf(new Map())); setSelectedId(''); setName(''); setPicking(null)
      setStatus({ text: 'Deleted. Showing the real day.', kind: 'ok' })
    } catch (cause) { setStatus({ text: cause instanceof Error ? cause.message : String(cause), kind: 'bad' }) }
    finally { setBusy(false) }
  }

  // The host is told about unsaved edits so leaving the tab asks first.
  const notifyDirty = environment.onDirtyChange
  useEffect(() => { notifyDirty?.(dirty); return () => notifyDirty?.(false) }, [dirty, notifyDirty])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  // ── editing ──
  const [picking, setPicking] = useState<string | null>(null)
  const [barOpen, setBarOpen] = useState(!compact)
  useEffect(() => { onPickingChange?.(picking !== null); return () => onPickingChange?.(false) }, [picking, onPickingChange])
  const canPick = environment.chartPicking === true
  const setLeg = useCallback((fillKey: string, edit: LegEdit | null) => {
    if (!currentKey) return
    setEdits(previous => {
      const next = new Map(previous)
      const trip = new Map(next.get(currentKey) ?? [])
      if (edit) trip.set(fillKey, edit); else trip.delete(fillKey)
      if (trip.size) next.set(currentKey, trip); else next.delete(currentKey)
      return next
    })
  }, [currentKey])
  const resetTrip = () => { setEdits(previous => { const next = new Map(previous); next.delete(currentKey); return next }); setPicking(null) }

  const pickedLeg = picking && result ? result.legs.find(leg => `${leg.fill.role}:${leg.fill.id}` === picking) : undefined
  const chartExtras: WhatIfChartExtras = {
    pickTarget: pickedLeg && result ? (result.trip.right ? 'option' : 'underlying') : null,
    onPick: ({ price }) => { if (pickedLeg && picking) { setLeg(picking, { price, quantity: pickedLeg.quantity }); setPicking(null) } },
    onPickCancel: () => setPicking(null),
    pickHint: pickedLeg ? `Click the chart to set the ${pickedLeg.fill.role} price` : undefined,
    whatIfMarkers: result ? whatIfMarkers(result) : undefined,
  }
  const go = (to: number) => { setPicking(null); setIndex(to) }
  const sessionCount = new Set(trips.map(trip => trip.session_id)).size

  if (loading) return <p role="status">Loading round trips…</p>
  if (error) return <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>Retry</button></p>

  const maximizeButton = (
    <button type="button" className="tl-ghost" onClick={() => setMaximized(!maximized)} aria-pressed={maximized}
      aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore (Esc): one chart with a switcher' : 'Maximize: larger view, Underlying and strike charts stacked'}>{maximized ? '⤡ Restore' : '⤢ Maximize'}</button>
  )
  const scenarioBar = source ? (
    <>
    {compact && (
      <button type="button" className="wi-scn-toggle" aria-expanded={barOpen} onClick={() => setBarOpen(open => !open)}>
        What-if: {selectedId ? names.find(([id]) => id === selectedId)?.[1] ?? selectedId : 'not saved'}{dirty ? ' · unsaved' : ''} {barOpen ? '▴' : '▾'}
      </button>
    )}
    {barOpen && <div className="wi-scenarios" role="group" aria-label="Saved what-ifs">
      <select aria-label="Saved what-ifs" value={selectedId} disabled={busy || !savedLoaded} onChange={event => select(event.target.value)}>
        <option value="">{names.length ? 'New what-if…' : 'No saved what-ifs yet'}</option>
        {names.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <input aria-label="What-if name" placeholder="Name this what-if" maxLength={NAME_MAX} value={name} disabled={readOnly || busy} onChange={event => setName(event.target.value)} />
      <button type="button" className="primary" disabled={readOnly || busy || !dirty && !name.trim()} onClick={() => void save()}>Save</button>
      <button type="button" disabled={busy || (!dirty && !selectedId && edits.size === 0)} onClick={() => { if (confirmLeave()) reset() }}>Revert day</button>
      <button type="button" disabled={readOnly || busy || !selectedId} onClick={() => void remove()}>Delete</button>
      <button type="button" onClick={() => setCompareOpen(true)}>Compare days</button>
      {readOnly && <span className="wi-status">Shared history: edits are a playground and cannot be saved.</span>}
      {status.text && <span className={`wi-status ${status.kind}`} role="status">{status.text}</span>}
      {dirty && <span className="wi-status">Unsaved changes.</span>}
    </div>}
    </>
  ) : (
    <p className="wi-muted">Saving what-ifs is not available here; your edits are lost when you leave this tab.</p>
  )
  const modeNote = !canPick ? <p className="wi-muted">To set a price by clicking the chart, switch the Analysis chart to KLine in Settings; you can still type prices and quantities.</p> : null

  return (
    <>
      <RoundTripSplitLayout labelContractMarkers={false} symbol={symbol} date={date} historicalDays={historicalDays} chartTrades={chartTrades} getMarkerText={getMarkerText} focusTime={focusTime} maximized={maximized} chartExtras={chartExtras}>
        <OneByOneLabeling
          trips={trips} index={Math.min(index, Math.max(trips.length - 1, 0))} sessionCount={sessionCount} labels={NO_LABELS}
          busy={false} readOnly save={IDLE} status={null} active={environment.active !== false}
          pnlMode={environment.pnlDisplayMode} onGo={go} onRetry={noop}
          controls={<>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Show every trade's markers on the chart, not just this trade's">
              <input type="checkbox" checked={showAllMarkers} onChange={event => setShowAllMarkers(event.target.checked)} /> All markers
            </label>
            {maximizeButton}
          </>}
        >
          <WhatIfPanel result={result} day={evaluation.day} pnlMode={environment.pnlDisplayMode} canPick={canPick} picking={picking}
            onEdit={setLeg} onPick={setPicking} onResetTrip={resetTrip} header={<>{scenarioBar}{modeNote}</>} />
        </OneByOneLabeling>
      </RoundTripSplitLayout>
      {compareOpen && source && <CompareDays source={source} onClose={() => setCompareOpen(false)} />}
    </>
  )
}
