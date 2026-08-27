## Enhancements-2


### Override session
This idea is that for simulation and stepwise sessions, one can override the previous session and all its data. This can be included as a settings to whether enable this feature or not. When, enabled, if a user is starting a simulation or a stepwise session, it would check if the same symbol, same type (equity/option), same date etc was previously run, if yes and if the setting is enabled, then it would ask user whether to override previous session. If user responds with yes, then delete all previous trades, delete all labels of those trades and also delete any wallet entries for that combination or previous sessions. It selected, yes, the all previous session for that exact combination (date, symbol, type, session type(simulation/stepwise), trading type(options/equity)).

During this can you also update the settings UI to separate the sections EVENT SNAPSHOTS, TRADE LABELING MODE, TRADE ANALYSIS PRICE SOURCE, PATTERN SHARING into a new tab called as A&P or analsis & patterns or others (whichever makes more sense, or you can choose your own name). Just that the settings of General Tab is becoming too long.

### Indicator

#### RR Indicator
Can you introduce a new risk ratio indicatoor, which is placed similar to the fibonacci indicators in the chart. The way indicator will work is user chooses the first price, then choose the 2nd price. Then the system should assume second price is the stock enter price, first price is the risk and then plot 1:1 reward, and 2:1 (2 part reward) and 1.5 as well. If the first price is lesser than the second price, then it is a buy trade and if the first price is greater than the 2nd price, then it is a sell trade. It shoudl also support clear and clear the last drawn lines. The reward line, the price line and the rissk line can be of different colors. Choose an appropriate name for the indicator.


### Chart Structure

I want to add a new way to define the chart structure. Currently, I think it is broken down into 3 sections, opening, midday and closing. Lets declare this broad chart structure. I want to define fine chart structure.

### Fine Chart Structure
All the UI and options would be present in the Structures windows. You can show tabs of fine and broad chart structures or way to switch between them.

The thoought process of fine chart structure is that, the user defines fine chart structures and then their types. For example, a trading range can be different types -> broad, narrow, with traps. Channel can be tight, broad. Breakout can be breakout, breakout 2nd Leg. Etc. The idea is user will define these chart structures and their types and then label the chart with transistion bars. So, user will take a day, first one by one, add the different chart structures the chart goes through in the entire day. Like from opening to TR then breakout, then Reversal, then TR then breakout, channel. These chart structures can also have directions which are only 2 types Buy and Sell.

Now, comes, the usage, the user will open a date, mention the different chart structure states the ohlc data flows through the entire day. The usser will mark on the chart the transition bars. Then system will record the date, the transition bars, and the different chart structures and the order in which they occur. 

Now, during searcches, a user might want to see entire flow, like he selects opening then T.R, in that case the system should list options of all chartss which have these 2 states, opening and T.R, The user can specify type like tight T.R or T.R with traps. Usser can select a particular option and see the chart for that day with the transistion bars marked on the chart. Use can also specify direction if needed. 

User can also search partial like, breakout, then breakout 2nd Leg, then Reversal. Then the system should show all types of reversals which occur with breakout and breakout 2nd leg before it.
s
I am not sure how the UI should look on this, please discuss it. Try to be innovative. 

Some suggestions on UI. User should be able to add new fine chart structure, or for a given chart structure, another type. And then UI needs to be able to add flows, or like user adds, first chart structure as Gap Up, then opening, then TR (adding a optional type if required), then Breakout, then TR then broadd channel, then reversal of type (50% reversal), then Trend Resumption(another chart structure), then Reversal (Double Top), then TR and then finally end chart sstructure.

And for each chart structure added in the flow, user puts a marker on the chart, which is the transition bar.


### Underlying Stoploss

Can you add a new strategy, which applies only for options, where user can use a underlying pricce as the stoploss. That is if a Call option buy trade then the price would be lower than current underlying market pricce, and if Put buy trade then stoploss pricce would be greater than current market price. Once the strategy is triggered it should allow to edit the pricce. WHen the stoplosss pricce is triggered as underlyihg market reaches that price, create new options stoploss orders as other strategies or use existing ones. It should support Sell options trade as well. Follow other strategies implementation mechanisms.


### Trade Calculation
In the Analysis section or stats section, number of trades is defined by total buy or sell orders, instead can you define a trade by the buy or sell action which resulted in a new position, and when that position is finally exited. User may be multiple multiple positions and exit them in any order. But one trade is defined lets say when in Call Option, a position is taken and then exited. That entire set of transactions of buying and sselling together constitute 1 trade. basically, I cam attacching patterns action and expected to one trade, so would like to see stats of trades count accordingly, similarly, the nummber of trades mentioned in Analysis section anywhere.


---

## Implementation Status

### Override Session

**Status:** ✅ Complete

#### Files Changed

**Backend:**
| File | Change |
|------|--------|
| `backend/app/models/schemas.py` | Added `override_session_enabled` to `UserSettingsResponse` and `UserSettingsUpdateRequest`; added `override: bool = False` to `SimulationStartRequest` |
| `backend/app/services/user_settings_service.py` | Added `"override_session_enabled": False` to `DEFAULT_SETTINGS` |
| `backend/app/services/session_cleanup_service.py` | **New** — cascade delete service: `delete_session_cascade()` deletes Trades, Orders, Strategies, TradeLabels, EventSnapshots, AICommands, AIDecisionLog, Sessions record, and wallet entry |
| `backend/app/services/wallet_service.py` | Added `delete_entry(user_id, date)` to remove wallet record from DynamoDB and in-memory cache |
| `backend/app/routers/simulation.py` | Added `override` flag handling in `start_simulation()`; added `GET /api/simulation/check-existing` endpoint |

**Frontend:**
| File | Change |
|------|--------|
| `frontend/src/components/SettingsModal.tsx` | Added "Analysis & Patterns" tab; moved EVENT SNAPSHOTS, TRADE LABELING MODE, TRADE ANALYSIS PRICE SOURCE, EXPERIMENTAL FEATURES, PATTERN SHARING from General tab to new tab; added OVERRIDE PREVIOUS SESSIONS toggle to General tab; added `loadOverrideSessionEnabled` helper |
| `frontend/src/components/SessionControls.tsx` | Added `overrideSessionEnabled` prop; added override confirmation flow in `_doStart()` |
| `frontend/src/hooks/useSimulation.ts` | Added `override?: boolean` to `InstrumentConfig` |
| `frontend/src/services/api.ts` | Added `override` to `SimulationStartRequest`; added `override_session_enabled` to `UserSettingsResponse`; added `checkExistingSession()` API function |
| `frontend/src/App.tsx` | Added `overrideSessionEnabled` state; passes prop to `SessionControls` |

**Tests:**
| File | Change |
|------|--------|
| `backend/tests/test_session_cleanup.py` | **New** — 7 tests: cascade delete (session record, wallet, snapshots, trades batch delete), wallet delete_entry (cache removal, missing entry, DB error) |
| `backend/tests/test_user_settings.py` | Added 3 tests: default constant, GET includes field, PUT accepts field |

#### How It Works

1. **Setting:** User enables "Override Previous Sessions" in Settings → General tab (persisted to DynamoDB + localStorage)
2. **Session Start:** When starting a sim/stepwise session, if setting is enabled:
   - Frontend calls `GET /api/simulation/check-existing` to check for existing session
   - If found, shows `window.confirm()` dialog: "A previous {type} session exists for {symbol} on {date}. Override it and delete all its data?"
   - If confirmed, passes `override: true` in the start request
3. **Cascade Delete:** Backend `delete_session_cascade()` deletes all data for the previous session across 8 DynamoDB tables + wallet entry
4. **New Session:** Fresh session is created with no connection to the previous session

#### Verification

1. Enable override setting in Settings → General tab
2. Start a simulation session for NIFTY on a specific date
3. Stop the session
4. Start another simulation for the same NIFTY + date → should see confirmation dialog
5. Confirm override → old session data deleted, new session starts fresh
6. Verify old trades/labels/wallet are gone
7. Verify without the setting enabled, no dialog appears (current behavior preserved)
8. Backend tests: `cd backend && python -m pytest tests/ -v` (700 pass, 8 pre-existing failures)
9. TypeScript check: `cd frontend && node node_modules/typescript/bin/tsc --noEmit` ✅

---

### RR Indicator

**Status:** ✅ Complete

#### Files Changed

**Frontend:**
| File | Change |
|------|--------|
| `frontend/src/components/Chart.tsx` | Added `'rrindicator'` to `DrawMode` type, `Drawing` type, `DRAW_LABEL`; added click handler (2 clicks: risk price, entry price); added dropdown entry `⚡ Risk:Reward`; added step hints |
| `frontend/src/pages/PatternLibrary.tsx` | Same changes as Chart.tsx for feature parity |

#### How It Works

1. Select **⚡ Risk:Reward** from the Draw dropdown
2. **Click 1:** Set the risk price (stop-loss level)
3. **Click 2:** Set the entry price
4. System auto-detects direction: risk < entry → Bull, risk > entry → Bear
5. Plots 5 horizontal lines (lineWidth: 3) across the time range:
   - **Risk** (red `#f85149`) — stop-loss level
   - **Entry** (white `#e6edf3`) — entry price
   - **1R** (green `#3fb950`) — 1:1 risk-reward
   - **1.5R** (blue `#58a6ff`) — 1.5:1 risk-reward
   - **2R** (purple `#bc8cff`) — 2:1 risk-reward
6. Supports **Clear** (undo last drawing) like all other draw tools

---

### Fine Chart Structure

**Status:** ✅ Complete

#### Files Changed

**Backend:**
| File | Change |
|------|--------|
| `backend/app/services/fine_structure_service.py` | **New** — CRUD for definitions and flows, search by contiguous subsequence, per-user copy of predefined definitions on first access |
| `backend/app/routers/fine_structures.py` | **New** — 11 REST endpoints under `/api/fine-structures` (definitions CRUD, flows CRUD, search, OHLC with flow overlay) |
| `backend/app/main.py` | Registered `fine_structures.router` |
| `scripts/setup-dynamodb-tables.py` | Added 2 new tables: `FineStructureDefinitions`, `FineStructureFlows` |

**Frontend:**
| File | Change |
|------|--------|
| `frontend/src/pages/FineStructures.tsx` | **New** — 3 sub-tabs: Definitions (manage structures/types), Builder (chart + flow steps + transition bars + draw tools + EMA), Search (3-panel: query+tiles | chart | flow steps) |
| `frontend/src/pages/ChartStructures.tsx` | Refactored with Broad/Fine tab switcher; existing content wrapped as `BroadStructures` |
| `frontend/src/services/api.ts` | Added `FineDefinition`, `FlowStep`, `FineFlow`, `FineSearchResult` interfaces + 12 API methods |

**Tests:**
| File | Change |
|------|--------|
| `backend/tests/test_fine_structures.py` | **New** — 21 tests: search algorithm (11), definitions CRUD (4), flows CRUD (3), search integration (3) |

#### DynamoDB Tables

**`FineStructureDefinitions`:**
- PK: `definition_id` (S)
- GSI: `UserIdIndex` on `user_id` (HASH)
- Attributes: `name`, `sub_types` (list of strings), `is_predefined`, `user_id`, `created_at`, `updated_at`

**`FineStructureFlows`:**
- PK: `flow_id` (S)
- GSI1: `UserIdIndex` on `user_id` (HASH)
- GSI2: `SymbolDateIndex` on `symbol` (HASH) + `date` (RANGE)
- Attributes: `symbol`, `date`, `user_id`, `steps` (ordered list of step maps), `created_at`, `updated_at`

Each step map: `{definition_id, name, type?, direction?, transition_bar_time?}`

#### Predefined Definitions

On first access, each user gets their own editable copies of 8 predefined structures:
- Trading Range (broad, narrow, with_traps)
- Channel (tight, broad)
- Breakout (breakout, breakout_2nd_leg)
- Reversal (50_pct, double_top, head_and_shoulders)
- Trend Resumption (strong, weak)
- Gap (gap_up, gap_down, big_gap_up, big_gap_down)
- Opening (within_range, gap_up, gap_down)
- End (no sub-types)

#### How It Works

1. **Structures Page:** Opened via `📊 Structures` button in header. Shows **Broad | Fine** tabs.
2. **Definitions Tab:** Manage structure names and sub-types. Predefined definitions are copied per-user on first access and are fully editable/deletable.
3. **Builder Tab:**
   - Enter symbol + date, click Load to fetch OHLC chart
   - Chart has EMA 9/21 toggle and full draw tools (Horizontal Line, Trend Line, Fib Retracement, Parallel Channel, Risk:Reward)
   - Add flow steps using the form: select structure → optional type → optional direction (Bull/Bear)
   - Click a step to select it, then click on the chart to set its transition bar
   - Markers appear on the chart: Bull = blue arrow up, Bear = orange arrow down
   - Save/update the flow
4. **Search Tab (3-panel layout):**
   - **Left panel:** Build a query sequence (structure + optional type + optional direction), click Search
   - **Results:** 3-column grid of result tiles showing symbol, date, and flow sequence with matched portion highlighted
   - **Right top:** OHLC chart with EMA and transition bar markers for the selected result
   - **Right bottom:** Flow steps list with matched steps highlighted in orange
5. **Search Algorithm:** Finds flows where the query pattern matches the flow steps. Each query step matches if name matches AND (type is null OR matches) AND (direction is null OR matches). Supports **wildcard** (`✱ Any`) which matches 1 or more consecutive steps of any type — useful for patterns like "Opening(gap_up) → * → Channel(tight)" to find any flow with that structure regardless of what happens in between.

#### Verification

1. TypeScript check: `cd frontend && node node_modules/typescript/bin/tsc --noEmit` ✅
2. Frontend build: `cd frontend && node node_modules/vite/bin/vite.js build` ✅
3. Backend tests: `cd backend && python -m pytest tests/test_fine_structures.py -v` (21 passed) ✅
4. Manual: Open Structures → Fine tab → Definitions → verify 8 predefined definitions copied
5. Manual: Builder → load NIFTY → add steps → click chart for transition bars → verify markers appear → save
6. Manual: Search → query [Opening, TR] → verify results → click tile → verify chart + flow steps display

---

### Underlying Stoploss

**Status:** ✅ Complete

Add a new strategy for options trades where the stoploss is based on the underlying price rather than the option price.

**Requirements:**
- Applies only to options trades
- For a Call option Bull trade: stoploss price is below the current underlying market price
- For a Put option Bull trade: stoploss price is above the current underlying market price
- For Sell options trades: reverse logic applies
- Once the strategy is triggered, allow editing the stoploss price
- When the underlying market reaches the stoploss price, create new options stoploss orders (or use existing ones)
- Follow the existing strategy implementation mechanisms

#### Files Changed

| File | Change |
|------|--------|
| `backend/app/models/schemas.py` | Added `UNDERLYING_STOPLOSS = "UnderlyingStoploss"` to `StrategyType` enum; added `underlying_sl_price` field to `StartStrategyRequest` |
| `backend/app/services/strategy_service.py` | Added `_on_tick_underlying_stoploss()` evaluator; wired into `on_tick()` dispatch |
| `backend/app/routers/strategies.py` | Added validation: options-only, requires `underlying_sl_price > 0`; added to metadata |
| `frontend/src/services/api.ts` | Added `'UnderlyingStoploss'` to strategy type union; added `underlying_sl_price` field |
| `frontend/src/components/OrderPanel.tsx` | Added "Underlying SL" UI section with price input, pick button, and start button |
| `frontend/src/App.tsx` | Added `underlying_sl_price` to strategy API call |

#### Trigger Logic

| Position | Stoploss triggers when |
|---|---|
| LONG CE | underlying price <= stoploss_price |
| LONG PE | underlying price >= stoploss_price |
| SHORT CE | underlying price >= stoploss_price |
| SHORT PE | underlying price <= stoploss_price |

#### How It Works

1. User enters underlying stoploss price in OrderPanel → "Underlying SL" section (options only)
2. Clicks "▶ Start Underlying SL" → creates strategy instance
3. On every tick, `_on_tick_underlying_stoploss()` checks if underlying has moved against the position
4. When triggered: shifts existing SL orders to option_LTP ± buffer_ticks, or creates new SL if none exist
5. Strategy marked COMPLETED after execution
6. Price can be edited while strategy is running (same as other strategies)

---

### Trade Calculation

**Status:** ✅ Complete

Redefine how trades are counted in the Analysis section. Currently, each buy or sell order counts as a trade. Instead, define a trade as a complete round-trip: a position being opened and then fully exited.

**Requirements:**
- A "trade" = one complete position lifecycle (entry → exit)
- User may hold multiple positions simultaneously and exit them in any order
- Example: Buying a Call option (position opened) and later selling it (position closed) = 1 trade
- Multiple buy orders that build up a position count as part of the same trade until the position is fully exited
- Update trade count in Analysis section and stats to use this definition
- This aligns trade counting with pattern/labeling actions (each pattern is attached to one complete trade)

#### Files Changed

| File | Change |
|------|--------|
| `backend/app/services/analysis_service.py` | Added `round_trip_count` to `compute_session_summary()` using existing `_fifo_match_trades()` from `trade_label_service` |
| `frontend/src/services/api.ts` | Added `round_trip_count` to `SessionSummary` interface |
| `frontend/src/components/TradeAnalysis.tsx` | Updated `groupSessions()` to use `round_trip_count` for trade totals |

#### How It Works

1. Backend `compute_session_summary()` now calls `_fifo_match_trades()` to detect round-trips (FIFO matching: net_qty returns to 0 = one complete trade)
2. Returns both `trade_count` (raw executions) and `round_trip_count` (complete position cycles)
3. Frontend `groupSessions()` uses `round_trip_count` for the "Total Trades" display (falls back to `trade_count` if unavailable)
4. Round-trip detection groups trades by `right` (equity/CE/PE tracked independently) and matches BUY→SELL chronologically
