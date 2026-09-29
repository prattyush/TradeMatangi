import assert from 'node:assert/strict'
import test from 'node:test'
import { selectPaperResumePanes } from './paperResume.ts'

const equity = { id: 1, type: 'equity', intervalMinutes: 3 }
const pane = (right, strike, expiry = '2026-10-01') => ({ id: strike, type: 'options', intervalMinutes: 3, right, strike, expiry })
const streamed = { CE: 24000, PE: 24100, expiry: '2026-10-01' }

test('removed option charts remain removed without open positions', () => {
  const result = selectPaperResumePanes([equity], [], streamed, pane)
  assert.deepEqual(result.panes, [equity])
})

test('saved contract is restored when its side has no open position', () => {
  const result = selectPaperResumePanes([equity, pane('PE', 24250)], [], streamed, pane)
  assert.equal(result.chosen.PE.strike, 24250)
  assert.equal(result.chosen.CE, undefined)
})

test('open CE and PE positions override removed or saved charts', () => {
  const result = selectPaperResumePanes([equity, pane('PE', 24100)], [
    { right: 'CE', strike: 24200, expiry: streamed.expiry, last_opened_at: 10 },
    { right: 'PE', strike: 24300, expiry: streamed.expiry, last_opened_at: 20 },
  ], streamed, pane)
  assert.equal(result.chosen.CE.strike, 24200)
  assert.equal(result.chosen.PE.strike, 24300)
  assert.equal(result.panes.filter(p => p.type === 'options').length, 2)
})

test('latest open strike wins when two PE positions exist', () => {
  const result = selectPaperResumePanes([equity, pane('PE', 24000)], [
    { right: 'PE', strike: 24000, expiry: streamed.expiry, last_opened_at: 10 },
    { right: 'PE', strike: 24200, expiry: streamed.expiry, last_opened_at: 30 },
  ], streamed, pane)
  assert.equal(result.chosen.PE.strike, 24200)
  assert.equal(result.panes.filter(p => p.right === 'PE').length, 1)
})
