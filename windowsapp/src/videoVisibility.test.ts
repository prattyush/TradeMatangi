import { describe, expect, it, vi } from 'vitest'
import { changeVisibility, visibilityResultText } from './tools/videoVisibility'
import type { SavedLink, VideoLinksApi } from './tools/videoLinks'

const row = (sessionId: string): SavedLink => ({ session_id: sessionId, video_id: 'dQw4w9WgXcQ', url: '', title: 'T', privacy: 'unlisted', chapters: '', uploaded_at: '' })
const video = { videoId: 'dQw4w9WgXcQ', title: 'T', chapters: '0:00 Open', sessionIds: ['s1', 's2'] }
const apiWith = (save: VideoLinksApi['save']): VideoLinksApi => ({ list: async () => [], listMine: async () => [], remove: async () => {}, save })

describe('changeVisibility', () => {
  it('changes the video on YouTube and then the label of every session', async () => {
    const invoke = vi.fn(async () => 'unlisted')
    const save = vi.fn(async ({ sessionId }: { sessionId: string }) => row(sessionId))
    const result = await changeVisibility({ invoke, api: apiWith(save as never) }, video, 'unlisted')
    expect(invoke).toHaveBeenCalledWith('youtube_set_visibility', { videoId: 'dQw4w9WgXcQ', privacy: 'unlisted' })
    expect(result).toEqual({ applied: 'unlisted', labelError: '' })
    expect(save.mock.calls.map(c => [c[0].sessionId, c[0].privacy, c[0].chapters])).toEqual([['s1', 'unlisted', '0:00 Open'], ['s2', 'unlisted', '0:00 Open']])
  })

  it('saves the label YouTube reports, not the one that was asked for', async () => {
    const save = vi.fn(async ({ sessionId }: { sessionId: string }) => row(sessionId))
    const result = await changeVisibility({ invoke: async () => 'private', api: apiWith(save as never) }, video, 'unlisted')
    expect(result.applied).toBe('private')
    expect(save.mock.calls[0][0].privacy).toBe('private')
    expect(visibilityResultText('unlisted', result)).toMatch(/kept the video Private/)
  })

  it('does not touch the labels when YouTube refuses', async () => {
    const save = vi.fn()
    await expect(changeVisibility({ invoke: async () => { throw new Error('YouTube refused') }, api: apiWith(save as never) }, video, 'unlisted')).rejects.toThrow('YouTube refused')
    expect(save).not.toHaveBeenCalled()
  })

  it('reports a failed label update without hiding the change', async () => {
    const result = await changeVisibility({ invoke: async () => 'unlisted', api: apiWith((async () => { throw new Error('offline') }) as never) }, video, 'unlisted')
    expect(result.applied).toBe('unlisted')
    expect(visibilityResultText('unlisted', result)).toMatch(/now Unlisted.*could not be updated \(offline\)/)
  })
})
