import { describe, expect, it } from 'vitest'
import { embedUrl, isVideoId, loadSavedVideos, type SavedLink } from '../../shared/analysis/videoLinks'

const link = (over: Partial<SavedLink> = {}): SavedLink => ({
  session_id: 's1', video_id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'T', privacy: 'unlisted', chapters: '', uploaded_at: '2026-11-09T10:00:00+00:00', ...over,
})

describe('embedUrl', () => {
  it('builds the no-cookie player address for a well-formed id', () => {
    expect(embedUrl('dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0')
  })
  it('refuses anything that is not a video id', () => {
    for (const id of ['', 'short', 'has space!!', 'dQw4w9WgXcQ/../x', 'javascript:alert(1)', 'dQw4w9WgXcQ?autoplay=1']) {
      expect(isVideoId(id)).toBe(false)
      expect(embedUrl(id)).toBeNull()
    }
  })
})

describe('loadSavedVideos', () => {
  it('merges the sessions and shows a shared video once', async () => {
    const rows: Record<string, SavedLink[]> = { s1: [link()], s2: [link({ session_id: 's2' })], s3: [] }
    const { videos, error } = await loadSavedVideos({ list: async id => rows[id] }, ['s1', 's2', 's3'])
    expect(error).toBe('')
    expect(videos).toHaveLength(1)
    expect(videos[0].sessionIds).toEqual(['s1', 's2'])
  })
  it('treats 404 (not the owner, or no links) as nothing, without an error', async () => {
    const { videos, error } = await loadSavedVideos({ list: async () => { throw new Error('Saved videos request failed: 404') } }, ['s1'])
    expect(videos).toEqual([])
    expect(error).toBe('')
  })
  it('keeps the links that loaded and reports other failures', async () => {
    const { videos, error } = await loadSavedVideos({
      list: async id => { if (id === 's2') throw new Error('Saved videos request failed: 500'); return [link()] },
    }, ['s1', 's2'])
    expect(videos).toHaveLength(1)
    expect(error).toMatch(/500/)
  })
  it('also treats the desktop wording of a 404 as nothing', async () => {
    const { error } = await loadSavedVideos({ list: async () => { throw new Error('Analysis request failed (404 Not Found): {"detail":"Session not found"}') } }, ['s1'])
    expect(error).toBe('')
  })
})
