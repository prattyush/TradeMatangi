import { describe, expect, it, vi } from 'vitest'
import type { BehaviorQuestion } from '../../shared/analysis/api'
import { diffAnswers, groupQuestions, questionIdsByTrip, questionsToShow, validateQuestionText } from '../../shared/analysis/behavior/model'
import { readableError } from '../../shared/analysis/behavior/types'
import { combineSaverStates, MarkSaver } from '../../shared/analysis/labeling/saver'
import { createAnalysisApi, validAnalysisPath, type AnalysisRequest } from './analysisApi'
import { createDesktopBehaviorApi } from './behaviorApi'

const question = (id: string, kind: 'entry' | 'exit', status: 'active' | 'archived' = 'active', extra: Partial<BehaviorQuestion> = {}): BehaviorQuestion => ({
  question_id: id, kind, text: `Question ${id}`, status, sort_order: Number(id.replace(/\D/g, '')) || 0, created_at: `2026-10-0${(Number(id.replace(/\D/g, '')) || 0) % 9 + 1}`, archived_at: status === 'archived' ? '2026-10-20T10:00:00Z' : null, ...extra,
})

describe('behavior question helpers', () => {
  it('groups active questions by type in order and lists archived ones separately, newest archive first', () => {
    const rows = [question('e2', 'entry'), question('x1', 'exit'), question('e1', 'entry'), question('a1', 'entry', 'archived', { archived_at: '2026-10-21T00:00:00Z' }), question('a2', 'exit', 'archived')]
    const grouped = groupQuestions(rows)
    expect(grouped.entry.map(q => q.question_id)).toEqual(['e1', 'e2'])
    expect(grouped.exit.map(q => q.question_id)).toEqual(['x1'])
    expect(grouped.archived.map(q => q.question_id)).toEqual(['a1', 'a2'])
  })
  it('shows active questions plus archived ones the trade is already marked with, never archived ones that are not', () => {
    const rows = [question('e1', 'entry'), question('e2', 'entry', 'archived'), question('e3', 'entry', 'archived'), question('x1', 'exit')]
    expect(questionsToShow(rows, 'entry', new Set()).map(q => q.question_id)).toEqual(['e1'])
    expect(questionsToShow(rows, 'entry', new Set(['e2'])).map(q => q.question_id)).toEqual(['e1', 'e2'])
    expect(questionsToShow(rows, 'exit', new Set(['e2']))).toHaveLength(1)
    expect(questionsToShow([], 'entry', new Set())).toEqual([])
  })
  it('validates text like the backend: empty, too long, duplicate among active questions of the same type', () => {
    const rows = [question('e1', 'entry', 'active', { text: 'Chased the move' }), question('e2', 'entry', 'archived', { text: 'Old habit' })]
    expect(validateQuestionText('   ', 'entry', rows)).toMatch(/Enter/)
    expect(validateQuestionText('x'.repeat(141), 'entry', rows)).toMatch(/140/)
    expect(validateQuestionText('  chased   THE move ', 'entry', rows)).toMatch(/already exists/)
    expect(validateQuestionText('chased the move', 'exit', rows)).toBe('')
    expect(validateQuestionText('Chased the move', 'entry', rows, 'e1')).toBe('') // editing itself
    expect(validateQuestionText('Old habit', 'entry', rows)).toBe('') // archived duplicates do not block
  })
  it('indexes marks by session and round trip', () => {
    const map = questionIdsByTrip([{ round_trip_index: 0, question_id: 'a', kind: 'entry' }, { round_trip_index: 0, question_id: 'b', kind: 'exit' }, { round_trip_index: 2, question_id: 'a', kind: 'entry' }], 's1')
    expect([...(map.get('s1#0') ?? [])]).toEqual(['a', 'b'])
    expect([...(map.get('s1#2') ?? [])]).toEqual(['a'])
    expect(map.get('s1#1')).toBeUndefined()
  })
  it('extracts the server detail from transport errors', () => {
    expect(readableError(new Error('An active question with this text already exists'))).toBe('An active question with this text already exists')
    expect(readableError(new Error('Analysis request failed (400 Bad Request): {"detail":"At most 40 active questions; archive one first"}'))).toBe('At most 40 active questions; archive one first')
    expect(readableError(new Error('Settings request failed (500): {"detail":"say \\"hi\\""}'))).toBe('say "hi"')
    expect(readableError('plain')).toBe('plain')
  })
})

describe('diffAnswers', () => {
  it('sends only the questions whose answer changed, as true/false', () => {
    expect(diffAnswers(new Set(['a', 'b']), new Set(['b', 'c']), ['a', 'b', 'c', 'd'])).toEqual({ a: false, c: true })
    expect(diffAnswers(new Set(['a']), new Set(['a']), ['a', 'b'])).toEqual({})
    expect(diffAnswers(new Set(), new Set(['x']), ['a'])).toEqual({}) // ids outside the shown questions are never sent
  })
})

describe('MarkSaver', () => {
  it('combines toggles on the same trade made before the save into one request, later answers winning', async () => {
    vi.useFakeTimers()
    try {
      const save = vi.fn().mockResolvedValue(undefined)
      const saver = new MarkSaver(save)
      saver.edit({ session_id: 's', round_trip_index: 1, answers: { a: true } })
      saver.edit({ session_id: 's', round_trip_index: 1, answers: { b: true } })
      saver.edit({ session_id: 's', round_trip_index: 1, answers: { a: false } })
      saver.edit({ session_id: 's', round_trip_index: 2, answers: { a: true } })
      await vi.advanceTimersByTimeAsync(500)
      expect(save).toHaveBeenCalledTimes(1)
      expect(save.mock.calls[0][0]).toEqual([
        { session_id: 's', round_trip_index: 1, answers: { a: false, b: true } },
        { session_id: 's', round_trip_index: 2, answers: { a: true } },
      ])
    } finally { vi.useRealTimers() }
  })
  it('combines label and mark status into one', () => {
    expect(combineSaverStates({ pending: 1, saving: false, error: '', savedCount: 2 }, { pending: 0, saving: true, error: 'offline', savedCount: 1 }))
      .toEqual({ pending: 1, saving: true, error: 'offline', savedCount: 3 })
  })
})

describe('behavior transports', () => {
  it('desktop Analysis adapter uses the allowlisted analysis routes', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.startsWith('behavior/questions?') ? { questions: [question('e1', 'entry')] } : path.startsWith('behavior/marks?') ? { marks: [{ round_trip_index: 0, question_id: 'e1', kind: 'entry' }] } : path === 'behavior/marks' ? { marks: [] } : question('e1', 'entry'))
    const { api } = createAnalysisApi(request as unknown as AnalysisRequest)
    expect(await api.getBehaviorQuestions(true)).toHaveLength(1)
    await api.addBehaviorQuestion('New', 'exit'); await api.updateBehaviorQuestion('e 1', 'Edited'); await api.archiveBehaviorQuestion('e1'); await api.restoreBehaviorQuestion('e1')
    expect(await api.getBehaviorMarks('s/1')).toHaveLength(1)
    await api.saveBehaviorMarks('s1', 3, { e1: true })
    const calls = request.mock.calls.map(call => [call[0], call[1], call[2]])
    expect(calls).toEqual([
      ['behavior/questions?include_archived=true', 'GET', undefined],
      ['behavior/questions', 'POST', { text: 'New', kind: 'exit' }],
      ['behavior/questions/e%201/update', 'POST', { text: 'Edited' }],
      ['behavior/questions/e1/archive', 'POST', {}],
      ['behavior/questions/e1/restore', 'POST', {}],
      ['behavior/marks?session_id=s%2F1', 'GET', undefined],
      ['behavior/marks', 'POST', { session_id: 's1', round_trip_index: 3, answers: { e1: true } }],
    ])
  })
  it('desktop Analysis adapter reads the habit ledger through the allowlisted route with the dashboard filters', async () => {
    const ledgerBody = { questions: [], trades: [], coverage: { closed_trades: 0, marked_trades: 0, marks: 0, unmatched_marks: 0, open_marked_trades: 0, trades_without_capital: 0, trades_without_bars: 0, truncated: false } }
    const request = vi.fn().mockResolvedValue(ledgerBody)
    const { performance } = createAnalysisApi(request as unknown as AnalysisRequest)
    const controller = new AbortController()
    expect(await performance.getHabitLedger!({ start_date: '2026-10-01', symbol: 'NIFTY', session_type: '' }, controller.signal)).toEqual(ledgerBody)
    const [path, method, , signal] = request.mock.calls[0]
    expect(method).toBe('GET')
    expect(path).toBe('behavior/habit-ledger?start_date=2026-10-01&symbol=NIFTY') // empty filters are dropped
    expect(validAnalysisPath(path, method)).toBe(true)
    expect(signal).toBeInstanceOf(AbortSignal)
    await performance.getHabitLedger!({ created_from: '2026-10-13', created_to: '2026-10-14', start_date: '' }, controller.signal)
    expect(request.mock.calls[1][0]).toBe('behavior/habit-ledger?created_from=2026-10-13&created_to=2026-10-14') // Run-on range is passed through
    expect(validAnalysisPath(request.mock.calls[1][0], 'GET')).toBe(true)
  })
  it('desktop trading adapter uses the in-session routes', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path.endsWith('behavior-marks') ? { marks: [] } : path.startsWith('behavior/questions?') ? { questions: [] } : {})
    const api = createDesktopBehaviorApi(request)
    await api.getBehaviorQuestions(); await api.addBehaviorQuestion('A', 'entry'); await api.archiveBehaviorQuestion('q'); await api.getBehaviorMarks('s1'); await api.saveBehaviorMarks('s1', 0, { q: false })
    expect(request.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
      ['behavior/questions?include_archived=false', 'GET', undefined],
      ['behavior/questions', 'POST', { text: 'A', kind: 'entry' }],
      ['behavior/questions/q/archive', 'POST', {}],
      ['s1/behavior-marks', 'GET', undefined],
      ['s1/behavior-marks', 'POST', { round_trip_index: 0, answers: { q: false } }],
    ])
  })
})
