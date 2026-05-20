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


##### More
1. More things to come. lets finish this first.

---

## Implementation Status — Phase IX (as of 2026-05-20)

**Status:** COMPLETE — PR #46 open on `feature/phase9-real-trading` (2026-05-19), awaiting merge to dev.

**Test count:** 420 passing (391 pre-phase + 29 new in `test_phase9_real_trading.py`). TypeScript clean.

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
