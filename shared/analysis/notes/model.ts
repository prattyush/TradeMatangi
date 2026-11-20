/** Pure helpers of the Notes tab: wording, the weekly review of TODOs, the autosave rule. */
import { NOTE_PARTS, type DayNote, type DayTodo, type NoteParts, type TodoStatus } from './types'

export const STATUS_LABEL: Record<TodoStatus, string> = { open: 'Open', working: 'Working on it', done: 'Done', improved: 'Improved' }
export const STATUS_ORDER: readonly TodoStatus[] = ['open', 'working', 'done', 'improved']
export const isClosed = (status: TodoStatus) => status === 'done' || status === 'improved'

export const PART_LABEL: Record<(typeof NOTE_PARTS)[number], { title: string; hint: string }> = {
  went_well: { title: 'What went well', hint: 'What you did right today, even on a losing day' },
  to_improve: { title: 'What to improve', hint: 'The one or two things to fix next' },
  specific_points: { title: 'Specific points to focus on', hint: 'Particular trades, setups or rules to watch' },
  context: { title: 'Context and behaviour', hint: 'The kind of day it was and how you traded it: calm, rushed, revenge, patient' },
}

export const emptyParts = (): NoteParts => ({ went_well: '', to_improve: '', specific_points: '', context: '' })
export const partsOf = (note: DayNote | null): NoteParts => (note ? { went_well: note.went_well, to_improve: note.to_improve, specific_points: note.specific_points, context: note.context } : emptyParts())
export const sameParts = (a: NoteParts, b: NoteParts) => NOTE_PARTS.every(part => a[part].trim() === b[part].trim())
export const hasText = (parts: NoteParts) => NOTE_PARTS.some(part => parts[part].trim() !== '')

/** Monday of the week a `YYYY-MM-DD` date is in (weeks start on Monday, like the trading week). */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  const back = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - back * 86400000).toISOString().slice(0, 10)
}

export interface WeekRow { week: string; written: number; done: number; improved: number }

/**
 * TODOs per week: how many were written, and how many were closed as Done or Improved (the week of the day it was closed, from its
 * history). Newest week first. A TODO reopened and closed again counts once, at its last closing.
 */
export function weeklyReview(todos: readonly DayTodo[]): WeekRow[] {
  const rows = new Map<string, WeekRow>()
  const row = (date: string) => {
    const week = weekStart(date)
    if (!rows.has(week)) rows.set(week, { week, written: 0, done: 0, improved: 0 })
    return rows.get(week)!
  }
  for (const todo of todos) {
    row(todo.created_date).written += 1
    const last = todo.history[todo.history.length - 1]
    if (last && isClosed(last.status)) row(last.date)[last.status as 'done' | 'improved'] += 1
  }
  return [...rows.values()].sort((a, b) => b.week.localeCompare(a.week))
}

export interface TodoTotals { total: number; open: number; working: number; done: number; improved: number }

/** Where every TODO stands now (its latest status). */
export function todoTotals(todos: readonly DayTodo[]): TodoTotals {
  const totals: TodoTotals = { total: todos.length, open: 0, working: 0, done: 0, improved: 0 }
  for (const todo of todos) totals[todo.history[todo.history.length - 1]?.status ?? todo.status] += 1
  return totals
}

/** `16 Nov: Open → 17 Nov: Working on it → 19 Nov: Improved` */
export function historyLine(todo: Pick<DayTodo, 'history'>, formatDate: (date: string) => string): string {
  return todo.history.map(change => `${formatDate(change.date)}: ${STATUS_LABEL[change.status]}`).join(' → ')
}

/** `16 Nov` (UTC, so the date never shifts with the time zone). */
export const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
