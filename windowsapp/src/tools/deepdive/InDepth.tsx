import { useCallback, useMemo, useState } from 'react'
import { readableError } from '../../../../shared/analysis/behavior/types'
import {
  applyTagValues, formatDay, nextGapIndex, positionLabel, stepIndex, toDiveSetup, withSetups, withTags,
} from '../../../../shared/deepdive/model'
import type { DeepDiveApi, DeepDiveTag, Dive, DiveSetup, SetupFields, TagValue } from '../../../../shared/deepdive/types'
import type { PatternsClient } from '../../patternsClient'
import type { PatternSettings } from '../usePatternsRuntime'
import DayStrip from './DayStrip'
import DayWorkspace from './DayWorkspace'
import GapsPanel from './GapsPanel'
import { fullFields } from './inDepthModel'
import { SaveQueue, type SaveState } from './saveQueue'

interface Props {
  client: PatternsClient
  api: DeepDiveApi
  dive: Dive
  setDive: (update: (dive: Dive) => Dive) => void
  settings: PatternSettings
  onGoMark: () => void
  /** A day to open on (from the results table); otherwise the first day. */
  focus?: DiveSetup | null
}

const sameDay = (a: DiveSetup, b: DiveSetup) => a.date === b.date && a.symbol === b.symbol && a.side === b.side

/**
 * Step 2 of a deep dive: walk the marked days one by one. Next and Previous always work; a day with tags nobody has marked
 * is flagged on its chip, in a banner and in the "Needs marking" list (a tag added on the 20th is open on the 11th). Every
 * change shows on screen at once and is saved in the background, in order.
 */
export default function InDepth({ client, api, dive, setDive, settings, onGoMark, focus }: Props) {
  const [index, setIndex] = useState(() => Math.max(0, dive.setups.findIndex(s => focus && sameDay(s, focus))))
  const [save, setSave] = useState<SaveState>({ status: 'idle' })
  const [failure, setFailure] = useState<string | null>(null)
  const queue = useMemo(() => new SaveQueue(setSave, readableError), [])
  const setups = dive.setups
  const canEdit = dive.can_edit
  const ref = { category: dive.category, strategy: dive.strategy }

  const patch = useCallback((target: DiveSetup, changes: Partial<DiveSetup>) =>
    setDive(current => withSetups(current, current.setups.map(s => (sameDay(s, target) ? toDiveSetup({ ...s, ...changes }, current.tags) : s)))), [setDive])

  if (!setups.length) return <div className="dd-empty-state">
    <p className="pl-muted">No days are marked yet. Mark the days this strategy occurred first.</p>
    <button className="pl-primary" onClick={onGoMark}>Mark days</button>
  </div>

  const position = stepIndex(index, 0, setups.length)
  const setup = setups[position]
  const go = (next: number) => setIndex(stepIndex(next, 0, setups.length))
  const unmarkedNext = nextGapIndex(setups, dive.tags, position)

  const change = (changes: Partial<DiveSetup>, fields?: SetupFields) => {
    patch(setup, changes)
    if (fields && canEdit) void queue.enqueue(() => api.saveSetup(setup, fields))
  }
  const markTags = (values: Record<string, TagValue | null>) => {
    if (!canEdit) return
    patch(setup, { tag_values: applyTagValues(setup, values).tag_values })
    void queue.enqueue(() => api.setTagValues(setup, values))
  }
  const addTag = async (name: string) => {
    const created = await api.addTag(ref, name)
    setDive(current => withTags(current, [...current.tags, created]))
    return created
  }
  const changeTagStatus = (tagId: string, action: 'archive' | 'restore') => {
    setFailure(null)
    const run = action === 'archive' ? api.archiveTag(ref, tagId) : api.restoreTag(ref, tagId)
    run.then(updated => setDive(current => withTags(current, current.tags.map((t: DeepDiveTag) => (t.tag_id === tagId ? updated : t)))))
      .catch(error => setFailure(readableError(error)))
  }
  const retry = () => void queue.enqueue(async () => {
    await api.saveSetup(setup, fullFields(setup))
    if (Object.keys(setup.tag_values).length) await api.setTagValues(setup, setup.tag_values)
  })

  return <div className="dd-depth">
    <div className="pl-bar dd-depth-head">
      <button onClick={() => go(position - 1)} disabled={position === 0} aria-label="Previous day">‹ Prev</button>
      <strong aria-live="polite">{positionLabel(position, setups)}</strong>
      <button onClick={() => go(position + 1)} disabled={position === setups.length - 1} aria-label="Next day">Next ›</button>
      {unmarkedNext >= 0 && unmarkedNext !== position && <button onClick={() => go(unmarkedNext)} title="Jump to the next day with tags not marked yet">Next unmarked day</button>}
      <span className={`dd-save ${save.status}`} role="status">
        {save.status === 'saving' ? 'Saving…' : save.status === 'saved' ? 'Saved' : save.status === 'error' ? '' : ''}
        {save.status === 'error' && <><span className="pl-error">Not saved: {save.message}</span> <button onClick={retry}>Retry</button></>}
      </span>
    </div>
    {!canEdit && <p className="pl-muted" role="status">This deep dive was shared with you: you can look at it but not change it.</p>}
    {failure && <p className="pl-error" role="alert">{failure}</p>}
    <DayStrip setups={setups} index={position} onSelect={go} />
    <details className="dd-gapsbox" open={dive.incomplete_days > 0}>
      <summary>Needs marking: {dive.incomplete_days} {dive.incomplete_days === 1 ? 'day' : 'days'}{dive.unmarked_total ? ` · ${dive.unmarked_total} tag marks open` : ''}</summary>
      <GapsPanel setups={setups} tags={dive.tags} onJump={go} />
    </details>
    <DayWorkspace key={`${setup.symbol}|${setup.date}|${setup.side}`} client={client} setup={setup} setups={setups} tags={dive.tags}
      category={dive.category} strategy={dive.strategy} canEdit={canEdit} settings={settings} change={change} markTags={markTags}
      addTag={addTag} archiveTag={id => changeTagStatus(id, 'archive')} restoreTag={id => changeTagStatus(id, 'restore')} />
    <p className="pl-muted dd-foot">{formatDay(setup.date)} · {setup.symbol}</p>
  </div>
}
