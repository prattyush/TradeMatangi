import type { SeriesMarker, Time } from 'lightweight-charts'
import { buildMarkers as buildNeutralMarkers } from '../../../shared/analysis/patternMarkers'
export * from '../../../shared/analysis/patternMarkers'

/** Adapt renderer-neutral pattern markers to the website chart's timestamp type. */
export function buildMarkers(...args: Parameters<typeof buildNeutralMarkers>): SeriesMarker<Time>[] {
  return buildNeutralMarkers(...args).map(marker => ({ ...marker, time: marker.time as Time }))
}
