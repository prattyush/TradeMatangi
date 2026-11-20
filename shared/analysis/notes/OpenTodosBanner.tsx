import { useEffect, useState } from 'react'
import { useOptionalAnalysisEnvironment } from '../environment'
import { STATUS_LABEL } from './model'
import type { DayTodo } from './types'
import './notes.css'

/**
 * The TODOs still open on a day, shown above Label Trades so they are in mind while labelling. Read only (they are changed in the
 * Notes tab); shows nothing without notes support, without open TODOs, or when they cannot be loaded.
 */
export default function OpenTodosBanner({ date }: { date: string }) {
  const source = useOptionalAnalysisEnvironment()?.dayNotes
  const [todos, setTodos] = useState<DayTodo[]>([])
  useEffect(() => {
    if (!source) return
    let live = true
    source.day(date).then(view => { if (live) setTodos(view.todos.filter(todo => todo.status === 'open' || todo.status === 'working')) }).catch(() => { if (live) setTodos([]) })
    return () => { live = false }
  }, [source, date])
  if (!todos.length) return null
  return <aside className="dn-banner" role="note" aria-label="Open TODOs">
    <strong>{todos.length} {todos.length === 1 ? 'TODO' : 'TODOs'} to keep in mind</strong>
    <ul>{todos.map(todo => <li key={todo.todo_id}>{todo.text} <span className="pl-muted">({STATUS_LABEL[todo.status]})</span></li>)}</ul>
  </aside>
}
