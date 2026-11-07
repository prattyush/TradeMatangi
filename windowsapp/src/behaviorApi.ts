import type { BehaviorKind, BehaviorMark, BehaviorQuestion } from '../../shared/analysis/api'
import type { BehaviorApi } from '../../shared/analysis/behavior/types'

type Request = <T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>) => Promise<T>

/**
 * Behavior API over the desktop trading routes (`/api/desktop/v1/trading/...`). Used by Settings and the in-session
 * labeling UI, which are not part of the Analysis proxy; Analysis uses `createAnalysisApi`.
 */
export function createDesktopBehaviorApi(request: Request): BehaviorApi {
  return {
    getBehaviorQuestions: async (includeArchived = false) => (await request<{ questions: BehaviorQuestion[] }>(`behavior/questions?include_archived=${includeArchived}`, 'GET')).questions,
    addBehaviorQuestion: (text: string, kind: BehaviorKind) => request<BehaviorQuestion>('behavior/questions', 'POST', { text, kind }),
    updateBehaviorQuestion: (id: string, text: string) => request<BehaviorQuestion>(`behavior/questions/${encodeURIComponent(id)}/update`, 'POST', { text }),
    archiveBehaviorQuestion: (id: string) => request<BehaviorQuestion>(`behavior/questions/${encodeURIComponent(id)}/archive`, 'POST', {}),
    restoreBehaviorQuestion: (id: string) => request<BehaviorQuestion>(`behavior/questions/${encodeURIComponent(id)}/restore`, 'POST', {}),
    getBehaviorMarks: async (sessionId: string) => (await request<{ marks: BehaviorMark[] }>(`${encodeURIComponent(sessionId)}/behavior-marks`, 'GET')).marks,
    saveBehaviorMarks: async (sessionId: string, roundTripIndex: number, answers: Record<string, boolean>) =>
      (await request<{ marks: BehaviorMark[] }>(`${encodeURIComponent(sessionId)}/behavior-marks`, 'POST', { round_trip_index: roundTripIndex, answers })).marks,
  }
}
