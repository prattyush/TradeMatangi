/**
 * Where heavy puzzle generators run (spec 17.7, correction C7). On the website the games share a renderer with the live
 * trading screen, so a long synchronous task (a solver, a grid search, a word-graph build) would delay tick handling and
 * clicks: those run in a module Web Worker behind this interface. The desktop Games window is its own WebView and may run
 * the same generators inline. No generator is heavy in the three Speed games; this is the seam the later games use.
 *
 * Budget: no Games task may block the main thread for more than `MAIN_THREAD_BUDGET_MS` while a session is active.
 */
export const MAIN_THREAD_BUDGET_MS = 8

export type GeneratorFn = (args: never) => unknown
export type GeneratorRegistry = Record<string, GeneratorFn>

export interface GeneratorHost {
  run<R>(name: string, args: unknown): Promise<R>
  dispose(): void
}

/** Runs generators on the calling thread. Fine for the desktop window and for tests. */
export function createInlineHost(registry: GeneratorRegistry): GeneratorHost {
  return {
    run: async <R,>(name: string, args: unknown) => {
      const fn = registry[name] as ((args: unknown) => R) | undefined
      if (!fn) throw new Error(`Unknown generator ${name}`)
      return fn(args)
    },
    dispose() { /* nothing to release */ },
  }
}

// --- Worker protocol -----------------------------------------------------------------------------------------------
interface Request { id: number; name: string; args: unknown }
interface Reply { id: number; result?: unknown; error?: string }

/** The slice of `Worker` that the host needs (also what a test double implements). */
export interface WorkerLike {
  postMessage(message: Request): void
  addEventListener(type: 'message', listener: (event: { data: Reply }) => void): void
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void
  terminate(): void
}

export function createWorkerHost(worker: WorkerLike): GeneratorHost {
  let nextId = 1
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>()
  worker.addEventListener('message', event => {
    const waiter = pending.get(event.data.id)
    if (!waiter) return
    pending.delete(event.data.id)
    if (event.data.error !== undefined) waiter.reject(new Error(event.data.error))
    else waiter.resolve(event.data.result as never)
  })
  worker.addEventListener('error', event => {
    const error = new Error(event.message || 'Generator worker failed')
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  return {
    run: <R,>(name: string, args: unknown) => new Promise<R>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (value: never) => void, reject })
      worker.postMessage({ id, name, args })
    }),
    dispose() {
      worker.terminate()
      const error = new Error('Generator host disposed')
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    },
  }
}

/** The worker side: answer each request from the registry. `scope` is the worker's global (`self`). */
export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: { data: Request }) => void): void
  postMessage(message: Reply): void
}

export function installWorkerRuntime(registry: GeneratorRegistry, scope: WorkerScope): void {
  scope.addEventListener('message', event => {
    const { id, name, args } = event.data
    try {
      const fn = registry[name] as ((args: unknown) => unknown) | undefined
      if (!fn) throw new Error(`Unknown generator ${name}`)
      scope.postMessage({ id, result: fn(args) })
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** Time one synchronous task in ms (`performance.now`); the benchmark tests use it to hold generators to the budget. */
export function timeTask<T>(task: () => T, now: () => number = () => performance.now()): { value: T; ms: number } {
  const start = now()
  const value = task()
  return { value, ms: now() - start }
}
