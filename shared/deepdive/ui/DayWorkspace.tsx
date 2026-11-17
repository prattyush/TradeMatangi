import { useMemo, useRef, useState } from 'react'
import { toggleAnnotation } from '../marking'
import { formatDay, optionRight, sideLabel, strikeLabel } from '../model'
import type { DeepDiveTag, DiveSetup, Outcome, SetupFields, TagValue } from '../types'
import DayIntervalBridge from './DayIntervalBridge'
import { useDeepDiveHost } from './host'
import TagPanel from './TagPanel'
import { markCount, optionEligible, strikeForSide, strikeModeFor, toolsFor } from './inDepthModel'
import { useDayStrikes } from './useDayStrikes'
import { useFillWindow } from './useFillWindow'

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
  archiveTag: (tagId: string) => void
  restoreTag: (tagId: string) => void
}

/**
 * One marked day: the underlying chart and the option chart of its side (a Buy setup is traded on the CE, a Sell setup on the
 * PE) with the setup's mark tools, and beside them the outcome, the tags and the notes. Mount it with a key per day.
 */
export default function DayWorkspace(props: Props) {
  const { setup, setups, tags, category, strategy, canEdit, change, markTags, addTag, archiveTag, restoreTag } = props
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
  const setOutcome = (outcome: Outcome | null) => change({ outcome }, { outcome })
  const strikeText = strikes.state === 'ready' ? `${right} ${strikeForSide(setup.side, strikes)}` : ''

  const area = useRef<HTMLDivElement>(null)
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
        <div className="dd-chartbox">
          <Chart key={`${setup.symbol}-${setup.date}-ul`} symbol={setup.symbol} date={setup.date}
            title={`${setup.symbol} · ${formatDay(setup.date)} · ${markCount(setup, 'underlying')} marks`} historicalDays={settings.historicalDays}
            annotations={setup.annotations.filter(a => a.instrument === 'underlying')} activeStrategy={strategy} activeCategory={category}
            pickMode={canEdit && tool?.instrument === 'underlying'} onPick={pick} pickHint={`${tool?.label ?? ''} — click a candle`} />
        </div>
        {optionEligible(setup.symbol) && <div className="dd-chartbox">
          {strikes.state === 'ready'
            ? <Chart key={`${setup.symbol}-${setup.date}-${right}-${strikeForSide(setup.side, strikes)}`} symbol={setup.symbol} date={setup.date}
              title={`${strikeText} · ${markCount(setup, right)} marks`} strike={strikeForSide(setup.side, strikes)} right={right} expiry={strikes.expiry}
              historicalDays={settings.historicalDays} annotations={setup.annotations.filter(a => a.instrument === right)}
              activeStrategy={strategy} activeCategory={category} pickMode={canEdit && tool?.instrument === right} onPick={pick}
              pickHint={`${tool?.label ?? ''} — click a candle`} />
            : strikes.state === 'error'
              ? <p className="pl-error" role="alert">Could not pick the {right} strike: {strikes.error}</p>
              : <p className="pl-muted dd-empty">Picking the {right} strike…</p>}
        </div>}
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
        <div className="pl-bar">
          <button aria-pressed={setup.outcome === 'success'} disabled={!canEdit} className="dd-success" onClick={() => setOutcome(setup.outcome === 'success' ? null : 'success')}>Success</button>
          <button aria-pressed={setup.outcome === 'failed'} disabled={!canEdit} className="dd-failed" onClick={() => setOutcome(setup.outcome === 'failed' ? null : 'failed')}>Failed</button>
        </div>
      </div>
      <TagPanel tags={tags} setups={setups} setup={setup} canEdit={canEdit} onMark={markTags} onAdd={addTag} onArchive={archiveTag} onRestore={restoreTag} />
      <label className="pl-notes">Notes
        <textarea rows={3} key={`${setup.date}-${setup.side}`} defaultValue={setup.notes} disabled={!canEdit} placeholder="What made this setup work or fail?"
          onBlur={e => { if (e.target.value !== setup.notes) change({ notes: e.target.value }, { notes: e.target.value }) }} />
      </label>
    </aside>
  </div>
}
