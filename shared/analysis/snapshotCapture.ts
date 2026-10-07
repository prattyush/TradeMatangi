import type { TickEvent } from './api'
export function captureObservation(tick:TickEvent|null) {
  return tick ? {time:Math.floor(tick.time/180)*180,ohlc:{open:tick.open,high:tick.high,low:tick.low,close:tick.close},resolution_seconds:typeof tick.interval_seconds==='number'?tick.interval_seconds:null,source_time:tick.time} : null
}
