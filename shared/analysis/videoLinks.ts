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

/** One video, shown once even when it is saved under several sessions. */
export interface SavedVideo {
  videoId: string
  url: string
  title: string
  privacy: string
  chapters: string
  uploadedAt: string
  sessionIds: string[]
}

/** Analysis shows saved videos only when the host gives it this (website and desktop do; nothing else needs to). */
export interface VideoLinksSource {
  list(sessionId: string): Promise<SavedLink[]>
  /** Opens the video on YouTube in the system browser. */
  open(video: { videoId: string; url: string }): void
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
export const isVideoId = (id: string): boolean => VIDEO_ID.test(id)

/** The player address, or null for anything that is not a well-formed video id. No cookies are set until the viewer plays. */
export function embedUrl(videoId: string): string | null {
  return isVideoId(videoId) ? `https://www.youtube-nocookie.com/embed/${videoId}?rel=0` : null
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

/**
 * Loads the links of several sessions. A session that is not the viewer's own (shared read-only) or has no links answers
 * 404 and counts as "nothing"; any other failure is returned as `error` while the links that did load are kept.
 */
export async function loadSavedVideos(source: Pick<VideoLinksSource, 'list'>, sessionIds: string[]): Promise<{ videos: SavedVideo[]; error: string }> {
  const settled = await Promise.allSettled(sessionIds.map(id => source.list(id)))
  const rows = settled.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !/\b404\b/.test(String(r.reason?.message ?? r.reason)))
  return { videos: groupSavedVideos(rows), error: failed ? String(failed.reason?.message ?? failed.reason) : '' }
}

/** Shown beside a private video: an embed only plays once the video is Unlisted or Public. */
export const PRIVATE_EMBED_NOTE = 'This video is Private on YouTube, so it cannot play here. In YouTube Studio set its visibility to Unlisted, then use Play here. Open on YouTube works when you are signed in to the owning account.'
export const EMBED_NOTE = 'Plays only if the video is Unlisted or Public in YouTube Studio. If it shows “Video unavailable”, use Open on YouTube.'
