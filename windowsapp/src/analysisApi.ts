import { AnalysisHistoryCache } from './analysisHistoryCache'
import type { AnalysisApi, AnalysisEnvironment } from '../../shared/analysis/environment'
import type { PerformanceCycle, PerformanceFilters, PerformanceReport } from '../../shared/analysis/performance'
import type { SessionDetail } from '../../shared/analysis/api'

export type AnalysisRequest = <T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal) => Promise<T>
export function validAnalysisPath(path: string, method: string): boolean {
  const route = path.split('?')[0]
  if (!route || route.startsWith('/') || route.includes('%') || route.includes('#') || route.includes('\\') || route.split('/').some(p => p === '.' || p === '..')) return false
  if (method === 'POST') return route === 'labels'
  if (method === 'DELETE') return route === 'snapshots'
  return method === 'GET' && /^(sessions(?:\/[A-Za-z0-9_-]+)?|round-trips|labels|entry-tags|exit-tags|snapshots|performance(?:\/cycles(?:\/[A-Za-z0-9_-]+)?)?|data\/(historical|pre-session|options-historical|expiry)|pattern\/(strategies|categories|chart\/by-date|ohlc\/(equity|options)))$/.test(route)
}
function awaitNative<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return promise
  return new Promise((resolve,reject)=>{
    const cleanup=()=>signal.removeEventListener('abort',abort)
    const abort=()=>{cleanup();reject(new DOMException('Analysis request cancelled','AbortError'))}
    signal.addEventListener('abort',abort,{once:true})
    promise.then(value=>{cleanup();if(signal.aborted)abort();else resolve(value)},error=>{cleanup();reject(error)})
    if(signal.aborted)abort()
  })
}
export function analysisRequest(baseUrl: string, token: string, native?: AnalysisRequest, onUnauthorized?:()=>void): AnalysisRequest {
  return async <T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> => {
    if (!validAnalysisPath(path, method)) throw new Error('Invalid analysis request')
    signal?.throwIfAborted()
    if (native) {
      try { const value=await awaitNative(native<T>(path,method,body,signal),signal);signal?.throwIfAborted();return value }
      catch(error){signal?.throwIfAborted();if(/\b401\b/.test(String(error)))onUnauthorized?.();throw error}
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/desktop/v1/analysis/${path}`, {
      method, signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    })
    signal?.throwIfAborted()
    if(response.status===401)onUnauthorized?.()
    if (!response.ok) throw new Error(`Analysis request failed (${response.status}): ${(await response.text()).slice(0, 240)}`)
    return (response.status === 204 ? null : await response.json()) as T
  }
}
export function createAnalysisApi(request: AnalysisRequest) {
  const sessions = new Map<string, { expires: number; value: Promise<SessionDetail> }>()
  const cycles = new Map<string, PerformanceCycle>()
  const history = new AnalysisHistoryCache()
  let generation = 0
  let disposed = false
  const pending = new Set<AbortController>()
  const invalidate = () => { generation++; pending.forEach(controller => controller.abort()); pending.clear(); sessions.clear(); cycles.clear(); history.clear() }
  const scopedRequest: AnalysisRequest = async <T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> => {
    if (disposed) throw new DOMException('Analysis account changed', 'AbortError')
    const current = generation
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    pending.add(controller)
    try {
      const value = await request<T>(path, method, body, controller.signal)
      controller.signal.throwIfAborted()
      if (disposed || current !== generation) throw new DOMException('Analysis request superseded', 'AbortError')
      return value
    } finally { pending.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  const params = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined && v !== null && v !== '').map(([k,v]) => [k, String(v)])).toString()
  type Result<K extends keyof AnalysisApi> = Awaited<ReturnType<AnalysisApi[K]>>
  const call = <K extends keyof AnalysisApi>(_key: K, path: string, query: Record<string, unknown> = {}, method: 'GET'|'POST'|'DELETE'='GET', body?:unknown):Promise<Result<K>> => {
    const url=`${path}?${params(query)}`
    const load=()=>scopedRequest<Result<K>>(url,method,body)
    return method==='GET'&&(path.startsWith('data/')||path.startsWith('pattern/ohlc/')) ? history.get(url,load) : load()
  }

  const remember = (cycle: PerformanceCycle) => { cycles.set(`${cycle.session_id}:${cycle.cycle_id}`, cycle); while (cycles.size > 200) cycles.delete(cycles.keys().next().value!) }
  const api: AnalysisApi = {
    getAnalysisSessions: opts => { invalidate(); return call('getAnalysisSessions', 'sessions', {symbol: opts?.symbol, start_date: opts?.startDate, end_date: opts?.endDate, include_shared: true, instrument_type: opts?.instrumentType, session_type: opts?.sessionType}) },
    getSessionDetail: id => {
      const cached = sessions.get(id)
      if (cached && cached.expires > Date.now()) return cached.value
      const current = generation
      const value = call('getSessionDetail', `sessions/${encodeURIComponent(id)}`).then(detail => { if (current === generation) detail.cycles?.forEach(remember); return detail }).catch(error => { if (sessions.get(id)?.value === value) sessions.delete(id); throw error })
      sessions.set(id, { expires: Date.now()+600_000, value }); while (sessions.size > 32) sessions.delete(sessions.keys().next().value!)
      return value
    },
    getRoundTrips: id => call('getRoundTrips', 'round-trips', {session_id:id}),
    getLabels: id => call('getLabels','labels',{session_id:id}),
    saveLabels: async labels => { const result = await call('saveLabels','labels',{},'POST',{labels}); invalidate(); return result },
    getEntryTags: async () => (await scopedRequest<{tags:string[]}>('entry-tags','GET')).tags,
    getExitTags: async () => (await scopedRequest<{tags:string[]}>('exit-tags','GET')).tags,
    getHistorical: (symbol,date,interval=3,days=2) => days === 0 ? Promise.resolve({symbol: symbol ?? 'NIFTY', dates:[], candles:[]}) : call('getHistorical','data/historical',{symbol,trading_date:date,interval_minutes:interval,historical_days:days}),
    getPreSession: async (symbol,date,time,interval=3) => (await history.get(`pre:${symbol}:${date}:${time}:${interval}`,()=>scopedRequest<{candles: Result<'getPreSession'>}>(`data/pre-session?${params({symbol,trading_date:date,start_time:time,interval_minutes:interval})}`,'GET'))).candles,
    getOptionsHistorical: (symbol,date,strike,expiry,right,interval=3,days=2) => call('getOptionsHistorical','data/options-historical',{symbol,date,strike,expiry,right,interval_minutes:interval,historical_days:days}),
    getExpiry: (symbol,date) => call('getExpiry','data/expiry',{symbol,date}),
    getSnapshots: id => call('getSnapshots','snapshots',{session_id:id}),
    deleteSnapshots: async id => { await call('deleteSnapshots','snapshots',{session_id:id},'DELETE') },
    patternListStrategies: () => call('patternListStrategies','pattern/strategies'),
    patternListCategories: () => call('patternListCategories','pattern/categories'),
    patternGetChartByDate: async (symbol,date,instrument) => { try { return await call('patternGetChartByDate','pattern/chart/by-date',{symbol,date,instrument_type:instrument}) } catch (error) { if (/\b404\b/.test(String(error))) return null; throw error } },
    patternOhlcEquity: (symbol,date,interval=3,days=2) => call('patternOhlcEquity','pattern/ohlc/equity',{symbol,date,interval_minutes:interval,days_back:days}),
    patternOhlcOptions: (symbol,date,strike,expiry,right,interval=3,days=2) => call('patternOhlcOptions','pattern/ohlc/options',{symbol,date,strike,expiry,right,interval_minutes:interval,days_back:days}),
  }
  const performance: AnalysisEnvironment['performance'] = {
    getPerformance: (filters:PerformanceFilters,signal) => scopedRequest<PerformanceReport>(`performance?${params({...filters,include_shared:true})}`,'GET',undefined,signal),
    getPerformanceCycles: async (filters,offset=0,signal) => { const current=generation; const page=await scopedRequest<{items:PerformanceCycle[];total:number;next_offset:number|null}>(`performance/cycles?${params({...filters,offset,include_shared:true})}`,'GET',undefined,signal); if(current===generation) page.items.forEach(remember); return page },
    getPerformanceDetail: async (cycle,enrich=false,signal) => { const current=generation; const detail=await scopedRequest<PerformanceCycle>(`performance/cycles/${encodeURIComponent(cycle.cycle_id)}?${params({session_id:cycle.session_id,enrich})}`,'GET',undefined,signal); if(current===generation) remember(detail); return detail },
  }
  return { api, performance, cycles, clear: invalidate, dispose: () => { disposed = true; invalidate() } }
}
