## Trading Enhancements

### Implementation Status

| Feature | Status | Details |
|---------|--------|---------|
| Trading % With Stoploss (Risk Ratio) | ✅ Complete | Backend + Frontend, ternary sizing mode |
| Mouse Right Click Support | ✅ Complete | ChartContextMenu with nested submenus |
| Setting Re-arrange | ✅ Complete | New Trading tab, improved tab styling |
| Bug Fixes (a-f) | ✅ Complete | 6 bugs fixed — see details below |
| Chart Time Interval Dropdown | ✅ Complete | Per-pane dropdown with 1m/2m/3m/5m/15m/30m |
| 2-Minute Interval Support | ✅ Complete | Added to chart and strategy interval options |
| 5-Pane Layout (Triple Top) | ✅ Complete | 3 top + 2 bottom panes with swap/maximize |
| Trade History Strategy & P&L | ✅ Complete | Strategy labels + round-trip P&L on closing trades |

**Tests:** TypeScript compiles clean. Backend: 724 passed, 10 failed (all pre-existing guardrail mock issues, not related to this PR).

---


### Trading % With Stoploss.
This change it to support % risk in capital in trading based on the total capital loss % to be incurred per trade. Currently, we have only 2 options for finding the number of shares or contracts to purchase which is funds ratio or quantity. The idea is to introduce a third risk ratio which takes same 3 percentages. But to calculate the actual quantity, the system would always expect a stoploss price to be present, if not present then it would add its own stoploss which will somme percentage from the current market price (This can be a default settings present in the settings UI, if risk % is choosen, the default can be 20%, if target or limit or merket price is 100, default stoploss is at 80). The stoploss value can be provided by the already present stoploss option present, while placing market, target and limit orders. This stoploss value now should also be present for auto stop orders, as in that case, system would find out the quantity based on the target price it is placing the order for , and the stoploss for that order(default stoploss is 20% below of the target price, if target price is 100, stoploss is 80). Idea is if the trade fails the quantity should be such that the total loss in capital % is the input, similar as how funds ratio is now taken. 

If the % is too less, make sure minimum contract size or shares are bought. 


### Mouse Right Click Support
This feature requires now the charts should support right click, I think lightweight charts supports catching click. So, when right click is done on the chart (only works when trading is in session, simulation, stepwise, paper or real) a small window should appear. The system should be taking the price at which the mouse is clicked, using that price options would be present in the window:-
a) As stoploss place, place a market order or place a auto-stop order. Then, the option of % or quantity should come. The UI menu can be nested, so, as mouse hovers on use as stoploss price, then another sub-menu comes with 2 options, market order or auto stop order, then another submenu comes with quantity or % based on settings choosen options (funds ratio, risk ratio or quantity). Or may be some other way to choose the UI menu layout.

b) Other options can be shift stoploss to here, this works if any open position is present on that chart. 
c) Option is make the price as target exit or limit price. Basically converts open stoplosss orders to limit price (target orders) or if limit price are already present changes to the clicked price value.  Similar behavior when shift stoploss to the price is selected.
d) Another option would be to start strategy target profit on that price.

The symbol can be choosen 
This should work for all stepwise, simulation, paper trading and real trading.

In case mouse click is done on underlying chart. 2 options:-
a) Start strategy "Underlying Target" at the underlying price which is the the clicked price.
b) Start strategy "Underlying SL" at the underlying price which is the the clicked price.



### Setting Re-arrange.
Change the settings Popup more beautiful by making the tabs more visible and their boundaries more distinct with having borders. Create another tab called trading and put these settings into that:-
a) Trading Mode. (Funds Ratio)
b) Target Order Deviation
c) Brokerage
d) Entry Auto Stoploss
e) Any new settings that is getting created for the "Trading % With Stoploss." or "Mouse Right Click Support"


---

## Implementation Details

### Feature 1: Risk % Position Sizing

**Formula:** `quantity = floor((session_capital × risk_ratio_pct) / abs(entry_price - stoploss_price))`

**Defaults:** L=1%, M=2%, H=4% of capital at risk per trade. Default SL = 20% below entry.

**How it works:**
- New `SizingMode` type replaces the old `fundsRatioMode` boolean: `'quantity' | 'fundsRatio' | 'riskRatio'`
- Backward compatible: old `fundsRatioMode=true` in localStorage migrates to `sizingMode='fundsRatio'`
- When RiskRatio is selected, OrderPanel shows orange R-L/R-M/R-H buttons
- If user provides a stoploss via "Stoploss on entry", that price is used for the risk formula
- If no stoploss is provided, backend uses `default_sl_pct` (configurable, default 20%) to compute one
- For AutoStop strategies, risk ratio is passed through metadata and computed at fill time
- Minimum 1 lot/contract is guaranteed even if risk % is very low

**Backend:** `compute_risk_ratio_quantity()` in `order_service.py`, risk ratio branch in `orders.py` router, settings in `user_settings_service.py`

### Feature 2: Right-Click Context Menu

**How it works:**
- Native DOM `contextmenu` event on chart container div (not Lightweight Charts API)
- Price converted from pixel Y via `seriesRef.current.coordinateToPrice()`
- Chart type (equity/CE/PE) auto-detected from pane props — no user selection needed
- Menu only appears when session is running or paused
- Nested submenus for: Use as SL → (Long/Short) → (Market/Auto-Stop) → (sizing options)
- Configurable SL direction: "Long Only" (default) or "Both Long & Short" via settings

**Actions:**
1. **Use as SL** — places entry order with clicked price as stoploss
2. **Shift SL to here** — bulk-updates all pending SL orders to clicked price
3. **Make as limit price** — converts pending non-SL orders to LIMIT at clicked price
4. **Start strategy** — Target Profit, Lock Profit, Underlying Target, Underlying SL

### Feature 3: Settings UI Re-arrange

**Changes:**
- New "Trading" tab between General and Analytics
- Moved from General → Trading: Trading Mode, Funds/Risk Ratio settings, Target Deviation, Brokerage, Entry Auto-Stoploss, Right-Click SL Direction
- Kept in General: P&L Display, Historical Days, Override Sessions, Wallet, Broker, Option Strike Mode
- Improved tab styling: visible borders between tabs, hover effects, better font weight

---

## Implementation Plan

### Feature 1: Risk % Position Sizing Mode

**Concept:** A third sizing mode alongside Quantity and FundsRatio. The user sets a "risk %" (L/M/H), and the system computes quantity so that if the stoploss is hit, the loss equals that % of session capital. Requires a stoploss price — if not provided, uses a configurable default (20% below entry).

**Formula:** `quantity = floor((session_capital × risk_ratio_pct) / abs(entry_price - stoploss_price))`

**Defaults:** L=1%, M=2%, H=4% of capital at risk per trade. Default SL = 20% below entry.

#### Backend Changes

**1a. `backend/app/models/schemas.py`**
- Add `risk_ratio_pct: float | None = None` to `PlaceOrderRequest`
- Add `risk_ratio_pct: float | None = None` to `StartStrategyRequest` (for AutoStop sizing)

**1b. `backend/app/services/order_service.py`**
- Add `compute_risk_ratio_quantity()` function next to `compute_funds_ratio_quantity()`:
  ```python
  def compute_risk_ratio_quantity(symbol, entry_price, stoploss_price, session_capital, risk_ratio_pct, current_wallet, lot_size=1):
      sl_distance = abs(entry_price - stoploss_price)
      if sl_distance <= 0: raise ValueError
      risk_amount = session_capital * risk_ratio_pct
      if lot_size > 1:
          loss_per_lot = sl_distance * lot_size
          lots = int(risk_amount / loss_per_lot)
          if lots < 1:
              if current_wallet >= entry_price * lot_size: lots = 1
              else: raise InsufficientFundsError
          return lots * lot_size
      else:
          qty = int(risk_amount / sl_distance)
          if qty < 1:
              if current_wallet >= entry_price: qty = 1
              else: raise InsufficientFundsError
          return qty
  ```

**1c. `backend/app/routers/orders.py`**
- In `place_order()`, after the `funds_ratio_pct` block, add parallel block for `risk_ratio_pct`:
  - Resolve `entry_price` from `trigger_price` or `limit_price`
  - Resolve `sl_price`: use `entry_sl_price` if provided, else compute from `default_sl_pct` user setting (default 20%)
  - Call `compute_risk_ratio_quantity()`
  - For BUY: `sl_price = entry_price * (1 - default_sl_pct)`. For SELL: `sl_price = entry_price * (1 + default_sl_pct)`

**1d. `backend/app/services/user_settings_service.py`**
- Add to `DEFAULT_SETTINGS`:
  ```python
  "risk_ratio_l_pct": 0.01,
  "risk_ratio_m_pct": 0.02,
  "risk_ratio_h_pct": 0.04,
  "default_sl_pct": 0.20,
  ```
- Add corresponding lines in `get_settings()` return dict

**1e. `backend/app/routers/strategies.py`**
- In `start_strategy()`, handle `risk_ratio_pct` for AutoStop — pass it through to strategy metadata so quantity can be computed at fill time

**1f. `backend/app/services/strategy_service.py`**
- In AutoStop entry logic, when `risk_ratio_pct` is in metadata, compute quantity using `compute_risk_ratio_quantity()` with the trigger price as entry and default SL %

#### Frontend Changes

**1g. `frontend/src/components/SettingsModal.tsx`**
- Add `RiskRatios` interface and `DEFAULT_RISK_RATIOS: { l: 1, m: 2, h: 4 }`
- Add `SizingMode` type: `'quantity' | 'fundsRatio' | 'riskRatio'`
- Add `loadSizingMode()` / `saveSizingMode()` with migration from old `fundsRatioMode` boolean
- Add `loadRiskRatios()` / `saveRiskRatios()` and `loadDefaultSlPct()` / `saveDefaultSlPct()`
- Replace binary toggle with ternary in the Trading tab (see Feature 3)
- Add Risk Ratio L/M/H inputs + Default SL % input (visible when riskRatio selected)

**1h. `frontend/src/App.tsx`**
- Replace `fundsRatioMode` state with `sizingMode: SizingMode`
- Add `riskRatios` and `defaultSlPct` state
- Update `SettingsModal` props/callbacks
- Pass `sizingMode`, `riskRatios`, `defaultSlPct` to `OrderPanel` and `TradePanel`

**1i. `frontend/src/components/OrderPanel.tsx`**
- Update `Props` to accept `sizingMode`, `riskRatios`, `defaultSlPct`
- In quantity/ratio section, add third branch for `riskRatio` showing L/M/H buttons
- In `handlePlace()`, add risk ratio path: compute `risk_ratio_pct`, pass `entry_sl_price` from "Stoploss on entry" if set, send `risk_ratio_pct` instead of `funds_ratio_pct`
- Update AutoStop strategy path to pass `risk_ratio_pct`

**1j. `frontend/src/components/TradePanel.tsx`**
- Update position display to show risk ratio info when `sizingMode === 'riskRatio'`

**1k. `frontend/src/services/api.ts`**
- Add `risk_ratio_pct` to `placeOrder()` opts
- Add `risk_ratio_pct` to `StartStrategyRequest`
- Add risk ratio fields to settings types

---

### Feature 2: Right-Click Context Menu on Charts

**Concept:** Right-click on a chart during an active session shows a context menu at the click position with the clicked price. The menu auto-detects which chart was clicked (equity/CE/PE) — no manual symbol selection needed. A setting controls whether "Use as SL" supports Long-only or both Long and Short.

#### 2a. New file: `frontend/src/components/ChartContextMenu.tsx`
- Generic nested context menu component
- Props: `x`, `y` (screen coords), `price`, `actions[]`, `onClose`
- `ContextMenuAction`: `{ label, icon?, disabled?, submenu?, onClick? }`
- Renders as fixed-position div at `(x, y)`, z-index 1000
- Submenus render to the right of parent (or left if near edge)
- Closes on: click outside, Escape key, action click
- Dark theme styling matching app (`#161b22` bg, `#30363d` border)
- Each item: hover highlight, arrow indicator for submenus

#### 2b. `frontend/src/components/Chart.tsx`
- Add `onContextMenu` prop:
  ```typescript
  onContextMenu?: (price: number, screenX: number, screenY: number, ctx: {
    paneType: string; right?: 'CE' | 'PE'; hasPosition: boolean; hasOpenOrders: boolean; hasSLOrders: boolean
  }) => void
  ```
- In chart init `useEffect`, add `contextmenu` event listener on `containerRef.current`:
  - `e.preventDefault()` to block browser menu
  - Convert `e.clientY` to price via `seriesRef.current.coordinateToPrice()`
  - Determine `right` from the pane's own props (CE or PE) — auto-detected, not user-selected
  - Call `onContextMenuRef.current?.(price, e.clientX, e.clientY, ctx)`
- Keep a ref for `onContextMenu` (same pattern as `onPriceSelectRef`)

#### 2c. `frontend/src/App.tsx`
- Add `contextMenu` state: `{ x, y, price, paneType, right, hasPosition, hasOpenOrders, hasSLOrders, paneId } | null`
- Create `handleChartContextMenu` callback
- Pass `onContextMenu` to each `Chart` in `renderPane()`
- Render `<ChartContextMenu>` when state is non-null
- Build action tree based on context:

**"Use as SL" direction setting:**
- New setting: `contextMenuSLMode: 'longOnly' | 'both'` (stored in localStorage + backend user settings)
- Default: `'longOnly'`
- When `longOnly`: show single option "Use for Long SL" (BUY entry with clicked price as SL)
- When `both`: show two sub-options: "Use for Long SL" (BUY) and "Use for Short SL" (SELL)

**Actions for all charts (when session active):**
1. **"Use as SL @ {price}"** → submenu:
   - If `slMode === 'longOnly'`: "Market Order" → sizing submenu, "Auto-Stop Order" → sizing submenu
   - If `slMode === 'both'`: "Long SL" → (Market/Auto-Stop → sizing), "Short SL" → (Market/Auto-Stop → sizing)
2. **"Shift SL to here"** (only if `hasSLOrders`) → `api.bulkUpdateSL()`
3. **"Make as limit price"** (only if `hasOpenOrders`) → `api.bulkConvertOrders()`
4. **"Start strategy"** → submenu: "Target Profit", "Lock Profit"

**Additional for underlying chart in options sessions:**
5. **"Start strategy"** submenu additions: "Underlying Target", "Underlying SL"

**Chart type auto-detection:**
- The `right` prop on each `Chart` component already indicates CE/PE/undefined
- For options sessions: each pane has `right='CE'` or `right='PE'` — the context menu uses this to place orders on the correct contract
- For equity sessions: `right` is undefined — orders go to the equity symbol
- No user selection needed; the chart clicked determines the instrument

**Action handlers:**
- `placeMarketOrderWithSL(slPrice, side, sizing)`: places order at `currentPrice * (1.01 for BUY / 0.99 for SELL)` with `entry_sl_price=slPrice`
- `placeAutoStopWithSL(slPrice, side, sizing)`: starts AutoStop strategy with `entry_sl_price=slPrice` and direction
- `handleBulkUpdateSL(price, right)`: calls `api.bulkUpdateSL(sessionId, right, price)`
- `handleBulkConvert(type, right)`: calls `api.bulkConvertOrders(sessionId, type, right)`
- `startStrategyFromMenu(type, price)`: calls `api.startStrategy()`

**Sizing submenu builder:**
```typescript
function buildSizingSubmenu(mode, fundsRatios, riskRatios): SizingOption[]
  - quantity mode: [1, 2, 3, 5, 10]
  - fundsRatio mode: [L, M, H] with ratioPct
  - riskRatio mode: [R-L, R-M, R-H] with ratioPct
```

#### 2d. Settings for context menu SL mode
- In SettingsModal Trading tab, add: "Right-Click SL Direction" toggle
  - Options: "Long Only" (default) / "Both Long & Short"
  - Stored in localStorage key `contextMenuSLMode` + backend `context_menu_sl_mode`
- In `backend/app/services/user_settings_service.py`, add `context_menu_sl_mode: "longOnly"` to defaults

---

### Feature 3: Settings UI Re-arrange

**Concept:** Create a new "Trading" tab in Settings. Move trading-related settings from "General" into it. Improve tab visual styling with more visible boundaries.

#### `frontend/src/components/SettingsModal.tsx`

**Tab type update:**
```typescript
type Tab = 'general' | 'trading' | 'analytics' | 'strategies' | 'guardrails' | 'admin' | 'profile'
```

**Tab bar styling:**
- Add visible borders between tabs (left border on each tab except first)
- Increase tab padding and font weight for better visibility
- Add subtle background on hover

**Move from General → Trading tab:**
- Trading Mode toggle → Trading tab
- Funds Ratio L/M/H settings → Trading tab
- Risk Ratio L/M/H settings (new) → Trading tab
- Default SL % setting (new) → Trading tab
- Target Order Deviation → Trading tab
- Brokerage → Trading tab
- Entry Auto-Stoploss → Trading tab
- Right-Click SL Direction (new) → Trading tab

**Keep in General tab:**
- P&L Display Mode
- Historical Days
- Override Previous Sessions
- Wallet
- Broker connection
- Option Strike Mode

**New Trading tab content order:**
1. Trading Mode (Quantity / FundsRatio / RiskRatio ternary toggle)
2. Funds Ratio L/M/H (visible when FundsRatio selected)
3. Risk Ratio L/M/H + Default SL % (visible when RiskRatio selected)
4. Target Order Deviation
5. Brokerage
6. Entry Auto-Stoploss
7. Right-Click SL Direction (Long Only / Both)


### Bugs
Few reported Bugs:-
a) Whwn starting options simulation max Price (50) with sensex as symbol for 7th August, at 09:42am, the CE and the PE price choosen at 09:42am were >500. Can you see if some bug is present in the code, specially cases where multiple depth has to be reached to reach a contract with price below such price. However, price 100 was working correctly.
b) In the Update All button, when multiple stoploss or limit orders can be modified, the 2 buttons shift all to Sl and shift to limit is outside the viewing area. Can you put it just below the UpdateAll button, or maybe arrange them in a way such that they are more visible.
c) The Settings UI tabs are all visible even for Admin, within the viewport, but the tab text are too small, can are increase them in size, and if required increase settings popup width as well.
d) For risk % quantity, the risk ratio button have R-L-1%, then R-M 2.4%, then are too much space, can you just write "RR <value>" like RR 1.2%, RR 2.4%, here RR is risk reward ratio.
e) When a position is already open, and I right click and start a target profit strategy, it doesn't show up in the UI when I click on Strat. What if I need to cancel the strategy which I started, I can't do that if I can't see that the strategy is working now. 
f) Once a order is placed, can you clear the stoploss on entry field value. The trader can switch between CE and PE, does a wrong stoploss on entry price would result in wrong trades. Thus, best it is auto cleared when the order is placed or Buy or sell button is clicked. Same goes for strategy (the stoploss on entry edit box).


### Chart Layout
This section has new features list for chart layout.

#### Time Interval
Currently, the only way to see chart of a new time interval is to add a new chart of different time interval. I can not change the ohlc bar time interval of the chart.
The feaure is to have a time interval dropdown of same values 1m, 3m, 5m, 15m, 30m at each chart, similar to dropdown which is present for "Draw". When the chart should chart to the respective time interval chart. It also needs to support time interval charts for CE and PE for options, I think currently I can only add 3m chart time interval charts.
This is required, as sometimes it makes sense to see what the chart shows for 1m or 15m momentarily, than to have it present alll the time.
The order markers should be visible correctly at the required prices when time intervals are shifted. Further, the strategies would be following the time interval as specified in the settings (Strategy Candle Interval).

Do discuss the complexities of handling such a switch between time intervals, the impact on computation and how will it be done.


#### Custom Time Windows
Can you also support 2 min time intervals.


#### Chart Panes
Supporting 5 chart panes. 3 options for 5 chart panes, 2 rows, top row has 3 chart, bottom 2. Bottom 2 divide the total chart area equally. 
a) The top row chart area is divided equally into 3 parts.
b) The top row chart area is divied into 2 equal parts. And one part (lets call it part 1b) is sub-divied into 2 more equal parts, where the 2 charts in 1b is stacked horizontally.
c) The top row chart area is divied into 2 equal parts. And one part (lets call it part 1b) is sub-divied into 2 more equal parts, where the 2 charts in 1b is stacked vertically.

You can name them as you want.


### Trade History
 Can the trade history pop up which opens also contain if the user can mentioned the expected strategy and the actual profit and loss of the trade. A trade is closed when both the orders of buy and sell are executed. Only after trade is closed only then the actual profit or loss can be calculated. So, can that be included in the trade history. Not all rows will have the value, only the row which has the last closing position entry (Last sell for long position) and vice-versa.

---

### Files Changed Summary

| File | Changes |
|------|---------|
| `backend/app/models/schemas.py` | Add `risk_ratio_pct` to PlaceOrderRequest, StartStrategyRequest |
| `backend/app/services/order_service.py` | Add `compute_risk_ratio_quantity()` |
| `backend/app/routers/orders.py` | Add risk ratio branch in `place_order()` |
| `backend/app/services/user_settings_service.py` | Add risk ratio, default SL, context menu SL mode settings |
| `backend/app/routers/strategies.py` | Pass `risk_ratio_pct` through for AutoStop |
| `backend/app/services/strategy_service.py` | Compute risk-based qty for AutoStop fills |
| `frontend/src/components/SettingsModal.tsx` | Ternary mode, risk ratio UI, new Trading tab, tab styling, context menu SL setting |
| `frontend/src/App.tsx` | sizingMode state, context menu state + handlers |
| `frontend/src/components/OrderPanel.tsx` | Risk ratio sizing UI + order placement |
| `frontend/src/components/TradePanel.tsx` | Risk ratio display |
| `frontend/src/services/api.ts` | Risk ratio fields in types + API calls |
| `frontend/src/components/ChartContextMenu.tsx` | **New** — nested context menu component |
| `frontend/src/components/Chart.tsx` | `contextmenu` DOM listener + `onContextMenu` prop |

### Implementation Order

1. **Settings UI Re-arrange** (Feature 3) — do first since it creates the Trading tab that Features 1 & 2 need
2. **Risk % Backend** (Feature 1a-1f) — schema + service + router
3. **Risk % Frontend** (Feature 1g-1k) — settings UI, order panel, API
4. **Context Menu** (Feature 2) — ChartContextMenu component, Chart.tsx wiring, App.tsx action handlers

### Verification

1. **Risk % sizing**: Start a sim session → switch to RiskRatio mode → place a BUY TARGET with L ratio → verify quantity = `floor(capital × 0.01 / sl_distance)` → verify SL auto-placement on fill
2. **Default SL**: Place order in RiskRatio mode WITHOUT setting entry SL → verify backend uses 20% default → verify correct quantity
3. **Minimum quantity**: Set risk % very low → verify at least 1 lot/contract is purchased
4. **Right-click menu**: Start any session → right-click on chart → verify menu appears at cursor with correct price → test each action
5. **Right-click Long/Short**: Change SL direction setting to "Both" → verify "Long SL" and "Short SL" sub-options appear
6. **Options auto-detection**: Start options session → right-click on CE chart → verify order goes to CE contract → right-click on PE chart → verify order goes to PE contract
7. **Underlying strategies**: Start options session → right-click on underlying chart → verify Underlying Target/SL options appear
8. **Settings re-arrange**: Open Settings → verify Trading tab exists with correct settings → verify General tab no longer has trading settings → verify tab styling is improved
9. **Run existing tests**: `cd backend && python -m pytest tests/ -v` and `cd frontend && node node_modules/typescript/bin/tsc --noEmit`

---

## Bug Fixes Implementation

### Bug (a): Options max price scan returning wrong strikes

**Root cause:** `_get_option_price_at()` uses 15-minute Breeze candles. The query `df[df.index >= target]` returns the close of the nearest candle boundary (e.g., 09:30 candle for a 09:42 query). In volatile markets, the option premium can shift dramatically in that window, causing the scan to accept strikes whose real price at the query time is far above `max_price`. Additionally, deep OTM strikes often have no cached data and are silently skipped.

**Changes:**
- `backend/app/services/options_service.py`: Increased `_MAX_SCAN_INTERVALS` from 20 to 30 (needed for high-value underlyings like BSESEN at 80k+)
- Added stale data warning in `_get_option_price_at()` when candle starts >5 minutes before reference time
- Added logging for fallback `fetch_options_historical()` failures (previously silently swallowed)
- Added warning log when no strike is found within the scan range

### Bug (b): UpdateAll buttons overflow viewport

**Root cause:** LTP, Update All, All SL, and All Lmt buttons were in a single flex row, causing overflow on narrow sidebars.

**Changes:**
- `frontend/src/components/OrderPanel.tsx`: Split into two rows — Row 1: price input + LTP + Update All; Row 2: All SL + All Lmt (with `flex: 1` for equal width)

### Bug (c): Settings tab text too small

**Changes:**
- `frontend/src/components/SettingsModal.tsx`: Tab `fontSize` 9→11, `padding` '8px 2px'→'8px 6px', popup `width` 440→520px

### Bug (d): Risk ratio button labels too verbose

**Changes:**
- `frontend/src/components/OrderPanel.tsx`: Changed label format from "R-L · 1%" to "RR 1%" in three locations: strat tab buttons, main order form buttons, and place button text

### Bug (e): Strategy started from context menu not visible in Strat panel

**Root cause:** Context menu strategy actions called `api.startStrategy().catch(() => {})` — the response (containing `strategy_id`) was discarded, so `runningStrategies` state was never updated.

**Changes:**
- `frontend/src/App.tsx`: All four context menu strategy actions (Target Profit, Lock Profit, Underlying Target, Underlying SL) now capture the response via `.then(resp => setRunningStrategies(prev => [...prev, resp]))`

### Bug (f): Stoploss-on-entry field not cleared after order placement

**Changes:**
- `frontend/src/components/OrderPanel.tsx`: After successful `handlePlace()`, clear `entrySlPrice` and collapse `slOnEntry`. After successful `handleStartStrategy()`, clear `entrySlPriceAuto` and collapse `slOnEntryAuto`

---

## Chart Layout Implementation

### Time Interval Dropdown

**Feature:** Each chart pane now has an interval dropdown (next to the Draw dropdown) supporting 1m, 2m, 3m, 5m, 15m, 30m candles. Changing the interval triggers a full data re-fetch from the backend (server-side resample from 1-second data).

**Changes:**
- `frontend/src/components/Chart.tsx`: Added `onIntervalChange` prop, interval dropdown in toolbar with click-outside-to-close handling
- `frontend/src/App.tsx`: Added `handlePaneIntervalChange` callback, passes `onIntervalChange` to each `<Chart>` component

**Notes:**
- Drawings are cleared on interval change (acceptable per spec — "momentary viewing")
- Order markers auto-adjust via `Math.floor(t.timestamp / intervalSecs) * intervalSecs`
- Strategy bars continue on their configured `strategy_interval_secs` independent of chart display interval

### 2-Minute Interval Support

**Changes:**
- `frontend/src/App.tsx`: Added `2` to `INTERVAL_OPTIONS`
- `frontend/src/components/SettingsModal.tsx`: Added "2 min" option to strategy candle interval dropdown

### 5-Pane Layout (Triple Top)

**Feature:** New "5 Panes" layout option with top row of 3 equal panes and bottom row of 2 equal panes.

**Changes:**
- `frontend/src/App.tsx`: Extended `LayoutPreset` type to include `5`, added "5 Panes" option to layout dropdown, implemented layout rendering with maximize/restore support for all 5 panes, added swap targets (top row: 0↔1↔2, bottom row: 3↔4, cross-row: 0↓3, 1↓4, 2↓4)

---

## Trade History Implementation

### Strategy & P&L Columns

**Feature:** Expanded trade history modal now shows "Strategy" and "P&L" columns. P&L displays only on the closing trade of each FIFO round-trip (green for profit, red for loss, ₹ prefix). Strategy shows the `expected_strategy` from trade labels.

**Changes:**
- `frontend/src/components/TradeHistory.tsx`: Added `roundTrips` and `labels` props, builds lookup maps (closing trade → P&L, closing trade → strategy), added two new columns to expanded modal table
- `frontend/src/App.tsx`: Added `roundTrips` and `tradeLabels` state, fetches via `api.getRoundTrips()` and `api.getLabels()` when session is active (re-fetches on trade count change), passes to `<TradeHistory>`

**Backend:** No changes needed — existing `GET /api/analysis/round-trips` and `GET /api/analysis/labels` endpoints are used.

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `backend/app/services/options_service.py` | Increased scan range 20→30, stale data warning, fallback logging |
| `frontend/src/components/SettingsModal.tsx` | Tab fontSize 9→11, padding, width 440→520, 2min strategy interval |
| `frontend/src/components/OrderPanel.tsx` | RR labels, UpdateAll row split, clear SL on entry after placement |
| `frontend/src/App.tsx` | Context menu strategy capture, interval change callback, 5-pane layout, round-trip/label fetching |
| `frontend/src/components/Chart.tsx` | Interval dropdown in toolbar, `onIntervalChange` prop |
| `frontend/src/components/TradeHistory.tsx` | Strategy + P&L columns in expanded modal |
