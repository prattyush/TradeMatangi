import { describe, expect, it } from 'vitest'
import { emptyIndexState, legOf, openIndex, stepLeg, type IndexState, type Leg } from '../../frontend/src/hooks/roundTripIndexer'

/** Drives the indexer the way useSimulation does: one net-quantity change per leg. */
function run(steps: [Leg, number, number][]) {
  let state: IndexState = emptyIndexState()
  const events: string[] = []
  for (const [leg, prev, cur] of steps) {
    const step = stepLeg(state, leg, prev, cur)
    state = step.state
    if (step.opened !== undefined) events.push(`open ${leg}=${step.opened}`)
    if (step.closed !== undefined) events.push(`close ${leg}=${step.closed}`)
  }
  return { state, events }
}

describe('round trip numbering', () => {
  it('maps option rights to legs', () => {
    expect([legOf(null), legOf(undefined), legOf('CE'), legOf('PE')]).toEqual(['eq', 'eq', 'ce', 'pe'])
  })
  it('numbers sequential trades 0, 1, 2 as the backend does', () => {
    const { events } = run([['ce', 0, 65], ['ce', 65, 0], ['pe', 0, 65], ['pe', 65, 0], ['eq', 0, 10], ['eq', 10, 0]])
    expect(events).toEqual(['open ce=0', 'close ce=0', 'open pe=1', 'close pe=1', 'open eq=2', 'close eq=2'])
  })
  it('keeps each leg\'s number when CE and PE are open together and close out of opening order', () => {
    const { events } = run([['ce', 0, 65], ['pe', 0, 65], ['pe', 65, 0], ['ce', 65, 0]])
    // Numbering at close time would have called the PE trip 0 and the CE trip 1.
    expect(events).toEqual(['open ce=0', 'open pe=1', 'close pe=1', 'close ce=0'])
  })
  it('lets an entry label find the number of an open leg while another leg opens and closes', () => {
    let state = emptyIndexState()
    state = stepLeg(state, 'ce', 0, 65).state
    expect(openIndex(state, 'ce')).toBe(0)
    state = stepLeg(state, 'pe', 0, 65).state
    expect(openIndex(state, 'ce')).toBe(0)
    expect(openIndex(state, 'pe')).toBe(1)
    state = stepLeg(state, 'pe', 65, 0).state
    expect(openIndex(state, 'ce')).toBe(0)
    expect(openIndex(state, 'pe')).toBe(2) // a closed leg's next open would take the next number
  })
  it('does not renumber on partial fills or when a position only changes size', () => {
    const { events } = run([['ce', 0, 65], ['ce', 65, 130], ['ce', 130, 65], ['ce', 65, 0]])
    expect(events).toEqual(['open ce=0', 'close ce=0'])
  })
  it('gives a leg that was already open before tracking began the next free number when it closes', () => {
    const { state, events } = run([['ce', 65, 0], ['pe', 0, 65], ['pe', 65, 0]])
    expect(events).toEqual(['close ce=0', 'open pe=1', 'close pe=1'])
    expect(state.counter).toBe(2)
  })
  it('a reopened contract gets a fresh number', () => {
    const { events } = run([['ce', 0, 65], ['ce', 65, 0], ['ce', 0, 65], ['ce', 65, 0]])
    expect(events).toEqual(['open ce=0', 'close ce=0', 'open ce=1', 'close ce=1'])
  })
})
