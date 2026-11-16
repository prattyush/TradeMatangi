/**
 * Builds a game's whole puzzle set before the block starts, off the main thread when the browser has a module Web Worker
 * (spec 17.7, C7) and on the calling thread otherwise. Each game keeps its own `new Worker(new URL('./x.worker.ts',
 * import.meta.url))` (the bundler needs the literal path in the file that uses it) and passes it in as `makeWorker`.
 */
import { createInlineHost, createWorkerHost, type GeneratorRegistry, type WorkerLike } from './generatorHost'

export async function buildPuzzleSet<R>(makeWorker: () => unknown, registry: GeneratorRegistry, name: string, args: unknown): Promise<R> {
  let worker: unknown = null
  try { if (typeof Worker !== 'undefined') worker = makeWorker() } catch { /* no module workers here: build on this thread */ }
  if (!worker) return createInlineHost(registry).run<R>(name, args)
  const host = createWorkerHost(worker as WorkerLike)
  try {
    return await host.run<R>(name, args)
  } catch {
    // A worker that fails (blocked by the page's policy, a build without the file): fall back to the calling thread.
    return await createInlineHost(registry).run<R>(name, args)
  } finally {
    host.dispose()
  }
}
