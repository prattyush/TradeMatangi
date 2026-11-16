import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { CODE_BREAKER_PARAMS, NUMBER_SERIES_PARAMS, PATTERN_MATRIX_PARAMS } from '../../config/difficulty.brain'
import { createInlineHost, createWorkerHost, installWorkerRuntime, type GeneratorRegistry, type WorkerLike } from '../../engine/generatorHost'
import { buildPuzzleSet } from '../../engine/puzzleHost'
import { generateCodes } from '../code_breaker/solver'
import { generateSeriesSet } from '../number_series/generator'
import { generateMatrices } from '../pattern_matrix/generator'
import { buildCodes, buildMatrices, buildSeries } from './host'
import { REASONING_GENERATORS } from './registry'

describe('Reasoning puzzle host', () => {
  it('without a Worker (plain node) each game builds its set on the calling thread, identical to the generator', async () => {
    expect(typeof Worker).toBe('undefined')
    const m = { params: paramsAt(PATTERN_MATRIX_PARAMS, 8), seed: 3, count: 4 }
    const s = { params: paramsAt(NUMBER_SERIES_PARAMS, 8), seed: 3, count: 4 }
    const c = { params: paramsAt(CODE_BREAKER_PARAMS, 8), seed: 3, count: 4 }
    expect(await buildMatrices(m)).toEqual(generateMatrices(m))
    expect(await buildSeries(s)).toEqual(generateSeriesSet(s))
    expect(await buildCodes(c)).toEqual(generateCodes(c))
  })
  it('through the worker protocol the result is the same as running inline', async () => {
    const listeners: Array<(event: { data: unknown }) => void> = []
    const replies: Array<(event: { data: never }) => void> = []
    installWorkerRuntime(REASONING_GENERATORS as unknown as GeneratorRegistry, { addEventListener: (_t: 'message', l: never) => void listeners.push(l), postMessage: (m: unknown) => void replies.forEach(l => l({ data: m as never })) } as never)
    const worker: WorkerLike = {
      postMessage: message => listeners.forEach(l => l({ data: message })),
      addEventListener: ((type: string, l: (event: never) => void) => { if (type === 'message') replies.push(l) }) as WorkerLike['addEventListener'],
      terminate: () => undefined,
    }
    const args = { params: paramsAt(CODE_BREAKER_PARAMS, 12), seed: 9, count: 3 }
    const viaWorker = await createWorkerHost(worker).run('codeBreaker', args)
    const inline = await createInlineHost(REASONING_GENERATORS as unknown as GeneratorRegistry).run('codeBreaker', args)
    expect(viaWorker).toEqual(inline)
  })
  it('a worker that cannot be made or that fails falls back to the calling thread', async () => {
    // `Worker` does not exist in node, so the factory is never called; fake one to see the failure path.
    const g = globalThis as { Worker?: unknown }
    g.Worker = class {}
    try {
      const registry = { echo: (args: { n: number }) => args.n * 2 } as unknown as GeneratorRegistry
      expect(await buildPuzzleSet<number>(() => { throw new Error('blocked') }, registry, 'echo', { n: 4 })).toBe(8)
      const failing = { postMessage() { throw new Error('boom') }, addEventListener() {}, terminate() {} }
      expect(await buildPuzzleSet<number>(() => failing, registry, 'echo', { n: 5 })).toBe(10)
    } finally { delete g.Worker }
  })
})
