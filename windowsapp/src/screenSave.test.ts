import { describe, expect, it, vi } from 'vitest'
import { enqueueScreenSave, saveScreenRecord, type SavedScreenRecord } from './screenSave'
import type { ScreenDraft } from './screenConflict'

const base: SavedScreenRecord = { screen_id: 'screen-1', revision: 1, state: { layout: '1', mode: 'Browse' }, name: 'One', order: 0 }
const desired = { state: { layout: '2-side', mode: 'Browse' }, name: 'One', order: 0 }

describe('saveScreenRecord', () => {
  it('samples the current base and draft when each queued save starts', async () => {
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let currentBase = base
    let currentDraft: ScreenDraft = desired
    const seen: Array<{ revision: number; layout: unknown }> = []
    const first = enqueueScreenSave(Promise.resolve(), async () => {
      seen.push({ revision: currentBase.revision, layout: currentDraft.state.layout })
      await firstGate
      currentBase = { ...base, revision: 2, state: currentDraft.state }
    })
    const second = enqueueScreenSave(first, async () => {
      seen.push({ revision: currentBase.revision, layout: currentDraft.state.layout })
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    currentDraft = { ...desired, state: { ...desired.state, layout: '4-grid' } }
    releaseFirst?.()
    await Promise.all([first, second])
    expect(seen).toEqual([{ revision: 1, layout: '2-side' }, { revision: 2, layout: '4-grid' }])
  })

  it('keeps the caller base unchanged after a failed retry, then rechecks on the next save', async () => {
    const remote = { ...base, revision: 2, state: { layout: '1', mode: 'Browse', indicators: { a: ['EMA'] } } }
    let writes = 0
    const write = vi.fn(async (_id: string | undefined, revision: number | undefined, draft: ScreenDraft) => {
      writes += 1
      if (revision === 1) throw new Error('409 Conflict')
      if (writes === 2) throw new Error('network down')
      return { ...remote, revision: 3, ...draft }
    })
    const read = vi.fn(async () => remote)
    const transport = { write, read, isConflict: (error: unknown) => String(error).includes('409') }
    await expect(saveScreenRecord(base, desired, 'first', transport)).rejects.toThrow('network down')
    expect(base.revision).toBe(1)
    expect(await saveScreenRecord(base, desired, 'second', transport)).toMatchObject({ revision: 3, state: { layout: '2-side', mode: 'Browse', indicators: { a: ['EMA'] } } })
    expect(write.mock.calls.map(call => call[1])).toEqual([1, 2, 1, 2])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not retry when a protected lifecycle field changed remotely', async () => {
    const write = vi.fn(async () => { throw new Error('409 Conflict') })
    const read = vi.fn(async () => ({ ...base, revision: 2, state: { ...base.state, mode: 'Paper', session_id: 'paper-1' } }))
    await expect(saveScreenRecord(base, desired, 'mutation', { write, read, isConflict: () => true })).rejects.toThrow('protected fields')
    expect(write).toHaveBeenCalledTimes(1)
  })
})
