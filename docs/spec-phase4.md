#### Phase-IV BetaMinorUpdates

##### UI-Upgrade
1. We need option to update the open orders, whether it be Stoploss Orders, Target Orders or Limit Orders. The open orders which is present in UI, can be clickable and when clicked the trigger value can be updated. At least the price should be available to be updated, i.e the trigger price.
2. Further, if the trigger price can be chosen by clicking on the chart. UI should be able to pick the price which is the horizontal line at the click point. The chart should be saame as the symbol for which the price is being updated.
3. The % deviation which is currently set to 1% should be configurable in the settings menu. I am assuming the % deviation is used for both Target as well as StopLoss Orders.
4. Is it possible to draw markers on the symbol which was traded to show buy and sell at the price and the time. The marker can be circle marker at the time and price at which the trade was executed, that is buy or sell, with buy and sell being of different colors.
5. The user needs to know how much time is left for the bar close, that needs to be displayed and updated with every second of replay or with live data stream. The live OHLC Data fetched  with also have timestamp which can be used. The time to left can also be shown as the current time, ticking which will be same for all the charts, so only 1 is enough. Either, way feel free however, the implementation can be done.
6. The UI also needs to show the current P&L as per the trades already taken for the day.
7. Remove the Buy and Sell Button from below the LTP, instead add a Market tab next to Target, Limit, SL. To reduce the width taken by buttons, rename Market to Mkt, Target to Tgt, Limit to Lmt and SL is anyways SL. When market tab is selected and buy or sell is seelected, it takes the L,M or H value and uses that to calculate quantity.
8. Show position P&L below LTP and also, session P&L (P&L for all trades taken in this session) for the current session. Feel free to name it session P&L or Days P&L as suitable.
9. The trade history displayed button should have a expand icon just beside the Trade History words, when that is clicked the history is shown in a pop up window with width enough to show the entire data with all columns.

##### Options-HistoricalData
1. Please fetch last 2 days of ohlc data for the selected option as well for both, CE and PE. The same as it is done for NIFTY 50 or Equity.

##### TradeP&L
1. To calculate Trade P&L please inclulde the commision for the broker as well. The default value can be 10 rupees per trade buy or sell irrespective of the quantity. Include in Settings menu, a value to change the commission to any other value.

---

## Phase IV Implementation Status

### ✅ COMPLETE (278 tests passing) — merged to dev; post-testing fixes in PR #17

All 9 UI-Upgrade features + Options-HistoricalData + TradeP&L shipped:
1. **Edit open orders** — click any open order row to edit trigger/limit price inline
2. **Pick price from chart** — ⊕ button in edit row AND placement form; `'__new__'` sentinel for placement vs order-ID for edits
3. **Configurable TARGET deviation %** — Settings → "TARGET ORDER DEVIATION"; default 1%; `target_deviation_pct` passed per order
4. **Trade markers on charts** — BUY (green ↑) and SELL (red ↓) arrow markers on candlestick series
5. **Bar close countdown** — each chart toolbar shows `Bar close: M:SS`; `paddingRight: 36` prevents overlap with ✕ button
6. **Day P&L** — header widget shows realized + unrealized P&L minus commission; updates on every tick
7. **Market tab (Mkt)** — Mkt/Tgt/Lmt/SL tabs; Mkt places LIMIT at `price × 1.01` (BUY) / `× 0.99` (SELL)
8. **Position P&L + Session P&L** — TradePanel shows "Pos P&L" (unrealized) and "Session P&L" (realized + unrealized − commission)
9. **Trade history expand popup** — ⛶ icon opens full modal with all columns

**Backend**: `PATCH /api/orders/{id}`, `target_deviation_pct` on order schemas, options historical 3-date fetch.
**New symbol**: SENSEX (`BSESEN`) — BSE index, options only, BFO exchange, weekly Thursday expiry, lot size 20, strike interval 100.

### Post-Merge Bugs Fixed
- Bug #1: Options pre-session candles missing — append `+ [date]` to options historical fetch
- Bug #2: Bar countdown overlaps ✕ button — `paddingRight: 36` on Chart toolbar
- Bug #3: Market order may not fill — place at `price × 1.01/0.99` not exact price
- Bug #4: Chart price-pick fails on empty area — move `!param.time` guard after price-pick branch
- Bug #5: Trade history shows wrong time — use `timeZone: 'UTC'` not `'Asia/Kolkata'`
- Bug #6: Cancel order 404 stays in UI — treat 404 as "already gone", remove from state
- Bug #7: Price pick only on edit row — add ⊕ to placement form with `'__new__'` sentinel
- Bug #8/11: Equity replay missing 09:15 bar — fetch `getHistorical` + `getPreSession` in parallel, single `setData`
- Bug #9: SENSEX OTM offset wrong interval — add `BSESEN: 100` to `addPane` strike interval map
- Bug #10: Mid-session pane no live ticks — equity-as-master-clock with per-tick CE/PE dict lookup + `liveFromTs` + `PUT /update-pane-strike`

### Lessons Learned
- Options historical needs trading date + prior days (`prior_trading_days(n=2) + [date]`)
- Market orders via LIMIT + deviation — 1% guarantees fill without a new order type
- Commission belongs in the backend (`compute_commission` in trading.py) so analysis can use accurate per-trade costs
- Absolute-positioned overlays need toolbar `paddingRight`, not `marginRight` on last item
- IST-as-UTC display: use `timeZone: 'UTC'` in `toLocaleTimeString`
- Cancel 404 = SSE race — always treat as "order is already gone"
- Equity chart needs single `setData` combining historical + pre-session to prevent "Cannot update oldest data"
- Mid-session pane requires 3 coordinated changes: backend state + per-tick reload + `liveFromTs` history cutoff
- Brokerage as session-level config so mid-session changes don't affect open sessions
