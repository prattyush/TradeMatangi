import { describe, expect, it, vi } from 'vitest'
import { enqueueScreenSave, saveScreenRecord, type SavedScreenRecord } from './screenSave'
import { mergeScreenDraft, screenContentKey, type ScreenDraft } from './screenConflict'

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


describe('autosave deduplication', () => {
  it('stops saving after a server/Rust response reorders the same screen content', async () => {
    const submitted: ScreenDraft = { name: 'One', order: 0, state: { id: 'screen-1', layout: '2-side', mode: 'Browse', tiles: [{ id: 'tile', symbol: 'NIFTY' }], session_id: undefined } }
    const write = vi.fn(async (_id, revision, draft: ScreenDraft) => ({
      screen_id: 'screen-1', revision: (revision ?? 0) + 1, name: draft.name, order: draft.order,
      state: { tiles: [{ symbol: 'NIFTY', id: 'tile' }], mode: 'Browse', layout: draft.state.layout, id: 'screen-1' },
    }))
    const transport = { write, read: vi.fn(), isConflict: () => false }
    let persisted = await saveScreenRecord(base, submitted, 'first', transport)
    const returnedDraft = { state: persisted.state, name: persisted.name, order: persisted.order }
    const reconciled = mergeScreenDraft(submitted, submitted, returnedDraft, true).draft
    const savedKey = screenContentKey({ id: 'screen-1', ...returnedDraft })
    const nextKey = screenContentKey({ id: 'screen-1', ...submitted })
    expect(savedKey).toBe(nextKey)
    expect(screenContentKey(reconciled)).toBe(screenContentKey(returnedDraft))
    for (let n = 0; n < 5; n += 1) persisted = await saveScreenRecord(persisted, submitted, `repeat-${n}`, transport)
    expect(write).toHaveBeenCalledTimes(1)
    expect(persisted.revision).toBe(2)
  })

  it('coalesces redundant queued saves after the first write completes', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let persisted = base
    const write = vi.fn(async (_id, revision, draft: ScreenDraft) => {
      await gate
      return { ...base, ...draft, revision: (revision ?? 0) + 1 }
    })
    const transport = { write, read: vi.fn(), isConflict: () => false }
    const execute = async () => { persisted = await saveScreenRecord(persisted, desired, 'queued', transport) }
    const first = enqueueScreenSave(Promise.resolve(), execute)
    const second = enqueueScreenSave(first, execute)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    release?.()
    await Promise.all([first, second])
    expect(write).toHaveBeenCalledTimes(1)
    expect(persisted.revision).toBe(2)
  })

  it('preserves an actual edit made while an earlier save is in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let persisted = base
    let current: ScreenDraft = desired
    const write = vi.fn(async (_id, revision, draft: ScreenDraft) => {
      if (revision === 1) await gate
      return { ...base, ...draft, revision: (revision ?? 0) + 1 }
    })
    const transport = { write, read: vi.fn(), isConflict: () => false }
    const execute = async () => {
      const submitted = current
      const returned = await saveScreenRecord(persisted, submitted, 'edit', transport)
      current = mergeScreenDraft(submitted, current, { state: returned.state, name: returned.name, order: returned.order }, true).draft
      persisted = returned
    }
    const first = enqueueScreenSave(Promise.resolve(), execute)
    const second = enqueueScreenSave(first, execute)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    current = { ...desired, state: { ...desired.state, layout: '4-grid' } }
    release?.()
    await Promise.all([first, second])
    expect(write.mock.calls.map(call => [call[1], call[2].state.layout])).toEqual([[1, '2-side'], [2, '4-grid']])
    expect(persisted.state.layout).toBe('4-grid')
  })
})
