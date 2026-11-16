/**
 * A cancellable animation-frame clock for the market games' Views (spec 9: timers use a monotonic clock, not `Date`).
 * Time only advances while nothing is suspended (a dialog is open) and the page is visible, and one slow frame never
 * counts for more than `maxFrameMs`, so a stall cannot cost the player a round.
 */
export interface FrameClockOptions {
  suspended: () => boolean
  /** The page being hidden is checked through this so tests can fake it. */
  hidden?: () => boolean
  maxFrameMs?: number
  raf?: (callback: FrameRequestCallback) => number
  caf?: (handle: number) => void
}

export interface FrameClock {
  /** Run for `ms`, calling `onFrame(elapsedMs)` every frame; resolves at the end or as soon as `stop()` is true or the clock is cancelled. */
  run(ms: number, onFrame: (elapsedMs: number) => void, stop?: () => boolean): Promise<void>
  cancel(): void
  readonly cancelled: boolean
}

export function createFrameClock(options: FrameClockOptions): FrameClock {
  const raf = options.raf ?? (callback => requestAnimationFrame(callback))
  const caf = options.caf ?? (handle => cancelAnimationFrame(handle))
  const hidden = options.hidden ?? (() => typeof document !== 'undefined' && document.hidden)
  const maxFrameMs = options.maxFrameMs ?? 100
  let cancelled = false
  let handle = 0
  return {
    get cancelled() { return cancelled },
    cancel() { cancelled = true; caf(handle) },
    run: (ms, onFrame, stop) => new Promise<void>(resolve => {
      let elapsed = 0
      let last: number | null = null
      const step = (now: number) => {
        if (cancelled) { resolve(); return }
        if (last !== null && !options.suspended() && !hidden()) elapsed += Math.min(maxFrameMs, now - last)
        last = now
        onFrame(elapsed)
        if (elapsed >= ms || stop?.()) { resolve(); return }
        handle = raf(step)
      }
      handle = raf(step)
    }),
  }
}
