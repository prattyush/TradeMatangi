import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYOUT_PANE_COUNT, defaultState, layoutRows, paneTitle, parseState, stepPaneDate, updatePane, withDate, withLayout, withSymbol } from './browseWorkspace.ts'

const DAY = '2026-11-09'
const format = iso => iso

test('every website layout has its panes laid out once, in the trading screen shapes', () => {
  for (const layout of [1, 2, 3, 4, 5, 6, 7]) {
    const indexes = layoutRows(layout).flatMap(row => row.panes)
    assert.deepEqual(indexes, [...Array(LAYOUT_PANE_COUNT[layout]).keys()], `layout ${layout}`)
  }
  assert.deepEqual(layoutRows(6)[0].flex, [1, 0.5, 0.5])          // 5 wide right
  assert.deepEqual(layoutRows(7).map(row => row.panes.length), [1, 3])  // 4 as 1 + 3
  assert.deepEqual(layoutRows(5).map(row => row.panes.length), [3, 2])  // 5 equal
})

test('the first Browse is two panes on the same day', () => {
  const state = defaultState(DAY)
  assert.equal(state.panes.length, 2)
  assert.deepEqual(state.panes.map(pane => pane.symbol), ['NIFTY', 'BSESEN'])
  assert.ok(state.panes.every(pane => pane.date === DAY && pane.kind === 'spot' && pane.interval === 3))
})

test('a bigger layout adds panes with new ids and unused symbols; a smaller one keeps the first panes', () => {
  const two = defaultState(DAY)
  const five = withLayout(two, 5)
  assert.equal(five.panes.length, 5)
  assert.equal(new Set(five.panes.map(pane => pane.id)).size, 5)
  assert.equal(new Set(five.panes.map(pane => pane.symbol)).size, 5)
  assert.deepEqual(five.panes.slice(0, 2), two.panes)
  const one = withLayout(five, 1)
  assert.deepEqual(one.panes, [five.panes[0]])
})

test('a pane that was maximized and no longer exists is restored', () => {
  const state = { ...withLayout(defaultState(DAY), 4), maximized: 4 }
  assert.equal(withLayout(state, 1).maximized, null)
  assert.equal(withLayout(state, 4).maximized, 4)
})

test('another symbol drops the old contract; another day keeps the strike by hand but not one found by price', () => {
  const option = { ...defaultState(DAY).panes[0], kind: 'CE', expiry: '2026-11-12', strike: 24500, pick: { mode: 'manual', cap: null } }
  const other = withSymbol(option, 'RELIND')
  assert.equal(other.kind, 'spot'); assert.equal(other.strike, null); assert.equal(other.symbol, 'RELIND'); assert.equal(other.date, DAY)
  assert.equal(withDate(option, '2026-11-06').strike, 24500)
  assert.equal(withDate(option, '2026-11-06').expiry, null)
  const byPrice = { ...option, pick: { mode: 'max_price', cap: 80 } }
  assert.equal(withDate(byPrice, '2026-11-06').strike, null)
})

test('stepping a day skips weekends and never passes the latest day', () => {
  const pane = { ...defaultState(DAY).panes[0], date: '2026-11-06' }   // a Friday
  assert.equal(stepPaneDate(pane, 1, DAY).date, '2026-11-09')         // the Monday
  assert.equal(stepPaneDate({ ...pane, date: DAY }, 1, DAY).date, DAY) // already the latest
  assert.equal(stepPaneDate({ ...pane, date: DAY }, -1, DAY).date, '2026-11-06')
})

test('updatePane changes one pane only', () => {
  const state = defaultState(DAY)
  const next = updatePane(state, 2, { symbol: 'TATMOT' })
  assert.equal(next.panes[1].symbol, 'TATMOT'); assert.equal(next.panes[0].symbol, 'NIFTY')
})

test('the pane button names the symbol, the day and the contract', () => {
  const base = defaultState(DAY).panes[0]
  assert.equal(paneTitle(base, format), `NIFTY · ${DAY}`)
  assert.equal(paneTitle({ ...base, kind: 'CE', strike: 24500 }, format), `NIFTY · ${DAY} · CE 24500`)
  assert.equal(paneTitle({ ...base, kind: 'PE', pick: { mode: 'max_price', cap: 80 } }, format), `NIFTY · ${DAY} · PE ≤80`)
})

test('saved state round-trips, including intervals and strikes', () => {
  const state = updatePane(withLayout(defaultState(DAY), 6), 1, { kind: 'CE', expiry: '2026-11-12', strike: 24500, interval: 15, pick: { mode: 'max_price', cap: 90 } })
  assert.deepEqual(parseState(JSON.stringify(state), DAY), state)
})

test('anything malformed becomes the default instead of breaking Browse', () => {
  for (const raw of [null, '', 'not json', '[]', '{"layout":99,"panes":[]}', '{"layout":2,"panes":"x"}', '{"layout":2,"panes":[{"id":1}]}']) {
    assert.deepEqual(parseState(raw, DAY), defaultState(DAY), String(raw))
  }
})

test('a saved set with too few or bad panes is repaired to the layout', () => {
  const raw = JSON.stringify({ layout: 4, panes: [{ id: 7, symbol: 'NIFTY', date: DAY, kind: 'XX', interval: 999 }, { id: 7, symbol: 'DUP', date: DAY }, { id: 8, symbol: 'RELIND', date: 'bad' }] })
  const state = parseState(raw, DAY)
  assert.equal(state.panes.length, 4)
  assert.equal(state.panes[0].kind, 'spot'); assert.equal(state.panes[0].interval, 3)
  assert.equal(new Set(state.panes.map(pane => pane.id)).size, 4)
})
