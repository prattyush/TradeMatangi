type Diagnostic = { at: number; name: string; duration?: number; value?: number }
const LIMIT = 600
const entries: Diagnostic[] = []
const counters: Record<string, number> = {}
let enabled = false

/** Opt in before reload: localStorage.setItem('tradingPerformance', '1'). */
export function startPerformanceDiagnostics(): () => void {
  enabled = localStorage.getItem('tradingPerformance') === '1'
  if (!enabled) return () => {}
  const host = window as unknown as { tradingPerformance?: unknown }
  host.tradingPerformance = { entries, counters, clear: () => { entries.length = 0; for (const key of Object.keys(counters)) delete counters[key] } }
  const observer = new PerformanceObserver(list => {
    for (const task of list.getEntries()) recordPerformance('long-task', task.duration)
  })
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({ type: 'longtask' })
  const timer = setInterval(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) recordPerformance('heap-bytes', undefined, memory.usedJSHeapSize)
  }, 60_000)
  return () => { observer.disconnect(); clearInterval(timer); enabled = false }
}

export function recordPerformance(name: string, duration?: number, value?: number): void {
  if (!enabled) return
  counters[name] = (counters[name] ?? 0) + 1
  entries.push({ at: performance.now(), name, duration, value })
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT)
}

export async function measureRequest<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!enabled) return operation()
  const start = performance.now()
  const pendingKey = `${name}-pending`
  counters[pendingKey] = (counters[pendingKey] ?? 0) + 1
  try { return await operation() }
  finally { counters[pendingKey]--; recordPerformance(name, performance.now() - start) }
}
