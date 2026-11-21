import { describe, expect, it } from 'vitest'
import { canonicalDrawingKey } from '../../shared/charts/drawingIdentity'
import { loadScopedRecords, notesScope, NOTES_SEED_TOOL, scopedIdentity, seedScopedDrawings } from '../../shared/charts/scopedDrawings'

const NIFTY = { kind: 'index', exchange: 'NSE', symbol: 'NIFTY' }
const CE = { kind: 'option', exchange: 'NFO', underlying: 'NIFTY', expiry: '2026-10-20', strike: 24500, right: 'CE' }
const line = (price: number) => ({ tool: 'Horizontal', points: [{ timestamp: 1000, price }] })

/** A drawings service in memory: records by the canonical instrument key, soft deletes removed from lists. */
function service(initial: Array<{ instrument: Record<string, unknown>; drawing: any }> = []) {
  const rows = initial.map((row, i) => ({ id: `r${i}`, key: canonicalDrawingKey(row.instrument), drawing: row.drawing }))
  const log: string[] = []
  const request = (async (path: string, method: string, body?: any) => {
    if (method === 'GET') {
      const key = decodeURIComponent(path.split('instrument=')[1])
      return { drawings: rows.filter(row => row.key === key).map(row => ({ drawing_id: row.id, revision: 1, drawing: row.drawing })) }
    }
    log.push(`${method} ${body.drawing.tool}`)
    rows.push({ id: `r${rows.length}`, key: canonicalDrawingKey(body.instrument), drawing: body.drawing })
    return { drawing_id: `r${rows.length - 1}`, revision: 1, drawing: body.drawing }
  }) as any
  return { request, rows, log }
}

describe('Notes scope (a day\'s Notes chart)', () => {
  it('names the scope after the date', () => expect(notesScope('2026-10-16')).toBe('notes:2026-10-16'))

  it('writes and reads only its own namespace, and copies from the plain one', () => {
    const identity = scopedIdentity(NIFTY, notesScope('2026-10-16'))
    expect(identity.writeInstrument).toEqual({ ...NIFTY, drawing_scope: 'notes:2026-10-16' })
    expect(identity.readKeys).toEqual([canonicalDrawingKey({ ...NIFTY, drawing_scope: 'notes:2026-10-16' })])
    expect(identity.sourceKeys).toEqual([canonicalDrawingKey(NIFTY)])
    // The options exchange (NFO) is read as the other charts read it (NSE first, then the feed venue), but the scope itself has one key.
    const option = scopedIdentity(CE, notesScope('2026-10-16'))
    expect(option.readKeys).toHaveLength(1)
    expect(option.sourceKeys.length).toBeGreaterThan(1)
  })

  it('copies the other charts\' drawings once and then writes a marker', async () => {
    const { request, rows, log } = service([{ instrument: NIFTY, drawing: line(100) }, { instrument: NIFTY, drawing: { ...line(98), tool: 'Text', text: 'support' } }])
    const identity = scopedIdentity(NIFTY, notesScope('2026-10-16'))
    expect(await seedScopedDrawings(request, identity)).toBe(true)
    expect(log).toEqual(['POST Horizontal', 'POST Text', `POST ${NOTES_SEED_TOOL}`])
    expect(rows.filter(row => row.key === identity.scopedKey)).toHaveLength(3)
    // Called again (the next time the day is opened): nothing is copied, including a drawing deleted in Notes meanwhile.
    expect(await seedScopedDrawings(request, identity)).toBe(false)
    expect(log).toHaveLength(3)
  })

  it('runs once when two charts ask at the same moment', async () => {
    const { request, log } = service([{ instrument: NIFTY, drawing: line(100) }])
    const identity = scopedIdentity(NIFTY, notesScope('2026-10-16'))
    await Promise.all([seedScopedDrawings(request, identity), seedScopedDrawings(request, identity)])
    expect(log).toEqual(['POST Horizontal', `POST ${NOTES_SEED_TOOL}`])
  })

  it('does not copy a drawing twice when an earlier attempt stopped half way', async () => {
    const identity = scopedIdentity(NIFTY, notesScope('2026-10-16'))
    const { request, log } = service([{ instrument: NIFTY, drawing: line(100) }, { instrument: NIFTY, drawing: line(101) }, { instrument: identity.writeInstrument, drawing: line(100) }])
    await seedScopedDrawings(request, identity)
    expect(log).toEqual(['POST Horizontal', `POST ${NOTES_SEED_TOOL}`]) // only the 101 line was missing
  })

  it('copies nothing between two days or two contracts', async () => {
    const { request, rows } = service([{ instrument: CE, drawing: line(100) }])
    await seedScopedDrawings(request, scopedIdentity(NIFTY, notesScope('2026-10-16')))
    expect(rows.filter(row => JSON.parse(row.key).drawing_scope && row.drawing.tool !== NOTES_SEED_TOOL)).toHaveLength(0)
  })

  it('shows the scope\'s own drawings without the marker; a day never opened shows the other charts\' only when viewing', async () => {
    const identity = scopedIdentity(NIFTY, notesScope('2026-10-16'))
    const fresh = service([{ instrument: NIFTY, drawing: line(100) }])
    expect(await loadScopedRecords(fresh.request, identity, false)).toEqual([]) // editing: the seed runs first, nothing to show before it
    expect((await loadScopedRecords(fresh.request, identity, true)).map(r => r.drawing.tool)).toEqual(['Horizontal'])
    const opened = service([{ instrument: NIFTY, drawing: line(100) }])
    await seedScopedDrawings(opened.request, identity)
    expect((await loadScopedRecords(opened.request, identity, true)).map(r => r.drawing.tool)).toEqual(['Horizontal']) // the copy, not the marker
    expect((await loadScopedRecords(opened.request, identity, false)).every(r => r.drawing.tool !== NOTES_SEED_TOOL)).toBe(true)
  })
})
