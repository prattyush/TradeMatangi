import { useCallback, useEffect, useRef, useState } from 'react'
import { useAnalysisEnvironment } from '../environment'
import { historyLine, isClosed, PART_LABEL, partsOf, sameParts, shortDate, STATUS_LABEL, STATUS_ORDER, todoTotals, weeklyReview } from './model'
import { NOTE_PARTS, type DayNotesSource, type DayNotesView, type DayTodo, type NoteParts, type TodoStatus } from './types'
import './notes.css'

const AUTOSAVE_MS = 800

/**
 * The Notes tab of a day: one note for the market date (what went well, what to improve, specific points, context) and the
 * TODOs, which are carried from the day they were written until they are Done or Improved. Typing saves by itself a moment after
 * you stop, and once more when you leave the tab. Reviewing an older day shows each TODO as it stood that day.
 */
export default function DayNotes({ date, readOnly = false }: { date: string; readOnly?: boolean }) {
  const source = useAnalysisEnvironment().dayNotes
  if (!source) return <p className="pl-muted" role="status">Notes are not available here.</p>
  return <Notes source={source} date={date} readOnly={readOnly} />
}

function Notes({ source, date, readOnly }: { source: DayNotesSource; date: string; readOnly: boolean }) {
  const [view, setView] = useState<DayNotesView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parts, setParts] = useState<NoteParts>(() => partsOf(null))
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const saved = useRef<NoteParts>(partsOf(null))
  const latest = useRef(parts)
  latest.current = parts
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewRevision, setReviewRevision] = useState(0)

  useEffect(() => {
    let live = true
    setView(null); setError(null)
    source.day(date).then(loaded => {
      if (!live) return
      setView(loaded)
      const loadedParts = partsOf(loaded.note)
      saved.current = loadedParts; setParts(loadedParts); setState('idle')
    }).catch(cause => { if (live) setError(message(cause)) })
    return () => { live = false }
  }, [source, date])

  const flush = useCallback(async () => {
    if (sameParts(latest.current, saved.current)) return
    const sending = latest.current
    setState('saving')
    try {
      const result = await source.saveNote(date, sending)
      saved.current = sending
      setView(current => (current ? { ...current, todos: result.todos } : current))
      setState('saved'); setError(null)
    } catch (cause) { setState('idle'); setError(`The note was not saved: ${message(cause)}`) }
  }, [source, date])

  // Save a moment after typing stops, and once more when the tab is left (the pending text must not be lost).
  useEffect(() => {
    if (readOnly || !view || sameParts(parts, saved.current)) return
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [parts, view, readOnly, flush])
  const flushOnLeave = useRef(flush)
  flushOnLeave.current = flush
  useEffect(() => () => { void flushOnLeave.current() }, [date])

  const act = async (run: () => Promise<DayNotesView>) => {
    setBusy(true); setError(null)
    try {
      const result = await run()
      setView(current => (current ? { ...current, todos: result.todos } : result))
      setReviewRevision(n => n + 1)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const add = async () => {
    const text = draft.trim()
    if (!text) return
    await act(() => source.addTodo(date, text))
    setDraft('')
  }

  if (error && !view) return <p role="alert" className="pl-error">{error}</p>
  if (!view) return <p role="status" className="pl-muted">Loading the notes…</p>
  const carried = view.todos.filter(todo => todo.carried)
  return <div className="dn" aria-label={`Notes for ${date}`}>
    {error && <p role="alert" className="pl-error">{error}</p>}
    <section className="dn-todos" aria-label="TODOs">
      <h4>TODOs {view.todos.length > 0 && <span className="pl-muted">({view.todos.length}{carried.length ? `, ${carried.length} carried over` : ''})</span>}</h4>
      <p className="pl-muted dn-hint">A TODO stays on every day until you mark it Done or Improved. Reviewing an older day shows it as it stood that day.</p>
      {view.todos.length === 0 && <p className="pl-muted">No open TODOs for this day.</p>}
      <ul>{view.todos.map(todo => <TodoRow key={todo.todo_id} todo={todo} busy={busy || readOnly}
        onStatus={status => void act(() => source.setStatus(todo.todo_id, date, status))}
        onDelete={() => { if (window.confirm('Delete this TODO and its history?')) void act(() => source.removeTodo(todo.todo_id, date)) }} />)}</ul>
      {!readOnly && <form className="dn-add" onSubmit={event => { event.preventDefault(); void add() }}>
        <input aria-label="New TODO" value={draft} maxLength={300} placeholder="Something to work on, for example: wait for the retest before entering" onChange={event => setDraft(event.target.value)} />
        <button type="submit" disabled={busy || !draft.trim()}>Add TODO</button>
      </form>}
    </section>
    <section className="dn-note" aria-label="Day note">
      <h4>Note for {shortDate(date)} <span className="pl-muted dn-state" role="status">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}</span></h4>
      {NOTE_PARTS.map(part => <label key={part} className="dn-part">
        <span>{PART_LABEL[part].title} <small className="pl-muted">{PART_LABEL[part].hint}</small></span>
        <textarea rows={3} value={parts[part]} disabled={readOnly} maxLength={4000} onChange={event => setParts(current => ({ ...current, [part]: event.target.value }))} />
      </label>)}
    </section>
    <Review source={source} revision={reviewRevision} />
  </div>
}

function TodoRow({ todo, busy, onStatus, onDelete }: { todo: DayTodo; busy: boolean; onStatus: (status: TodoStatus) => void; onDelete: () => void }) {
  return <li className={`dn-todo ${todo.status}`} data-status={todo.status}>
    <div className="dn-todo-main">
      <span className="dn-todo-text">{todo.text}</span>
      {todo.carried && <span className="dn-badge" title={`Written on ${todo.created_date}`}>from {shortDate(todo.created_date)}</span>}
      <span className="dn-status" role="group" aria-label={`Status of ${todo.text}`}>
        {STATUS_ORDER.map(status => <button key={status} type="button" aria-pressed={todo.status === status} disabled={busy} className={`dn-s-${status}`}
          title={isClosed(status) ? 'Closes the TODO: it is not carried to later days' : undefined} onClick={() => onStatus(status)}>{STATUS_LABEL[status]}</button>)}
      </span>
      <button type="button" className="dn-x" aria-label={`Delete TODO ${todo.text}`} disabled={busy} onClick={onDelete}>✕</button>
    </div>
    {todo.history.length > 1 && <details className="dn-history"><summary>History ({todo.history.length})</summary><p className="pl-muted">{historyLine(todo, shortDate)}</p></details>}
  </li>
}

/** Every TODO and how many were written and closed per week, so improvement can be seen over time. */
function Review({ source, revision }: { source: DayNotesSource; revision: number }) {
  const [open, setOpen] = useState(false)
  const [todos, setTodos] = useState<DayTodo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    source.todos().then(rows => { if (live) { setTodos(rows); setError(null) } }).catch(cause => { if (live) setError(message(cause)) })
    return () => { live = false }
  }, [source, open, revision])
  const totals = todos ? todoTotals(todos) : null
  return <details className="dn-review" onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary>Review: how the TODOs are going</summary>
    {error && <p role="alert" className="pl-error">{error}</p>}
    {open && !todos && !error && <p className="pl-muted" role="status">Loading…</p>}
    {todos && totals && (todos.length === 0 ? <p className="pl-muted">No TODOs yet.</p> : <>
      <p data-testid="review-totals">{totals.total} TODOs: {totals.open} open, {totals.working} working on it, {totals.done} done, {totals.improved} improved.</p>
      <table className="dn-weeks"><thead><tr><th>Week of</th><th>Written</th><th>Done</th><th>Improved</th></tr></thead>
        <tbody>{weeklyReview(todos).map(row => <tr key={row.week} data-week={row.week}><td>{shortDate(row.week)}</td><td>{row.written}</td><td>{row.done}</td><td>{row.improved}</td></tr>)}</tbody></table>
      <ul className="dn-all">{todos.map(todo => <li key={todo.todo_id} className={todo.status}>
        <strong>{todo.text}</strong> <span className="pl-muted">written {shortDate(todo.created_date)} · now {STATUS_LABEL[todo.status]}</span>
        <div className="pl-muted">{historyLine(todo, shortDate)}</div></li>)}</ul>
    </>)}
  </details>
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
