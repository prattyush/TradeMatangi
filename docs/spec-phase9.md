#### Phase-IX RealTrading
This phase launches support of real broker for making trades through that broker. The sections how to integrate with a new broker and extra features or corner cases to handle.


##### Kotak Neo Integration
1. The Kotak Neo Python Library is at https://github.com/Kotak-Neo/Kotak-neo-api-v2.
2. The way to connect to Kotak Neo Client is as below. However, to connect you need a Timed Based OTP. That can be only be fetched real-time. So, whenever you are initializing the Kotak Client, feel free to ask to TOTP through a popup. And if the kotak client is already initialized, no, need to create it again. Lets say you got the totp from user, using that follow the below code to connect to kotak client.
```


    from neo_api_client import NeoAPI

    client = NeoAPI(environment='prod', access_token=None, neo_fin_key=None,
                    consumer_key=parser['kotak-neo']['access_token'])
    client.totp_login(mobile_number=parser['kotak-neo']['mobile'], ucc=parser['kotak-neo']['ucc'], totp=totp)
    client.totp_validate(mpin=parser['kotak-neo']['mpin'])

```
The other details required are added in accesskeys.ini
```
[kotakneo]
access_token=
mobile=
ucc=
mpin=

```
3. To get order feed you need to setup callbacks like
```

        self.neo_client.on_message = self.onmessage  # called when message is received from websocket
        self.neo_client.on_error = self.onerror  # called when any error or exception occurs in code or websocket
        self.neo_client.on_close = self.onclose  # called when websocket connection is closed
        self.neo_client.on_open = self.onopen  # called when websocket successfully connects

        def onmessage(self, message):
            if message['type'] == "order_feed":
                message_data = json.loads(message['data'])
                if  message_data['type'] == 'order':
                    order_data = message_data['data']

```
with sample order is
```

{ "actId": "", "algId": "NA", "algCat": "NA", "algSeqNo": "NA", "avgPrc": "0.00", "brdLtQty": "1", "brkClnt": "08081",
        "cnlQty": 0, "coPct": 0, "defMktProV": "0", "dscQtyPct": "0", "dscQty": 0,
"exUsrInfo": "NA", "exCfmTm": "22-Jan-2025 14:28:01", "exOrdId": "1100000059569867", "expDt": "NA", "expDtSsb": "-", "exSeg": "nse_cm",
"fldQty": 0, "boeSec": 1737536281, "mktProPct": "--", "mktPro":"0", "mfdBy": "NA", "minQty": 0, "mktProFlg": "0", "noMktProFlg": "0",
"nOrdNo": "250122000612876", "optTp": "- ", "ordAutSt": "NA","odCrt": "NA", "ordDtTm": "22-Jan-2025 14:28:01", "ordEntTm":"22-Jan-2025 14:28:01",
"ordGenTp": "NA", "ordSrc": "", "ordValDt": "NA", "prod": "NRML", "prc": "9.39", "prcTp": "L", "qty": 1, "refLmtPrc": 0, "rejRsn": "--", "rmk": "--",
"rptTp": "NA", "reqId": "1", "series": "EQ", "sipInd": "NA", "stat": "open", "ordSt": "open", "stkPrc": "0.00", "sym": "IDEA", "symOrdId": "NA",
"tckSz": "0.0100","tok": "14366", "trnsTp": "B", "trgPrc": "0.00", "trdSym":"IDEA-EQ", "unFldSz": 1, "usrId": "", "uSec": "1737536281", "vldt": "DAY",
"classification": "0", "vendorCode": "", "genDen": "1","genNum": "1", "prcNum": "1", "prcDen": "1", "lotSz": "1", "multiplier":"1",
"precision": "2", "hsUpTm": "2025/01/22 14:28:01", "GuiOrdId": "", "locId": "111111111111100", "appInstlId": "NA", "ordModNo": "",
"strategyCode": "NA", "updRecvTm": 1737536281933015920, "it": "EQ" }

```
here trnsTp is S or B which is Sell and Buy respectively. ordSt moves from OPEN, TO TRIGGER PENDING TO FILLED or COMPLETE
4. Funds or wallet can be fetched by float(self.neo_client.limits()["Net"])
5. Before starting a session wallet should reflect net wallet from Kotak. Or maybe when page is refreshed. Then the actual wallet can be maintained internally per trade or directly from Kotak, do as suited.
6. Kotak can throw many errors during first integration, please show a pop up with the exact error so quickly things can be handled, as it is with real money.


##### Access
1. The access to RealTrading would be limited. Admin would have a new option in the settings to whitelist accounts through a common separated entries. The entries will have the email id. Only those accounts when logged with todays date selected can do realtrading.
2. Also, include a refresh button just left of maximize in trade history so that the real order history can be fetched from kotak and populated.
3. Those whitelisted accounts would have also have an option in settings to select realtrading account. For now Only have KotakNeo in there.
4. Please choose how you want to solve if today's date is selected switching between paper trading or real trading. i am fine with only have real trading option for whiltelisted accounts.


##### Options & Strategies
1. Support options for Nifty50 and SENSEX in realtrading. For sensex the exchanges are (bse_cm and bse_fo(options)). For NIFTY they are (nse_cm and nse_fo)
2. Add support of strategies for real-trading, with AutoStop Order Strategy not actually placing a stop-limit order to KotakNeo, but instead keep it locally and when it is triggers place the order in Kotak-Neo.
3. For Aggresive StopLoss and Breakeven which modify Stoploss. They should always go directly to Kotak-Neo. As shifting stoploss is very very important for trades. So, they should be directly applied to the broker.
4. When fetching kotak neo orders when the user clicks on trading history refresh, also fetch open orders (like stoploss or any open limit orders due to not getting filled) and update if required. Limit orders can be left open or partially filled as according to SEBI Regulations, all market orders placed through API should be limit orders. And technically, any limit order can remain open if it is fully filled, partially filled maybe.
  
##### More
1. More things to come. lets finish this first.

---

## Implementation Status — Phase IX (as of 2026-05-22)

**Status:** COMPLETE — all PRs merged to dev and main.

**Test count:** 436 passing (420 pre-feature + 16 new for Options & Strategies). TypeScript clean.

---

### Architecture Decisions

**Order routing by type:**
- `STOPLOSS` orders → placed directly on Kotak as SL-M at creation via `kotak_service.place_sl_order()`. Kotak's own trigger engine manages fill. Our `check_orders` skips any order with `kotak_order_id` set.
- `LIMIT` / `TARGET` orders → simulated locally by the tick engine. When triggered, intercepted in `_emit_tick_and_check_orders_real()` and forwarded to Kotak as a limit order.
- `TradePanel buy/sell` → Kotak limit order at LTP ± `KOTAK_SLIPPAGE_PCT = 0.005` (0.5%). Indian regulatory requirement: no market orders; a price sufficiently inside bid/ask fills immediately.

**Fill lifecycle:**
1. Kotak order-feed WebSocket fires `on_message` in a background thread.
2. `_on_order_feed` parses the message; on `ordSt == "complete"` dispatches the registered fill callback via `loop.call_soon_threadsafe`.
3. Fill callback: records trade in DynamoDB, updates wallet, emits `order_filled` SSE event.
4. Frontend `handleOrderFilled` adds the trade to state. For `broker_pending` (TradePanel real buy/sell), the 202 response is handled by checking `result.status === 'broker_pending'` and skipping the optimistic state update — the SSE event is the source of truth.

**Wallet sync:**
- On real session start: `wallet_service.reset(user_id, date, kotak_funds)` overwrites the wallet with Kotak's live net balance.
- Per-trade: credited/debited the same as paper, but only AFTER Kotak fill confirmation (not at order placement time).

**Whitelist:**
- `RealTradingWhitelist` DynamoDB table with `user_id` as PK. Lazy `_ensure_table()` on first access — no startup script changes needed (same pattern as all other tables).
- Admin bypasses whitelist check (admin can always use real trading).
- `require_real_trading_access` FastAPI dependency: checks whitelist + raises 403 for non-whitelisted non-admin users.

**Session type auto-detection:**
- Frontend sets `session_type = "real"` when `isRealTradingUser && currentDate === todayIST()`.
- Non-whitelisted users on today's date get `session_type = "paper"` (unchanged).
- Historical dates always use `session_type = "sim"` regardless of whitelist.

---

### Files Created

| File | Purpose |
|------|---------|
| `backend/app/services/kotak_service.py` | `KotakNeoService` singleton, TOTP login, `place_limit_order`, `place_sl_order`, `cancel_order`, `get_funds`, fill callbacks bridged to asyncio via `loop.call_soon_threadsafe`, `KotakError` exception |
| `backend/app/routers/kotak.py` | `/api/kotak/login`, `/api/kotak/status`, `/api/kotak/funds`, `/api/kotak/order-history` |
| `backend/app/services/real_trading_service.py` | `RealTradingWhitelist` DynamoDB CRUD — `get_whitelist`, `add_to_whitelist`, `remove_from_whitelist`, `is_whitelisted_user` |
| `backend/tests/test_phase9_real_trading.py` | 29 tests covering whitelist CRUD, Kotak login/status/funds, session guards, SL routing, buy/sell routing |
| `frontend/src/components/KotakTOTPModal.tsx` | 6-digit TOTP input modal; calls `api.kotakLogin(totp)`; shows exact Kotak error string on failure |

### Files Modified

**Backend:**
- `backend/app/config.py` — `KOTAK_SLIPPAGE_PCT = 0.005`
- `backend/app/dependencies.py` — `require_real_trading_access` dependency
- `backend/app/main.py` — register `kotak.router`
- `backend/app/models/schemas.py` — `KotakLoginRequest`, `KotakStatusResponse`, `KotakFundsResponse`, `WhitelistAddRequest`, `WhitelistEntry`; `kotak_order_id: str | None` on `Order`
- `backend/app/routers/admin.py` — whitelist CRUD endpoints (`GET/POST/DELETE /api/admin/real-trading/whitelist`)
- `backend/app/routers/orders.py` — SL placement: when `session_type == "real"`, place on Kotak and store `kotak_order_id`; cancel: calls `kotak_service.cancel_order()` if `kotak_order_id` set
- `backend/app/routers/simulation.py` — real session guards (whitelist check → 403, Kotak auth check → 401, fund sync); `update_pane_strike` handles real sessions same as paper
- `backend/app/routers/trading.py` — `_place_kotak_direct()` helper; `buy()`/`sell()` return 202 `broker_pending` for real sessions
- `backend/app/services/order_service.py` — `check_orders` skips orders with `kotak_order_id` (Kotak manages fill)
- `backend/app/services/simulation.py` — `kotak_order_map: dict[str, str]` on `SimulationSession`; `_run_real_session()`; `_emit_tick_and_check_orders_real()`

**Frontend:**
- `frontend/src/App.tsx` — `isRealTradingUser` state fetched via `api.checkRealTradingAccess()` on mount; passes `sessionType` to `TradeHistory`; `onRefresh` handler for real sessions; `maximizedPaneId` state + `⤢`/`⤡` maximize logic; `order_cancelled` SSE event handler calling `sim.handleOrderCancelled()`
- `frontend/src/components/SessionControls.tsx` — `isRealTradingUser` prop; red REAL badge; TOTP modal flow before session start; `session_type: 'real'` in start config
- `frontend/src/components/SettingsModal.tsx` — admin whitelist panel (add/remove emails); broker status + Connect button for whitelisted users
- `frontend/src/components/TradeHistory.tsx` — refresh button (🔄) when `sessionType === 'real'`; calls `api.kotakOrderHistory()`
- `frontend/src/components/Chart.tsx` — `onMaximize`/`isMaximized` props; `⤢`/`⤡` button in toolbar after ↻ reload button; directional trade marker colors (long Nifty direction = white `#FFFFFF`, short = bright red `#FF4D4D`; PE pane inverts BUY/SELL meaning)
- `frontend/src/hooks/useSimulation.ts` — `sessionType: string` in `SimulationState`; `setTrades` exported; `handleOrderCancelled` callback filters cancelled order from `openOrders` and bumps `walletRefreshKey`
- `frontend/src/services/api.ts` — `kotakLogin`, `kotakStatus`, `kotakFunds`, `kotakOrderHistory`, `checkRealTradingAccess`, `getRealTradingWhitelist`, `addToRealTradingWhitelist`, `removeFromRealTradingWhitelist`; `session_type` union extended to include `'real'`; `buy()`/`sell()` return type widened to include `{ status: string; kotak_order_id?: string }`

**Scripts:**
- `scripts/start-backend.sh` — `pip install --no-deps` for `neo_api_client` (after main requirements install)
- `scripts/start-backend-ec2.sh` — same `--no-deps` step

---

### Bugs Fixed Post-PR (2026-05-20 session)

#### BUG-IX-4: Trade markers / history / wallet updated on failed Kotak orders

**Symptom:** After a Kotak order failed with `stCode 100008 / unauthorized`, the trade marker still appeared on the chart, the trade was added to trade history, and the wallet was debited. The failure was only visible as a toast error.

**Root cause:** `_emit_tick_and_check_orders_real()` had a fallback that recorded the trade and emitted `order_filled` locally when `KotakError` was raised — as if the order had actually filled. This was a leftover from development scaffolding before the Kotak order-feed WebSocket was wired in.

**Fix:** On `KotakError` in the triggered-order forward path:
1. Revert `order.status` from `FILLED` back to `CANCELLED`
2. If the order had a `reserved_amount > 0` (BUY limit), credit it back to the wallet
3. Emit `order_cancelled` SSE event so the frontend removes it from `openOrders`
4. Emit `broker_error` SSE event with the exact Kotak error string so the frontend shows a toast
5. Do NOT call `record_trade()` — the trade must only be recorded on actual Kotak fill confirmation

The same guard applies to `_place_kotak_direct()` in `trading.py` for TradePanel buys/sells (those already returned 202 `broker_pending` and waited for fill callback, so no separate fix needed there).

**Files:** `backend/app/services/simulation.py` (`_emit_tick_and_check_orders_real`); `frontend/src/App.tsx` (add `order_cancelled` handler); `frontend/src/hooks/useSimulation.ts` (add `handleOrderCancelled`)

---

#### BUG-IX-5: TradeHistory 🔄 and ⛶ buttons shifted to the left

**Symptom:** After adding the 🔄 refresh button, both buttons appeared left-aligned under the "Trade History (N)" title instead of right-aligned at the end of the header row.

**Root cause:** The original ⛶ button had `marginLeft: 'auto'` applied directly on itself, which worked when it was the only button. Adding the conditional 🔄 button before it meant that when 🔄 was not shown (non-real session), ⛶ still had `auto` margin and stayed right. But when 🔄 was rendered, it did not have `auto` margin itself, causing it to sit left of ⛶ instead of next to it on the right.

**Fix:** Wrap both buttons in a single container `div` with `marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2`. Neither button needs its own `marginLeft`. The container pushes both buttons to the right as a unit.

**File:** `frontend/src/components/TradeHistory.tsx`

---

#### BUG-IX-1: `neo_api_client` not on PyPI — dependency conflict breaks start-backend.sh

**Symptom:** Clicking "Connect" in Settings → Kotak Neo raised `ModuleNotFoundError: neo_api_client`. Adding it to `requirements.txt` as a Git URL caused pip's dependency resolver to fail: `neo_api_client` pins `urllib3==1.26.x` which conflicts with uvicorn's requirements.

**Root cause:** `neo_api_client` is distributed from GitHub only (not PyPI). Its setup.cfg pins old dependency versions (`urllib3==1.26.14`, `websockets==8.1`, `requests==2.32.3`) that conflict with modern uvicorn/httpx.

**Fix:**
- Removed `neo_api_client` from `requirements.txt` so the main `pip install -r` runs without conflict.
- Added a second `pip install --no-deps` line in `start-backend.sh` and `start-backend-ec2.sh`:
  ```bash
  "$VENV/bin/pip" install -q --no-deps "neo_api_client @ git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1"
  ```
- `--no-deps` is safe because all of `neo_api_client`'s actual runtime dependencies (`requests`, `websockets`, `urllib3`, etc.) are already installed at modern compatible versions by the main requirements install.

---

#### BUG-IX-2: TATMOT Kite streaming fails — NSE symbol renamed after Tata Motors demerger

**Symptom:** Starting a session with TATMOT in real (or paper) mode failed at the Kite streaming step: the instrument token lookup returned nothing, causing "Instrument token not found for TATMOT on NSE".

**Root cause:** After Tata Motors demerged its commercial and passenger vehicle businesses (April 2025), NSE changed the trading symbol:
- Old: `TATAMOTORS` → New: `TMCV` (commercial vehicles, the primary listed entity)
- New: `TMPV` (passenger vehicles, new listing)

Our `_KITE_NAMES["TATMOT"] = "TATAMOTORS"` and Kotak's `_SYMBOL_MAP["TATMOT"] = ("TATAMOTORS", "nse_cm")` both referenced the defunct symbol.

**Fix:**
- `backend/app/services/kite_service.py` — `_KITE_NAMES["TATMOT"]` changed from `"TATAMOTORS"` to `"TMCV"`
- `backend/app/services/kotak_service.py` — `_SYMBOL_MAP["TATMOT"]` changed from `("TATAMOTORS", "nse_cm")` to `("TMCV", "nse_cm")`

**Rule going forward:** When NSE renames/recodes a stock, update both `_KITE_NAMES` in `kite_service.py` and `_SYMBOL_MAP` in `kotak_service.py`. Also delete the stale `data/kite_instruments_NSE.csv` cache file so it is refreshed on next startup.

---

#### BUG-IX-3: `stCode 100008 / unauthorized` on every Kotak API call — IP not whitelisted

**Symptom:** Every Kotak order, fund-fetch, and order-history call returned `{'stCode': 100008, 'errMsg': 'unauthorized', 'stat': 'Not_Ok'}` even after a successful TOTP login.

**Root cause:** Kotak Neo requires the IP address of the calling machine to be registered in the Kotak Neo developer portal before any API call is accepted. The TOTP login itself succeeds (credentials are correct), but the subsequent `place_order` / `limits` / `order_report` calls are rejected because the server's IP is not on the whitelist.

**Fix (operational):** Log in to the Kotak Neo developer portal and add the backend server's public IP address to the allowed IP list. For local development this is your machine's public IP; for EC2 this is the instance's Elastic IP. No code change required.

**Code improvement applied alongside:** `_check_api_response()` helper added to `kotak_service.py` so that any `stat: 'Not_Ok'` response is caught immediately and raises a descriptive `KotakError` (rather than falling through to a confusing "no order ID" message). `stCode 100008` specifically also marks `_authenticated = False` so the frontend shows "Not connected" and prompts re-TOTP.

---

### Lessons Learned — Phase IX

**`neo_api_client` is GitHub-only with pinned old deps**
The library is not on PyPI. Always install with `--no-deps` after the main requirements install so its pinned `urllib3`/`websockets` versions do not force downgrade of uvicorn-required packages. The GitHub URL to use: `git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1`.

**Lazy import vs module-level import patch paths**
When mocking in tests, the patch target must match how the module binds the name at the time the test code executes:
- `admin.py` does `from app.services.user_service import get_user_info` at module load → patch `app.routers.admin.get_user_info` (already bound)
- `simulation.py` does `from app.services.user_service import get_user_info` inside a function → patch `app.services.user_service.get_user_info` (lazy, only bound at call time)
- `kotak.py` does `from app.services.kotak_service import get_service as get_kotak` at module load → patch `app.routers.kotak.get_service`
- `simulation.py` imports `kotak_service` inside the route function → patch `app.services.kotak_service.get_service`

**`wallet_service.reset()` not `set_balance()`**
There is no `wallet_service.set_balance()`. To overwrite the wallet with Kotak funds at session start, use `wallet_service.reset(user_id, date, amount)` — this both updates the in-memory store and persists to DynamoDB.

**TradePanel real buy/sell returns HTTP 202 `broker_pending`**
A real session buy/sell cannot return a `Trade` synchronously — the trade is only confirmed when Kotak's order-feed WebSocket fires. The endpoint returns `{"status": "broker_pending", "kotak_order_id": "..."}` (HTTP 202). Frontend detects this and skips the optimistic state update; the trade arrives via the existing `order_filled` SSE path. The frontend `buy()`/`sell()` return type was widened to `Promise<Trade | { status: string; kotak_order_id?: string }>`.

**Real session uses the same Kite tick infrastructure as paper**
`_run_real_session()` consumes from `session.paper_tick_queue` exactly like `_run_paper_session()`. The only difference is order execution: SL orders go to Kotak; limit/target orders are locally triggered then forwarded; the wallet is seeded from Kotak funds at session start instead of carry-forward.

**`kotak_order_id` on Order prevents double-fill**
`check_orders` (the local tick engine's order checker) skips any order where `order.kotak_order_id` is set. Without this guard, a Kotak SL would be both triggered by Kotak's server-side fill AND by our local tick engine when the price crossed the trigger — resulting in duplicate wallet credits and SSE events.

**RealTradingWhitelist table follows lazy `_ensure_table()` pattern**
All DynamoDB tables in this project use lazy creation on first access. No startup script changes are needed for new tables. The `start-backend.sh` script does not explicitly bootstrap tables.

**NSE symbol renames break Kite token lookups and must be tracked manually**
`_KITE_NAMES` in `kite_service.py` maps our internal symbol key → NSE `tradingsymbol` (for equity) and also → NFO `name` column (for options). When NSE renames a stock (as happened with TATAMOTORS → TMCV in April 2025), both `_KITE_NAMES` and Kotak's `_SYMBOL_MAP` must be updated, and the cached `data/kite_instruments_NSE.csv` deleted so it refreshes. The Breeze `breeze_stock_code` in `config.py` uses ICICI's own codes and may differ — check separately.

**Chart pane maximize/minimize**
Added `maximizedPaneId: number | null` state to `App.tsx`. When set, `renderLayout()` bypasses the normal grid and renders only that pane at full column height. The ✕ remove button is hidden while a pane is maximized (prevents accidental deletion). The `⤢`/`⤡` toggle button is in `Chart.tsx`'s toolbar after the ↻ reload button, passed as `onMaximize` prop. Removing a maximized pane via code clears `maximizedPaneId` automatically.

**Kotak Neo requires IP whitelisting in the developer portal**
`stCode 100008 / unauthorized` on every API call (even after a successful TOTP login) means the server's IP is not on Kotak's allowed IP list. TOTP login and credential validation succeed regardless of IP — the whitelist check only happens on subsequent `place_order` / `limits` / `order_report` calls. Fix: add the backend server's public IP in the Kotak Neo developer portal. For EC2 use the Elastic IP; for local dev use the machine's current public IP.

**Kotak API returns error dicts, not exceptions**
`neo_api_client.place_order()`, `limits()`, and `order_report()` return `{'stat': 'Not_Ok', 'errMsg': '...', 'stCode': N}` on error instead of raising. Always call `_check_api_response(resp)` before processing the response. Without this check, an error response silently falls through (e.g. `get_funds()` would return ₹0, `get_order_history()` would return `[]`).

**SEBI IP whitelisting is mandatory for all API-based order placement — not Kotak-specific**
SEBI regulations require all brokers to restrict API-based order placement to pre-registered IP addresses. This affects every broker integration (Kotak Neo, Zerodha, ICICI Direct, etc.). Fund/wallet balance APIs (`limits()`, `get_funds()`) are read-only and typically do not require IP whitelisting. Order placement APIs (`place_order`, `modify_order`, `cancel_order`) always do. When integrating a new broker, register the server's public IP in that broker's developer portal before testing order flows. For EC2 deployments, use an Elastic IP so the IP does not change across instance stops.

**On Kotak order failure, cancel the local order — never record a fake trade**
`_emit_tick_and_check_orders_real` marks triggered orders `FILLED` before forwarding to Kotak (matching `check_orders` flow). On `KotakError`, the order must be reverted to `CANCELLED`, any `reserved_amount` credited back to the wallet, and an `order_cancelled` SSE event emitted so the frontend removes it from `openOrders`. A `broker_error` SSE event with the error message is also emitted so the frontend can show a toast. Never record a trade locally — the trade record must wait for actual Kotak fill confirmation.

**`order_cancelled` is a new SSE event type (post-Phase IX)**
Added alongside `broker_error`. Frontend `App.tsx` handles `order_cancelled` by calling `sim.handleOrderCancelled(event.order_id)`, which filters the order from `openOrders` and increments `walletRefreshKey`. `useSimulation.ts` exports `handleOrderCancelled` from the hook return object.

**Trade marker colors are directional (long Nifty vs short Nifty), not raw buy/sell**
Chart.tsx uses `isLongDirection = right === 'PE' ? t.side === 'SELL' : t.side === 'BUY'` to determine the Nifty-equivalent direction for each trade:
- Long direction (BUY equity/CE, SELL PE) → white `#FFFFFF` — maximum contrast against dark chart background and both green/red candle bodies
- Short direction (SELL equity/CE, BUY PE) → bright red `#FF4D4D` — distinct from white and from the green up-candle color; `#FFA726` amber was replaced because it blended into up-candles
- The marker text still shows `B`/`S` for the actual instrument-level trade side

**TradeHistory button layout: wrap both action buttons in one `marginLeft: auto` container**
The 🔄 refresh button and ⛶ expand button must share a single wrapper `div` with `marginLeft: 'auto'`. If each button independently applies `marginLeft: 'auto'`, removing one of them (e.g. 🔄 when `sessionType !== 'real'`) causes the remaining button to lose its right-alignment. Wrapper pattern: `<div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>`.

---

### Bugs Fixed Post-Merge (2026-05-22 session — PR #50)

#### Trade marker color scheme revised

**Change:** Marker colors switched from directional (long/short Nifty) to raw instrument side — BUY = white `#FFFFFF`, SELL = bright yellow `#FFE600` — on all live chart panes (equity, CE, PE). The analysis/underlying chart in `TradeAnalysis.tsx` retains directional mapping via `effectiveSideForChart` but also updated red → yellow.

**Rationale:** Red (`#FF4D4D`) blends with red down-candles. The PE-inversion made CE/PE Buy markers show different colors for the same instrument-level action, confusing traders. Raw-side coloring is intuitive: every Buy you place is white, every Sell is yellow.

**Files:** `Chart.tsx` (removed `isLongDirection`; `color = t.side === 'BUY' ? '#FFFFFF' : '#FFE600'`), `TradeAnalysis.tsx` (`#FF4D4D` → `#FFE600`), `CLAUDE.md` (updated invariant).

---

#### BUG-POST-IX-1: Maximizing a chart resets the current in-progress candle bar

**Symptom:** With a 3-min candle accumulating for ~2 minutes, clicking ⤢ to maximize that chart causes the bar to restart from the current streaming value — the high/low/open accumulated so far are lost. Reproduced on equity, CE, and PE panes in both sim and paper sessions.

**Root cause:** `renderLayout()` had a standalone `if (maximizedPaneId !== null)` branch at the top that returned only the maximized pane as a direct child of the chart column div. Multi-pane layouts (2/3/4) wrapped pane wrappers inside intermediate flex containers. Switching between branches changed each pane wrapper's DOM parent. React treats a DOM-parent change as an unmount+remount — regardless of the `key` prop — resetting all Chart refs including `liveWindowRef.current`. The next tick then started a fresh OHLC accumulation from scratch.

**First fix attempt (partial — failed for paper trading):** Restored `liveWindowRef.current` from the last candle in the re-fetched historical data after `series.setData()`. This worked for simulation (past-date parquets are complete) but not paper trading — the options parquet for today is cached with a 10-minute TTL, so the current partial candle may not exist in the cached file. `candles.find(c => c.time === cutoffTs)` returned `undefined` and no restore occurred.

**Final fix (App.tsx):** Removed the standalone maximize branch. Each layout preset (2, 3, 4) now handles maximize inline while preserving its flex container structure:
- Non-maximized panes → `{ display: 'none' }`: still mounted, Chart refs intact.
- Layout 3/4 row containers that hold no maximized pane → `display: none` on the container itself (avoids phantom layout gap) while inner pane wrappers remain in the React tree.
- Pane DOM parent never changes across maximize/restore → no React remount.

**Fix (Chart.tsx ResizeObserver):** Guard against `applyOptions({ width: 0 })` when a pane transitions to `display: none`. A hidden element reports `contentRect.width = 0`; skipping the update prevents potential canvas corruption. The observer fires again with the correct width when the pane becomes visible.

**Fix (Chart.tsx partial-candle restore — kept as safety net):** After `series.setData()` in both the equity and options historical effects, restores `liveWindowRef.current` from the last fetched candle if its timestamp equals the current bar slot. This covers hard-refresh during a running session (chart mounts fresh from page load, not maximize toggle).

**Key lesson:** React component identity is tied to position within the **same DOM parent**, not just the `key` prop. Any component whose parent element changes between renders is unmounted and remounted. For layout-driven show/hide, always prefer CSS (`display: none`) over conditional rendering — the component stays mounted and all refs/state survive.

---

### Options & Strategies for Real Trading (PR #67, 2026-05-22)

**Status:** COMPLETE — merged to dev. Test count: 436 (16 new).

#### Architecture additions

**Options order routing in real sessions:**

- `_build_options_trading_symbol(base, expiry, strike, right, symbol)` in `kotak_service.py` — computes the correct Kotak/NSE-BSE trading symbol string without needing the Kite instruments CSV.
  - Monthly expiry (last occurrence of expiry weekday in the month): `{BASE}{YY}{MON3}{STRIKE}{RIGHT}` e.g. `NIFTY26MAY24700CE`, `SENSEX26MAY76000CE`
  - Weekly non-monthly: `{BASE}{YY}{M}{DD}{STRIKE}{RIGHT}` e.g. `NIFTY2660224700CE` (June 2 = 26+6+02), `SENSEX2660476000CE` (June 4 = 26+6+04)
  - Oct/Nov/Dec month uses two digits: `NIFTY261001...` (Oct 1), `NIFTY261203...` (Dec 3)
  - "Last of month" check: `(expiry + timedelta(7)).month != expiry.month` → True = monthly contract
  - Expiry weekday: NIFTY → Tuesday from 2025-09-01, Thursday before; BSESEN → always Thursday

- `_is_monthly_expiry(expiry_dt, symbol)` — module-level helper implementing the above check
- `_resolve_options_symbol(symbol, right, strike, expiry)` — returns `(kotak_trading_symbol, exchange_segment)`; NIFTY → `nse_fo`, BSESEN → `bse_fo`
- `place_options_limit_order(symbol, right, strike, expiry, side, qty, price)` — options limit order
- `place_options_sl_order(symbol, right, strike, expiry, side, qty, trigger_price, limit_price)` — options SL order
- `modify_sl_order(kotak_order_id, new_trigger, new_limit)` — modifies trigger/limit of an existing Kotak SL order via `client.modify_order()`

**`routers/orders.py` SL routing** — real-session STOPLOSS block now branches on `session.instrument_type`:
- `options` → `kotak_svc.place_options_sl_order(right=order.right, strike=order.strike or session.strike, expiry=session.expiry, ...)`
- `equity` → `kotak_svc.place_sl_order(symbol=session.symbol, ...)`

**`simulation.py` triggered order forwarding** — `_emit_tick_and_check_orders_real()` checks `order.right` before forwarding:
- Options orders (`order.right` set) → `place_options_limit_order(...)`
- Equity orders → `place_limit_order(...)`

**`_register_kotak_sl_for_order(session, order, loop)`** — new module-level helper in `simulation.py`. Encapsulates the full SL placement + fill/reject callback registration pattern so strategies can call it without duplicating the closure code from `orders.py`.

**Strategy real-session routing:**

- `strategy_service.on_tick(session, tick, tick_right, loop=None)` — `loop` parameter added; passed down through `_on_bar_close` → `_on_bar_close_aggressive_sl` and `_on_tick_breakeven`
- `_emit_tick_and_check_orders_real()` passes `loop=loop` when calling `strategy_service.on_tick()`
- `_update_exit_order_price(session, order, new_price)` — signature changed from `(session_id, order, price, trading_date)` to `(session, order, price)`. For real sessions with `order.kotak_order_id` set, also calls `get_kotak().modify_sl_order(order.kotak_order_id, new_price, kotak_limit)` — this is what makes BreakEven/AggressiveStoploss SL modifications reach the broker immediately.
- **BreakEven / AggressiveStoploss fallback** (no existing exit order found): for real sessions (`loop is not None`) places `OrderType.STOPLOSS` locally then calls `_register_kotak_sl_for_order` to route it to Kotak. For sim/paper: places `OrderType.TARGET` locally as before.

**Reconcile enhancement** — `POST /api/kotak/reconcile` now returns `open_orders` (list of Kotak orders with status `"open"` / `"trigger pending"` / `"amo"`) in addition to `reconciled` count. Frontend `onRefresh` handler shows a toast with both counts. `api.ts` return type updated to `{ reconciled: number; open_orders: unknown[] }`.

#### Files modified (PR #67)

- `backend/app/services/kotak_service.py` — `_is_monthly_expiry`, `_build_options_trading_symbol`, `_resolve_options_symbol`, `place_options_limit_order`, `place_options_sl_order`, `modify_sl_order`
- `backend/app/services/simulation.py` — `_register_kotak_sl_for_order` helper; options routing in `_emit_tick_and_check_orders_real`; pass `loop` to `strategy_service.on_tick`
- `backend/app/routers/orders.py` — branch on `instrument_type` for real STOPLOSS placement
- `backend/app/services/strategy_service.py` — `loop` param on `on_tick`, `_on_bar_close`, `_on_bar_close_aggressive_sl`, `_on_tick_breakeven`; `_update_exit_order_price` signature + Kotak modify call; real-session SL routing in fallback paths
- `backend/app/routers/kotak.py` — reconcile returns `open_orders`
- `backend/tests/test_phase9_real_trading.py` — 16 new tests (symbol construction, options order routing, `modify_sl_order`, strategy SL modification, reconcile open_orders)
- `frontend/src/App.tsx` — refresh toast shows open_orders count
- `frontend/src/services/api.ts` — `reconcileKotakOrders` return type includes `open_orders`

#### Lessons Learned — Options & Strategies

**Kotak options trading symbol is formula-based — no instrument CSV needed**
The NSE/BSE options trading symbol can be computed directly from expiry date, strike, and right. Monthly vs weekly distinction: if `(expiry + 7 days).month != expiry.month`, it is the last occurrence of the weekday → monthly format (`MON3`). Otherwise → weekly format (single-digit month Jan–Sep, two-digit Oct–Dec, plus 2-digit zero-padded day). This avoids a Kite API dependency and works for any future expiry date.

**Strategy `_update_exit_order_price` must modify the broker-side order**
BreakEven and AggressiveStoploss shift SL prices by calling `_update_exit_order_price`. Before this fix, only the local `Order` record was updated — the actual Kotak SL order kept its original trigger. The fix: when `order.kotak_order_id` is set and session is real, call `modify_sl_order()` on the broker alongside the local update. Failure to modify on the broker side is logged as a warning but does not abort the local update.

**Strategies need the event loop for real-session Kotak routing**
The asyncio event loop is required to register thread-safe fill/reject callbacks for Kotak orders (`loop.call_soon_threadsafe`). Strategies run synchronously inside `_emit_tick_and_check_orders_real`, which already has `loop` in scope. Adding `loop=None` to `on_tick` and threading it through the call chain is the clean pattern — sim/paper sessions pass `None` and strategies skip broker routing entirely.

**BreakEven/AggressiveStoploss fallback uses STOPLOSS not TARGET in real sessions**
When no existing exit order is found, the "place new exit" fallback used `OrderType.TARGET` (waits for price to cross trigger, then forwards to Kotak). For real sessions, the spec requires immediate broker placement — so the fallback places `OrderType.STOPLOSS` locally and calls `_register_kotak_sl_for_order` straight away. This means the SL is active on Kotak from the moment the strategy fires, not only when price eventually crosses the trigger.

**`_register_kotak_sl_for_order` avoids duplicating callback closure code**
The fill/reject callback pattern (closure over `order_id` + `session`, recording trade, updating wallet, emitting SSE) was duplicated across `orders.py` and `simulation.py`. Extracting it into `_register_kotak_sl_for_order` in `simulation.py` provides a single place to call from strategies, keeping the closure logic DRY. Import is lazy (`from app.services.simulation import _register_kotak_sl_for_order`) to avoid circular imports.

---

### Options Indicator Analysis Script (2026-05-24)

**Status:** COMPLETE — merged to dev.

#### What it does

`scripts/options_indicator.py` is a standalone Python analysis tool that, given a date, symbol, OTM offset, and anchor time:

1. Loads the underlying 1-second parquet from `data/ohlcdata/`, fetches CE and PE options parquets (from cache if present, otherwise via Breeze).
2. Computes ATM from the underlying price at the anchor time; derives `CE strike = ATM + N×interval`, `PE strike = ATM − N×interval`.
3. Resamples all three to 1-minute OHLC starting at the anchor time.
4. Computes four ratio indicators per 1-min bar (each bar's close vs its own open as the % change):
   - `CE% / PE%`
   - `PE% / CE%`
   - `(Und% / CE%) × 10`  — scaled ×10 so the small underlying moves are visible on the same ±1 y-axis
   - `(Und% / PE%) × 10`
5. Plots 7 panels in a dark-themed matplotlib figure: 3 candlestick charts (Underlying, CE, PE) + 4 individual indicator panels (one per ratio), each with its own y-axis.

```bash
# Interactive display
python scripts/options_indicator.py --date 2026-05-22 --symbol NIFTY --otm 2 --time 09:30

# Save to file (headless / EC2)
python scripts/options_indicator.py --date 2026-05-22 --symbol NIFTY --otm 2 --time 09:30 --save out.png
```

#### Files created / modified

| File | Change |
|------|--------|
| `scripts/options_indicator.py` | New — 364-line standalone analysis script |
| `scripts/start-backend.sh` | Added `pip install mplfinance matplotlib` after requirements install |
| `scripts/start-backend-ec2.sh` | Same mplfinance/matplotlib install line |

#### Lessons Learned — Options Indicator Script

**Keep each indicator on its own subplot when scales differ**
Plotting `CE%/PE%` (often 2–10×) and `Und%/CE%` (often 0.05–0.2×) on the same y-axis makes the smaller series invisible. One panel per ratio with independent auto-scaled y-axes is the correct pattern for ratio indicators whose magnitudes can differ by an order of magnitude.

**Scale the small ratio, not the components**
`Und%` moves roughly 10× less than `CE%` or `PE%` in absolute terms. The fix is `(Und%/CE%) × 10` — the full ratio is computed first (`_safe_ratio`), then the result series is multiplied by 10. Scaling a component (e.g. multiplying only the numerator or denominator) changes the meaning of the ratio; scaling the result preserves it and just shifts the visual range.

**Clip ratios to avoid chart-destroying outliers**
When CE% or PE% crosses zero, the ratio spikes to ±∞. `_safe_ratio` returns `NaN` for denominators below 1e-8 (shown as a gap in the line) and clips the remaining values to ±10. This keeps the chart readable without losing information on the non-degenerate bars.

**Integer x-axis with formatted labels avoids mplfinance alignment issues**
mplfinance uses its own internal x-axis coordinate system when plotting into external axes (`ax=`). Mixing mplfinance candle axes with matplotlib indicator axes using `sharex` leads to misaligned ticks. The simpler solution: draw candles manually (matplotlib `FancyBboxPatch` + `plot` for wicks) so all 7 panels share integer positions 0…N-1 with formatted `HH:MM` tick labels — no coordinate mismatch possible.

**`mplfinance` and `matplotlib` are script-only dependencies**
These packages are not needed by the FastAPI backend. Rather than adding them to `backend/requirements.txt` (which would slow down every deployment), they are installed via an extra `pip install` line in the start-backend scripts, which already run on every startup to ensure the venv is current. The script itself imports them at the top level and prints a helpful install hint on `ImportError`.

---

### Kotak Neo Live Streaming + Admin Settings Tab (2026-05-24, PR #73)

**Status:** PR #73 open (feature/kotak-streaming-admin-tab → dev).

#### What it does

Adds Kotak Neo as an alternative live market-data streaming source for paper and real trading sessions, with an admin toggle in the Settings UI to switch between Kite and Kotak Neo.

**Backend:**
- `KotakBroadcaster` singleton in `kotak_service.py` — one NeoWebSocket shared by all sessions; `_KotakOHLCAccumulator` aggregates LTP → 1-second OHLC; fan-out via `loop.call_soon_threadsafe`. Mirrors `KiteBroadcaster` exactly.
- `KotakNeoService._on_message` now dispatches `stock_feed` type messages to a registered `_market_data_callback` (set by `KotakBroadcaster`). Order-feed handling unchanged.
- Instrument master cache: `data/kotak_instruments.json` downloaded via `client.master_data()`, refreshed every 24 h. `fetch_kotak_equity_instrument_token` / `fetch_kotak_options_instrument_token` resolve scrip tokens.
- `live_stream_source` admin setting stored in DynamoDB `BrokerTokens` table via `token_service`. `GET/PUT /api/admin/stream-source` in `admin.py` (admin-only).
- `_setup_kotak_streaming(session, loop)` async helper registers a session with `KotakBroadcaster`, resolving equity + options tokens.
- `_run_paper_session` and `_run_real_session` Phase 2 check `live_stream_source`. Fallback chain: Kotak (if authenticated) → Kite → Breeze (paper only).
- `SimulationSession.kotak_streaming: bool` tracks which broadcaster to unregister in `stop_session()`.

**Frontend:**
- Settings modal: admin users see `[General] [Admin]` tabs. Non-admin layout unchanged.
- Admin tab: BROKER TOKENS, LIVE STREAMING SOURCE toggle (Kite / Kotak Neo with inline Kotak status), REAL TRADING ACCESS whitelist, BROKER CONNECTION.
- `api.getStreamSource()` / `api.setStreamSource()` call `GET/PUT /api/admin/stream-source`.

#### Files modified (PR #73)

| File | Change |
|------|--------|
| `backend/app/services/kotak_service.py` | `KotakBroadcaster`, `_KotakOHLCAccumulator`, instrument master cache helpers, `register_market_data_callback`, stock_feed dispatch in `_on_message` |
| `backend/app/routers/admin.py` | `GET/PUT /api/admin/stream-source` endpoints |
| `backend/app/services/simulation.py` | `_setup_kotak_streaming` helper; Phase 2 streaming source check in paper + real sessions; `kotak_streaming` field on `SimulationSession`; `stop_session` Kotak unregister path |
| `frontend/src/components/SettingsModal.tsx` | Tab refactor (General / Admin); streaming source toggle; admin content moved to Admin tab |
| `frontend/src/services/api.ts` | `getStreamSource()` / `setStreamSource()` |

#### Lessons Learned — Kotak Neo Streaming

**Kotak order-feed and market-data messages share one WebSocket — dispatch by type**
`KotakNeoService._on_message` already received all NeoWebSocket messages. Rather than creating a second WebSocket, we added a `_market_data_callback` field and dispatch `stock_feed` type messages there while leaving `order_feed` handling intact. The broadcaster registers its handler via `register_market_data_callback()` before calling `client.subscribe()`.

**Kotak scrip tokens differ from Kite instrument tokens**
Kite uses integer instrument tokens from downloaded CSV files. Kotak uses numeric scrip codes from the `scrip_master` CSV (column `pSymbol`). The CSV is obtained by calling `client.scrip_master(exchange_segment=seg)` once per segment — it returns a URL string; download the CSV and parse with `csv.DictReader`. Key CSV columns: `pSymbol` (token for `subscribe`), `pTrdSymbol` (trading symbol for `place_order`), `pExchSeg` (exchange). A daily 24-h cache at `data/kotak_instruments.json` avoids repeated API calls.

**Kotak WebSocket stock_feed tick field names are short codes**
In `stock_feed` messages, each tick dict uses short field names defined in `settings.py:stock_key_mapping`: `"tk"` (instrument token — matches `pSymbol` from master), `"e"` (exchange segment), `"ltp"` (LTP — lowercase). `_process_tick` must check `tick.get("tk")` first for token matching. LTP falls back through `"ltp"`, `"last_price"`, etc. for safety but `"ltp"` is the authoritative field.

**`loop.call_soon_threadsafe` requires the event loop to actually be running**
`KotakBroadcaster._process_tick` fans out to session queues via `loop.call_soon_threadsafe(queue.put_nowait, payload)`. This schedules the put on the asyncio event loop from the background WebSocket thread. In unit tests, the loop must be running (use `asyncio.run()` or `await asyncio.sleep(0)`) for the callback to execute — synchronous `queue.put_nowait` will see an empty queue if the loop has no iteration.

**Streaming source selection is global, not per-session**
The `live_stream_source` setting applies at the time each new session is started. Active sessions are unaffected by a mid-flight source change — they continue with the broadcaster they registered with at Phase 2 startup. `stop_session()` reads `session.kotak_streaming` (not the current global setting) so it always unregisters from the correct broadcaster.

---

### Kotak Neo API Corrections (2026-05-25, PR #75)

**Status:** PR #75 open (fix/kotak-api-corrections → dev).

Five API bugs found by reading the installed `neo_api_client` v2 source at `~/venvs/tradematangi/lib/python3.12/site-packages/neo_api_client/`.

#### Bugs Fixed

**BUG-KOTAK-1: `client.master_data()` doesn't exist**
- Root cause: Method was invented — no such function in neo_api_client v2. The correct method is `client.scrip_master(exchange_segment=seg)`, called once per exchange segment. When called with `exchange_segment`, it returns a CSV URL **string** (not data); the CSV must be downloaded separately via `urllib.request`.
- CSV column names: `pSymbol` (numeric instrument token), `pTrdSymbol` (trading symbol for `place_order`), `pExchSeg` (exchange segment), `pSymbolName` (company name), `pInstType` (instrument type).
- Fix: Replaced `_load_kotak_master_from_api()` entirely. Calls `scrip_master()` for `nse_cm`, `nse_fo`, `bse_fo`; downloads each CSV URL; parses with `csv.DictReader`; normalises rows using correct column names with fallbacks.

**BUG-KOTAK-2: `_process_tick()` never matched subscribed tokens**
- Root cause: WebSocket `stock_feed` messages carry the instrument token as `"tk"` (defined in `settings.py:stock_key_mapping`). Code looked for `"instrument_token"`, `"scrip_token"`, `"pScrip"`, `"token"` — none matched. Every tick was silently dropped; KotakBroadcaster fan-out never fired.
- Fix: Added `tick.get("tk")` as the first lookup in `_process_tick()`.

**BUG-KOTAK-3: `modify_sl_order()` always raised TypeError**
- Root cause: `client.modify_order(order_id, price, order_type, quantity, validity, ...)` requires `quantity` as the 4th positional argument. `modify_sl_order()` never passed it → Python-level TypeError on every SL price modification attempt by strategies.
- Fix: Added `qty: int` parameter to `modify_sl_order()`; passes `quantity=str(qty)` to `client.modify_order`. Updated `strategy_service.py:_update_exit_order_price` caller to pass `order.quantity`.

**BUG-KOTAK-4: `un_subscribe` calls missing `exchange_segment`**
- Root cause: `unregister()` and `update_session_right()` built un_subscribe dicts as `[{"instrument_token": t}]` without `exchange_segment`. Also, both popped from `_token_exchange` before extracting the exchange value (so the exchange was lost).
- Fix: Collect `(token, exchange)` tuples *before* popping from `_token_exchange`; include `"exchange_segment"` in all un_subscribe dicts.

#### Lessons Learned

**Read the installed SDK source before writing integration code**
All four bugs came from assuming API shape from documentation or analogies rather than reading the actual installed code. The SDK source is at `~/venvs/tradematangi/lib/python3.12/site-packages/neo_api_client/`. Key files: `neo_api.py` (main class), `NeoWebSocket.py` (WebSocket handler + tick field names), `settings.py` (field name mappings, `stock_key_mapping`), `api/scrip_master_api.py` (scrip_master return format), `api/modify_order_api.py` (modify_order parameter contract).

**`scrip_master()` returns a URL, not data**
`ScripMasterAPI.scrip_master_init(exchange_segment)` hits a REST endpoint that returns `{"data": {"filesPaths": [...]}}`, then filters for the matching segment CSV URL and returns it as a string. Callers must download the URL and parse the CSV — the SDK does not do this for you.

**`modify_order` quantity is mandatory even in the order-id-only path**
`modification_with_orderid` (the path taken when only `order_id` is provided) still sends `"qt": quantity` in its POST body. Passing `quantity=None` sends a null field which the exchange rejects. Always pass the current order quantity even when modifying only price/trigger.
