import type { AnalysisRequest } from '../analysisApi'
import type { Privacy } from './videoMakerModel'
import type { SavedLink } from '../../../shared/analysis/videoLinks'

export type { SavedLink, SavedVideo } from '../../../shared/analysis/videoLinks'
export { groupSavedVideos } from '../../../shared/analysis/videoLinks'

export interface VideoLinksApi {
  list(sessionId: string): Promise<SavedLink[]>
  /** Every saved video of the signed-in user (newest first), whatever the session. */
  listMine(): Promise<SavedLink[]>
  save(link: { sessionId: string; videoId: string; title: string; privacy: Privacy; chapters: string }): Promise<SavedLink>
  remove(sessionId: string, videoId: string): Promise<void>
}

/**
 * Saved links live on the server, tied to the trading session and visible to its owner only.
 * The server builds the address from the video id, so only the id is sent.
 */
export function createVideoLinksApi(request: AnalysisRequest): VideoLinksApi {
  return {
    list: async sessionId => (await request<{ links: SavedLink[] }>(`video-links?session_id=${encodeURIComponent(sessionId)}`, 'GET')).links,
    listMine: async () => (await request<{ links: SavedLink[] }>('video-links/mine', 'GET')).links,
    save: ({ sessionId, videoId, title, privacy, chapters }) =>
      request<SavedLink>('video-links', 'POST', { session_id: sessionId, video_id: videoId, title, privacy, chapters }),
    remove: async (sessionId, videoId) => {
      await request(`video-links?session_id=${encodeURIComponent(sessionId)}&video_id=${encodeURIComponent(videoId)}`, 'DELETE')
    },
  }
}

/** The visibility to remember: what YouTube applied, falling back to what was asked for. */
export function privacyToSave(applied: string | null, requested: Privacy): Privacy {
  return applied === 'private' || applied === 'unlisted' || applied === 'public' ? applied : requested
}

export type SaveOutcome = { saved: number; failed: Array<{ sessionId: string; message: string }> }

/** Saves one video under each session. A session that fails does not stop the others. */
export async function saveVideoUnderSessions(
  api: VideoLinksApi, sessionIds: string[], link: { videoId: string; title: string; privacy: Privacy; chapters: string },
): Promise<SaveOutcome> {
  const outcome: SaveOutcome = { saved: 0, failed: [] }
  for (const sessionId of sessionIds) {
    try { await api.save({ sessionId, ...link }); outcome.saved += 1 } catch (e) { outcome.failed.push({ sessionId, message: e instanceof Error ? e.message : String(e) }) }
  }
  return outcome
}

export function saveOutcomeText(outcome: SaveOutcome, wanted: number): string {
  if (wanted === 0) return 'The link was not saved because no recording is open. Copy it from here.'
  if (outcome.failed.length === 0) return wanted === 1 ? 'Link saved with the session.' : `Link saved with ${wanted} sessions.`
  const first = outcome.failed[0].message
  return `The link could not be saved (${first}). Copy it from here, or try “Save link” again.`
}

export function formatUploadedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
