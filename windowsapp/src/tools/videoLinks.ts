import type { AnalysisRequest } from '../analysisApi'
import type { Privacy } from './videoMakerModel'

/** A saved YouTube link as the server returns it (one row per trading session). */
export interface SavedLink {
  session_id: string
  video_id: string
  url: string
  title: string
  privacy: string
  chapters: string
  uploaded_at: string
}

/** One video, shown once even when it is saved under several sessions of the same recording. */
export interface SavedVideo {
  videoId: string
  url: string
  title: string
  privacy: string
  chapters: string
  uploadedAt: string
  sessionIds: string[]
}

export interface VideoLinksApi {
  list(sessionId: string): Promise<SavedLink[]>
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
    save: ({ sessionId, videoId, title, privacy, chapters }) =>
      request<SavedLink>('video-links', 'POST', { session_id: sessionId, video_id: videoId, title, privacy, chapters }),
    remove: async (sessionId, videoId) => {
      await request(`video-links?session_id=${encodeURIComponent(sessionId)}&video_id=${encodeURIComponent(videoId)}`, 'DELETE')
    },
  }
}

/** Groups the rows of several sessions by video, newest upload first. */
export function groupSavedVideos(links: SavedLink[]): SavedVideo[] {
  const byVideo = new Map<string, SavedVideo>()
  for (const l of links) {
    const known = byVideo.get(l.video_id)
    if (known) {
      if (!known.sessionIds.includes(l.session_id)) known.sessionIds.push(l.session_id)
      if (l.uploaded_at > known.uploadedAt) Object.assign(known, { title: l.title, privacy: l.privacy, chapters: l.chapters, uploadedAt: l.uploaded_at })
    } else {
      byVideo.set(l.video_id, { videoId: l.video_id, url: l.url, title: l.title, privacy: l.privacy, chapters: l.chapters, uploadedAt: l.uploaded_at, sessionIds: [l.session_id] })
    }
  }
  return [...byVideo.values()].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0))
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
