import { useEffect, useRef, useState } from 'react'
import { dispose, init } from 'klinecharts'
import type { Candle } from './contracts'

const demo: Candle[] = [
  { timestamp: 1746522900, open: 23100, high: 23124, low: 23080, close: 23112 },
  { timestamp: 1746522960, open: 23112, high: 23140, low: 23101, close: 23132 },
  { timestamp: 1746523020, open: 23132, high: 23148, low: 23120, close: 23125 },
]

export function ChartTile({ symbol, interval, candles = demo, onConfigure, onMaximize, maximized }: { symbol: string; interval: string; candles?: Candle[]; onConfigure: () => void; onMaximize: () => void; maximized: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Array<{ id: number; tool: string; locked: boolean; hidden: boolean }>>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [indicators, setIndicators] = useState<string[]>([])
  useEffect(() => {
    if (!element.current) return
    const chart = init(element.current)
    if (!chart) return
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 })
    chart.setPeriod({ span: Number(interval.replace('m', '')), type: 'minute' })
    chart.setDataLoader({
      getBars: ({ callback }) => callback(candles.map(candle => ({ timestamp: candle.timestamp * 1000, open: candle.open, high: candle.high, low: candle.low, close: candle.close }))),
    })
    // MA is drawn over the candle pane. RSI and MACD are deliberately created
    // without a pane ID: KLineCharts creates a real, independently resizable pane.
    indicators.forEach(indicator => {
      if (indicator === 'MA') chart.createIndicator({ name: 'MA', paneId: 'candle_pane' }, true)
      else chart.createIndicator(indicator)
    })
    return () => { dispose(element.current!) }
  }, [symbol, interval, candles, indicators])
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
  const addIndicator = (name: string) => setIndicators(current => current.includes(name) ? current : [...current, name])
  return <section className="chart"><div className="chart-head"><span>{symbol} · {interval} · IST</span><span className="chart-actions"><button onClick={onConfigure}>Instrument…</button><button onClick={onMaximize}>{maximized ? 'Restore' : 'Maximize'}</button><span>{tool ? `Drawing: ${tool}` : 'Browse'}</span></span></div><div className="indicator-bar"><button onClick={() => addIndicator('MA')}>+ MA overlay</button><button onClick={() => addIndicator('RSI')}>+ RSI pane</button><button onClick={() => addIndicator('MACD')}>+ MACD pane</button><button disabled={!indicators.length} onClick={() => setIndicators([])}>Clear panes</button><small>{indicators.join(', ') || 'No indicators'}</small></div><div className="kline" ref={element} /><div className="drawing-bar"><button onClick={() => addDrawing('Trend')}>Trend</button><button onClick={() => addDrawing('Horizontal')}>Horizontal</button><button onClick={() => addDrawing('Fib')}>Fib</button><button disabled={selected === null} onClick={() => updateSelected(drawing => ({ ...drawing, locked: !drawing.locked }))}>Lock</button><button disabled={selected === null} onClick={() => updateSelected(drawing => ({ ...drawing, hidden: !drawing.hidden }))}>Hide</button><button disabled={selected === null} onClick={() => { setDrawings(current => current.filter(drawing => drawing.id !== selected)); setSelected(null) }}>Delete</button><small>{drawings.length} drawing(s) · Esc cancel · Del remove · Ctrl+Z undo</small></div></section>
}
