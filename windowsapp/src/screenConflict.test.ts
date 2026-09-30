import { describe, expect, it } from 'vitest'
import { mergeScreenDraft, mergeScreenState } from './screenConflict'

describe('mergeScreenState', () => {
  it('keeps independent local and remote presentation changes', () => {
    const base = { layout: '1', indicators: { a: ['EMA'] }, mode: 'Browse' }
    const local = { ...base, layout: '4-grid', indicators: { a: ['EMA'] } }
    const remote = { ...base, layout: '1', indicators: { a: ['RSI'] } }
    expect(mergeScreenState(base, local, remote)).toEqual({
      state: { layout: '4-grid', indicators: { a: ['RSI'] }, mode: 'Browse' },
      conflicts: [],
    })
  })

  it('merges indicators independently per tile', () => {
    const base = { indicators: { a: ['EMA'], b: [] } }
    const local = { indicators: { a: ['EMA'], b: ['RSI'] } }
    const remote = { indicators: { a: ['MACD'], b: [] } }
    expect(mergeScreenState(base, local, remote)).toEqual({
      state: { indicators: { a: ['MACD'], b: ['RSI'] } },
      conflicts: [],
    })
  })

  it('merges edits to different tiles independently', () => {
    const base = { tiles: [{ id: 'a', interval: '1' }, { id: 'b', interval: '1' }] }
    const local = { tiles: [{ id: 'a', interval: '3' }, { id: 'b', interval: '1' }] }
    const remote = { tiles: [{ id: 'a', interval: '1' }, { id: 'b', interval: '5' }] }
    expect(mergeScreenState(base, local, remote)).toEqual({
      state: { tiles: [{ id: 'a', interval: '3' }, { id: 'b', interval: '5' }] },
      conflicts: [],
    })
  })

  it('preserves a local tile reorder when the remote edits another field', () => {
    const base = { tiles: [{ id: 'a', interval: '1' }, { id: 'b', interval: '1' }], speed: '1' }
    const local = { ...base, tiles: [...base.tiles].reverse() }
    const remote = { ...base, speed: '2' }
    expect(mergeScreenState(base, local, remote)).toEqual({ state: { tiles: local.tiles, speed: '2' }, conflicts: [] })
  })

  it('preserves a remote tile reorder and independently added local tile', () => {
    const base = { tiles: [{ id: 'a' }, { id: 'b' }] }
    const local = { tiles: [...base.tiles, { id: 'c' }] }
    const remote = { tiles: [...base.tiles].reverse() }
    expect(mergeScreenState(base, local, remote).state.tiles).toEqual([{ id: 'b' }, { id: 'a' }, { id: 'c' }])
  })

  it('reports competing tile reorders', () => {
    const base = { tiles: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    const local = { tiles: [base.tiles[1], base.tiles[0], base.tiles[2]] }
    const remote = { tiles: [base.tiles[0], base.tiles[2], base.tiles[1]] }
    expect(mergeScreenState(base, local, remote).conflicts).toContain('tiles.order')
  })

  it('reports deletion versus editing the same tile', () => {
    const base = { tiles: [{ id: 'a', interval: '1' }, { id: 'b', interval: '1' }] }
    const local = { tiles: [base.tiles[0]] }
    const remote = { tiles: [base.tiles[0], { id: 'b', interval: '3' }] }
    expect(mergeScreenState(base, local, remote).conflicts).toContain('tiles.b')
  })

  it('keeps edits made during an in-flight save while accepting remote metadata', () => {
    const submitted = { state: { indicators: { a: ['EMA'], b: [] }, mode: 'Browse' }, name: 'Old', order: 0 }
    const latest = { ...submitted, state: { indicators: { a: ['EMA'], b: ['RSI'] }, mode: 'Browse' } }
    const saved = { state: { indicators: { a: ['MACD'], b: [] }, mode: 'Browse' }, name: 'Renamed', order: 1 }
    expect(mergeScreenDraft(submitted, latest, saved, true)).toEqual({
      draft: { state: { indicators: { a: ['MACD'], b: ['RSI'] }, mode: 'Browse' }, name: 'Renamed', order: 1 },
      conflicts: [],
    })
  })

  it('rejects competing lifecycle changes', () => {
    const base = { mode: 'Browse', session_id: undefined }
    const local = { mode: 'Paper', session_id: 'local-session' }
    const remote = { mode: 'Paper', session_id: 'remote-session' }
    expect(mergeScreenState(base, local, remote).conflicts).toEqual(['session_id'])
  })

  it('rejects a remote lifecycle change even when local only changed layout', () => {
    const base = { layout: '1', mode: 'Browse', session_id: undefined }
    const local = { layout: '4-grid', mode: 'Browse', session_id: undefined }
    const remote = { layout: '1', mode: 'Paper', session_id: 'session-1' }
    expect(mergeScreenState(base, local, remote).conflicts).toEqual(['mode', 'session_id'])
  })
})
