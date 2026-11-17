import { useLayoutEffect, type RefObject } from 'react'

/**
 * Sizes an element to run from where it starts down to the bottom of the window, so a chart area uses all the room it has
 * instead of a fixed height (empty space on a tall window, a clipped chart on a short one). Refits when the window or the
 * content above it changes size. A narrow window (`stackBelow` px) is left to the stylesheet, where the page scrolls instead.
 */
export function useFillWindow(ref: RefObject<HTMLElement | null>, { bottomGap = 12, minHeight = 420, stackBelow = 1000 } = {}) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const fit = () => {
      if (window.innerWidth <= stackBelow) { element.style.height = ''; return }
      const top = element.getBoundingClientRect().top
      element.style.height = `${Math.max(minHeight, Math.floor(window.innerHeight - top - bottomGap))}px`
    }
    fit()
    window.addEventListener('resize', fit)
    // What sits above (banner, day strip, the "Needs marking" box) can grow or shrink: the area follows.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    if (element.parentElement) observer?.observe(element.parentElement)
    return () => { window.removeEventListener('resize', fit); observer?.disconnect() }
  }, [ref, bottomGap, minHeight, stackBelow])
}
