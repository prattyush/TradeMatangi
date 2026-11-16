import { useState } from 'react'
import { activeTags, restNotValid, tagState, toggleTag, tagValueOf, unmarkedDaysForTag, unmarkedTagIds, validateTagName } from '../model'
import type { DeepDiveTag, DiveSetup, TagValue } from '../types'

interface Props {
  tags: DeepDiveTag[]
  setups: DiveSetup[]
  setup: DiveSetup
  canEdit: boolean
  onMark: (values: Record<string, TagValue | null>) => void
  onAdd: (name: string) => Promise<DeepDiveTag>
  onArchive: (tagId: string) => void
  onRestore: (tagId: string) => void
}

/**
 * The day's tags. Each tag is Valid, Not valid or not marked yet (nothing selected); tapping the selected state again clears
 * it. "Mark the rest not valid" settles every tag nobody has looked at on this day in one click.
 */
export default function TagPanel({ tags, setups, setup, canEdit, onMark, onAdd, onArchive, onRestore }: Props) {
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const active = activeTags(tags)
  const archived = tags.filter(tag => tag.status === 'archived')
  const open = unmarkedTagIds(setup, tags)

  const add = async () => {
    const invalid = validateTagName(draft, tags)
    if (invalid) { setProblem(invalid); return }
    setAdding(true); setProblem(null); setNote(null)
    try {
      const created = await onAdd(draft)
      setDraft('')
      const days = unmarkedDaysForTag(setups, created.tag_id)
      setNote(`Added. It is not marked on ${days} ${days === 1 ? 'day' : 'days'} yet (see "Needs marking").`)
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)) } finally { setAdding(false) }
  }

  return <div className="dd-tags">
    <h4>Tags</h4>
    {active.length === 0 && <p className="pl-muted">No tags yet. Add what you want to count on every day, for example "Second leg" or "Reversed by a double top".</p>}
    {!setup.complete && active.length > 0 && <p className="dd-banner" role="status">{open.length} {open.length === 1 ? 'tag is' : 'tags are'} not marked on this day.</p>}
    <ul className="dd-taglist">
      {active.map(tag => {
        const state = tagState(setup, tag.tag_id)
        return <li key={tag.tag_id} className={state}>
          <span className="dd-tagname">{tag.name}</span>
          <span className="dd-tagbtns">
            <button aria-pressed={state === 'valid'} disabled={!canEdit} className="valid" onClick={() => onMark({ [tag.tag_id]: tagValueOf(toggleTag(state, 'valid')) })}>Valid</button>
            <button aria-pressed={state === 'not_valid'} disabled={!canEdit} className="not-valid" onClick={() => onMark({ [tag.tag_id]: tagValueOf(toggleTag(state, 'not_valid')) })}>Not valid</button>
            {canEdit && <button className="dd-x" title="Archive this tag (its marks are kept, it stops counting)" aria-label={`Archive ${tag.name}`} onClick={() => onArchive(tag.tag_id)}>🗄</button>}
          </span>
        </li>
      })}
    </ul>
    {canEdit && open.length > 0 && <button onClick={() => onMark(restNotValid(setup, tags))}>Mark the rest not valid ({open.length})</button>}
    {canEdit && <div className="pl-bar dd-addtag">
      <input value={draft} onChange={e => { setDraft(e.target.value); setProblem(null) }} placeholder="New tag" aria-label="New tag" size={22}
        onKeyDown={e => { if (e.key === 'Enter') void add() }} />
      <button onClick={() => void add()} disabled={adding || !draft.trim()}>Add tag</button>
    </div>}
    {problem && <p className="pl-error" role="alert">{problem}</p>}
    {note && <p className="pl-muted" role="status">{note}</p>}
    {canEdit && archived.length > 0 && <details className="dd-archived">
      <summary>Archived tags ({archived.length})</summary>
      <ul>{archived.map(tag => <li key={tag.tag_id}><span>{tag.name}</span><button onClick={() => onRestore(tag.tag_id)}>Restore</button></li>)}</ul>
    </details>}
  </div>
}
