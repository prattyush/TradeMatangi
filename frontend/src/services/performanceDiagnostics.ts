type Diagnostic = { at: number; name: string; duration?: number; value?: number; utcMs?: number; eventId?: unknown; scope?: string; sentAtMs?: number }
const LIMIT = 600
const entries: Diagnostic[] = []
const counters: Record<string, number> = {}
let enabled = false

/** Opt in before reload: localStorage.setItem('tradingPerformance', '1'). */
export function startPerformanceDiagnostics(): () => void {
  try { enabled = localStorage.getItem('tradingPerformance') === '1' } catch { enabled = false }
  if (!enabled) return () => {}
  const host = window as unknown as { tradingPerformance?: unknown }
  host.tradingPerformance = { entries, counters, clear: () => { entries.length = 0; for (const key of Object.keys(counters)) delete counters[key] } }
  const observer = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver(list => {
    for (const task of list.getEntries()) recordPerformance('long-task', task.duration)
  })
  if (observer && PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({ type: 'longtask' })
  const timer = setInterval(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) recordPerformance('heap-bytes', undefined, memory.usedJSHeapSize)
  }, 60_000)
  return () => { observer?.disconnect(); clearInterval(timer); enabled = false }
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

const feedSamples = new Map<string, { id: unknown; at: number }>()
const operationSamples = new Map<string, number>()

/** Bounded, opt-in correlation. Cross-machine clock delta is not exact latency. */
export function recordFeedReceipt(event: unknown, scope: string): void {
  if (!enabled || !event || typeof event !== 'object') return
  const marker = (event as Record<string, unknown>)._feed_diagnostic as { event_id?: unknown; sent_at_ms?: number } | undefined
  if (!marker || !Number.isFinite(marker.sent_at_ms)) return
  const previous = feedSamples.get(scope)
  if (previous?.id === marker.event_id) return
  const at = performance.now()
  if (!feedSamples.has(scope) && feedSamples.size >= 128) feedSamples.delete(feedSamples.keys().next().value!)
  feedSamples.set(scope, { id: marker.event_id, at })
  entries.push({ at, name: "feed-sample", utcMs: Date.now(), eventId: marker.event_id, scope, sentAtMs: marker.sent_at_ms })
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT)
  recordPerformance(`${scope.split(':')[0]}-feed-clock-delta-ms`, undefined, Date.now() - marker.sent_at_ms!)
  if (previous) recordPerformance(`${scope.split(':')[0]}-feed-receipt-gap-ms`, at - previous.at)
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => recordPerformance('feed-next-frame-ms', performance.now() - at))
}

export function beginPerformanceSample(name: string): number | undefined {
  if (!enabled) return undefined
  const now = performance.now()
  if (now - (operationSamples.get(name) ?? -Infinity) < 1000) return undefined
  operationSamples.set(name, now)
  return now
}

export function endPerformanceSample(name: string, started: number | undefined): void {
  if (started !== undefined) recordPerformance(name, performance.now() - started)
}
