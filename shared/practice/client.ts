import type { PracticeApi, PracticeRequest, PracticeRun, PracticeStrategy } from './types'

/**
 * The Strategy Practice client over any transport: the website's fetch (`/api/deep-dive/practice/...`) or the Windows app's
 * patterns transport. Both serve the same `deep-dive/practice/...` paths (the desktop allowlists must accept them).
 */
export function createPracticeClient(request: PracticeRequest): PracticeApi {
  return {
    strategies: async () => (await request<{ strategies: PracticeStrategy[] }>('deep-dive/practice/strategies', 'GET')).strategies,
    pick: (ref, filter) => request('deep-dive/practice/pick', 'POST', {
      category: ref.category, strategy: ref.strategy,
      ...(filter?.symbol ? { symbol: filter.symbol } : {}), ...(filter?.grades?.length ? { grades: filter.grades } : {}), ...(filter?.include_negatives ? { include_negatives: true } : {}),
    }),
    runs: async () => (await request<{ runs: PracticeRun[] }>('deep-dive/practice/runs', 'GET')).runs,
    evaluate: sessionId => request(`deep-dive/practice/evaluate?session_id=${encodeURIComponent(sessionId)}`, 'GET'),
  }
}
