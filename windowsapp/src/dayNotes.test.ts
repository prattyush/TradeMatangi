import { describe, expect, it } from 'vitest'
import { createDayNotesSource } from '../../shared/analysis/notes/source'
import { emptyParts, hasText, historyLine, isClosed, partsOf, sameParts, shortDate, todoTotals, weekStart, weeklyReview } from '../../shared/analysis/notes/model'
import type { DayTodo, TodoStatus } from '../../shared/analysis/notes/types'

const todo = (id: string, created: string, changes: Array<[string, TodoStatus]> = []): DayTodo => {
  const history = [{ date: created, status: 'open' as TodoStatus, at: '' }, ...changes.map(([date, status]) => ({ date, status, at: '' }))]
  return { todo_id: id, text: `todo ${id}`, created_date: created, status: history[history.length - 1].status, history }
}

describe('day notes model', () => {
  it('finds the Monday of a week', () => {
    expect(weekStart('2026-11-16')).toBe('2026-11-16') // a Monday
    expect(weekStart('2026-11-20')).toBe('2026-11-16') // Friday
    expect(weekStart('2026-11-22')).toBe('2026-11-16') // Sunday
    expect(weekStart('2026-11-23')).toBe('2026-11-23')
    expect(weekStart('2027-01-01')).toBe('2026-12-28') // across the year
  })

  it('counts TODOs written and closed per week, newest week first, by the day each was closed', () => {
    const rows = weeklyReview([
      todo('a', '2026-11-16', [['2026-11-18', 'working'], ['2026-11-24', 'improved']]), // written week 16 Nov, closed week 23 Nov
      todo('b', '2026-11-17', [['2026-11-19', 'done']]),
      todo('c', '2026-11-24'),
      todo('d', '2026-11-17', [['2026-11-18', 'done'], ['2026-11-25', 'open']]), // reopened: not closed now
    ])
    expect(rows).toEqual([
      { week: '2026-11-23', written: 1, done: 0, improved: 1 },
      { week: '2026-11-16', written: 3, done: 1, improved: 0 },
    ])
    expect(weeklyReview([])).toEqual([])
  })

  it('totals where every TODO stands now', () => {
    expect(todoTotals([todo('a', '2026-11-16'), todo('b', '2026-11-16', [['2026-11-17', 'working']]), todo('c', '2026-11-16', [['2026-11-17', 'done']]), todo('d', '2026-11-16', [['2026-11-18', 'improved']])]))
      .toEqual({ total: 4, open: 1, working: 1, done: 1, improved: 1 })
  })

  it('reads a history in words and knows which statuses close a TODO', () => {
    expect(historyLine(todo('a', '2026-11-16', [['2026-11-17', 'working'], ['2026-11-19', 'improved']]), shortDate)).toBe('16 Nov: Open → 17 Nov: Working on it → 19 Nov: Improved')
    expect(['open', 'working', 'done', 'improved'].map(s => isClosed(s as TodoStatus))).toEqual([false, false, true, true])
  })

  it('compares note parts ignoring surrounding spaces', () => {
    const a = { ...emptyParts(), context: 'calm' }
    expect(sameParts(a, { ...a, context: '  calm ' })).toBe(true)
    expect(sameParts(a, { ...a, went_well: 'x' })).toBe(false)
    expect(hasText(emptyParts())).toBe(false)
    expect(hasText({ ...emptyParts(), context: ' ' })).toBe(false)
    expect(partsOf(null)).toEqual(emptyParts())
    expect(partsOf({ date: 'd', updated_at: null, went_well: 'w', to_improve: 'i', specific_points: 's', context: 'c' })).toEqual({ went_well: 'w', to_improve: 'i', specific_points: 's', context: 'c' })
  })
})

describe('day notes source', () => {
  it('uses exact paths and POST or DELETE for every write', async () => {
    const calls: Array<[string, string, unknown]> = []
    const source = createDayNotesSource(async (path, method, body) => { calls.push([path, method, body]); return (path === 'day-notes/todos' && method === 'GET' ? { todos: [] } : { date: 'd', note: null, todos: [] }) as never })
    await source.day('2026-11-19')
    await source.saveNote('2026-11-19', { ...emptyParts(), context: 'c' })
    await source.addTodo('2026-11-19', 'x')
    await source.setStatus('t1', '2026-11-19', 'done')
    await source.removeTodo('t 1', '2026-11-19')
    expect(await source.todos()).toEqual([])
    expect(calls).toEqual([
      ['day-notes?date=2026-11-19', 'GET', undefined],
      ['day-notes', 'POST', { date: '2026-11-19', went_well: '', to_improve: '', specific_points: '', context: 'c' }],
      ['day-notes/todos', 'POST', { date: '2026-11-19', text: 'x' }],
      ['day-notes/todos/status', 'POST', { todo_id: 't1', date: '2026-11-19', status: 'done' }],
      ['day-notes/todos?todo_id=t%201&date=2026-11-19', 'DELETE', undefined],
      ['day-notes/todos', 'GET', undefined],
    ])
  })
})
