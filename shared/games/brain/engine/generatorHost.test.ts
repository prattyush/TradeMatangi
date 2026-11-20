import { describe, expect, it } from 'vitest'
import { createInlineHost, createWorkerHost, installWorkerRuntime, MAIN_THREAD_BUDGET_MS, timeTask, type WorkerLike, type WorkerScope } from './generatorHost'

const registry = { double: (n: number) => n * 2, boom: () => { throw new Error('bad input') } }

/** A worker double: messages go to the runtime and replies come back asynchronously, as with a real Worker. */
function pair() {
  const toWorker: Array<(e: { data: never }) => void> = []
  const toHost: { message: Array<(e: { data: never }) => void>; error: Array<(e: { message?: string }) => void> } = { message: [], error: [] }
  const scope: WorkerScope = {
    addEventListener: (_t, listener) => { toWorker.push(listener as never) },
    postMessage: reply => { queueMicrotask(() => toHost.message.forEach(l => l({ data: reply as never }))) },
  }
  installWorkerRuntime(registry, scope)
  let terminated = false
  const worker: WorkerLike = {
    postMessage: message => { queueMicrotask(() => toWorker.forEach(l => l({ data: message as never }))) },
    addEventListener: ((type: string, listener: never) => { (type === 'message' ? toHost.message : toHost.error).push(listener) }) as WorkerLike['addEventListener'],
    terminate: () => { terminated = true },
  }
  return { worker, fail: (message: string) => toHost.error.forEach(l => l({ message })), terminated: () => terminated }
}

describe('generator host', () => {
  it('runs a generator inline and rejects an unknown name', async () => {
    const host = createInlineHost(registry)
    expect(await host.run('double', 21)).toBe(42)
    await expect(host.run('nope', 1)).rejects.toThrow('Unknown generator nope')
    await expect(host.run('boom', 1)).rejects.toThrow('bad input')
  })
  it('runs through a worker and keeps concurrent requests apart', async () => {
    const { worker } = pair()
    const host = createWorkerHost(worker)
    const results = await Promise.all([host.run('double', 1), host.run('double', 2), host.run('double', 3)])
    expect(results).toEqual([2, 4, 6])
    await expect(host.run('boom', 0)).rejects.toThrow('bad input')
    await expect(host.run('nope', 0)).rejects.toThrow('Unknown generator')
  })
  it('a worker failure rejects what is waiting, and dispose stops the worker', async () => {
    const { worker, fail, terminated } = pair()
    const host = createWorkerHost(worker)
    const waiting = host.run('double', 5)
    fail('crashed')
    await expect(waiting).rejects.toThrow('crashed')
    const later = host.run('double', 6)
    host.dispose()
    await expect(later).rejects.toThrow('disposed')
    expect(terminated()).toBe(true)
  })
  it('times a task against the 8 ms main-thread budget', () => {
    expect(MAIN_THREAD_BUDGET_MS).toBe(8)
    let t = 0
    const { value, ms } = timeTask(() => 'done', () => (t += 5))
    expect(value).toBe('done'); expect(ms).toBe(5)
  })
})
