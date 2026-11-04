import { useEffect, useRef, useState } from 'react'

/** The rendered width of an element, tracked with a ResizeObserver; `fallback` until it is first measured. */
export function useWidth<T extends HTMLElement>(fallback = 1000) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => { const next = Math.round(element.getBoundingClientRect().width); if (next > 0) setWidth(next) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
