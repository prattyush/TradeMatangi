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

import { lookupVideoTitle, parseYoutubeVideoId } from '../../shared/analysis/videoLinks'

describe('parseYoutubeVideoId', () => {
  const id = 'dQw4w9WgXcQ'
  it('reads the id from every usual address', () => {
    for (const text of [
      `https://www.youtube.com/watch?v=${id}`, `http://youtube.com/watch?v=${id}&t=42s`, `https://m.youtube.com/watch?feature=share&v=${id}`,
      `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/live/${id}?feature=share`, `https://music.youtube.com/watch?v=${id}`, `www.youtube.com/watch?v=${id}`, `youtu.be/${id}`, `  ${id}  `, id,
    ]) expect(parseYoutubeVideoId(text), text).toBe(id)
  })
  it('refuses anything else', () => {
    for (const text of ['', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/playlist?list=PL123', 'https://www.youtube.com/watch?v=short',
      'https://evil.com/?u=https://youtu.be/dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'two words dQw4w9WgXcQ']) {
      expect(parseYoutubeVideoId(text), text).toBeNull()
    }
  })
})

describe('lookupVideoTitle', () => {
  it('returns the title from the oEmbed answer', async () => {
    let asked = ''
    const fetcher = (async (url: string) => { asked = url; return { ok: true, json: async () => ({ title: ' My video ' }) } }) as unknown as typeof fetch
    expect(await lookupVideoTitle('dQw4w9WgXcQ', fetcher)).toBe('My video')
    expect(asked).toBe('https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json')
  })
  it('gives null for a refusal, a network error, a bad answer or a bad id', async () => {
    expect(await lookupVideoTitle('dQw4w9WgXcQ', (async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull()
    expect(await lookupVideoTitle('dQw4w9WgXcQ', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
    expect(await lookupVideoTitle('dQw4w9WgXcQ', (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch)).toBeNull()
    expect(await lookupVideoTitle('bad', (async () => { throw new Error('must not be called') }) as unknown as typeof fetch)).toBeNull()
  })
})
