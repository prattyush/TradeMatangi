import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BehaviorKind, BehaviorQuestion } from '../api'
import { groupQuestions, MAX_ACTIVE_QUESTIONS, MAX_TEXT_LENGTH, validateQuestionText } from './model'
import { readableError, type BehaviorApi } from './types'
import '../labeling/labeling.css'

interface Props {
  api: BehaviorApi
  /** Called after any change, so a labeling view can reload its checklists. */
  onChanged?: () => void
}

const SECTIONS: { kind: BehaviorKind; title: string; hint: string }[] = [
  { kind: 'entry', title: 'Entry questions', hint: 'asked when you label a trade you entered' },
  { kind: 'exit', title: 'Exit questions', hint: 'asked when you label a closed trade' },
]
const archivedOn = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''

/**
 * Behavior questions: add (text + Entry/Exit), edit the text, archive and unarchive. Questions are never deleted;
 * archived ones leave every labeling form but keep their past marks in Stats.
 */
export default function BehaviorQuestionsManager({ api, onChanged }: Props) {
  const [questions, setQuestions] = useState<BehaviorQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<BehaviorKind>('entry')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [confirming, setConfirming] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try { const rows = await api.getBehaviorQuestions(true); setQuestions(Array.isArray(rows) ? rows : []) }
    catch (cause) { setLoadError(readableError(cause)) }
    finally { setLoading(false) }
  }, [api])
  useEffect(() => { void load() }, [load])

  const grouped = useMemo(() => groupQuestions(questions), [questions])
  const activeCount = grouped.entry.length + grouped.exit.length

  const run = async (id: string, action: () => Promise<BehaviorQuestion>, apply: (result: BehaviorQuestion) => void) => {
    setBusy(id); setError('')
    try { apply(await action()); onChanged?.() }
    catch (cause) { setError(readableError(cause)) }
    finally { setBusy('') }
  }
  const replace = (result: BehaviorQuestion) => setQuestions(rows => rows.map(row => row.question_id === result.question_id ? result : row))

  const add = (event: React.FormEvent) => {
    event.preventDefault()
    const invalid = validateQuestionText(draft, draftKind, questions)
    if (invalid) { setError(invalid); return }
    if (activeCount >= MAX_ACTIVE_QUESTIONS) { setError(`At most ${MAX_ACTIVE_QUESTIONS} active questions; archive one first`); return }
    void run('new', () => api.addBehaviorQuestion(draft, draftKind), created => { setQuestions(rows => [...rows, created]); setDraft('') })
  }
  const saveEdit = () => {
    if (!editing) return
    const current = questions.find(question => question.question_id === editing.id)
    const invalid = current ? validateQuestionText(editing.text, current.kind, questions, editing.id) : ''
    if (invalid) { setError(invalid); return }
    void run(editing.id, () => api.updateBehaviorQuestion(editing.id, editing.text), result => { replace(result); setEditing(null) })
  }

  const row = (question: BehaviorQuestion) => {
    const archived = question.status === 'archived'
    const editingThis = editing?.id === question.question_id
    return (
      <li key={question.question_id} className={`bq-row ${archived ? 'archived' : ''}`}>
        {editingThis ? (
          <>
            <input className="tl-input" aria-label="Question text" autoFocus value={editing.text} maxLength={MAX_TEXT_LENGTH + 20}
              onChange={event => { setEditing({ id: editing.id, text: event.target.value }); setError('') }}
              onKeyDown={event => { if (event.key === 'Enter') saveEdit(); else if (event.key === 'Escape') { setEditing(null); setError('') } }} />
            <button type="button" className="tl-ghost" disabled={busy === question.question_id} onClick={saveEdit}>Save</button>
            <button type="button" className="tl-ghost" onClick={() => { setEditing(null); setError('') }}>Cancel</button>
          </>
        ) : confirming === question.question_id ? (
          <>
            <span className="bq-text">Archive “{question.text}”? It leaves every labeling form; past marks stay in Stats.</span>
            <button type="button" className="tl-ghost danger" disabled={busy === question.question_id} onClick={() => { setConfirming(''); void run(question.question_id, () => api.archiveBehaviorQuestion(question.question_id), replace) }}>Archive</button>
            <button type="button" className="tl-ghost" onClick={() => setConfirming('')}>Cancel</button>
          </>
        ) : (
          <>
            <span className="bq-text">{question.text}{archived && <em> · archived {archivedOn(question.archived_at)}</em>}</span>
            {archived
              ? <button type="button" className="tl-ghost" aria-label={`Unarchive question: ${question.text}`} disabled={busy === question.question_id} onClick={() => void run(question.question_id, () => api.restoreBehaviorQuestion(question.question_id), replace)}>Unarchive</button>
              : <>
                  <button type="button" className="tl-ghost" aria-label={`Edit question: ${question.text}`} onClick={() => { setEditing({ id: question.question_id, text: question.text }); setConfirming(''); setError('') }}>Edit</button>
                  <button type="button" className="tl-ghost" aria-label={`Archive question: ${question.text}`} onClick={() => { setConfirming(question.question_id); setEditing(null); setError('') }}>Archive</button>
                </>}
          </>
        )}
      </li>
    )
  }

  if (loading) return <p role="status" className="tl-root">Loading behavior questions…</p>
  if (loadError) return <p role="alert" className="tl-root">{loadError} <button type="button" className="tl-ghost" onClick={() => void load()}>Retry</button></p>
  return (
    <section className="tl-root bq" aria-label="Behavior questions">
      <form className="bq-add" onSubmit={add}>
        <input className="tl-input" aria-label="New question text" placeholder="e.g. Profit for 1 bar, then exited at a loss" value={draft}
          onChange={event => { setDraft(event.target.value); setError('') }} />
        <div className="tl-mode" role="radiogroup" aria-label="Question type">
          {SECTIONS.map(section => (
            <button key={section.kind} type="button" role="radio" aria-checked={draftKind === section.kind} aria-pressed={draftKind === section.kind} onClick={() => setDraftKind(section.kind)}>{section.kind === 'entry' ? 'Entry' : 'Exit'}</button>
          ))}
        </div>
        <button type="submit" className="tl-nav-button primary" disabled={busy === 'new'}>Add question</button>
      </form>
      {error && <p role="alert" className="bq-error">{error}</p>}
      {SECTIONS.map(section => (
        <div key={section.kind} className="bq-section">
          <h4>{section.title} <small>({grouped[section.kind].length} active) — {section.hint}</small></h4>
          {grouped[section.kind].length ? <ul>{grouped[section.kind].map(row)}</ul> : <p className="bq-empty">None yet.</p>}
        </div>
      ))}
      <p className="bq-count">{activeCount} / {MAX_ACTIVE_QUESTIONS} active questions</p>
      <div className="bq-section">
        <button type="button" className="tl-ghost" aria-expanded={showArchived} onClick={() => setShowArchived(value => !value)}>
          {showArchived ? '▾' : '▸'} Archived ({grouped.archived.length})
        </button>
        {showArchived && (grouped.archived.length
          ? <ul>{grouped.archived.map(row)}</ul>
          : <p className="bq-empty">Archived questions appear here. They stay in your Stats history and can be unarchived.</p>)}
      </div>
    </section>
  )
}
