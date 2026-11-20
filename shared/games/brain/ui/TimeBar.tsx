import { useEffect, useRef } from 'react'

/** The time left in a block. It writes the bar width straight to the DOM each frame, so it never re-renders the game. */
export function TimeBar({ getElapsedMs, totalMs }: { getElapsedMs: () => number; totalMs: number }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (bar.current) bar.current.style.width = `${Math.max(0, Math.min(100, 100 - (getElapsedMs() / totalMs) * 100))}%`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getElapsedMs, totalMs])
  return <div className="brain-timebar" role="progressbar" aria-label="Time left" aria-valuemin={0} aria-valuemax={100}><div ref={bar} /></div>
}
