import { useAnalysisEnvironment } from './environment'
export const ANALYSIS_INTERVALS = [1, 3, 5, 10, 15, 30, 60] as const
export function CandleInterval() {
  const { intervalMinutes = 3, setIntervalMinutes } = useAnalysisEnvironment()
  return <select aria-label="Candle interval" title="Candle interval" value={intervalMinutes} onChange={event => setIntervalMinutes?.(Number(event.target.value))} style={{background:'#161b22',color:'#e6edf3',border:'1px solid #30363d',borderRadius:4,fontSize:11,padding:'3px 5px'}}>
    {ANALYSIS_INTERVALS.map(minutes => <option key={minutes} value={minutes}>{minutes}m</option>)}
  </select>
}
