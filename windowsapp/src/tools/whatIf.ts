import type { AnalysisRequest } from '../analysisApi'
import type { WhatIfScenario, WhatIfSource } from '../../../shared/analysis/whatif/scenarios'

/** Saved what-ifs live on the server, tied to the trading session and visible to its owner only. */
export function createWhatIfApi(request: AnalysisRequest): WhatIfSource {
  return {
    list: async sessionId => (await request<{ scenarios: WhatIfScenario[] }>(`whatif?session_id=${encodeURIComponent(sessionId)}`, 'GET')).scenarios,
    range: async (start, end) => {
      const query = [start ? `start=${encodeURIComponent(start)}` : '', end ? `end=${encodeURIComponent(end)}` : ''].filter(Boolean).join('&')
      return (await request<{ scenarios: WhatIfScenario[] }>(`whatif/range${query ? `?${query}` : ''}`, 'GET')).scenarios
    },
    save: ({ sessionId, name, edits, summary }) => request<WhatIfScenario>('whatif', 'POST', { session_id: sessionId, name, edits, summary }),
    remove: async (sessionId, scenarioId) => {
      await request(`whatif?session_id=${encodeURIComponent(sessionId)}&scenario_id=${encodeURIComponent(scenarioId)}`, 'DELETE')
    },
  }
}
