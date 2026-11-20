import type { DayNotesSource, DayNotesView, DayTodo } from './types'

/** The transport a host runs the notes over: a path under `/api/` (`day-notes...`), the method and a JSON body. */
export type DayNotesRequest = <T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => Promise<T>

const q = encodeURIComponent

/** Notes and TODOs over any transport (the website's fetch, the desktop's analysis command): exact paths, writes are POST or DELETE. */
export function createDayNotesSource(request: DayNotesRequest): DayNotesSource {
  return {
    day: date => request<DayNotesView>(`day-notes?date=${q(date)}`, 'GET'),
    saveNote: (date, parts) => request<DayNotesView>('day-notes', 'POST', { date, ...parts }),
    addTodo: (date, text) => request<DayNotesView>('day-notes/todos', 'POST', { date, text }),
    setStatus: (todoId, date, status) => request<DayNotesView>('day-notes/todos/status', 'POST', { todo_id: todoId, date, status }),
    removeTodo: (todoId, date) => request<DayNotesView>(`day-notes/todos?todo_id=${q(todoId)}&date=${q(date)}`, 'DELETE'),
    todos: async () => (await request<{ todos: DayTodo[] }>('day-notes/todos', 'GET')).todos,
  }
}
