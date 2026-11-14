# Phase 24 — Scalping Brain Games (Desktop app only)

**Status: Planned.** Applies to the **desktop app only** (`windowsapp/`, Tauri 2 + React + TypeScript). Not built for the website (`frontend/`) or the webapp (`webapp/`). All work lands on `dev` first via feature branches (see `CLAUDE.md` branch strategy). Nothing here goes to `preprod`/`main` until reviewed.

Implementation plan and sprint table: §14 of this document (split out into `docs/spec-phase24-implementation-plan.md` after Sprint 0, following the Phase 22/23 convention).

---

## 0. Instructions to the implementing agent

1. Read `CLAUDE.md`, `docs/spec.md`, `docs/backend-technical-constraints.md`, `docs/frontend-technical-constraints.md`, `docs/architecture-backend.md`, `docs/architecture-frontend.md`, `docs/spec-phase22.md` and `docs/spec-phase23.md` before writing anything.
2. **Sprint 0 is discovery only.** Answer every item in §13 ("Open questions to verify in Sprint 0") against the real code, record the answers in the implementation plan, and stop for review before Sprint 1.
3. Work on a new feature branch per sprint; PRs target `dev`. Never touch `main` or `preprod`. Merge commits only for inter-branch merges (as in `CLAUDE.md`).
4. **Isolation is a hard requirement (§3.4).** Games must not be able to affect real trading, paper trading, replay or live sessions.
5. Where this spec says "verify", do not assume: read the code and follow what is there. Where the spec and the code disagree, stop and report the disagreement rather than silently choosing.
6. Each sprint updates this document (status table in §14, any decisions in §1.3) in the same PR.

---

## 1. Requirements

### 1.1 Goal

A set of short, adaptive "brain games" that train the specific skills needed for **scalping index options** (Nifty / Bank Nifty and the other index symbols the platform already supports): reading fast price action, entering and exiting well, sizing and risk arithmetic, strike selection, regime awareness and, above all, discipline. Games use **real historical second-level data** already cached on the TradeMatangi server, so practice resembles the real chart.

It is a personal training tool for the platform owner. It is not a leaderboard, not multiplayer, and not a trading signal generator.

### 1.2 Categories

| Category | Purpose | Games |
|---|---|---|
| Speed | React and execute quickly and cleanly | Tick Reader, Hotkey Drill |
| Memory | Hold key levels and structure in mind | Level Recall |
| Attention | Find the relevant signal among noise | Entry Sniper, Spot the Trap |
| Flexibility | Switch playbook when the market changes | Regime Switch |
| Math | Fast, correct risk and position arithmetic | Risk Calculator |
| Reasoning | Choose structure and manage trades by logic | Strike Picker, Exit Discipline |
| Discipline | Follow rules, avoid overtrading | No-Trade Day |

Word games are **out of scope**.

### 1.3 Decisions

| Topic | Decision |
|---|---|
| Clients | Desktop app only. Games are a separate Tauri window (own WebView process). |
| Where compute happens | **On the laptop.** Round generation, difficulty, scoring, option pricing and rendering all run in the desktop WebView. The server only (a) authenticates, (b) serves read-only slices of already-cached market data, and (c) stores small per-user progress records. |
| Server database growth | Hard budget: **under ~1 MB of DynamoDB data per user per year** (§8.5). No per-round, per-tick or per-answer storage. |
| Server CPU | No pandas modelling, no game logic, no scoring on the server. Data endpoints are cache-only file slices (optionally one resample). |
| Cheating/anti-tamper | Not a concern (single owner, no leaderboard). Scoring is client-side by design. Hiding date/symbol before a round ends is a UI discipline, not a security boundary. |
| Real orders | Games **never** place, modify or cancel any order, paper or real, and never touch broker services. |
| Language | TypeScript/React in `windowsapp/`; Python/FastAPI in `backend/` for the thin endpoints. |
| Charts | A small purpose-built canvas chart (`GameChart`) for games. Do not reuse or modify the trading charts (`AnalysisChart`, `ChartTile`, KLine wrappers). |
| Login | Reuse the existing desktop sign-in (tokens held by the Rust host). Progress is per signed-in user. No separate game accounts. |
| Persistence | Local cache (IndexedDB) for market-data windows and an offline outbox; DynamoDB only for compact progress. |
| Option pricing | Real option premium history where cached; otherwise Black–Scholes modelled premium, clearly labelled "modelled". |
| Costs | Configurable cost model (slippage points + flat per-lot round-trip cost). Placeholder defaults are shipped and the user edits them in Settings. No statutory rates are hard-coded. |
| Lot sizes / strike steps / expiries | Read from existing backend configuration (`LOT_SIZES`, `STRIKE_INTERVALS`, `get_expiry_date`), never hard-coded in games. |

### 1.4 Out of scope

Website/webapp support; multiplayer or leaderboards; live or streaming data; any order placement; mobile; AI Helper or LLM-generated content; word games; changes to real/paper trading, replay, stepwise, strategies, guardrails or analysis behaviour.

---

## 2. Terms and shared definitions

All games use these definitions so scoring is comparable.

- **Points**: index points (underlying) or premium points (option), as stated.
- **volUnit**: robust volatility unit for a round = median of 5-second high-low ranges over the previous 5 minutes of the same session. Used to normalise thresholds so a quiet day and a wild day feel comparable. Floor it at a configured minimum to avoid division by ~0 at the open.
- **Window**: `(symbol, date, startSecondOfDay, durationSeconds)`. A **windowId** is the string `symbol|date|startSecond`.
- **R-multiple**: net option points of a trade divided by its risk points (stop distance).
- **Net P&L**: gross points minus slippage (both sides) minus the flat per-lot round-trip cost expressed in points for the lot size in play.
- **deltaProxy**: ATM-like delta (default 0.5) used to convert underlying points to option points when no real premium series exists; Strike Picker uses full Black–Scholes instead.
- **Edge threshold**: `max(1.5 × costPoints, 0.25 × volUnit × sqrt(H/5))` for a hold of H seconds. A move smaller than this is "no tradable edge".
- **SessionScore**: integer 0–100 per game session (see §6). 50 means break-even skill for P&L-style games.
- **Timestamps** follow the platform's IST invariant: data timestamps encode IST wall-clock as if UTC (`tz_localize("UTC")` on naive IST). Display with UTC formatting so 09:15 shows as 09:15. Seconds-of-day = `t mod 86400`. Do not change this convention; do not apply a timezone shift in the client.

---

## 3. Architecture

### 3.1 Overview

```
Desktop app (Tauri host, Rust)           Backend (FastAPI)               Storage
┌───────────────────────────────┐        ┌───────────────────────┐     ┌──────────────────┐
│ Main window (trading)         │        │ /api/desktop/v1/games │     │ OHLC cache files │ (read-only)
│   toolbar "Games" button ─────┼──open──┤  availability (GET)    │────▶│ parquet/pickle   │
│                               │        │  window       (GET)    │     └──────────────────┘
│ Games window (own WebView)    │        │  state    (GET/PUT)    │     ┌──────────────────┐
│  engine (pure TS)             │◀─Rust──│                        │────▶│ DynamoDB         │
│  data cache (IndexedDB)       │ command│ auth: get_desktop_     │     │ GameProfiles     │
│  GameChart (canvas)           │        │       user_id          │     │ (tiny items)     │
└───────────────────────────────┘        └───────────────────────┘     └──────────────────┘
```

### 3.2 Backend (thin, new)

New files, following the existing desktop router/service conventions (`routers/desktop*.py`, `services/desktop_persistence_service.py`):

- `backend/app/routers/desktop_games.py`: prefix `/api/desktop/v1/games`, every route depends on `get_desktop_user_id`. Registered in `main.py` the same way as the other desktop routers.
- `backend/app/services/games_data_service.py`: cache-only slicing of existing second-level data (§8.1–8.3).
- `backend/app/services/games_persistence_service.py`: DynamoDB table `GameProfiles` (§8.4–8.5), created lazily with `PAY_PER_REQUEST` exactly like `desktop_persistence_service._ensure_tables`, and also added to `scripts/setup-dynamodb-tables.py` if that is where other tables are declared (verify).
- `DesktopCapabilities`: add a `games` flag (follow that model's existing pattern; verify) so a desktop build talking to an older backend hides the Games button instead of erroring.

**Hard rules for the data endpoints**

- **Cache-only.** Never call `_ensure_data`, `load_history` with a download path, Breeze, Kite, Kotak, Fyers or any broker. A cache miss returns `404 {"reason": "not_cached"}`. (The existing `/historical/pages` endpoint can trigger a Breeze download on a miss; games must not use it.)
- Read the existing cached file for `(symbol, date)` (see `data_loader.py`: `parquet_path`, `pickle_path`, `load_dataframe`), slice by time, return compact arrays. At most one optional resample (`interval_seconds`), reusing existing resample helpers.
- Honour the `observed` column: never return back-filled or forward-filled rows as real observations (see `observed_frame` / `infer_observed` in `desktop_preparation.py`). Return only observed rows, or return the flag; Sprint 0 decides which, and records it.
- No server-side game logic, scoring, pattern detection, regime labelling or option pricing.
- Responses are gzip-compressed, struct-of-arrays, prices as integers in paise (×100) to keep payloads small.
- Per-user soft rate limit (e.g. 5 requests/second) and a maximum window length (e.g. 900 seconds) to protect the server.

### 3.3 Desktop (new, isolated)

New directory `windowsapp/src/games/`:

```
games/
  GamesApp.tsx            // root of the Games window: hub, routing between screens
  registry.ts             // GameId -> GameDefinition (one line per game)
  types.ts                // GameDefinition, Round, Answer, Result, Category, Level params
  engine/
    rng.ts                // seeded PRNG (mulberry32), seed from (userId, date, gameId, sessionNo)
    difficulty.ts         // level up/down rules, parameter tables loader
    scoring.ts            // R-multiples, SessionScore mapping, category rating
    costModel.ts          // slippage + per-lot cost -> points
    volUnit.ts            // robust volatility unit
    optionPricing.ts      // Black–Scholes price + delta/gamma/theta/vega (pure)
    regime.ts             // efficiency ratio, trend/range classification
    patterns.ts           // deterministic candle-pattern detectors (inside bar, engulfing, pin bar, higher-low)
    levels.ts             // prior-day H/L/C, pivots, VWAP-like, opening range
    windows.ts            // window picking: filters, no-repeat memory, difficulty-driven selection
  data/
    gamesApi.ts           // calls the Rust command (no direct fetch to the backend)
    windowCache.ts        // IndexedDB LRU cache of fetched windows (size-capped)
    outbox.ts             // IndexedDB queue of unsent progress writes, flushed on reconnect
    seenWindows.ts        // local no-repeat memory
  chart/GameChart.tsx     // minimal canvas candle chart: candles, lines, zones, markers, replay clock
  ui/                     // Hub, GameShell (instructions->countdown->play->result), ResultScreen,
                          // Dashboard, DailyWarmup, SettingsPanel, ReviewMode, Timer, HotkeyHints
  games/                  // one folder per game: index.ts (definition), View.tsx, round.ts, score.ts
  config/
    difficulty.json       // per-game parameter tables (L1..L20 anchors, interpolated)
    defaults.json         // cost model, hotkeys, memory caps
```

Rust additions in `windowsapp/src-tauri/src/lib.rs`, following `desktop_settings_request` / `desktop_analysis_request`:

- `desktop_games_request(path, method, body)`: strict allowlist of the `/api/desktop/v1/games/...` routes in §8 and methods GET/PUT only (no arbitrary URLs). **A Rust change requires rebuilding the desktop app** (as `docs/spec-phase23.md` notes); call this out in the PR.
- A command or the existing window-opening helper to open the **Games window** (label `games`), modelled on the existing screen/swing window pattern (`open_screen_window`); add its capability entry in the Tauri capabilities/config as the existing windows do (verify location).

### 3.4 Isolation and safety (hard requirements)

1. The Games window is a **separate Tauri window/WebView**. It shares no React tree, store or state with the trading window. Closing it frees its memory.
2. Files under `windowsapp/src/games/` **must not import** from the trading modules (`App.tsx`, `tradingStream`, `tradingOverlays`, order/ticket/execution modules, `AnalysisChart`, `ChartTile`, swing modules, guardrail modules). Add a vitest "import boundary" test that fails on any such import.
3. The only server routes the games window can call are the three families in §8, through `desktop_games_request`.
4. The Hotkey Drill and every game use a **simulated** mini order panel. No game code path may call an order, broker or session endpoint.
5. The Games button is available in the main window. If a real-trading session is active, show a non-blocking banner in the games window ("Real session active — keep trading window in view"). Do not auto-close or block either window.
6. Games must not change settings, drawings, screens or any other persisted trading data.

### 3.5 Resource budget

| Resource | Budget |
|---|---|
| Laptop RAM (Games window) | Target ≤ 600 MB peak at level 20; ≤ 150,000 candles resident; windows released when a round ends; "Low memory mode" setting halves these |
| Laptop disk | IndexedDB window cache capped (default 300 MB, configurable, LRU eviction), plus outbox (tiny) |
| Server network per round | Typically ≤ 30 KB gzipped (a 300–600 s window at 1 s, underlying + optionally one option series); prefetch throttled to 1 request in flight, ≥ 250 ms apart |
| Server CPU | File read + slice (+ optional resample). Index file avoids directory scans per request |
| Server DynamoDB | ≤ ~1 MB per user per year; one read per Games launch (single query), writes only at session end |
| Server memory | No game-specific caches larger than a couple of dataframes; reuse existing loaders |

---

## 4. Game framework

### 4.1 Contract

```ts
type GameId = 'tick_reader' | 'entry_sniper' | 'exit_discipline' | 'risk_calculator'
            | 'hotkey_drill' | 'level_recall' | 'regime_switch' | 'strike_picker'
            | 'spot_the_trap' | 'no_trade_day'

interface GameDefinition<Round, Answer> {
  id: GameId
  category: Category
  title: string
  blurb: string
  instructions: string[]                 // shown on the instructions screen, max 6 lines
  needs: { underlying?: 'second' | 'minute'; option?: 'preferred' | 'none'; priorDay?: boolean }
  roundsPerSession(level: number): number
  params(level: number): Record<string, number>        // from config/difficulty.json
  makeRound(ctx: RoundContext): Promise<Round>          // pure given (rng, data)
  scoreRound(round: Round, answer: Answer, ctx: RoundContext): RoundResult  // roundScore in [-1, 1] or [0, 1], plus facts
  summarise(results: RoundResult[], level: number): SessionSummary          // -> SessionScore 0..100 + game stats
  View: React.ComponentType<GameViewProps<Round, Answer>>
}
```

Adding a game = one folder in `games/` and one line in `registry.ts`. Nothing else may be edited (enforced in review, not code).

### 4.2 Session flow (shared `GameShell`)

Instructions screen → optional "Practice" vs "Progress" choice → 3-2-1 countdown → N rounds (per `roundsPerSession`) → **Result screen** → write progress → back to hub.

- **Result screen** shows: SessionScore, level change (up/down/same), per-round breakdown with the "best action and why" for each round, and the underlying chart with the revealed date/symbol/time (the identity hidden during play).
- **Progress mode** updates the user's level and stats. **Practice mode** lets the user pick a fixed level; it never changes level, never counts towards streaks, and is stored only as a practice counter.
- **Pause** is allowed between rounds, not during a timed decision.
- **Esc** during a session asks to quit; quitting a progress session records nothing (no penalty).

### 4.3 Round data selection (`windows.ts`)

For each round, pick a window that satisfies the game's needs:

1. From the cached **availability** list (§8.1), choose `(symbol, date)` with native second-level data for the required series.
2. Choose a start second inside the trading session with enough lookback and horizon available; avoid the first and last minutes unless the game says otherwise.
3. **No-repeat memory**: skip any windowId seen in the last `noRepeatDays` (default 30) for this user and game (local `seenWindows`; losing it is harmless).
4. **Difficulty-driven selection**: choppiness, volatility and event content are selected by metrics computed on the client from the fetched data (efficiency ratio, range/volUnit); the generator may fetch a few candidate windows and keep the one matching the level's target profile. Cap candidates per round (default 3) to protect the server.
5. **Identity hiding**: the UI shows only relative time ("t+0s") and prices rebased to the round start; symbol, date and absolute clock are revealed on the result screen. Rebase can be switched off in Settings for the games that require absolute levels (Level Recall).
6. **Seeding**: round order and random choices derive from a seeded PRNG (`userId + date + gameId + sessionNo`) so a session can be reproduced for Review mode and tests.

### 4.4 Cost model (`costModel.ts`)

Settings (synced in the profile record): `slippagePtsPerSide` (option points), `roundTripCostPerLotRs`, `defaultLots`. Cost in points for a trade = `2 × slippagePtsPerSide + roundTripCostPerLotRs / (lotSize)` where `lotSize` comes from the backend config for the symbol. Ship placeholder defaults and label them as placeholders in Settings; the owner enters their broker's real numbers.

---

## 5. The ten games

Each game below defines: the skill, the round, the data it uses, controls, scoring (`roundScore`), difficulty levers, and the feedback shown. Scoring constants live in `config/` so they can be tuned without code changes. Every game must handle: window with too little data (re-pick), data fetch failure (skip round and retry with another window, max 3 retries then end the session gracefully), and a missed decision (timeout counts as the game's neutral outcome and is recorded as `timeout`).

### 5.1 Tick Reader (Speed)

**Skill:** fast directional read of tape-like price action; knowing when not to trade.
**Data:** underlying at 1-second cadence (shown aggregated to 5 s bars for readability, with a live 1-second "last price" line), plus deltaProxy for option P&L.

**Round**
1. A chart reveals the previous `lookbackSec` seconds of price, rebased to 0, with a ticking clock.
2. The user has `decisionSec` seconds to press **LONG (CE)**, **SHORT (PE)** or **SKIP** (keys `←` / `→` / `↓`, also clickable).
3. The next `holdSec` seconds replay at `replaySpeed`×; the trade exits at the end of the hold (no discretion in this game; that is Exit Discipline).
4. Result flash: move in points, net P&L in option points after costs, and whether a tradable edge existed.

**Scoring** (`move` = underlying close at hold end − close at decision, in points):
- Trade: `net = sign × move × deltaProxy − costPts`; `roundScore = clamp(net / (k × volUnitH), −1, +1)` where `volUnitH = volUnit × sqrt(holdSec/5)`, `k` configurable (default 1.0).
- Skip: if `|move| × deltaProxy < edgeThreshold` → `+0.3` ("correct skip"); otherwise `0` ("missed move", counted in stats but not penalised).
- Timeout: treated as skip, flagged.
- `SessionScore = clamp(50 + 50 × mean(roundScore), 0, 100)`.

**Difficulty levers (L1 → L20):** `lookbackSec` 180→45; `decisionSec` 10→2; `holdSec` 60→15; window choppiness (efficiency ratio of the lookback) clean-trend → noisy; `slippagePtsPerSide` multiplier 0→1.5; round count 15→25; share of "no edge" windows 20%→50% (rewarding skip discipline).

**Stats kept:** hit rate, expectancy per trade (option points), skip precision, timeout count, mean decision time.

### 5.2 Entry Sniper (Attention)

**Skill:** timing an entry within a known setup instead of chasing.
**Data:** underlying 1-second; deltaProxy.

**Round**
1. The game states a direction (LONG/SHORT), a stop distance `S = stopMult × volUnit` and target `T = rr × S`, and shows the chart live-forming over a `decisionWindowSec` window.
2. The user presses **ENTER** once to enter at the current price (plus slippage) or **PASS**.
3. From the entry, the replay continues until stop hit, target hit or `horizonSec`; time-out marks to market.
4. The result shows the user's entry, the best possible entry in the window, and the R outcome of each.

**Scoring**
- `R_user`: −1 if stop first, `+rr` if target first, else fractional mark-to-market R at horizon; subtract cost in R.
- `R_opt`: the best `R` achievable over every possible entry second in the window (computed by simulation on the same data).
- Enter: `roundScore = clamp(R_user / max(R_opt, 0.5), −1, 1)`.
- Pass: if `R_opt < 0.25` (trap round) → `+0.5`; else `0`.
- Traps: the window is chosen so that the stated direction fails in a configured share of rounds (L1 0%, L20 30%).

**Difficulty levers:** `decisionWindowSec` 45→10; `stopMult` 1.5→0.8 (tighter); `rr` 1.0→2.0; trap share 0→30%; slippage multiplier; premature-entry penalty (entering in the first 2 seconds at high levels counts as "chasing" in stats).

**Stats:** mean entry efficiency `(R_user / R_opt)`, early-entry rate, trap-pass rate, stop-out rate.

### 5.3 Exit Discipline (Reasoning)

**Skill:** managing an open trade: sticking to the plan, trailing correctly, not giving back winners or holding losers.
**Data:** underlying 1-second (plus real option premium when cached, else deltaProxy), 3–10 minute windows.

**Round**
1. A trade is already entered at time 0 (direction given). Before the replay starts the user sets a **plan**: stop distance and target distance (defaults offered; inputs required).
2. Replay runs at `replaySpeed`×. The user may press **EXIT** at any time, **TRAIL TO COST** (move stop to entry) or **LOCK** (move stop to lock a configurable fraction of open profit). The stop/target are enforced automatically.
3. The round ends at exit, stop, target or `horizonSec`.
4. Result: outcome in R, the plan outcome, MFE/MAE in R, and a "regret" panel.

**Scoring**
- `R_user` = realised R (net of costs). `R_plan` = outcome of holding the original plan untouched. `R_mfe` = maximum favourable excursion in R within the horizon. Floor `R_floor = −1`.
- `capture = clamp((R_user − R_floor) / (R_mfe − R_floor), 0, 1)` (if `R_mfe ≤ 0`, `capture = 1` when `R_user ≥ −1` and the user did not make it worse than the stop).
- Overrides: if the user overrode the plan and ended **worse** than `R_plan`, `roundScore = capture − 0.2`; if ended **better**, no bonus (the lesson is the plan was fine or the override was lucky; shown in the regret panel).
- `roundScore` is clamped to [0, 1] after the adjustment.
- Round mix is controlled: ~40% give-back trades (reach ≥ +1R then retrace), ~30% straight-to-target, ~30% straight-to-stop, classified by simulating the plan on candidate windows.

**Difficulty levers:** horizon length; replay speed 1×→4×; stop tightness; noise; whether the plan fields are pre-filled (L1–L5 yes, later blank).

**Stats:** capture ratio, plan-override rate, override-regret rate (override made it worse), give-back rate, average hold time.

### 5.4 Risk Calculator (Math)

**Skill:** instant, correct risk arithmetic for options scalps.
**Data:** none from the server except `lotSize`/`strikeStep` from backend config (fetched once with the profile). Numbers are generated by the seeded PRNG.

**Question types** (unlocked progressively; each shows a "working" line afterwards):
1. Rupee risk = stop points × lots × lot size.
2. Rupee reward and risk:reward from entry, stop, target (option points).
3. Breakeven premium including round-trip cost per lot.
4. Lots allowed for a risk budget (₹) and a stop in points (floor to whole lots).
5. Percentage of capital at risk for a trade.
6. Option move estimate: `delta × underlying move` (and with gamma at higher levels).
7. Averaging: new average entry after adding lots at a second price; new breakeven.
8. Multi-step: combine 4 + 3 (lots allowed, then breakeven for that size).

**Input and scoring:** numeric keypad entry with Enter to submit. Each question has a time limit `T_q`. `roundScore = correct × (0.7 + 0.3 × speed)` where `speed = clamp(1 − t/T_q, 0, 1)`; "close" answers within a per-type tolerance earn `0.5×`; wrong or timed-out = 0. `SessionScore = 100 × mean(roundScore)`.

**Difficulty levers:** number "ugliness" (round numbers → awkward decimals), number of steps (1→3), `T_q` 25 s→8 s, question-type pool, 12→20 questions.

**Stats:** accuracy by question type, median answer time, most-missed type (drives the Daily Warm-up).

### 5.5 Hotkey Drill (Speed)

**Skill:** clean, fast execution without fat-fingering.
**Data:** none (simulated panel only).

**Round (one 60-second block = one "round"; a session is 3 blocks)**
1. A prompt appears ("BUY CE 2 lots", "EXIT ALL", "STOP TO COST", "SELL PE 1 lot", chains such as "BUY CE 1 lot → STOP −15 pts").
2. The user performs it on a mock panel with the configured key map. The next prompt appears immediately after a correct completion.
3. A wrong key, wrong lots or wrong side is a **fat-finger**: it logs an error and the prompt stays.

**Key map:** defaults (editable in Settings): `C` buy CE, `P` buy PE, `X` exit all, `S` stop to cost, `↑/↓` lots, `1–5` set lots, `Enter` confirm. If the desktop app already defines trading hotkeys (Sprint 0 to verify), offer "import my hotkeys" as a one-way, read-only copy; otherwise use the defaults.

**Scoring:** `accuracy = correct / (correct + errors)`; `speedFactor = clamp((RT_slow − medianRT) / (RT_slow − RT_fast), 0, 1)` with `RT_fast`/`RT_slow` from config (default 600 ms / 2500 ms for single-step prompts; scaled for chains). `SessionScore = 100 × accuracy × (0.4 + 0.6 × speedFactor)`; an error rate above 15% caps SessionScore at 60.

**Difficulty levers:** prompt complexity (single → chains), prompt delay jitter, distractor prompts that must be **ignored** (e.g., "do nothing" cues at high levels), lots variation, shorter display time.

**Stats:** median/p90 reaction time, error types, longest clean streak.

### 5.6 Level Recall (Memory)

**Skill:** holding the day's key levels and structure in mind without staring at the chart.
**Data:** underlying 60-second candles for the prior trading day and the current session up to the round time, plus a few 1-second windows. Levels computed locally in `levels.ts`.

**Round**
1. **Study phase** (`studySec` seconds): the chart shows labelled levels: prior-day high, low and close, today's open, opening-range high/low, today's high/low so far, VWAP-like average (typical price average, since the index has no volume) and the nearest round-number level. The number of levels shown is `levelCount`.
2. **Recall phase**: the levels disappear; a blank price ladder (or the chart without lines) remains with the current price marked. The user clicks to place each named level (the game prompts the names in a random order). Optionally drag to adjust, then submit.
3. **Result**: placed vs true levels with errors in points and in volUnits.

**Scoring** (per level): `levelScore = clamp(1 − err / (tolMult × volUnit_day), 0, 1)`; `roundScore = mean(levelScore)`. A second sub-mode at higher levels ("Swing sequence"): after studying the last 6 swing points, reproduce the order (higher/lower relative to the previous) with an accuracy score. `SessionScore = 100 × mean(roundScore)`.

**Difficulty levers:** `levelCount` 3→8; `studySec` 20→5; `tolMult` 1.0→0.35; distractor lines (irrelevant levels shown) 0→4; sequence sub-mode unlocks at L10.

**Stats:** error per level type (which levels you forget), mean error in volUnits.

### 5.7 Regime Switch (Flexibility)

**Skill:** recognising when conditions changed and switching playbook, instead of repeating what just worked.
**Data:** underlying 1-second segments from different days.

**Round (one session = a chain of `segments` consecutive segments)**
1. Each segment shows `segSec` seconds of price (rebased) and asks the user to choose a **playbook**: **FOLLOW** (go with the last 30 s direction), **FADE** (go against it), or **STAND ASIDE**.
2. The next `holdSec` seconds replay and each playbook's net outcome is computed locally (including costs) for all three options, so there is always a defined best playbook.
3. The user is shown the regime label detected for the segment (trend-up / trend-down / range / spike) and which playbook was best.
4. Segments are ordered so regimes **change** every 2–4 segments; the previous-segment regime is shown in a small "last regime" hint only at low levels.

**Scoring:** rank-based on net outcomes: best playbook `1.0`, second `0.5`, worst `0`; STAND ASIDE is valid and ranked like the others. **Perseveration penalty:** if the regime changed since the previous segment and the user repeated the previous playbook that is now not the best, `roundScore −= 0.25` (floor 0). `SessionScore = 100 × mean(roundScore)`.

**Difficulty levers:** `segSec` 120→40; `holdSec` 60→20; regime change frequency every 4 segments → every 2; "hint" visibility; noisy/ambiguous windows (efficiency ratio near the boundary) at high levels; `segments` 8→16.

**Stats:** perseveration rate, switch accuracy (correct playbook right after a regime change), preferred playbook bias.

### 5.8 Strike Picker (Reasoning)

**Skill:** choosing ITM/ATM/OTM and expiry sensitivity given expected move, time and cost.
**Data:** primarily **modelled** via `optionPricing.ts` (Black–Scholes). When real option premium history exists for the underlying window (per `availability`), a "reality check" row is added using actual premium change.

**Round**
1. A scenario card: underlying price, days to expiry (e.g., 0, 1, 2, 5), implied volatility regime (low/normal/high), direction, **expected move** (points) and **time** (seconds or minutes), and an **objective** stated explicitly (e.g., "maximise ₹ return on ₹10,000 capital" or "maximise ₹ profit per lot").
2. The user chooses CE or PE (given by direction) and a strike offset from `ITM3 … OTM3` (step from backend config).
3. The game prices every strike before and after the scenario (spot move + elapsed time + optional IV shift), including a spread cost that widens for far-OTM strikes.
4. The result table shows premium, delta, gamma, theta, spread cost, ₹ P&L and % return per strike, highlights the best and the user's pick, and prints a templated explanation of the dominant driver (delta, gamma, theta, spread).

**Scoring:** `roundScore = (pnl(pick) − pnl(worst)) / (pnl(best) − pnl(worst))` on the stated objective, `1` if best and worst are equal. `SessionScore = 100 × mean(roundScore)`.

**Difficulty levers:** days-to-expiry mix (0DTE only at higher levels), IV shift scenarios, tighter time windows, objective type variety, cost-sensitive objectives, adding "move does not come" negative scenarios at high levels.

**Stats:** pick distribution vs optimal, ITM/OTM bias, theta-blindness indicator (picks that lose mainly to decay).

### 5.9 Spot the Trap (Attention)

**Skill:** telling real breakouts from fake-outs and finding setups quickly in clutter.
**Data:** underlying 5-second candles (60–120 bars on screen); deterministic detectors in `patterns.ts`.

**Mode A — Breakout verdict (levels 1–20)**
1. A level (recent range high/low) and a breakout candle are highlighted. The chart stops at the breakout.
2. The user chooses **REAL** or **FAKE** within `decisionSec`.
3. Truth is computed locally from the next `horizonSec`: REAL if price extends ≥ `extMult × volUnit` beyond the level before returning `retMult × volUnit` inside the level; otherwise FAKE.
4. `roundScore` = 1 correct, 0 wrong; confidence is not asked.

**Mode B — Pattern hunt (unlocks at L6)**
1. A 60-bar chart is shown with a target pattern named at the top (inside-bar break, engulfing, pin-bar rejection, higher-low sequence).
2. The user clicks every occurrence within `huntSec`; near-miss candles (distractors) are present.
3. `roundScore = F1` of clicked vs true occurrences (tolerance ±1 bar).

`SessionScore = 100 × mean(roundScore)`; sessions alternate modes by level.

**Difficulty levers:** `decisionSec` 12→3; bar count 40→120; distractor count; ambiguity margin (breakouts near the REAL/FAKE boundary); pattern variety; `huntSec` 30→12.

**Stats:** fake-out detection accuracy, real-breakout hesitation (real called fake), per-pattern recall and precision.

### 5.10 No-Trade Day (Discipline)

**Skill:** following pre-committed rules, avoiding overtrading and revenge trades, and standing aside in poor conditions.
**Data:** underlying 1-second (and deltaProxy), a 15–25 minute segment compressed to 3–5 minutes of play via `replaySpeed`.

**Round (one segment = one round; a session is 3 segments)**
1. **Pre-commit screen:** the user chooses rules from a list with limits (max trades, max loss in R, stop after N consecutive losses, cooldown seconds after a loss, max lots). Each rule is optional; chosen rules are enforced as "violations" (the game does not block the click; it records and penalises it).
2. The segment replays. The user may **ENTER LONG/SHORT**, **EXIT**, or do nothing. Fixed lots, fixed stop distance for risk accounting.
3. The segment ends at the end of data or when a hard daily-loss limit is hit (that is a rule too).
4. Result: net R, trades taken, violations, revenge trades, and the **opportunity score**.

**Scoring**
- `opportunity`: the best net R achievable with ≤ `maxTrades` non-overlapping trades (greedy hindsight on the same data, deterministic), floored at 0. This measures how much there was to trade.
- `perf = clamp(R_user / max(opportunity, 0.5), −1, 1)`.
- `discipline = 1 − min(1, 0.25 × violations + 0.25 × revenge)`; a **revenge trade** = an entry within `cooldownSec` after a loss with the same or larger lots.
- Stand-aside credit: if `opportunity < 0.5` and trades ≤ 1 → `perf = max(perf, 0.6)`.
- `roundScore = 0.5 × perf_normalised + 0.5 × discipline`, where `perf_normalised = (perf + 1) / 2`.
- `SessionScore = 100 × mean(roundScore)`.

**Difficulty levers:** segment choppiness (more bait), compressed speed, tighter rule set required (e.g., at L15+ the user must pick at least 3 rules before starting), rule-violation visibility (warnings off at higher levels), a "tilt event" injected at high levels (a forced early loss to test cooldown discipline).

**Stats:** rule-adherence rate, revenge-trade count, overtrade ratio (trades vs opportunity), net R, stand-aside accuracy.

---

## 6. Difficulty, levels and ratings

### 6.1 Levels

- Every game has **levels 1–20 per user**, stored per game. Parameters come from `config/difficulty.json` as anchor values at levels 1, 5, 10, 15, 20 and are linearly interpolated (integers rounded) in `difficulty.ts`.
- Level bands for display: 1–5 Warm-up, 6–10 Trader, 11–15 Pro, 16–20 Elite.

### 6.2 Adaptive rule (universal, overridable per game in config)

- After each **Progress** session compute `SessionScore`.
- **Level up** by 1 if the last **two** SessionScores at the current level are ≥ `upThreshold` (default 70). Reset the counter on level change.
- **Level down** by 1 if the last two SessionScores at the current level are ≤ `downThreshold` (default 40), never below 1.
- At most one level change per session. Starting level 1.
- **Practice** mode: user-chosen fixed level, no level change.

### 6.3 Category rating

`categoryRating = 0.7 × categoryRating_prev + 0.3 × (SessionScore × levelFactor)`, with `levelFactor = 0.6 + 0.4 × (level / 20)`, averaged over the games in the category. Displayed 0–100. Used by the dashboard and the Daily Warm-up.

---

## 7. Dashboard, Daily Warm-up, Review

### 7.1 Dashboard (Games window)

- Per-category ratings (bar or radar) and per-game level badges.
- Score history per game (last 30 sessions, line chart).
- Trading-relevant trends: **expectancy per trade** (Tick Reader, Entry Sniper, No-Trade Day), **capture ratio** (Exit Discipline), **discipline score** (No-Trade Day), **perseveration rate** (Regime Switch), **fat-finger rate** (Hotkey Drill).
- Streak: consecutive days with a completed Daily Warm-up; personal bests per game.
- All charts rendered locally with simple SVG/canvas; no chart library required.

### 7.2 Daily Warm-up

Designed to run before market open in about 10 minutes. Deterministic for a given date (seed = userId + date):
1. **Hotkey Drill** — one 60-second block (physical warm-up).
2. Game from the **weakest category** (lowest rating) not played in the last 2 days.
3. Game from the **second weakest** category, same rule.
4. **Risk Calculator** — 6 questions, biased to the most-missed question type.
5. One **random** other game, short version (5 rounds).

Completion is recorded in the day record. Skipping individual games is allowed; the streak requires at least 4 of 5.

### 7.3 Review mode

Select any of the last N sessions kept **locally** (default 20, stored in IndexedDB with the generating seed and window ids) and replay rounds with the correct answer overlaid. If the underlying data has been evicted from the local cache it is re-fetched. Nothing about Review is stored on the server.

### 7.4 Settings (synced in the profile record)

Cost model, default lots, hotkey map, theme (follow desktop dark/light), sound on/off, rebasing on/off, no-repeat days, cache size cap, Low memory mode, level thresholds (advanced).

---

## 8. Backend API and data model

All routes: prefix `/api/desktop/v1/games`, `Depends(get_desktop_user_id)`, called only through `desktop_games_request` in Rust.

### 8.1 `GET /availability`

Returns the cached second-level coverage, from a small **index file** (not a directory scan per request):

```json
{
  "version": 1,
  "generated_at": "2026-11-14T10:00:00Z",
  "symbols": {
    "NIFTY": {
      "lot_size": 75, "strike_step": 50,
      "dates": ["2026-10-01", "2026-10-03"],
      "options": { "2026-10-01": [{"expiry": "2026-10-06", "right": "CE", "strike": 24800}] }
    }
  }
}
```

- Only dates with **native second cadence** and enough observed rows are listed (`has_native_second_cadence` in `data_loader.py`; verify semantics).
- The index is built by `scripts/build-games-index.py` (incremental; safe to run from cron or by hand), not on request. The endpoint reads the file and caches it in process for ~10 minutes. If the index is missing the endpoint returns an empty list with `index_missing: true` (never scans on demand).
- The `lot_size`/`strike_step` values must come from the existing config (`LOT_SIZES`, `STRIKE_INTERVALS`); the example numbers above are illustrative only.

### 8.2 `GET /window`

Query: `symbol`, `date`, `start_sec` (seconds of day), `duration_sec` (max configurable, default 900), `interval_seconds` ∈ {1, 5, 15, 60}, and for options `expiry`, `strike`, `right` (omit for the underlying).

```json
{
  "symbol": "NIFTY", "date": "2026-10-01", "interval_seconds": 1,
  "start_sec": 34200, "count": 300,
  "t": [/* seconds-of-day or epoch per the IST invariant */],
  "o": [/* integer paise */], "h": [], "l": [], "c": [],
  "observed": [/* 0/1, omitted if only observed rows are returned */]
}
```

Rules: cache-only (§3.2), `404 not_cached` on a miss, `422` on invalid parameters, gzip, struct-of-arrays, integer paise. For `interval_seconds > 1` use the existing resample helpers; do not add new modelling code.

A convenience `interval_seconds=60` call over a whole day is allowed for prior-day levels (≈375 rows).

### 8.3 Local cache policy

`windowCache.ts` keys windows by `symbol|date|start|duration|interval|contract`; stores them compressed in IndexedDB; evicts least-recently-used to stay under the size cap; a window fetched once is never re-fetched unless evicted. A "Prefetch" setting may download the next few rounds' windows in the background (1 request in flight, ≥ 250 ms apart) while the user reads instructions.

### 8.4 `GET /state`, `PUT /state` (progress)

`GET /state` returns, in **one DynamoDB query**, the user's `profile`, all `game#…` items and the last 30 `day#…` items. `PUT /state` accepts a single transaction:

```json
{
  "mutation_id": "uuid",
  "game": { "id": "tick_reader", "revision": 7, "item": { /* see below */ } },
  "day":  { "date": "2026-11-14", "revision": 3, "item": { /* see below */ } },
  "profile": { "revision": 2, "item": { /* optional settings change */ } }
}
```

Behaviour: validates schema and size only; applies as one `TransactWriteItems`; idempotent per `mutation_id`; optimistic concurrency on `revision` (409 with the current item on conflict; client merges by re-reading and re-applying its session on top). Same revision/mutation-id pattern as `desktop_persistence_service` (verify and reuse its helpers).

### 8.5 DynamoDB table `GameProfiles` and size budget

- Keys: partition `user_id` (S), sort `record_id` (S). `PAY_PER_REQUEST`. Created lazily like the other desktop tables.
- **Records:**
  - `profile` — settings, createdAt, version. ≤ 4 KB.
  - `game#<gameId>` — `level`, `consecutiveHigh`, `consecutiveLow`, `sessions`, `best`, `emaScore`, `lastScores` (≤ 20 integers), `stats` (≤ 20 small numeric keys), `lastPlayed`, `revision`. ≤ 3 KB.
  - `day#YYYY-MM-DD` — per-game `{n, avg, best}`, `warmupDone`, `minutes`, `categoryScores`, `expectancyR`, `discipline`. ≤ 2 KB. **TTL** attribute `expires_at` ≈ 400 days.
  - `month#YYYY-MM` — same shape aggregated monthly, written when a day item is created for a new month (client rolls up the previous month before its days expire). ≤ 2 KB. No TTL.
- **Hard validation:** reject unknown `gameId`, items over 8 KB, `lastScores` over 20 entries, any field not in the schema.
- **Budget:** ~10 × 3 KB + ~400 × 2 KB + 12 × 2 KB + 4 KB ≈ **0.9 MB per user at steady state**, constant over time (TTL and monthly rollups keep it bounded).
- **Never stored on the server:** rounds, answers, windows, per-trade records, tick data, review sessions.
- **Write discipline:** one `PUT /state` per completed session (not per round). If offline, the write goes to the local outbox and is flushed on reconnect, merged by revision.

---

## 9. Chart and UI requirements

- `GameChart` is a canvas component: candles (OHLC), optional line series, horizontal levels, shaded zones, entry/exit/stop/target markers, a replay clock, and rebasing. It redraws only on state change; it must hold ≤ 20,000 points at once and use `requestAnimationFrame` batching. No dependency on KLine or Lightweight Charts.
- Look and feel: match the desktop dark theme (`#0d1117` background family) and its CSS variables; support the desktop light theme if present.
- Keyboard-first controls on every game, with on-screen hints; all primary actions work with the mouse too.
- Timers use a monotonic clock (`performance.now()`), not `Date`.
- Sound is optional and off by default.
- The UI must remain responsive while a round's data is loading (spinner; the countdown starts only when data is ready).

---

## 10. Testing

**Desktop (vitest, `windowsapp/src/games/**/*.test.ts`)**
- Engine unit tests: RNG determinism, `difficulty.ts` interpolation and level-up/down transitions (incl. never below 1, never above 20), `scoring.ts` bounds, cost model, `volUnit` flooring, `regime.ts` classification, `patterns.ts` detectors on hand-built fixtures, `levels.ts`, Black–Scholes (put-call parity, Greeks sign checks, known reference values).
- Per game: `makeRound` determinism with a fixed seed and a small fixture window (~600 rows checked into the repo), `scoreRound` correctness on hand-computed cases, `summarise` bounds (SessionScore in 0–100), and degenerate inputs (flat data, tiny windows, timeouts).
- Property tests: random answers never score above the optimal answer; always-skip in Tick Reader cannot exceed a break-even-ish ceiling; no NaN or Infinity anywhere.
- **Import-boundary test** (§3.4): fails if `games/` imports trading modules.
- `windowCache` LRU/eviction and `outbox` flush/merge tests (use `fake-indexeddb`).

**Backend (pytest, DynamoDB Local as the existing suite)**
- `availability`: index present/missing, schema, symbol/lot-size values sourced from config.
- `window`: slicing correctness, `observed` handling, `404 not_cached` (assert **no** download/broker call is made — monkeypatch the loaders to fail if called), parameter validation, max duration, gzip header.
- `state`: GET/PUT round trip, transaction atomicity, idempotency by `mutation_id`, revision conflict (409), size and schema rejection, per-user isolation, TTL attribute present on day items.

**Manual acceptance** (`docs/phase24-manual-acceptance.md`, created in Sprint 7): play every game at levels 1, 10, 20; measure the Games window's memory in Task Manager at level 20 (must meet §3.5); disconnect network mid-session and verify the outbox flushes; confirm the trading window is unaffected while a game runs and while it is closed; verify no network traffic to any route outside `/api/desktop/v1/games`.

`tsc --noEmit`, `vitest run` (desktop) and the backend suite must pass for every sprint.

---

## 11. Non-functional requirements

- **Performance:** a round starts within 1.5 s of pressing Start when the window is cached, within 4 s otherwise (on the owner's connection). Frame time stays under ~16 ms for chart updates at 1,000 visible points.
- **Reliability:** every network failure degrades gracefully (cached data, skip round, offline outbox); the Games window never crashes the trading window.
- **Security:** all game routes require the desktop token; the Rust allowlist rejects any path outside `/api/desktop/v1/games`; no secrets in the games bundle.
- **Maintainability:** one folder per game; constants in `config/`; no game-specific code in shared engine files.
- **Docs:** update `CLAUDE.md` (phase table), `docs/architecture-frontend.md` (desktop games module), `docs/architecture-backend.md` (games endpoints and index), and add a "How to add a game" section to this document (§12 final form).

---

## 12. How to add a game (to be completed in Sprint 7)

1. Create `windowsapp/src/games/games/<id>/` with `index.ts` (the `GameDefinition`), `round.ts`, `score.ts`, `View.tsx`.
2. Add the id to `GameId` and one line to `registry.ts`.
3. Add its anchors to `config/difficulty.json`.
4. Add tests (round determinism, scoring, summarise).
5. No backend change is needed unless the game needs a new data series; if it does, extend `/window` parameters, not new endpoints.

---

## 13. Open questions to verify in Sprint 0

Record each answer in the implementation plan before coding.

1. **Second-level data coverage:** which symbols/dates have native second cadence in the cache? How many dates exist? Do option files exist for useful strikes/dates, and at what cadence? Confirm the semantics of `has_native_second_cadence` and the `observed` column in the files the games will read.
2. **Window endpoint design:** is returning only observed rows correct, or should the flag be returned? Which existing helpers should the slice/resample reuse? What are the real file locations/formats (`parquet_path`, `pickle_path`) and their size, so the per-request cost is estimated?
3. **Index build:** where should `scripts/build-games-index.py` run (cron on the server, manual)? Is there an existing script pattern for maintenance jobs (`scripts/`, `ddb_maintenance`)?
4. **Tauri windows:** how does `open_screen_window` create windows, and what capability/config entries a new `games` window needs; how the main-window toolbar adds a button (`ToolbarActionButton.tsx`).
5. **Rust transport:** copy the allowlist pattern from `desktop_settings_request`/`desktop_analysis_request`; confirm that the three copies mentioned in `docs/spec-phase23.md` (backend router, TS API, Rust) apply here and what each must contain.
6. **Capabilities:** the shape of `DesktopCapabilities`; add the `games` flag the same way.
7. **Persistence helpers:** can `desktop_persistence_service` revision/mutation-id helpers be reused for `GameProfiles`? Where are tables declared (`scripts/setup-dynamodb-tables.py`) and does the lazy-create pattern also apply?
8. **Hotkeys:** does the desktop app already define configurable trading shortcuts that Hotkey Drill can import?
9. **Config sources:** the exact API/objects for `LOT_SIZES`, `STRIKE_INTERVALS`, expiry rules, and `SUPPORTED_SYMBOLS` for the symbols to support in games (index symbols only).
10. **Desktop build/CI:** how `.github/workflows/desktop-windows.yml` builds; any version bump or auto-update implications for the Rust change; the minimum WebView2 features required for IndexedDB quota.
11. **Testing tools:** whether `fake-indexeddb` can be added as a dev dependency under the repo's rules; the vitest environment (`jsdom` or `happy-dom`) and how existing desktop tests are structured.
12. **Rate limiting:** is there an existing per-user limiter to reuse?

---

## 14. Implementation plan (sprints)

Each sprint: one feature branch off `dev`, one PR into `dev`, tests green, this document updated. Stop for the owner's review after each sprint.

| Sprint | Scope | Exit criteria | Status |
|---|---|---|---|
| 0 | Discovery: answer §13, write `docs/spec-phase24-implementation-plan.md`, finalise parameter anchor tables | Owner approves the plan; no code changed | Planned |
| 1 | Backend data: `build-games-index.py`, `/availability`, `/window`, cache-only guarantees, tests | Backend tests pass; manual check of payload sizes; proves no broker/download call on miss | Planned |
| 2 | Backend persistence: `GameProfiles`, `/state` GET/PUT, schema/size/TTL rules, `games` capability flag, tests | Round trip, idempotency, conflict and per-user isolation tests pass | Planned |
| 3 | Desktop foundation: Rust `desktop_games_request` + allowlist, Games window + toolbar button, hub shell, engine core (`rng`, `difficulty`, `scoring`, `costModel`, `volUnit`), `GameChart`, `windowCache`, `outbox`, import-boundary test, **Tick Reader end-to-end** | Tick Reader playable from the hub at all levels; progress saved and restored; Rust change rebuilt and tested | Planned |
| 4 | Entry Sniper, Exit Discipline, Hotkey Drill, Risk Calculator | Each game playable, tested, tuned with owner feedback | Planned |
| 5 | Level Recall (`levels.ts`), Strike Picker (`optionPricing.ts`), Regime Switch (`regime.ts`) | Same | Planned |
| 6 | Spot the Trap (`patterns.ts`), No-Trade Day | Same | Planned |
| 7 | Dashboard, Daily Warm-up, Review mode, Settings, memory/perf pass against §3.5, docs (`CLAUDE.md`, architecture docs, §12), `docs/phase24-manual-acceptance.md` | Manual acceptance checklist passes on the Windows build | Planned |

**Rules for every sprint**
- Never modify trading, replay, stepwise, analysis, guardrail or broker code except the single toolbar hook and Tauri window/transport entries listed above.
- Run `cd windowsapp && npm run build && npm test`, the TypeScript check, and the backend pytest suite for changed areas before the PR.
- Tune difficulty anchors using the owner's play feedback; keep constants in config files.

---

## 15. Appendix — default parameter anchors (first pass, to be tuned)

Values are anchors at levels 1 / 5 / 10 / 15 / 20; interpolate between them. These are starting points, not requirements.

| Game | Parameter | L1 | L5 | L10 | L15 | L20 |
|---|---|---|---|---|---|---|
| Tick Reader | lookbackSec | 180 | 120 | 90 | 60 | 45 |
| Tick Reader | decisionSec | 10 | 7 | 5 | 3 | 2 |
| Tick Reader | holdSec | 60 | 45 | 35 | 25 | 15 |
| Tick Reader | rounds | 15 | 18 | 20 | 22 | 25 |
| Tick Reader | no-edge window share | 20% | 30% | 40% | 45% | 50% |
| Entry Sniper | decisionWindowSec | 45 | 35 | 25 | 15 | 10 |
| Entry Sniper | stopMult (× volUnit) | 1.5 | 1.3 | 1.1 | 0.9 | 0.8 |
| Entry Sniper | rr | 1.0 | 1.3 | 1.6 | 1.8 | 2.0 |
| Entry Sniper | trap share | 0% | 10% | 20% | 25% | 30% |
| Exit Discipline | replaySpeed | 1× | 1.5× | 2× | 3× | 4× |
| Exit Discipline | horizonSec | 180 | 240 | 300 | 420 | 600 |
| Exit Discipline | plan prefilled | yes | yes | no | no | no |
| Risk Calculator | time per question (s) | 25 | 20 | 15 | 11 | 8 |
| Risk Calculator | steps | 1 | 1–2 | 2 | 2–3 | 3 |
| Risk Calculator | questions | 12 | 14 | 16 | 18 | 20 |
| Hotkey Drill | chain length | 1 | 1 | 2 | 2–3 | 3 |
| Hotkey Drill | ignore-cues share | 0% | 0% | 10% | 15% | 20% |
| Hotkey Drill | RT_slow (ms) | 2500 | 2200 | 1900 | 1700 | 1500 |
| Level Recall | levelCount | 3 | 4 | 5 | 6 | 8 |
| Level Recall | studySec | 20 | 15 | 10 | 8 | 5 |
| Level Recall | tolMult | 1.0 | 0.8 | 0.6 | 0.45 | 0.35 |
| Regime Switch | segSec | 120 | 90 | 70 | 50 | 40 |
| Regime Switch | holdSec | 60 | 45 | 35 | 25 | 20 |
| Regime Switch | segments | 8 | 10 | 12 | 14 | 16 |
| Strike Picker | DTE mix | 5, 2 | 5, 2, 1 | 2, 1, 0 | 1, 0 | 0 |
| Strike Picker | scenarios | 8 | 10 | 12 | 14 | 16 |
| Spot the Trap | decisionSec | 12 | 9 | 6 | 4 | 3 |
| Spot the Trap | bars on screen | 40 | 60 | 80 | 100 | 120 |
| Spot the Trap | Mode B unlocked | no | no (L6+) | yes | yes | yes |
| No-Trade Day | min rules required | 0 | 1 | 2 | 3 | 3 |
| No-Trade Day | segment minutes | 15 | 18 | 20 | 22 | 25 |
| No-Trade Day | tilt event | no | no | yes | yes | yes |

---

## 16. Acceptance criteria (summary)

1. A Games button in the desktop main window opens a separate Games window; closing it releases its memory; the trading window is unaffected throughout.
2. All ten games are playable with adaptive levels 1–20, practice mode, result screens with explanations, and persisted per-user progress.
3. Games use real cached second-level data through cache-only endpoints; no game or endpoint triggers a broker download or any order action.
4. Server load is limited to file slices and tiny DynamoDB reads/writes; per-user server data stays under ~1 MB, bounded by TTL and monthly rollups.
5. The Games window stays within the §3.5 memory budget at level 20 in manual testing.
6. Dashboard, Daily Warm-up, Review mode and Settings work; progress syncs across sessions and survives offline play via the outbox.
7. Import-boundary, engine, backend and manual acceptance tests pass; docs are updated.
