import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { withTags, withSetups, toDiveSetup, strikeLabel } from '../../../../shared/deepdive/model'
import type { DeepDiveSetup, DeepDiveTag, Dive } from '../../../../shared/deepdive/types'
import { fullFields, markCount, needsStrikes, optionEligible, strikeForSide, strikeModeFor, toolsFor } from '../../../../shared/deepdive/ui/inDepthModel'
import { SaveQueue, type SaveState } from '../../../../shared/deepdive/ui/saveQueue'
import DayStrip from '../../../../shared/deepdive/ui/DayStrip'
import GapsPanel from '../../../../shared/deepdive/ui/GapsPanel'
import TagPanel from '../../../../shared/deepdive/ui/TagPanel'

const tag = (id: string, name = id, status: 'active' | 'archived' = 'active'): DeepDiveTag => ({ tag_id: id, name, status, sort_order: 0, created_at: '', archived_at: null })
const raw = (date: string, side: 'buy' | 'sell', tag_values: Record<string, boolean> = {}): DeepDiveSetup => ({
  category: 'Breakout', strategy: 'ORB', symbol: 'NIFTY', date, side, strike_ce: null, strike_pe: null, strike_mode: null, interval_minutes: 3,
  annotations: [], outcome: null, tag_values, notes: '', created_at: '', updated_at: '',
})
const dive = (setups: DeepDiveSetup[], tags: DeepDiveTag[]): Dive => withSetups({
  category: 'Breakout', strategy: 'ORB', owner_id: 'u', can_edit: true, setups: [], tags, incomplete_days: 0, unmarked_total: 0,
}, setups.map(s => toDiveSetup(s, tags)))

describe('withTags', () => {
  it('works out every day again when a tag is added or archived', () => {
    const start = dive([raw('2026-10-06', 'buy', { t1: true }), raw('2026-10-07', 'buy', { t1: true })], [tag('t1')])
    expect(start.incomplete_days).toBe(0)
    const added = withTags(start, [tag('t1'), tag('t2')])
    expect(added.incomplete_days).toBe(2)
    expect(added.unmarked_total).toBe(2)
    expect(added.setups[0].missing).toEqual(['t2'])
    const archived = withTags(added, [tag('t1'), tag('t2', 't2', 'archived')])
    expect(archived.incomplete_days).toBe(0)
  })
  it('names the strike modes', () => {
    expect([strikeLabel('max_price'), strikeLabel('otm'), strikeLabel('manual')]).toEqual(['Max Price', 'OTM', 'manual'])
  })
})

describe('in-depth helpers', () => {
  it('gives option charts to indices only', () => {
    expect(optionEligible('NIFTY')).toBe(true)
    expect(optionEligible('RELIANCE')).toBe(false)
  })
  it('knows when strikes still have to be picked', () => {
    expect(needsStrikes({ strike_ce: null, strike_pe: null })).toBe(true)
    expect(needsStrikes({ strike_ce: 24500, strike_pe: null })).toBe(true)
    expect(needsStrikes({ strike_ce: 24500, strike_pe: 24400 })).toBe(false)
  })
  it('trades a Buy setup on its CE and a Sell setup on its PE', () => {
    expect(strikeForSide('buy', { ce: 24500, pe: 24400 })).toBe(24500)
    expect(strikeForSide('sell', { ce: 24500, pe: 24400 })).toBe(24400)
  })
  it('offers the underlying tools plus the side\'s own option tools', () => {
    expect(toolsFor('buy', true).map(t => t.key)).toEqual(['entry-underlying', 'exit-underlying', 'entry-CE', 'exit-CE'])
    expect(toolsFor('sell', true).map(t => t.key)).toEqual(['entry-underlying', 'exit-underlying', 'entry-PE', 'exit-PE'])
    expect(toolsFor('buy', false).map(t => t.key)).toEqual(['entry-underlying', 'exit-underlying'])
  })
  it('uses the account strike setting like the Pattern Library', () => {
    expect(strikeModeFor('NIFTY', { mode: 'threshold', ceCap: 60, peCap: 45 })).toBe('max_price')
    expect(strikeModeFor('NIFTY', { mode: 'threshold', ceCap: 0, peCap: 45 })).toBe('otm')
    expect(strikeModeFor('RELIANCE', { mode: 'threshold', ceCap: 60, peCap: 45 })).toBe('otm')
  })
  it('counts marks per chart and lists what a retry must save', () => {
    const day = { ...raw('2026-10-06', 'buy'), outcome: 'success' as const, notes: 'n', annotations: [
      { id: 'a', time: 1, price: 1, type: 'entry', instrument: 'underlying', strategy_name: 'ORB', category: 'Breakout', text: '' },
      { id: 'b', time: 2, price: 1, type: 'exit', instrument: 'CE', strategy_name: 'ORB', category: 'Breakout', text: '' }] }
    expect([markCount(day, 'underlying'), markCount(day, 'CE'), markCount(day, 'PE')]).toEqual([1, 1, 0])
    expect(fullFields(day)).toMatchObject({ outcome: 'success', notes: 'n', interval_minutes: 3, strike_ce: null })
    expect(fullFields(day).annotations).toHaveLength(2)
  })
})

describe('SaveQueue', () => {
  const states = () => { const seen: SaveState[] = []; return { seen, queue: new SaveQueue(s => seen.push(s), e => String(e)) } }
  const later = (ms: number, log: string[], name: string) => () => new Promise<void>(resolve => setTimeout(() => { log.push(name); resolve() }, ms))

  it('runs saves in the order they were made, however long each takes', async () => {
    const { queue } = states(); const log: string[] = []
    await Promise.all([queue.enqueue(later(30, log, 'first')), queue.enqueue(later(1, log, 'second')), queue.enqueue(later(10, log, 'third'))])
    expect(log).toEqual(['first', 'second', 'third'])
  })
  it('reports saving, then saved once the last one is done', async () => {
    const { queue, seen } = states(); const log: string[] = []
    await Promise.all([queue.enqueue(later(5, log, 'a')), queue.enqueue(later(5, log, 'b'))])
    expect(seen.map(s => s.status)).toEqual(['saving', 'saving', 'saved'])
  })
  it('reports a failure, keeps going, and the next success clears it', async () => {
    const { queue, seen } = states()
    await queue.enqueue(() => Promise.reject(new Error('boom')))
    expect(seen.at(-1)).toEqual({ status: 'error', message: 'Error: boom' })
    const ran: string[] = []
    await queue.enqueue(async () => { ran.push('after') })
    expect(ran).toEqual(['after'])
    expect(seen.at(-1)).toEqual({ status: 'saved' })
  })
})

describe('panels', () => {
  const tags = [tag('t1', 'Second leg'), tag('t2', 'Double top'), tag('old', 'Retired', 'archived')]
  const state = dive([raw('2026-10-06', 'buy', { t1: true, t2: false }), raw('2026-10-07', 'sell', { t1: true }), raw('2026-10-08', 'buy')], tags)

  it('colours the day strip by whether every tag is marked', () => {
    const html = renderToStaticMarkup(<DayStrip setups={state.setups} index={1} onSelect={() => undefined} />)
    expect(html.match(/dd-chip complete/g)).toHaveLength(1)
    expect(html.match(/dd-chip incomplete/g)).toHaveLength(2)
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('6 Oct')
  })

  it('lists the days that need marking with how many tags are open', () => {
    const html = renderToStaticMarkup(<GapsPanel setups={state.setups} tags={tags} onJump={() => undefined} />)
    expect(html).toContain('Needs marking (2 days)')
    expect(html).toContain('7 Oct 2026 · Sell')
    expect(html).toContain('8 Oct 2026 · Buy')
    expect(html).toContain('2 tags')
    const done = renderToStaticMarkup(<GapsPanel setups={[state.setups[0]]} tags={tags} onJump={() => undefined} />)
    expect(done).toContain('Every tag is marked on every day.')
  })

  const panel = (index: number, canEdit = true) => renderToStaticMarkup(<TagPanel tags={tags} setups={state.setups} setup={state.setups[index]} canEdit={canEdit}
    onMark={() => undefined} onAdd={async () => tag('x')} onArchive={() => undefined} onRestore={() => undefined} />)

  it('shows each tag as valid, not valid or unmarked, and warns about an open day', () => {
    const complete = panel(0)
    expect(complete).toContain('Second leg')
    expect(complete).not.toContain('dd-tagname">Retired')
    expect(complete).toContain('Archived tags (1)')
    expect(complete).not.toContain('not marked on this day')
    expect(complete.match(/aria-pressed="true"/g)).toHaveLength(2) // t1 Valid, t2 Not valid
    const open = panel(2)
    expect(open).toContain('2 tags are not marked on this day.')
    expect(open).toContain('Mark the rest not valid (2)')
  })

  it('shows a shared deep dive without editing controls', () => {
    const html = panel(2, false)
    expect(html).not.toContain('Add tag')
    expect(html).not.toContain('Mark the rest not valid')
    expect(html).not.toContain('Archive Second leg')
    expect(html.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(4)
  })
})
