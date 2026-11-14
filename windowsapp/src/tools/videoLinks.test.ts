import { describe, expect, it, vi } from 'vitest'
import { validAnalysisPath } from '../analysisApi'
import { createVideoLinksApi, groupSavedVideos, privacyToSave, saveOutcomeText, saveVideoUnderSessions, type SavedLink, type VideoLinksApi } from './videoLinks'

const link = (over: Partial<SavedLink> = {}): SavedLink => ({
  session_id: 's1', video_id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'T', privacy: 'private', chapters: '', uploaded_at: '2026-11-09T10:00:00+00:00', ...over,
})

describe('createVideoLinksApi', () => {
  it('uses only paths the desktop allows', async () => {
    const request = vi.fn(async (path: string, method: string) => {
      expect(validAnalysisPath(path, method)).toBe(true)
      return { links: [link()] } as never
    })
    const api = createVideoLinksApi(request as never)
    expect(await api.list('a b')).toHaveLength(1)
    await api.save({ sessionId: 's1', videoId: 'dQw4w9WgXcQ', title: 'T', privacy: 'private', chapters: '0:00 Open' })
    expect(await api.listMine()).toHaveLength(1)
    await api.remove('s1', 'dQw4w9WgXcQ')
    expect(request.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['video-links?session_id=a%20b', 'GET'],
      ['video-links', 'POST'],
      ['video-links/mine', 'GET'],
      ['video-links?session_id=s1&video_id=dQw4w9WgXcQ', 'DELETE'],
    ])
    expect(request.mock.calls[1][2]).toEqual({ session_id: 's1', video_id: 'dQw4w9WgXcQ', title: 'T', privacy: 'private', chapters: '0:00 Open' })
  })

  it('does not allow other methods or paths', () => {
    expect(validAnalysisPath('video-links?session_id=s1', 'GET')).toBe(true)
    expect(validAnalysisPath('video-links', 'POST')).toBe(true)
    expect(validAnalysisPath('video-links?session_id=s1&video_id=x', 'DELETE')).toBe(true)
    expect(validAnalysisPath('video-links/mine', 'GET')).toBe(true)
    for (const method of ['POST', 'DELETE', 'PUT']) expect(validAnalysisPath('video-links/mine', method)).toBe(false)
    expect(validAnalysisPath('video-links/extra', 'GET')).toBe(false)
    expect(validAnalysisPath('video-links', 'PUT')).toBe(false)
  })
})

describe('groupSavedVideos', () => {
  it('shows a video once with all its sessions, newest first', () => {
    const rows = [
      link({ session_id: 's1' }),
      link({ session_id: 's2' }),
      link({ session_id: 's1', video_id: 'abcdefghijk', title: 'Newer', uploaded_at: '2026-11-10T10:00:00+00:00' }),
    ]
    const videos = groupSavedVideos(rows)
    expect(videos.map(v => v.videoId)).toEqual(['abcdefghijk', 'dQw4w9WgXcQ'])
    expect(videos[1].sessionIds).toEqual(['s1', 's2'])
  })
  it('is empty for no links', () => expect(groupSavedVideos([])).toEqual([]))
})

describe('privacyToSave', () => {
  it('keeps what YouTube applied', () => {
    expect(privacyToSave('private', 'public')).toBe('private')
    expect(privacyToSave('unlisted', 'private')).toBe('unlisted')
  })
  it('falls back to the request when the applied value is missing or odd', () => {
    expect(privacyToSave(null, 'unlisted')).toBe('unlisted')
    expect(privacyToSave('weird', 'private')).toBe('private')
  })
})

describe('saveVideoUnderSessions', () => {
  const fake = (failFor: string[]): VideoLinksApi => ({
    list: async () => [],
    listMine: async () => [],
    listMine: async () => [],
    remove: async () => {},
    save: async ({ sessionId }) => { if (failFor.includes(sessionId)) throw new Error('Session not found'); return link({ session_id: sessionId }) },
  })
  const video = { videoId: 'dQw4w9WgXcQ', title: 'T', privacy: 'private' as const, chapters: '' }

  it('saves under every session', async () => {
    const outcome = await saveVideoUnderSessions(fake([]), ['s1', 's2'], video)
    expect(outcome).toEqual({ saved: 2, failed: [] })
    expect(saveOutcomeText(outcome, 2)).toBe('Link saved with 2 sessions.')
  })
  it('keeps going when one session fails and says so', async () => {
    const outcome = await saveVideoUnderSessions(fake(['s1']), ['s1', 's2'], video)
    expect(outcome.saved).toBe(1)
    expect(outcome.failed).toEqual([{ sessionId: 's1', message: 'Session not found' }])
    expect(saveOutcomeText(outcome, 2)).toMatch(/could not be saved \(Session not found\)/)
  })
  it('explains when there is no recording', () => {
    expect(saveOutcomeText({ saved: 0, failed: [] }, 0)).toMatch(/no recording is open/)
    expect(saveOutcomeText({ saved: 1, failed: [] }, 1)).toBe('Link saved with the session.')
  })
})

describe('loadSavedVideos with an unexpected answer', () => {
  it('treats a missing or non-list answer as no links instead of failing', async () => {
    const { loadSavedVideos } = await import('../../../shared/analysis/videoLinks')
    const source = { list: async (id: string) => (id === 'a' ? (undefined as never) : id === 'b' ? ({} as never) : [{ session_id: 'c', video_id: 'abcdefghijk', url: 'u', title: 't', privacy: 'unlisted', chapters: '', uploaded_at: '2026-11-09T00:00:00Z' }]) }
    const result = await loadSavedVideos(source, ['a', 'b', 'c'])
    expect(result.error).toBe('')
    expect(result.videos.map(video => video.videoId)).toEqual(['abcdefghijk'])
  })
})
