/** Day notes and carried-over TODOs (Phase 27, S5): the shapes of `/api/day-notes` and the source every host provides. */

export type TodoStatus = 'open' | 'working' | 'done' | 'improved'

export const NOTE_PARTS = ['went_well', 'to_improve', 'specific_points', 'context'] as const
export type NotePart = (typeof NOTE_PARTS)[number]
export type NoteParts = Record<NotePart, string>

/** One market date's note: what went well, what to improve, specific points, and the context of the day. */
export interface DayNote extends NoteParts { date: string; updated_at: string | null }

export interface TodoChange { date: string; status: TodoStatus; at: string }

/** `status` is the status on the day asked for (a TODO reviewed on an older day shows as it stood then); `carried` is true when it was written on an earlier day. */
export interface DayTodo {
  todo_id: string
  text: string
  created_date: string
  status: TodoStatus
  history: TodoChange[]
  carried?: boolean
}

/** What one day's Notes tab shows: its note (null when none was written) and the TODOs that belong on it, carried ones first. */
export interface DayNotesView { date: string; note: DayNote | null; todos: DayTodo[] }

/**
 * Notes and TODOs of the signed-in user, keyed by market date. Analysis offers the Notes tab only when the host gives it this.
 * Every call returns the day's view again, so the screen never has to merge by hand.
 */
export interface DayNotesSource {
  day(date: string): Promise<DayNotesView>
  /** Replaces the day's note; a note with every part empty is removed. */
  saveNote(date: string, parts: NoteParts): Promise<DayNotesView>
  addTodo(date: string, text: string): Promise<DayNotesView>
  /** Records a status for the market date being viewed. */
  setStatus(todoId: string, date: string, status: TodoStatus): Promise<DayNotesView>
  removeTodo(todoId: string, date: string): Promise<DayNotesView>
  /** Every TODO with its whole history, newest first: the review list. */
  todos(): Promise<DayTodo[]>
}
