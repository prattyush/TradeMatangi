import type { BehaviorKind, BehaviorMark, BehaviorQuestion } from '../api'

export const MAX_TEXT_LENGTH = 140
export const MAX_ACTIVE_QUESTIONS = 40

export interface GroupedQuestions { entry: BehaviorQuestion[]; exit: BehaviorQuestion[]; archived: BehaviorQuestion[] }

const bySort = (a: BehaviorQuestion, b: BehaviorQuestion) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)

/** Active questions by type, plus every archived question (most recently archived first). */
export function groupQuestions(questions: BehaviorQuestion[]): GroupedQuestions {
  const active = questions.filter(question => question.status === 'active').sort(bySort)
  return {
    entry: active.filter(question => question.kind === 'entry'),
    exit: active.filter(question => question.kind === 'exit'),
    archived: questions.filter(question => question.status === 'archived').sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '')),
  }
}

/**
 * Questions of one type to show on a trade: every active question, plus archived ones this trade was already marked
 * with (so the history stays visible and can be cleared, but nothing archived can be newly marked).
 */
export function questionsToShow(questions: BehaviorQuestion[], kind: BehaviorKind, marked: ReadonlySet<string>): BehaviorQuestion[] {
  return questions
    .filter(question => question.kind === kind && (question.status === 'active' || marked.has(question.question_id)))
    .sort((a, b) => (a.status === b.status ? bySort(a, b) : a.status === 'active' ? -1 : 1))
}

/** Client-side mirror of the backend validation, so the user gets feedback without a round trip. */
export function validateQuestionText(text: string, kind: BehaviorKind, questions: BehaviorQuestion[], exceptId?: string): string {
  const cleaned = text.split(/\s+/).filter(Boolean).join(' ')
  if (!cleaned) return 'Enter the question text'
  if (cleaned.length > MAX_TEXT_LENGTH) return `At most ${MAX_TEXT_LENGTH} characters`
  const key = cleaned.toLowerCase()
  if (questions.some(question => question.status === 'active' && question.kind === kind && question.question_id !== exceptId && question.text.toLowerCase() === key)) {
    return 'An active question with this text already exists'
  }
  return ''
}

export const questionIdsByTrip = (marks: BehaviorMark[], sessionId: string): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>()
  for (const mark of marks) {
    const key = `${sessionId}#${mark.round_trip_index}`
    map.set(key, (map.get(key) ?? new Set()).add(mark.question_id))
  }
  return map
}
