import type { DayNotesRequest } from '../notes/source'
import type { DaySummary, DaySummarySource } from './types'
import { summaryQuery } from './summaryModel'

/** The Summary over any transport (the website's fetch, the desktop's analysis command): one read-only route. */
export function createDaySummarySource(request: DayNotesRequest): DaySummarySource {
  return { days: filters => request<DaySummary>(`day-summary${summaryQuery(filters)}`, 'GET') }
}
