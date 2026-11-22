import type { DayNotesRequest } from '../notes/source'
import type { DayScore, DayScoreSource, ScoreRange } from './types'

const q = encodeURIComponent

/** The day score over any transport (the website's fetch, the desktop's analysis command): two read-only routes. */
export function createDayScoreSource(request: DayNotesRequest): DayScoreSource {
  return {
    day: (date, mode) => request<DayScore>(`day-score?date=${q(date)}&mode=${q(mode)}`, 'GET'),
    range: (start, end, compute = false, mode) => {
      const query = [start ? `start=${q(start)}` : '', end ? `end=${q(end)}` : '', compute ? 'compute=true' : '', mode ? `mode=${q(mode)}` : ''].filter(Boolean).join('&')
      return request<ScoreRange>(`day-scores${query ? `?${query}` : ''}`, 'GET')
    },
  }
}
