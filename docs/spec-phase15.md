## Trading Enhancements

### Implementation Status

| Feature | Status | Details |
|---------|--------|---------|
| Trading % With Stoploss (Risk Ratio) | ✅ Complete | Backend + Frontend, ternary sizing mode |
| Mouse Right Click Support | ✅ Complete | ChartContextMenu with nested submenus |
| Setting Re-arrange | ✅ Complete | New Trading tab, improved tab styling |

**Tests:** TypeScript compiles clean. Backend: 726 passed, 8 failed (all pre-existing guardrail mock issues, not related to this PR).

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


