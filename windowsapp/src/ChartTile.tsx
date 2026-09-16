import { useEffect, useRef, useState } from 'react'
import { dispose, init } from 'klinecharts'
import type { Candle } from './contracts'

const demo: Candle[] = [
  { timestamp: 1746522900, open: 23100, high: 23124, low: 23080, close: 23112 },
  { timestamp: 1746522960, open: 23112, high: 23140, low: 23101, close: 23132 },
  { timestamp: 1746523020, open: 23132, high: 23148, low: 23120, close: 23125 },
]

export function ChartTile({ symbol, interval }: { symbol: string; interval: string }) {
  const element = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Array<{ id: number; tool: string; locked: boolean; hidden: boolean }>>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [indicators, setIndicators] = useState<string[]>([])
  useEffect(() => {
    if (!element.current) return
    const chart = init(element.current)
    chart.applyNewData(demo.map(candle => ({ timestamp: candle.timestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close })))
    return () => { dispose(element.current!) }
  }, [])
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTool(null)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) { setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { setDrawings(current => current.slice(0, -1)); setSelected(null) }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [selected])
  const addDrawing = (nextTool: string) => {
    const id = Date.now()
    setTool(nextTool); setDrawings(current => [...current, { id, tool: nextTool, locked: false, hidden: false }]); setSelected(id)
  }
  const updateSelected = (update: (drawing: { id: number; tool: string; locked: boolean; hidden: boolean }) => { id: number; tool: string; locked: boolean; hidden: boolean }) => setDrawings(current => current.map(drawing => drawing.id === selected ? update(drawing) : drawing))
  return <section className="chart"><div className="chart-head"><span>{symbol} · {interval} · IST</span><span>{tool ? `Drawing: ${tool}` : 'Browse'}</span></div><div className="indicator-bar"><button onClick={() => setIndicators(current => [...current, 'MA'])}>+ MA</button><button onClick={() => setIndicators(current => [...current, 'RSI'])}>+ RSI</button><small>{indicators.join(', ') || 'No indicators'}</small></div><div className="kline" ref={element} /><div className="drawing-bar"><button onClick={() => addDrawing('Trend')}>Trend</button><button onClick={() => addDrawing('Horizontal')}>Horizontal</button><button onClick={() => addDrawing('Fib')}>Fib</button><button disabled={selected === null} onClick={() => updateSelected(drawing => ({ ...drawing, locked: !drawing.locked }))}>Lock</button><button disabled={selected === null} onClick={() => updateSelected(drawing => ({ ...drawing, hidden: !drawing.hidden }))}>Hide</button><button disabled={selected === null} onClick={() => { setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }}>Delete</button><small>{drawings.length} drawing(s) · Esc cancel · Del remove · Ctrl+Z undo</small></div></section>
}
