import { describe, expect, it } from 'vitest'
import { allowedTypes, fixType, heldPosition, instructionKey, intentLabel, isExit, needsPreview, newDraft, orderBody, orderQuantity, outstandingExit, previewBody, problems, RequestIdentity, snapPrice, type Draft, type TicketContext } from './orderTicket'
import type { ListedContract, OrderPreview, PendingOrder, Portfolio, Position } from './swingTypes'

const portfolio: Portfolio = { session_id: 'p1', mode: 'paper', state: 'running', entries_paused: false, session_capital: 100000, guardrail_epoch: 3 }
const equityPosition: Position = { session_id: 's1', symbol: 'HDFCBANK', instrument_type: 'equity', side: 'LONG', quantity: 100, avg_entry_price: 1500 }
const futurePosition = (side: 'LONG' | 'SHORT'): Position => ({ session_id: 's2', symbol: 'RELIND', instrument_type: 'futures', side, quantity: 500, avg_entry_price: 1300, expiry: '2026-11-26' })
const draft = (patch: Partial<Draft> = {}): Draft => ({ ...newDraft(), price: '1500', ...patch })
const future = (patch: Partial<Draft> = {}): Draft => draft({ symbol: 'RELIND', instrument: 'futures', expiry: '2026-11-26', quantity: '1', price: '1300', ...patch })
const futureContract: ListedContract = { expiry: '2026-11-26', lot_size: 500, tick_size: 0.05 }
const optionContract: ListedContract = { expiry: '2026-11-26', strike: 1500, right: 'CE', lot_size: 550, tick_size: 0.05 }
const futurePreview: OrderPreview = { quantity: 500, lot_size: 500, budget: 120000, fees: 90, required_funds: 120090, capital_revision: 3, fee_hash: 'f'.repeat(64), margin: 119000, execution_enabled: true }
const context = (patch: Partial<TicketContext> = {}): TicketContext => ({ portfolio, positions: [], openOrders: [], contract: undefined, preview: null, ...patch })

describe('entry and exit', () => {
  it('equity and options exit by selling; a future exits against the open position', () => {
    expect(isExit(draft({ side: 'SELL' }), [])).toBe(true)
    expect(isExit(draft({ side: 'BUY' }), [])).toBe(false)
    expect(isExit(future({ side: 'SELL' }), [futurePosition('LONG')])).toBe(true)
    expect(isExit(future({ side: 'BUY' }), [futurePosition('SHORT')])).toBe(true)
    expect(isExit(future({ side: 'SELL' }), [futurePosition('SHORT')])).toBe(false) // adds to the short
    expect(isExit(future({ side: 'SELL' }), [])).toBe(false) // opens a short
  })

  it('entries are Limit or Target and exits are Limit or Stoploss; the kind is corrected when the intent changes', () => {
    expect(allowedTypes(false)).toEqual(['LIMIT', 'TARGET'])
    expect(allowedTypes(true)).toEqual(['LIMIT', 'STOPLOSS'])
    expect(fixType(draft({ side: 'SELL', type: 'TARGET' }), []).type).toBe('LIMIT')
    expect(fixType(draft({ side: 'BUY', type: 'STOPLOSS' }), []).type).toBe('LIMIT')
    expect(fixType(draft({ side: 'SELL', type: 'STOPLOSS' }), []).type).toBe('STOPLOSS')
  })

  it('words a short and its cover plainly', () => {
    expect(intentLabel(future({ side: 'SELL' }), [])).toBe('Sell to open a short')
    expect(intentLabel(future({ side: 'BUY' }), [futurePosition('SHORT')])).toBe('Buy to cover')
    expect(intentLabel(future({ side: 'SELL' }), [futurePosition('LONG')])).toBe('Sell to exit')
    expect(intentLabel(draft({ side: 'BUY' }), [])).toBe('Buy (enter)')
  })

  it('finds the held contract and the quantity already promised to exit orders', () => {
    const order = (quantity: number, filled = 0): PendingOrder => ({ order_id: 'o', session_id: 's1', symbol: 'HDFCBANK', side: 'SELL', order_type: 'LIMIT', quantity, trigger_price: 1600, limit_price: 1600, status: 'PENDING', instrument_type: 'equity', broker_filled_quantity: filled })
    const held = heldPosition([equityPosition], draft({ side: 'SELL' }))!
    expect(held.quantity).toBe(100)
    expect(outstandingExit([order(30), order(50, 20)], draft({ side: 'SELL' }), held)).toBe(60)
    expect(heldPosition([equityPosition], draft({ symbol: 'TCS' }))).toBeUndefined()
  })
})

describe('what must be previewed', () => {
  it('every future and every capital-% entry, nothing else', () => {
    expect(needsPreview(future(), [])).toBe(true)
    expect(needsPreview(draft({ sizing: 'capital_pct' }), [])).toBe(true)
    expect(needsPreview(draft({ sizing: 'capital_pct', side: 'SELL' }), [equityPosition])).toBe(false)
    expect(needsPreview(draft(), [])).toBe(false)
  })
})

describe('problems', () => {
  it('a plain equity limit buy is ready', () => {
    expect(problems(draft(), context())).toEqual([])
  })

  it('there are no market orders and a price must sit on the tick', () => {
    expect(problems(draft({ price: '' }), context())).toContain('Enter a price. There are no market orders.')
    expect(problems(future({ price: '1300.03' }), context({ contract: futureContract, preview: futurePreview })).join(' ')).toContain('multiple of 0.05')
  })

  it('selling more than is free is refused, counting open exit orders', () => {
    const sell = draft({ side: 'SELL', quantity: '80' })
    const open: PendingOrder[] = [{ order_id: 'o', session_id: 's1', symbol: 'HDFCBANK', side: 'SELL', order_type: 'STOPLOSS', quantity: 40, trigger_price: 1400, limit_price: 1390, status: 'PENDING', instrument_type: 'equity' }]
    expect(problems(sell, context({ positions: [equityPosition] }))).toEqual([])
    expect(problems(sell, context({ positions: [equityPosition], openOrders: open })).join(' ')).toContain('Only 60 can still be sold')
    expect(problems(sell, context())).toContain('You hold none of this to sell.')
  })

  it('options need a listed contract and whole lots', () => {
    const option = draft({ instrument: 'options', expiry: '2026-11-26', strike: '1500', quantity: '1.5' })
    expect(problems(option, context({ contract: optionContract })).join(' ')).toContain('whole number of lots')
    expect(problems({ ...option, quantity: '2' }, context({ contract: undefined })).join(' ')).toContain('not listed')
    expect(problems({ ...option, quantity: '2' }, context({ contract: optionContract }))).toEqual([])
  })

  it('a future waits for its margin estimate and is blocked when the server has futures off', () => {
    expect(problems(future(), context({ contract: futureContract }))).toContain('Waiting for the margin estimate.')
    expect(problems(future(), context({ contract: futureContract, preview: futurePreview }))).toEqual([])
    expect(problems(future(), context({ contract: futureContract, preview: { ...futurePreview, execution_enabled: false } }))).toContain('Futures orders are not enabled on this server.')
  })

  it('a short can be opened, and a cover is allowed against a short', () => {
    expect(problems(future({ side: 'SELL' }), context({ contract: futureContract, preview: futurePreview }))).toEqual([])
    expect(problems(future({ side: 'BUY', type: 'STOPLOSS' }), context({ positions: [futurePosition('SHORT')], contract: futureContract, preview: futurePreview }))).toEqual([])
  })

  it('entries are refused while paused, exits are not', () => {
    const paused = { ...portfolio, entries_paused: true }
    expect(problems(draft(), context({ portfolio: paused }))).toContain('Entries are paused. Resume them to enter.')
    expect(problems(draft({ side: 'SELL' }), context({ portfolio: paused, positions: [equityPosition] }))).toEqual([])
    expect(problems(draft(), context({ portfolio: { ...portfolio, state: 'ended' } }))).toContain('The portfolio is not running.')
  })

  it('capital % entries wait for the estimate and need a share between 0 and 100', () => {
    const sized = draft({ sizing: 'capital_pct', capitalPct: '10' })
    expect(problems(sized, context())).toContain('Waiting for the size estimate.')
    expect(problems(sized, context({ preview: { ...futurePreview, quantity: 66 } }))).toEqual([])
    expect(problems({ ...sized, capitalPct: '150' }, context())).toContain('Capital % must be between 0 and 100.')
    expect(problems(sized, context({ preview: { ...futurePreview, quantity: 0 } }))).toContain('That share of capital is too small for one lot.')
  })
})

describe('request bodies', () => {
  it('a future order carries the preview approval, in units of the lot size, and is tagged phone', () => {
    const body = orderBody(future({ side: 'SELL', quantity: '2' }), futureContract, futurePreview, 'r1')
    expect(body).toMatchObject({ symbol: 'RELIND', instrument_type: 'futures', side: 'SELL', order_type: 'LIMIT', client: 'phone', quantity: 1000, expiry: '2026-11-26', approved_budget: 120000, fee_hash: 'f'.repeat(64), capital_revision: 3, price: 1300, request_id: 'r1' })
  })

  it('a capital % option entry sends the share and the capital revision of the preview', () => {
    const preview = { ...futurePreview, quantity: 1100, capital_revision: 3 }
    const body = orderBody(draft({ instrument: 'options', expiry: '2026-11-26', strike: '1500', right: 'PE', sizing: 'capital_pct', capitalPct: '5' }), optionContract, preview, 'r2')
    expect(body).toMatchObject({ instrument_type: 'options', right: 'PE', strike: 1500, expiry: '2026-11-26', capital_pct: 0.05, capital_revision: 3, quantity: 1100 })
    expect(body).not.toHaveProperty('approved_budget')
  })

  it('a plain equity order has no sizing fields', () => {
    const body = orderBody(draft({ quantity: '25' }), undefined, null, 'r3')
    expect(body).toEqual({ symbol: 'HDFCBANK', instrument_type: 'equity', side: 'BUY', order_type: 'LIMIT', client: 'phone', quantity: 25, price: 1500, request_id: 'r3' })
  })

  it('previews ask for one unit when sizing by capital and use the portfolio\'s capital revision', () => {
    const body = previewBody(draft({ sizing: 'capital_pct', capitalPct: '10', instrument: 'options', expiry: '2026-11-26', strike: '1500' }), portfolio, optionContract)
    expect(body).toMatchObject({ side: 'BUY', quantity: 1, capital_pct: 0.1, capital_revision: 3, request_id: 'preview', client: 'phone', right: 'CE' })
    expect(previewBody(future({ side: 'SELL', quantity: '2' }), portfolio, futureContract)).toMatchObject({ side: 'SELL', quantity: 1000 })
  })

  it('units are lots times the lot size for derivatives and shares for equity', () => {
    expect(orderQuantity(draft({ quantity: '7' }), undefined, null)).toBe(7)
    expect(orderQuantity(draft({ instrument: 'options', quantity: '3' }), optionContract, null)).toBe(1650)
  })

  it('prices snap to the tick', () => {
    expect(snapPrice(draft({ price: '1500.07' }), optionContract)).toBe('1500.05')
  })
})

describe('request identity', () => {
  it('the same instructions keep one id, any change starts a new one, and an accepted order resets it', () => {
    let count = 0
    const identity = new RequestIdentity(() => `id-${++count}`)
    const one = instructionKey(draft(), null)
    expect(identity.idFor(one)).toBe('id-1')
    expect(identity.idFor(one)).toBe('id-1')
    expect(identity.idFor(instructionKey(draft({ price: '1501' }), null))).toBe('id-2')
    identity.done()
    expect(identity.idFor(instructionKey(draft({ price: '1501' }), null))).toBe('id-3')
  })
})
