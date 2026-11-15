/** Send queued sessions to the server, re-applying each on top of the latest state when a revision moved (spec 8.4). */
import { buildSessionPut, alreadyApplied, type ProgressState } from '../core/progress'
import { isConflict, isRejected, type GamesClient } from '../core/client'
import type { Outbox } from './outbox'

export interface FlushReport {
  sent: number
  /** Already on the server (a retry after a lost response) or refused as invalid. */
  dropped: number
  pending: number
  /** The latest state seen (after the flush), when one was read. */
  state?: ProgressState
  /** Last transient error (offline, server down); the entries stay queued. */
  error?: unknown
  /** Sessions the server rejected as invalid (422 and the like), dropped so they cannot block the queue. */
  rejected: string[]
}

const MAX_CONFLICT_RETRIES = 3

export async function flushOutbox(outbox: Outbox, client: GamesClient): Promise<FlushReport> {
  const report: FlushReport = { sent: 0, dropped: 0, pending: 0, rejected: [] }
  const entries = await outbox.list()
  for (const entry of entries) {
    let settled = false
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES && !settled; attempt++) {
      try {
        const state = await client.getState()
        report.state = state
        if (alreadyApplied(state, entry.session)) { await outbox.remove(entry.id); report.dropped += 1; settled = true; break }
        await client.putState(buildSessionPut(state, entry.session))
        await outbox.remove(entry.id)
        report.sent += 1
        settled = true
      } catch (error) {
        if (isConflict(error) && attempt < MAX_CONFLICT_RETRIES) continue
        if (isRejected(error)) { await outbox.remove(entry.id); report.dropped += 1; report.rejected.push(entry.id); settled = true; break }
        await outbox.bumpAttempts(entry.id).catch(() => undefined)
        report.error = error
        report.pending = (await outbox.list()).length
        return report
      }
    }
  }
  if (report.sent) {
    try { report.state = await client.getState() } catch { /* the entries are already stored; the next load reads the state */ }
  }
  report.pending = (await outbox.list()).length
  return report
}

/** Queue a finished session, then try to send everything that is waiting. Never throws: the queue is the safety net. */
export async function recordSession(outbox: Outbox, client: GamesClient, session: import('../core/progress').SessionResult): Promise<FlushReport> {
  await outbox.add(session)
  return flushOutbox(outbox, client).catch(error => ({ sent: 0, dropped: 0, pending: 1, rejected: [], error }))
}
