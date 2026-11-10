import { privacyToSave, type VideoLinksApi } from './videoLinks'

export type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

export interface VisibilityResult {
  /** What YouTube reports after the change. It can differ from the request (YouTube keeps some videos Private). */
  applied: string
  /** Set when the visibility changed on YouTube but the saved label on the server could not be updated. */
  labelError: string
}

/**
 * Asks YouTube to change a video's visibility, then updates the label saved with each session so Analysis shows the truth.
 * A failed label update never hides that YouTube changed the video.
 */
export async function changeVisibility(
  deps: { invoke: Invoke; api: VideoLinksApi },
  video: { videoId: string; title: string; chapters: string; sessionIds: string[] },
  privacy: 'private' | 'unlisted' | 'public',
): Promise<VisibilityResult> {
  const applied = String(await deps.invoke('youtube_set_visibility', { videoId: video.videoId, privacy }))
  let labelError = ''
  for (const sessionId of video.sessionIds) {
    try { await deps.api.save({ sessionId, videoId: video.videoId, title: video.title, privacy: privacyToSave(applied, privacy), chapters: video.chapters }) }
    catch (e) { labelError = e instanceof Error ? e.message : String(e) }
  }
  return { applied, labelError }
}

export function visibilityResultText(requested: string, result: VisibilityResult): string {
  const label = (p: string) => (p === 'private' ? 'Private' : p === 'unlisted' ? 'Unlisted' : p === 'public' ? 'Public' : p)
  const base = result.applied === requested
    ? `Done: the video is now ${label(result.applied)} on YouTube.`
    : `YouTube kept the video ${label(result.applied)}. Change it in YouTube Studio.`
  return result.labelError ? `${base} The saved label could not be updated (${result.labelError}).` : base
}
