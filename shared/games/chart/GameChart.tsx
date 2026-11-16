import { useEffect, useRef } from 'react'
import type { ChartData, Size } from './chartModel'
import { DARK_THEME, drawChart, type ChartTheme, type Painter } from './drawChart'

export interface GameChartProps {
  data: ChartData
  /** CSS pixels. The canvas is scaled by the device pixel ratio so lines stay sharp. */
  width?: number
  height?: number
  theme?: ChartTheme
  /** A text description for screen readers (the canvas itself is not readable). */
  label: string
}

/**
 * The games' own minimal canvas chart (spec 9): candles, a line, levels, zones, markers and a replay clock. It repaints only when its
 * props change, batched into one `requestAnimationFrame`, and has no dependency on KLine or Lightweight Charts.
 */
export function GameChart({ data, width = 640, height = 300, theme = DARK_THEME, label }: GameChartProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ data, theme, size: { width, height } as Size })
  latest.current = { data, theme, size: { width, height } }
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (frame.current !== null) return // a repaint is already queued; it will read the newest props
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const element = canvas.current
      const context = element?.getContext('2d')
      if (!element || !context) return
      const { data: current, theme: colours, size } = latest.current
      const ratio = window.devicePixelRatio || 1
      if (element.width !== Math.round(size.width * ratio) || element.height !== Math.round(size.height * ratio)) {
        element.width = Math.round(size.width * ratio); element.height = Math.round(size.height * ratio)
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      drawChart(context as unknown as Painter, current, size, colours)
    })
  })
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null }, [])

  return <canvas ref={canvas} className="games-chart" role="img" aria-label={label} style={{ width, height, maxWidth: '100%' }} width={width} height={height} />
}
