import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createInlineHost, createWorkerHost, installWorkerRuntime, type GeneratorRegistry, type WorkerLike } from '../../engine/generatorHost'
import { ANAGRAM_DASH_PARAMS, LETTER_GRID_PARAMS, WORD_LADDER_PARAMS } from '../../config/difficulty.brain'
import { generateAnagramSet } from '../anagram_dash/generator'
import { generateGridSet } from '../letter_grid/generator'
import { generateLadderSet } from '../word_ladder/generator'
import { buildAnagrams, buildGrids, buildLadders } from './host'
import { WORD_GENERATORS } from './registry'

describe('Word puzzle host', () => {
  it('without a Worker (plain node) each game builds its set on the calling thread, identical to the generator', async () => {
    expect(typeof Worker).toBe('undefined')
    const a = { params: paramsAt(ANAGRAM_DASH_PARAMS, 5), seed: 3, count: 6 }
    const g = { params: paramsAt(LETTER_GRID_PARAMS, 1), seed: 3, count: 1 }
    const l = { params: paramsAt(WORD_LADDER_PARAMS, 5), seed: 3, count: 2 }
    expect(await buildAnagrams(a)).toEqual(await generateAnagramSet(a))
    expect(await buildGrids(g)).toEqual(await generateGridSet(g))
    expect(await buildLadders(l)).toEqual(await generateLadderSet(l))
  })
  it('through the worker protocol an ASYNCHRONOUS generator (it loads the lists first) gives the same result as running inline', async () => {
    const listeners: Array<(event: { data: unknown }) => void> = []
    const replies: Array<(event: { data: never }) => void> = []
    installWorkerRuntime(WORD_GENERATORS as unknown as GeneratorRegistry, { addEventListener: (_t: 'message', l: never) => void listeners.push(l), postMessage: (m: unknown) => void replies.forEach(l => l({ data: m as never })) } as never)
    const worker: WorkerLike = {
      postMessage: message => listeners.forEach(l => l({ data: message })),
      addEventListener: ((type: string, l: (event: never) => void) => { if (type === 'message') replies.push(l) }) as WorkerLike['addEventListener'],
      terminate: () => undefined,
    }
    const args = { params: paramsAt(ANAGRAM_DASH_PARAMS, 8), seed: 5, count: 4 }
    const viaWorker = await createWorkerHost(worker).run('anagramDash', args)
    const inline = await createInlineHost(WORD_GENERATORS as unknown as GeneratorRegistry).run('anagramDash', args)
    expect(viaWorker).toEqual(inline)
  })
  it('a generator that fails inside the worker reports the error instead of hanging', async () => {
    const replies: Array<(event: { data: never }) => void> = []
    const listeners: Array<(event: { data: unknown }) => void> = []
    installWorkerRuntime({ boom: async () => { throw new Error('no list') } } as unknown as GeneratorRegistry, { addEventListener: (_t: 'message', l: never) => void listeners.push(l), postMessage: (m: unknown) => void replies.forEach(l => l({ data: m as never })) } as never)
    const worker: WorkerLike = {
      postMessage: message => listeners.forEach(l => l({ data: message })),
      addEventListener: ((type: string, l: (event: never) => void) => { if (type === 'message') replies.push(l) }) as WorkerLike['addEventListener'],
      terminate: () => undefined,
    }
    await expect(createWorkerHost(worker).run('boom', {})).rejects.toThrow('no list')
  })
})
