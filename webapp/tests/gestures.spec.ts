import { expect, test } from '@playwright/test'

test('nested chart strategies are reachable by touch and keyboard near the tablet edge', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 768, height: 1024 } })
  const page = await context.newPage()
  try {
    await page.goto('/webapp/tests/menu.html')
    await page.getByRole('menuitem', { name: 'Strategies', exact: false }).tap()
    await page.getByRole('menuitem', { name: 'Underlying target', exact: false }).tap()
    const half = page.getByRole('menuitem', { name: 'Half', exact: true })
    await expect(half).toBeInViewport()
    await half.tap()
    expect(await page.evaluate(() => (window as any).chosen)).toBe('half')
    await page.reload()
    await page.getByRole('menuitem', { name: 'Strategies', exact: false }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Underlying target', exact: false }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Full', exact: true }).focus()
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => (window as any).chosen)).toBe('full')
  } finally { await context.close() }
})

test('menu gestures ignore pan, pinch, cancelled and editing gestures; detach cleanly', async ({ page }) => {
  await page.goto('/webapp/tests/gestures.html')
  await page.waitForFunction(() => Boolean((window as any).clean))
  await page.evaluate(() => {
    const target = document.getElementById('chart')!
    const send = (type: string, id: number, x: number, y: number) => target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, bubbles: true }))
    const tap = () => { send('pointerdown', 1, 50, 50); send('pointerup', 1, 50, 50) }
    tap()
    if ((window as any).menus.length) throw Error('Single tap opened menu')
    send('pointerdown', 1, 50, 50); send('pointermove', 1, 90, 50); send('pointermove', 1, 50, 50); send('pointerup', 1, 50, 50)
    tap()
    if ((window as any).menus.length) throw Error('Pan returned to start opened menu')
    send('pointerdown', 1, 50, 50); send('pointerdown', 2, 80, 80); send('pointerup', 2, 80, 80); send('pointerup', 1, 50, 50)
    tap()
    if ((window as any).menus.length) throw Error('Pinch opened menu')
    send('pointerdown', 1, 50, 50); send('pointercancel', 1, 50, 50)
    tap()
    if ((window as any).menus.length) throw Error('Cancelled gesture opened menu')
    ;(window as any).blocked = true
    tap(); tap()
    ;(window as any).blocked = false
    tap()
    if ((window as any).menus.length) throw Error('Editing gesture leaked into menu')
    tap()
    if ((window as any).menus.length !== 1) throw Error('Double-tap did not open menu')
    target.dispatchEvent(new MouseEvent('dblclick', { clientX: 50, clientY: 50 }))
    if ((window as any).menus.length !== 1) throw Error('Synthetic mouse event duplicated menu')
    ;(window as any).clean()
    tap(); tap()
    if ((window as any).menus.length !== 1) throw Error('Listeners leaked after cleanup')
  })
})

for (const renderer of ['kline', 'lightweight']) {
  test(`${renderer}: double-click opens contract menu; single and right clicks do not`, async ({ page }) => {
    await page.goto('/webapp/tests/charts.html?menuGesture=doubleclick')
    await page.waitForFunction(() => (window as any).ready)
    await page.evaluate(() => (window as any).setProps({ menuHarness: true, paneType: 'options', right: 'CE', strike: 24000, expiry: '2026-10-20', openOrders: [] }))
    if (renderer === 'lightweight') await page.evaluate(() => (window as any).switchRenderer('lightweight'))
    const chart = renderer === 'kline' ? page.locator('.kline') : page.locator('.tv-lightweight-charts').first()
    await expect(chart.locator('canvas').first()).toBeVisible()
    await chart.click({ position: { x: 250, y: 150 } })
    await expect(page.getByText(/^Use as SL @/)).toHaveCount(0)
    await chart.click({ button: 'right', position: { x: 250, y: 150 } })
    await expect(page.getByText(/^Use as SL @/)).toHaveCount(0)
    await chart.dblclick({ position: { x: 250, y: 150 } })
    await expect(page.getByText(/^Use as SL @/)).toBeVisible()
    expect(await page.evaluate(() => (window as any).requests.filter((r: any) => r.method === 'PATCH' || r.url.includes('/api/orders') && r.method === 'POST'))).toEqual([])
    await page.getByText(/^Use as SL @/).click()
    await expect(page.getByRole('dialog', { name: 'Chart entry ticket' })).toContainText('24000 CE')
    await page.getByRole('button', { name: 'Limit', exact: true }).click()
    await page.getByRole('button', { name: 'Qty 1', exact: true }).click()
    expect(await page.evaluate(() => (window as any).submittedTicket)).toMatchObject({ ticket: { sessionId: 'session', paneId: 1, right: 'CE', strike: 24000, expiry: '2026-10-20', orderType: 'LIMIT' }, quantity: 1 })
    await page.getByRole('button', { name: 'Chart trading menu', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu', { name: 'Chart trading actions' })).toContainText('₹107.00')
  })

  test(`${renderer}: native touch double-tap opens menu and background drag pans`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 768 } })
    const page = await context.newPage()
    try {
      await page.goto('/webapp/tests/charts.html?menuGesture=doubleclick')
      await page.waitForFunction(() => (window as any).ready)
      await page.evaluate(() => (window as any).setProps({ menuHarness: true, paneType: 'options', right: 'CE', strike: 24000, expiry: '2026-10-20', openOrders: [] }))
      await page.evaluate(() => (window as any).setProps({ onVisibleRangeChange: (range: unknown) => { (window as any).visibleRange = range } }))
      if (renderer === 'lightweight') await page.evaluate(() => (window as any).switchRenderer('lightweight'))
      const chart = renderer === 'kline' ? page.locator('.kline') : page.locator('.tv-lightweight-charts').first()
      await expect(chart.locator('canvas').first()).toBeVisible()
      const box = (await chart.boundingBox())!
      const session = await context.newCDPSession(page)
      const x = box.x + 250, y = box.y + 160
      const touch = async (type: string, px: number) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y }] })
      // Observe the chart's actual view before and after native touch panning.
      if (renderer === 'kline') await page.evaluate(() => { (window as any).beforeRange = (window as any).chart().getVisibleRange() })
      else {
        await page.waitForFunction(() => Boolean((window as any).visibleRange))
        await page.evaluate(() => { (window as any).beforeRange = (window as any).visibleRange })
      }
      await touch('touchStart', x)
      for (let delta = 15; delta <= 120; delta += 15) await touch('touchMove', x + delta)
      await touch('touchEnd', x + 120)
      await expect(page.getByRole('menu', { name: 'Chart trading actions' })).toHaveCount(0)
      if (renderer === 'kline') expect(await page.evaluate(() => JSON.stringify((window as any).chart().getVisibleRange()) !== JSON.stringify((window as any).beforeRange))).toBe(true)
      else await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).visibleRange) !== JSON.stringify((window as any).beforeRange))).toBe(true)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect(page.getByText(/^Use as SL @/)).toBeVisible()
      await page.getByText(/^Use as SL @/).tap()
      await expect(page.getByRole('dialog', { name: 'Chart entry ticket' })).toContainText('24000 CE')
    } finally { await context.close() }
  })

  test(`${renderer}: touch order-line drag writes only on release and cancellation restores it`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 768 } })
    const page = await context.newPage()
    try {
      await page.goto('/webapp/tests/charts.html?menuGesture=doubleclick')
      await page.waitForSelector('.kline canvas')
      if (renderer === 'lightweight') {
        // Capture the real chart API through its public prototype, only in this test.
        await page.evaluate(async () => {
          const url = performance.getEntriesByType('resource').find(r => /deps\/lightweight-charts/.test(r.name))!.name
          const { createChart } = await import(/* @vite-ignore */ url)
          const host = document.createElement('div'); document.body.append(host)
          const temporary = createChart(host, { width: 10, height: 10 })
          const proto = Object.getPrototypeOf(temporary), add = proto.addCandlestickSeries
          proto.addCandlestickSeries = function (...args: any[]) {
            const series = add.apply(this, args)
            ;(window as any).priceSeries = series
            return series
          }
          temporary.remove(); host.remove()
          ;(window as any).lineEdits = []
          ;(window as any).setProps({ onSwingOrderDrag: async (order: any, price: number) => { (window as any).lineEdits.push({ id: order.order_id, price }) } })
          await (window as any).switchRenderer('lightweight')
        })
        await page.waitForFunction(() => (window as any).priceSeries?.data().length > 0)
      }
      const position = await page.evaluate(renderer => {
        const w = window as any
        const rect = document.querySelector(renderer === 'kline' ? '.kline' : '.tv-lightweight-charts')!.getBoundingClientRect()
        const y = renderer === 'kline'
          ? w.chart().convertToPixel([{ timestamp: w.chart().getDataList().at(-1).timestamp, value: 105 }], { paneId: 'candle_pane' })[0].y
          : w.priceSeries.priceToCoordinate(105)
        return { x: rect.x + 300, y: rect.y + y }
      }, renderer)
      const edits = () => page.evaluate(renderer => renderer === 'kline'
        ? (window as any).requests.filter((r: any) => r.method === 'PATCH' && r.url.includes('/api/orders/')).length
        : (window as any).lineEdits.length, renderer)
      const session = await context.newCDPSession(page)
      const touch = (type: string, y: number) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: position.x, y }] })
      await touch('touchStart', position.y)
      await touch('touchMove', position.y - 20)
      await touch('touchMove', position.y - 40)
      expect(await edits()).toBe(0)
      await touch('touchCancel', position.y - 40)
      expect(await edits()).toBe(0)
      await touch('touchStart', position.y)
      await touch('touchMove', position.y - 20)
      await touch('touchMove', position.y - 40)
      expect(await edits()).toBe(0)
      await touch('touchEnd', position.y - 40)
      await expect.poll(edits).toBe(1)
      await expect(page.getByRole('menu', { name: 'Chart trading actions' })).toHaveCount(0)
    } finally { await context.close() }
  })
}
