import { createContext, useContext, type RefObject } from 'react'

/** The website and desktop retain their existing context-menu gesture. */
export const ChartMenuGesture = createContext<'contextmenu' | 'doubleclick'>('contextmenu')
export const useChartMenuGesture = () => useContext(ChartMenuGesture)

export type MenuPoint = { clientX: number; clientY: number; currentPrice?: boolean }

/** Observe gestures without capturing pointers or preventing chart pan/zoom. */
export function bindChartMenu(
  element: HTMLElement,
  gesture: 'contextmenu' | 'doubleclick',
  open: (point: MenuPoint) => void,
  blocked: () => boolean = () => false,
) {
  let previous: { x: number; y: number; time: number } | undefined
  let start: { id: number; x: number; y: number; time: number; blocked: boolean } | undefined
  const pointers = new Set<number>()
  let ignoreMouseUntil = 0
  let blockedUntil = 0
  const down = (event: PointerEvent) => {
    pointers.add(event.pointerId)
    if (event.pointerType !== 'touch') {
      if (blocked()) blockedUntil = Date.now() + 500
      return
    }
    ignoreMouseUntil = Date.now() + 1000
    if (pointers.size !== 1) { previous = undefined; start = undefined; return }
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, time: Date.now(), blocked: blocked() }
  }
  const move = (event: PointerEvent) => {
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
      start = undefined
      previous = undefined
    }
  }
  const up = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (event.pointerType !== 'touch' || !start || start.id !== event.pointerId) return
    const tap = start
    start = undefined
    if (tap.blocked || blocked() || pointers.size || Date.now() - tap.time > 350 || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) {
      previous = undefined
      return
    }
    const now = Date.now()
    if (previous && now - previous.time <= 350 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 24) {
      previous = undefined
      open(event)
    } else previous = { x: event.clientX, y: event.clientY, time: now }
  }
  const cancel = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    start = undefined
    previous = undefined
  }
  const mouse = (event: MouseEvent) => {
    if (gesture === 'doubleclick' && (Date.now() < ignoreMouseUntil || Date.now() < blockedUntil)) return
    if (blocked()) return
    event.preventDefault()
    open(event)
  }
  const request = () => {
    if (blocked()) return
    const rect = element.getBoundingClientRect()
    open({ clientX: rect.left + rect.width / 2, clientY: rect.top + 30, currentPrice: true })
  }
  const mouseEvent = gesture === 'doubleclick' ? 'dblclick' : 'contextmenu'
  element.addEventListener(mouseEvent, mouse)
  if (gesture === 'doubleclick') {
    element.addEventListener('pointerdown', down, { passive: true })
    element.addEventListener('pointermove', move, { passive: true })
    element.addEventListener('pointerup', up, { passive: true })
    element.addEventListener('pointercancel', cancel, { passive: true })
    element.addEventListener('chart-menu-request', request)
  }
  return () => {
    element.removeEventListener(mouseEvent, mouse)
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', cancel)
    element.removeEventListener('chart-menu-request', request)
  }
}

export function ChartMenuButton({ chart, visible = true }: { chart: RefObject<HTMLElement>; visible?: boolean }) {
  const gesture = useChartMenuGesture()
  return gesture === 'doubleclick' && visible ? <button type="button" aria-label="Chart trading menu"
    title="Chart menu · double-click or double-tap the chart at a price"
    onClick={event => { event.stopPropagation(); chart.current?.dispatchEvent(new Event('chart-menu-request')) }}>
    Chart menu
  </button> : null
}
