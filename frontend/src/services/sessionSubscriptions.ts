import type { SessionGroupResponse } from './api'

/** Group refresh may lag start/attach; the selected active session owns a stream. */
export function activeSessionSubscriptions(group: SessionGroupResponse | null, sessionId: string | null, state: string): string[] {
  return Array.from(new Set([
    ...(group?.members.filter(member => member.state !== 'ended').map(member => member.session_id) ?? []),
    ...(sessionId && state !== 'ended' ? [sessionId] : []),
  ].filter(Boolean))).sort()
}
