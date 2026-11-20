import { useLayoutEffect, type RefObject } from 'react'

/**
 * Sizes an element to run from where it starts down to the bottom of the window, so a chart area uses all the room it has
 * instead of a fixed height (empty space on a tall window, a clipped chart on a short one). A narrow window (`stackBelow` px) is
 * left to the stylesheet, where the page scrolls instead.
 *
 * Where the element starts is not fixed: a header filled after this mounts (a portal, fonts, a banner above) moves it down without
 * resizing anything that could be observed. So the position is checked every frame while it is mounted (one `getBoundingClientRect`,
 * which costs a layout only when something changed) and the height refitted when the position or the window height changed. Measuring
 * once, as this used to, left a stale height and the bottom of the chart (its time axis) below the window.
 */
export function useFillWindow(ref: RefObject<HTMLElement | null>, { bottomGap = 12, minHeight = 420, stackBelow = 1000 } = {}) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let lastTop = Number.NaN
    let lastWindow = Number.NaN
    const fit = () => {
      if (window.innerWidth <= stackBelow) {
        if (element.style.height) element.style.height = ''
        lastTop = lastWindow = Number.NaN
        return
      }
      const top = element.getBoundingClientRect().top
      if (top === lastTop && window.innerHeight === lastWindow) return
      lastTop = top
      lastWindow = window.innerHeight
      const height = `${Math.max(minHeight, Math.floor(window.innerHeight - top - bottomGap))}px`
      if (element.style.height !== height) element.style.height = height
    }
    fit()
    let frame = requestAnimationFrame(function watch() {
      fit()
      frame = requestAnimationFrame(watch)
    })
    window.addEventListener('resize', fit)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', fit) }
  }, [ref, bottomGap, minHeight, stackBelow])
}
