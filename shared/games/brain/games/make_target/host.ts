/** Where Make Target puzzles are built: a module Web Worker when the browser has one, otherwise on the calling thread. */
import { createInlineHost, createWorkerHost, type GeneratorHost, type GeneratorFn, type WorkerLike } from '../../engine/generatorHost'
import { generatePuzzles, type GenerateArgs, type Puzzle } from './solver'

const registry = { makeTarget: generatePuzzles as unknown as GeneratorFn }

function createHost(): { host: GeneratorHost; worker: boolean } {
  try {
    if (typeof Worker !== 'undefined') {
      const worker = new Worker(new URL('./makeTarget.worker.ts', import.meta.url), { type: 'module' })
      return { host: createWorkerHost(worker as unknown as WorkerLike), worker: true }
    }
  } catch { /* no module workers here: build on this thread */ }
  return { host: createInlineHost(registry), worker: false }
}

/**
 * Build a puzzle set. A worker that fails (blocked by the page's security policy, a build without the worker file) falls back
 * to the calling thread, so the game still starts. The worker is released as soon as the set is ready.
 */
export async function buildPuzzles(args: GenerateArgs): Promise<Puzzle[]> {
  const { host, worker } = createHost()
  try {
    return await host.run<Puzzle[]>('makeTarget', args)
  } catch (error) {
    if (!worker) throw error
    return createInlineHost(registry).run<Puzzle[]>('makeTarget', args)
  } finally {
    host.dispose()
  }
}
