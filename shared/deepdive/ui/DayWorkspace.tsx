import { useMemo, useRef, useState } from 'react'
import { toggleAnnotation } from '../marking'
import { formatDay, optionRight, setupTimings, sideLabel, STRENGTHS, strengthLabel, strikeLabel } from '../model'
import type { DeepDiveTag, DiveSetup, SetupFields, Strength, TagValue } from '../types'
import DayIntervalBridge from './DayIntervalBridge'
import { useDeepDiveHost } from './host'
import TagPanel from './TagPanel'
import { markCount, optionEligible, strikeForSide, strikeModeFor, toolsFor } from './inDepthModel'
import { useDayStrikes } from './useDayStrikes'
import { useFillWindow } from './useFillWindow'
import ChartFrame, { useMaximizedChart } from './ChartFrame'

interface Props {
  setup: DiveSetup
  setups: DiveSetup[]
  tags: DeepDiveTag[]
  category: string
  strategy: string
  canEdit: boolean
  /** Change the day on screen at once and save it in the background. */
  change: (patch: Partial<DiveSetup>, fields?: SetupFields) => void
  markTags: (values: Record<string, TagValue | null>) => void
  addTag: (name: string) => Promise<DeepDiveTag>
  renameTag: (tagId: string, name: string) => Promise<void>
  archiveTag: (tagId: string) => void
  restoreTag: (tagId: string) => void
}

/**
 * One marked day: the underlying chart and the option chart of its side (a Buy setup is traded on the CE, a Sell setup on the
 * PE) with the setup's mark tools, and beside them the outcome, the tags and the notes. Mount it with a key per day.
 */
export default function DayWorkspace(props: Props) {
  const { setup, setups, tags, category, strategy, canEdit, change, markTags, addTag, renameTag, archiveTag, restoreTag } = props
  const right = optionRight(setup.side)
  const { settings, Chart } = useDeepDiveHost()
  const strikes = useDayStrikes(setup, canEdit, fields => change({ ...fields } as Partial<DiveSetup>, fields))
  const hasOptionChart = optionEligible(setup.symbol) && strikes.state === 'ready'
  const tools = useMemo(() => toolsFor(setup.side, hasOptionChart), [setup.side, hasOptionChart])
  const [toolKey, setToolKey] = useState('entry-underlying')
  const tool = tools.find(t => t.key === toolKey) ?? tools[0]
  const [offset, setOffset] = useState(0)

  const pick = (point: { time: number; price: number }) => {
    if (!canEdit || !tool) return
    const annotations = toggleAnnotation(setup.annotations, tool, point.time, point.price, strategy, category, crypto.randomUUID())
    change({ annotations }, { annotations })
  }
  const undo = () => { const annotations = setup.annotations.slice(0, -1); change({ annotations }, { annotations }) }
  const clear = () => change({ annotations: [] }, { annotations: [] })
  // One choice per day: Ideal, Average or Poor (each a success) or Failed; the same choice again clears it. The server drops a grade with a failure.
  const choose = (choice: Strength | 'failed' | 'success') => {
    if (choice === 'failed') return setup.outcome === 'failed' ? change({ outcome: null, strength: null }, { outcome: null }) : change({ outcome: 'failed', strength: null }, { outcome: 'failed' })
    if (choice === 'success' || setup.strength === choice) return change({ outcome: null, strength: null }, { outcome: null }) // an old, ungraded success is cleared by its own button
    change({ outcome: 'success', strength: choice }, { outcome: 'success', strength: choice })
  }
  const times = setupTimings(setup.annotations)
  const strikeText = strikes.state === 'ready' ? `${right} ${strikeForSide(setup.side, strikes)}` : ''

  const area = useRef<HTMLDivElement>(null)
  const { maximized, toggle } = useMaximizedChart<'underlying' | 'option'>('in-depth', optionEligible(setup.symbol) ? ['underlying', 'option'] : ['underlying'])
  useFillWindow(area, { minHeight: 640 })

  return <div className="dd-day" ref={area}>
    <DayIntervalBridge interval={setup.interval_minutes} onUserChange={canEdit ? minutes => change({ interval_minutes: minutes }, { interval_minutes: minutes }) : undefined} />
    <div className="dd-day-main">
      {canEdit && <div className="pl-bar">
        <span className="pl-muted">Mark:</span>
        {tools.map(t => <button key={t.key} aria-pressed={tool?.key === t.key} className={`pl-tool ${t.type}`} onClick={() => setToolKey(t.key)}>{t.label}</button>)}
        <button onClick={undo} disabled={!setup.annotations.length}>Undo</button>
        <button onClick={clear} disabled={!setup.annotations.length}>Clear marks</button>
        <span className="pl-muted">{setup.annotations.length} marks · candle {setup.interval_minutes}m (set on a chart)</span>
      </div>}
      <div className="dd-charts">
        <ChartFrame className="dd-chartbox" label={setup.symbol} isMaximized={maximized === 'underlying'} isHidden={maximized === 'option'} onToggle={() => toggle('underlying')}>
          <Chart key={`${setup.symbol}-${setup.date}-ul`} symbol={setup.symbol} date={setup.date}
            title={`${setup.symbol} · ${formatDay(setup.date)} · ${markCount(setup, 'underlying')} marks`} historicalDays={settings.historicalDays}
            annotations={setup.annotations.filter(a => a.instrument === 'underlying')} activeStrategy={strategy} activeCategory={category}
            pickMode={canEdit && tool?.instrument === 'underlying'} onPick={pick} pickHint={`${tool?.label ?? ''} — click a candle`} />
        </ChartFrame>
        {optionEligible(setup.symbol) && <ChartFrame className="dd-chartbox" label={strikeText || `${right} chart`} isMaximized={maximized === 'option'} isHidden={maximized === 'underlying'} onToggle={() => toggle('option')}>
          {strikes.state === 'ready'
            ? <Chart key={`${setup.symbol}-${setup.date}-${right}-${strikeForSide(setup.side, strikes)}`} symbol={setup.symbol} date={setup.date}
              title={`${strikeText} · ${markCount(setup, right)} marks`} strike={strikeForSide(setup.side, strikes)} right={right} expiry={strikes.expiry}
              historicalDays={settings.historicalDays} annotations={setup.annotations.filter(a => a.instrument === right)}
              activeStrategy={strategy} activeCategory={category} pickMode={canEdit && tool?.instrument === right} onPick={pick}
              pickHint={`${tool?.label ?? ''} — click a candle`} />
            : strikes.state === 'error'
              ? <p className="pl-error" role="alert">Could not pick the {right} strike: {strikes.error}</p>
              : <p className="pl-muted dd-empty">Picking the {right} strike…</p>}
        </ChartFrame>}
      </div>
      {optionEligible(setup.symbol) && strikes.state === 'ready' && <div className="pl-bar">
        <span className="pl-muted">{sideLabel(setup.side)} setup → {strikeText} (CE {strikes.ce} / PE {strikes.pe}{setup.strike_mode ? `, ${strikeLabel(setup.strike_mode)}` : ''})</span>
        {canEdit && <>
          {strikeModeFor(setup.symbol, settings) === 'otm' && <label className="pl-muted">OTM <input type="number" value={offset} onChange={e => setOffset(Number(e.target.value) || 0)} style={{ width: 56 }} aria-label="OTM offset in strikes" /></label>}
          <button onClick={() => void strikes.repick(offset)} title="Pick the strikes again from the account's strike setting">Pick strikes again</button>
        </>}
      </div>}
    </div>
    <aside className="dd-day-side">
      <div className="dd-outcome">
        <h4>Outcome</h4>
        <div className="pl-bar" role="group" aria-label="How this setup turned out">
          {STRENGTHS.map(grade => <button key={grade} aria-pressed={setup.outcome === 'success' && setup.strength === grade} disabled={!canEdit}
            className={`dd-success dd-grade-${grade}`} title={`A success: ${grade}`} onClick={() => choose(grade)}>{strengthLabel(grade)}</button>)}
          {setup.outcome === 'success' && !setup.strength && <button aria-pressed disabled={!canEdit} className="dd-success" title="Marked a success before grades existed: pick Ideal, Average or Poor, or click to clear" onClick={() => choose('success')}>Success (not graded)</button>}
          <button aria-pressed={setup.outcome === 'failed'} disabled={!canEdit} className="dd-failed" onClick={() => choose('failed')}>Failed</button>
        </div>
        <p className="pl-muted dd-times" aria-label="Entry and exit times from the marks">
          {times.entry || times.exit
            ? <>Entry {times.entry ? times.entry.clock : '—'} · Exit {times.exit ? times.exit.clock : '—'} <span title="From the Entry and Exit marks on the charts (the start of the candle, IST)">(from the marks)</span></>
            : 'Mark an Entry and an Exit on the chart to record their times.'}
        </p>
      </div>
      <TagPanel tags={tags} setups={setups} setup={setup} canEdit={canEdit} onMark={markTags} onAdd={addTag} onRename={renameTag} onArchive={archiveTag} onRestore={restoreTag} />
      <label className="pl-notes">Notes
        <textarea rows={3} key={`${setup.date}-${setup.side}`} defaultValue={setup.notes} disabled={!canEdit} placeholder="What made this setup work or fail?"
          onBlur={e => { if (e.target.value !== setup.notes) change({ notes: e.target.value }, { notes: e.target.value }) }} />
      </label>
    </aside>
  </div>
}
