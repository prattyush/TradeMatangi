import type { PersistedDrawing } from '../../../../shared/charts/klineDrawingModel'

/**
 * How a Lightweight drawing is saved to the database, as the same record a KLine drawing is (`PersistedDrawing`), so both chart types
 * show and delete the same drawings. Pure (no chart), so the mapping is unit-tested on its own. Only the points, the text and the colour
 * of a Text are shared; each chart draws them in its own style (the Lightweight Fib has 5 levels, the KLine one 7).
 */
export type LwKind = 'hline' | 'trendline' | 'fibretracement' | 'rect' | 'text' | 'buymarker' | 'sellmarker' | 'rrindicator'
export interface LwPoint { time: number; price: number }
/** What a drawing is, apart from the chart objects that draw it. `pts` are the clicks in order (a Risk : Reward is stop, then entry). */
export interface LwSpec { kind: LwKind; pts: LwPoint[]; text?: string; color?: string }

/** The tool name KLine saves each drawing under (the catalogue names in `shared/charts/catalogue.ts`). */
export const LW_TOOL: Record<LwKind, string> = {
  hline: 'Horizontal', trendline: 'Trend', fibretracement: 'Fib Retracement', rect: 'rect', text: 'Text',
  buymarker: 'Buy Marker', sellmarker: 'Sell Marker', rrindicator: 'Risk Reward',
}
const KIND_OF_TOOL = Object.fromEntries(Object.entries(LW_TOOL).map(([kind, tool]) => [tool, kind as LwKind])) as Record<string, LwKind>
/** How many points each drawing has. */
export const LW_POINTS: Record<LwKind, number> = {
  hline: 1, trendline: 2, fibretracement: 2, rect: 2, text: 1, buymarker: 1, sellmarker: 1, rrindicator: 2,
}
export const LW_MARKER_TEXT = { buymarker: 'Buy UL', sellmarker: 'Sell UL' } as const
export const LW_TEXT_MAX = 80

/** The record to save for a drawing (always visible and unlocked: a new or changed drawing). */
export function toPersisted(spec: LwSpec): PersistedDrawing {
  const drawing: PersistedDrawing = {
    tool: LW_TOOL[spec.kind],
    points: spec.pts.slice(0, LW_POINTS[spec.kind]).map(p => ({ timestamp: Math.round(p.time), price: p.price })),
    visible: true,
    locked: false,
  }
  if (spec.kind === 'text') {
    drawing.text = (spec.text ?? '').slice(0, LW_TEXT_MAX)
    if (spec.color) drawing.style = { color: spec.color }
  } else if (spec.kind === 'buymarker' || spec.kind === 'sellmarker') {
    drawing.text = spec.text ?? LW_MARKER_TEXT[spec.kind]
  }
  return drawing
}

export interface LwFromRecord { spec: LwSpec; locked: boolean }
/**
 * The Lightweight drawing for a saved record, or null when this chart does not draw it: a KLine-only tool (ray, arrow, brush, Long
 * position, ...), a record with the wrong number of points, or one hidden in KLine. A null is left alone on the server, never deleted.
 */
export function fromPersisted(drawing: PersistedDrawing): LwFromRecord | null {
  const kind = KIND_OF_TOOL[drawing.tool]
  if (!kind || drawing.visible === false) return null
  const points = Array.isArray(drawing.points) ? drawing.points : []
  if (points.length < LW_POINTS[kind] || points.some(p => !Number.isFinite(p.timestamp) || !Number.isFinite(p.price))) return null
  const spec: LwSpec = { kind, pts: points.slice(0, LW_POINTS[kind]).map(p => ({ time: p.timestamp, price: Number(p.price) })) }
  if (kind === 'text') {
    if (typeof drawing.text !== 'string' || !drawing.text) return null
    spec.text = drawing.text.slice(0, LW_TEXT_MAX)
    if (drawing.style?.color) spec.color = drawing.style.color
  } else if (kind === 'buymarker' || kind === 'sellmarker') {
    spec.text = typeof drawing.text === 'string' && drawing.text ? drawing.text : LW_MARKER_TEXT[kind]
  }
  return { spec, locked: Boolean(drawing.locked) }
}

/** The same drawing, whatever its id: for finding a drawing that is already saved. */
export const specSignature = (spec: LwSpec) =>
  `${LW_TOOL[spec.kind]}|${spec.pts.map(p => `${Math.round(p.time)}:${p.price}`).join(',')}|${spec.kind === 'text' ? spec.text ?? '' : ''}`

interface LegacyLine { time: number; value: number }
const legacyLines = (d: any): LegacyLine[][] =>
  (Array.isArray(d?.series) ? d.series.map((s: any) => s?.data) : Array.isArray(d?.lines) ? d.lines : [])
    .map((line: unknown) => (Array.isArray(line) ? line.filter((p: any) => p && Number.isFinite(p.time) && Number.isFinite(p.value)) : []))

/**
 * The drawings kept in the browser before they were saved to the database (`analysis-lw-drawings:*` in localStorage), as specs.
 * A horizontal line had no time, so it takes `fallbackTime` (the last candle). Entries that cannot be read are skipped.
 */
export function legacyToSpecs(saved: unknown, fallbackTime: number): LwSpec[] {
  if (!Array.isArray(saved)) return []
  const specs: LwSpec[] = []
  for (const d of saved as any[]) {
    if (!d || typeof d !== 'object') continue
    const lines = legacyLines(d)
    switch (d.type) {
      case 'hline':
        if (Number.isFinite(d.price)) specs.push({ kind: 'hline', pts: [{ time: fallbackTime, price: d.price }] })
        break
      case 'rect':
        if (d.p1 && d.p2 && [d.p1.time, d.p1.price, d.p2.time, d.p2.price].every(Number.isFinite)) {
          specs.push({ kind: 'rect', pts: [{ time: d.p1.time, price: d.p1.price }, { time: d.p2.time, price: d.p2.price }] })
        }
        break
      case 'text':
        if (typeof d.text === 'string' && d.text && Number.isFinite(d.time) && Number.isFinite(d.price)) {
          specs.push({ kind: 'text', pts: [{ time: d.time, price: d.price }], text: d.text.slice(0, LW_TEXT_MAX), color: d.color })
        }
        break
      case 'trendline':
        if (lines[0]?.length >= 2) specs.push({ kind: 'trendline', pts: [{ time: lines[0][0].time, price: lines[0][0].value }, { time: lines[0][1].time, price: lines[0][1].value }] })
        break
      case 'fibretracement':
        // Five level lines between two times: the first is the low (0), the last the high (1).
        if (lines.length >= 5 && lines[0].length >= 2 && lines[4].length >= 1) {
          specs.push({ kind: 'fibretracement', pts: [{ time: lines[0][0].time, price: lines[0][0].value }, { time: lines[0][1].time, price: lines[4][0].value }] })
        }
        break
      case 'rrindicator':
        // Five level lines: the stop (risk) first, the entry second.
        if (lines.length >= 2 && lines[0].length >= 2 && lines[1].length >= 1) {
          specs.push({ kind: 'rrindicator', pts: [{ time: lines[0][0].time, price: lines[0][0].value }, { time: lines[0][1].time, price: lines[1][0].value }] })
        }
        break
      case 'buymarker':
      case 'sellmarker':
        if (lines[0]?.length >= 1) specs.push({ kind: d.type, pts: [{ time: lines[0][0].time, price: lines[0][0].value }], text: LW_MARKER_TEXT[d.type as 'buymarker' | 'sellmarker'] })
        break
      default:
        break // the retired parallel channel, anything unknown
    }
  }
  return specs
}
