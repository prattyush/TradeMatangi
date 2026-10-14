/** Browser-local trading message journal. No backend calls on the execution path. */
export type NotificationLevel = 'error' | 'warning' | 'info' | 'success'
export interface NotificationRecord {
  id: string
  message: string
  level: NotificationLevel
  source: string
  firstAt: number
  lastAt: number
  count: number
  sessionId?: string
  symbol?: string
  mode?: string
  unread: boolean
}
/** visible is the pending error FIFO; only its first entry is displayed. */
export interface NotificationState { records: NotificationRecord[]; visible: string[] }
export const NOTIFICATION_LIMIT = 100
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const listeners = new Set<() => void>()
let state: NotificationState = { records: [], visible: [] }
let storageKey = ''
export type NotificationContext = Pick<NotificationRecord, 'sessionId' | 'symbol' | 'mode'>
let context: NotificationContext = {}
let persistTimer: ReturnType<typeof setTimeout> | undefined
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const reported = new WeakSet<object>()
const recentErrors = new Map<string, { source: string; at: number }>()
export function subscribeNotifications(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getNotifications() { return state }
export function getNotificationScope() { return storageKey }
export function getNotificationContext() { return { ...context } }
export function flushNotifications() {
  if (persistTimer) clearTimeout(persistTimer)
  if (storageKey) try { localStorage.setItem(storageKey, JSON.stringify(state.records)) } catch {}
}
function publish(records: NotificationRecord[], visible: string[]) {
  const retained = new Set(records.map(record => record.id))
  visible = visible.filter(id => retained.has(id))
  for (const [id,timer] of timers) if (id !== visible[0]) { clearTimeout(timer); timers.delete(id) }
  state = { records, visible }; listeners.forEach(fn => fn())
  const active = visible[0]
  if (active && !timers.has(active)) timers.set(active,setTimeout(()=>dismissNotification(active),8000))
  // Batch storage writes off the user action/SSE callback path.
  if (persistTimer) clearTimeout(persistTimer)
  const key = storageKey
  const snapshot = records
  if (key) persistTimer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(snapshot)) } catch { /* Quota/privacy mode: memory history still works. */ } }, 100)
}
export function validNotification(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== 'object') return false
  const n = value as NotificationRecord
  return typeof n.id === 'string' && typeof n.message === 'string' && n.message.length <= 4000 &&
    ['error', 'warning', 'info', 'success'].includes(n.level) && typeof n.source === 'string' &&
    Number.isFinite(n.firstAt) && Number.isFinite(n.lastAt) && Number.isInteger(n.count) && n.count > 0 &&
    typeof n.unread === 'boolean' && [n.sessionId, n.symbol, n.mode].every(v => v == null || typeof v === 'string')
}
export function setNotificationAccount(account: string | null, backend = '') {
  const key = account ? `tradematangi_notifications_v1:${backend}:${account}` : ''
  if (key === storageKey) return
  if (persistTimer) { clearTimeout(persistTimer); if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(state.records)) } catch {} } }
  timers.forEach(timer => clearTimeout(timer)); timers.clear(); recentErrors.clear(); context = {}; storageKey = key
  let records: NotificationRecord[] = []
  if (key) try { const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); if (Array.isArray(parsed)) records = parsed.filter(validNotification).filter(n => n.lastAt > Date.now()-RETENTION_MS).slice(0,NOTIFICATION_LIMIT) } catch {}
  // Restoring history must not replay old flashes.
  publish(records, [])
}
export function setNotificationContext(value: typeof context) { context = value }
export function dismissNotification(id: string) {
  const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id)
  publish(state.records, state.visible.filter(item => item !== id))
}
export function markNotificationsRead() { publish(state.records.map(n => ({ ...n, unread: false })), state.visible) }
export function clearNotifications() { timers.forEach(timer => clearTimeout(timer)); timers.clear(); publish([], []) }
export function flashMessage(message: string, level: NotificationLevel = 'error', source = 'Website', details: NotificationContext = context) {
  const text = message.replace(/^Error:\s*/, '').trim().slice(0,4000)
  if (!text) return
  const now = Date.now()
  const previous = state.records.find(n => n.message === text && n.level === level && n.sessionId === details.sessionId && now-n.lastAt < 30_000)
  const entry: NotificationRecord = previous ? { ...previous, lastAt: now, count: previous.count+1, unread: true } : {
    id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`,
    message: text, level, source, firstAt: now, lastAt: now, count: 1, unread: true, ...details,
  }
  const records = [entry, ...state.records.filter(n => n.id !== entry.id && now-n.lastAt < RETENTION_MS)].slice(0,NOTIFICATION_LIMIT)
  // Repeated active messages update counts without extending their display time.
  // Suppress repeated flashes in this short window even after dismissal.
  const visible = previous || level !== 'error' ? state.visible : [...state.visible,entry.id]
  publish(records,visible)
}
export function flashError(error: unknown, source = 'Website', details: NotificationContext = context) {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return
  if (error && typeof error === 'object') { if (reported.has(error)) return; reported.add(error) }
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '').trim()
  const key = `${details.sessionId ?? ''}:${message}`
  const previous = recentErrors.get(key)
  if (previous && previous.source !== source && Date.now() - previous.at < 1000) return
  recentErrors.set(key, { source, at: Date.now() })
  while (recentErrors.size > NOTIFICATION_LIMIT) recentErrors.delete(recentErrors.keys().next().value!)
  flashMessage(message, 'error', source, details)
}


export function flashPatternAlert(alert: {title: string; description: string; severity: string; pattern?: string; category?: string; trade_suggestion?: string | null}) {
  const message = [alert.title, alert.pattern && `Pattern: ${alert.pattern}`, alert.category && `Category: ${alert.category}`, alert.description, alert.trade_suggestion].filter(Boolean).join('\n')
  flashMessage(message,alert.severity === 'critical' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info','Pattern alert')
}
