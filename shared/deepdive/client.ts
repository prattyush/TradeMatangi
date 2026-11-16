import type { DeepDiveApi, DeepDiveRequest, DiveRef, DiveSummary, SetupRef, StatsAllEntry } from './types'

const query = (values: Record<string, unknown>) => {
  const q = new URLSearchParams(Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)])).toString()
  return q ? `?${q}` : ''
}

const setupQuery = (ref: SetupRef) => query({ category: ref.category, strategy: ref.strategy, symbol: ref.symbol, date: ref.date, side: ref.side })
const setupBody = (ref: SetupRef) => ({ category: ref.category, strategy: ref.strategy, symbol: ref.symbol, date: ref.date, side: ref.side })
const tagPath = (tagId: string, action: 'update' | 'archive' | 'restore') => `deep-dive/tags/${encodeURIComponent(tagId)}/${action}`
const diveBody = (ref: DiveRef) => ({ category: ref.category, strategy: ref.strategy })

/**
 * The Deep Dive client over any transport. The website passes a `fetch` over `/api/`, the Windows app passes its
 * patterns transport (`/api/desktop/v1/patterns/`): both serve the same `deep-dive/...` paths, so the call
 * shapes cannot drift apart. `patternsApi.validPatternsPath` must accept every path built here (tested).
 */
export function createDeepDiveClient(request: DeepDiveRequest): DeepDiveApi {
  return {
    listDives: async () => (await request<{ dives: DiveSummary[] }>('deep-dive/dives', 'GET')).dives,
    getDive: (ref, ownerId) => request('deep-dive/dive' + query({ ...diveBody(ref), owner_id: ownerId }), 'GET'),
    getStats: (ref, side, ownerId) => request('deep-dive/stats' + query({ ...diveBody(ref), side, owner_id: ownerId }), 'GET'),
    getStatsAll: async () => (await request<{ dives: StatsAllEntry[] }>('deep-dive/stats/all', 'GET')).dives,
    saveSetup: (ref, fields = {}) => request('deep-dive/setup', 'PUT', { ...setupBody(ref), ...fields }),
    deleteSetup: async ref => (await request<{ status: string }>('deep-dive/setup' + setupQuery(ref), 'DELETE')).status === 'deleted',
    setTagValues: (ref, tagValues) => request('deep-dive/setup/tag-values', 'PUT', { ...setupBody(ref), tag_values: tagValues }),
    saveToPatterns: ref => request('deep-dive/setup/save-to-patterns', 'POST', setupBody(ref)),
    addTag: (ref, name) => request('deep-dive/tags', 'POST', { ...diveBody(ref), name }),
    updateTag: (ref, tagId, name) => request(tagPath(tagId, 'update'), 'POST', { ...diveBody(ref), name }),
    archiveTag: (ref, tagId) => request(tagPath(tagId, 'archive'), 'POST', diveBody(ref)),
    restoreTag: (ref, tagId) => request(tagPath(tagId, 'restore'), 'POST', diveBody(ref)),
  }
}
