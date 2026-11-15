# Phase 25 — Scalping Brain Games (Desktop, website and webapp)

**Status: Planned. Scope changed on 2026-11-14:** the Games are now built in `shared/games/` for the desktop app (`windowsapp/`, Tauri 2 + React + TypeScript), the website (`frontend/`) and the webapp (`webapp/`, which reuses the website code). The text below that says "desktop only" is superseded. A second track, porting **Patterns, Chart Structures and Fine Structures to the desktop** (on KLine), goes first. See `docs/spec-phase25-implementation-plan.md` for both tracks, the spec corrections found against the real code, and the shared files touched. All work lands on `dev` first via feature branches (see `CLAUDE.md` branch strategy). Nothing here goes to `preprod`/`main` until reviewed.

**Update 2026-11-15 (Track B):** §17 adds **21 general cognitive games** (Lumosity-style: Speed, Memory, Attention, Flexibility, Math, Reasoning and Word, three each) to the same Games section, for the desktop, website and webapp. They are pure client code with no market data. Track B can start once G2 and G3 are merged; sprints B0–B6 are in §17.11. Sections of this document that say "ten games" refer to the **market games** (Track G); the registry now holds 31 games.

Implementation plan and sprint table: §14 of this document (split out into `docs/spec-phase25-implementation-plan.md` after Sprint 0, following the Phase 22/23 convention).

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

The table above lists the **market games** (§5). Each category also has three general **brain games** (including Word games), described in §17.

### 1.3 Decisions

| Topic | Decision |
|---|---|
| Clients | Desktop app (separate Tauri window, own WebView process), website and webapp (lazy Games workspace). Shared code in `shared/games/`. |
| Where compute happens | **On the laptop.** Round generation, difficulty, scoring, option pricing and rendering all run in the desktop WebView. The server only (a) authenticates, (b) serves read-only slices of already-cached market data, and (c) stores small per-user progress records. |
| Server database growth | Hard budget: **under ~1 MB of DynamoDB data per user per year** (§8.5). No per-round, per-tick or per-answer storage. |
| Server CPU | No pandas modelling, no game logic, no scoring on the server. Data endpoints are cache-only file slices (optionally one resample). |
| Cheating/anti-tamper | Not a concern (single owner, no leaderboard). Scoring is client-side by design. Hiding date/symbol before a round ends is a UI discipline, not a security boundary. |
| Real orders | Games **never** place, modify or cancel any order, paper or real, and never touch broker services. |
| Language | TypeScript/React in `windowsapp/`; Python/FastAPI in `backend/` for the thin endpoints. |
| Charts | A small purpose-built canvas chart (`GameChart`) for games. Do not reuse or modify the trading charts (`AnalysisChart`, `ChartTile`, KLine wrappers). |
| Login | Reuse the existing sign-in: desktop bearer via the Rust host, website `X-User-Id` (accepted by `get_desktop_user_id`). Progress is per signed-in user. No separate game accounts. |
| Persistence | Local cache (IndexedDB) for market-data windows and an offline outbox; DynamoDB only for compact progress. |
| Option pricing | Real option premium history where cached; otherwise Black–Scholes modelled premium, clearly labelled "modelled". |
| Costs | Configurable cost model (slippage points + flat per-lot round-trip cost). Placeholder defaults are shipped and the user edits them in Settings. No statutory rates are hard-coded. |
| Lot sizes / strike steps / expiries | Read from existing backend configuration (`LOT_SIZES`, `STRIKE_INTERVALS`, `get_expiry_date`), never hard-coded in games. |

### 1.4 Out of scope

Multiplayer or leaderboards; live or streaming data; any order placement; phone/mobile layouts; AI Helper or LLM-generated content; medical or IQ claims for the brain games (§17.1); changes to real/paper trading, replay, stepwise, strategies, guardrails or analysis behaviour.

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

The 21 brain games (Track B) use the trial-based `TrialGameDefinition` in §17.3; both definition types share `GameShell`, difficulty, scoring, the registry and the hub. `GameId` is extended with the brain-game ids in §17.2.

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

`categoryRating = 0.7 × categoryRating_prev + 0.3 × (SessionScore × levelFactor)`, with `levelFactor = 0.6 + 0.4 × (level / 20)`, averaged over the games in the category. Displayed 0–100. Used by the dashboard and the Daily Warm-up. With Track B, the average covers both the market and the brain games in a category (§17.8).

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

With Track B the plan draws from a `warmupPool` setting (`both` | `market` | `brain`); see §17.8 for the pool rules.

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
  - `day#YYYY-MM-DD` — per-game `{n, avg, best}`, `warmupDone`, `minutes`, `categoryScores`, `expectancyR`, `discipline`. ≤ 2.5 KB. **TTL** attribute `expires_at` ≈ 200 days (reduced from 400 in Track B to keep the budget with 31 games; monthly rollups keep the history).
  - `month#YYYY-MM` — same shape aggregated monthly, written when a day item is created for a new month (client rolls up the previous month before its days expire). ≤ 2 KB. No TTL.
- **Hard validation:** reject any `gameId` not in the registry (31 ids once Track B lands: 10 market and 21 brain), items over 8 KB, `lastScores` over 20 entries, any field not in the schema.
- **Budget:** with all 31 games, ~31 × 3 KB + ~200 × 2.5 KB + 24 × 3 KB + 4 KB ≈ **0.67 MB per user at steady state**, constant over time (TTL and monthly rollups keep it bounded). With only the ten market games it is smaller still.
- **Never stored on the server:** rounds, answers, windows, per-trade records, tick data, review sessions, brain-game trial logs.
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

**Manual acceptance** (`docs/phase25-manual-acceptance.md`, created in Sprint 7): play every game at levels 1, 10, 20; measure the Games window's memory in Task Manager at level 20 (must meet §3.5); disconnect network mid-session and verify the outbox flushes; confirm the trading window is unaffected while a game runs and while it is closed; verify no network traffic to any route outside `/api/desktop/v1/games`.

`tsc --noEmit`, `vitest run` (desktop) and the backend suite must pass for every sprint.

Track B adds simulated-player, generator-uniqueness, timing and word-asset tests; see §17.10.

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
| 0 | Discovery: answer §13, write `docs/spec-phase25-implementation-plan.md`, finalise parameter anchor tables | Owner approves the plan; no code changed | Planned |
| 1 | Backend data: `build-games-index.py`, `/availability`, `/window`, cache-only guarantees, tests | Backend tests pass; manual check of payload sizes; proves no broker/download call on miss | Planned |
| 2 | Backend persistence: `GameProfiles`, `/state` GET/PUT, schema/size/TTL rules, `games` capability flag, tests | Round trip, idempotency, conflict and per-user isolation tests pass | Planned |
| 3 | Desktop foundation: Rust `desktop_games_request` + allowlist, Games window + toolbar button, hub shell, engine core (`rng`, `difficulty`, `scoring`, `costModel`, `volUnit`), `GameChart`, `windowCache`, `outbox`, import-boundary test, **Tick Reader end-to-end** | Tick Reader playable from the hub at all levels; progress saved and restored; Rust change rebuilt and tested | Planned |
| 4 | Entry Sniper, Exit Discipline, Hotkey Drill, Risk Calculator | Each game playable, tested, tuned with owner feedback | Planned |
| 5 | Level Recall (`levels.ts`), Strike Picker (`optionPricing.ts`), Regime Switch (`regime.ts`) | Same | Planned |
| 6 | Spot the Trap (`patterns.ts`), No-Trade Day | Same | Planned |
| 7 | Dashboard, Daily Warm-up, Review mode, Settings, memory/perf pass against §3.5, docs (`CLAUDE.md`, architecture docs, §12), `docs/phase25-manual-acceptance.md` | Manual acceptance checklist passes on the Windows build | Planned |

**Track B (brain games)** has its own sprints B0–B6 in §17.11; they follow G3 and do not need G1.

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
8. (Track B) All 21 brain games meet §17.12 on the desktop, website and webapp.

---

## 17. Track B — Brain Games (Lumosity-style cognitive games)

Added 2026-11-15. This track adds **21 general cognitive games** (three per category, seven categories) to the same Games section as the ten market games in §5. They run on the **desktop** (Games window), the **website** and the **webapp** from one shared codebase. Everything in §1–§16 still applies unless this section says otherwise.

### 17.1 Goal and principles

1. **A classic brain-training set.** Speed, Memory, Attention, Flexibility, Math, Reasoning and Word games in the style of commercial brain-training apps, so there is a daily mental warm-up that is not tied to market data.
2. **Standard paradigms, original product.** Every game implements a long-established cognitive task (same–different matching, Stroop, go/no-go, spatial span, n-back, Eriksen flanker, visual search, multiple-object tracking, task switching, card sorting, stimulus–response remapping, mental arithmetic, number-target puzzles, matrix reasoning, number series, code breaking, anagrams, word search, word ladders). Names, artwork, copy and sounds are **original**. Do not copy any commercial product's game names, artwork, layout, characters or audio. Do not mimic a specific product's look.
3. **Pure client.** Brain games need no market data, no new server endpoints and no server computation. The only server contact is the small progress write already defined in §8.4. They work offline; progress queues in the outbox.
4. **Same framework.** Levels 1–20 per game (§6), Practice and Progress modes (§4.2), result screen, dashboard and warm-up (§7), local review, the same `GameProfiles` storage (§8.5).
5. **Honest framing.** These are practice tools. UI copy and docs must not claim IQ gains, "brain age", medical or clinical benefit, or improved trading results. Ratings mean "your practice progress on these tasks", nothing more. Include a one-line note on the Games settings page saying so.
6. **Safe next to trading.** No brain-game code imports trading modules, calls trading or order routes, or registers global keyboard handlers (see §17.7).

### 17.2 Catalogue

Session type: **T** = timed block (seconds), **R** = fixed number of puzzles/rounds. Choice count `k` sets the chance level used for scoring (§17.4).

| # | Game (`id`) | Category | Paradigm | Session | Input | Chance |
|---|---|---|---|---|---|---|
| 1 | Quick Match (`quick_match`) | Speed | Same–different matching of two items | T 60 | 2 keys / buttons | 0.5 |
| 2 | Colour Clash (`colour_clash`) | Speed | Stroop (name the ink colour) | T 60 | 4–6 keys / buttons | 1/k |
| 3 | Green Light (`green_light`) | Speed | Go / no-go | T 75 | 1 key | detection |
| 4 | Grid Recall (`grid_recall`) | Memory | Spatial span | R (until 3 misses) | click tiles | span |
| 5 | Sequence Echo (`sequence_echo`) | Memory | Serial recall, forward/backward | R (until 3 misses) | click pads / digits | span |
| 6 | N-Back Stream (`n_back_stream`) | Memory | n-back working memory | T ≈ 90 | 1 key | detection |
| 7 | Flanker Flock (`flanker_flock`) | Attention | Eriksen flanker | T 60 | 2 keys | 0.5 |
| 8 | Needle Finder (`needle_finder`) | Attention | Visual search (feature/conjunction) | R 20 | click / "none" key | ≈ 0 |
| 9 | Track the Dots (`track_the_dots`) | Attention | Multiple-object tracking | R 8 | click dots | t/N |
| 10 | Rule Switch (`rule_switch`) | Flexibility | Task switching with cues | T 75 | 2 keys | 0.5 |
| 11 | Card Sorter (`card_sorter`) | Flexibility | Hidden-rule card sorting | R 64 cards | click 1 of 4 | rule search |
| 12 | Flip Map (`flip_map`) | Flexibility | Stimulus–response remapping | T 75 | 4 arrow keys | 0.25 |
| 13 | Number Sprint (`number_sprint`) | Math | Mental arithmetic | T 90 | typed answer | ≈ 0 |
| 14 | Equation Drop (`equation_drop`) | Math | Arithmetic under falling-time pressure | T 90 or 3 lives | typed answer | ≈ 0 |
| 15 | Make Target (`make_target`) | Math | Reach a target from given numbers | R 8 | click numbers/operators | ≈ 0 |
| 16 | Pattern Matrix (`pattern_matrix`) | Reasoning | Raven-style matrix completion | R 10 | click 1 of 6–8 | 1/k |
| 17 | Number Series (`number_series`) | Reasoning | Inductive number series | R 12 | click 1 of 5 / typed | 1/k |
| 18 | Code Breaker (`code_breaker`) | Reasoning | Mastermind-style deduction | R 6 codes | click/typed guesses | ≈ 0 |
| 19 | Anagram Dash (`anagram_dash`) | Word | Anagram solving | T 90 | typed / click tiles | ≈ 0 |
| 20 | Letter Grid (`letter_grid`) | Word | Boggle-type word search | T 120 | drag/click path or typed | ≈ 0 |
| 21 | Word Ladder (`word_ladder`) | Word | One-letter-change word chains | R 5 | typed words | ≈ 0 |

The registry (§4.1) now holds 31 game ids: the 10 market games and these 21. `GameId` is extended accordingly, and the server whitelist in §8.5 uses the registry ids.

### 17.3 Framework additions

Brain games are trial-based and usually timed, so they use a second definition type alongside `GameDefinition`. Both share `GameShell`, `difficulty.ts`, `scoring.ts`, the registry, the hub, the outbox and the result screen.

```ts
interface TrialGameDefinition<Trial, Response> {
  id: GameId
  category: Category
  title: string
  blurb: string
  instructions: string[]                          // max 6 lines
  session: { kind: 'timed'; seconds: number } | { kind: 'rounds'; count: (level: number) => number }
                                                  // 'rounds' may end early (e.g. 3 misses)
  params(level: number): Record<string, number>   // from config/difficulty.json
  createEngine(params: Record<string, number>, rng: Rng): TrialEngine<Trial, Response>
  summarise(log: TrialLog<Trial, Response>[], level: number): SessionSummary
  View: React.ComponentType<TrialViewProps<Trial, Response>>
}

interface TrialEngine<Trial, Response> {
  next(): Trial | null                            // null = session over (strikes, trial cap)
  evaluate(trial: Trial, response: Response | 'timeout', rtMs: number): TrialOutcome
  progress?(): { span?: number; strikes?: number; lives?: number }
}
```

- **`GameShell`** gains a timed-block mode: instructions → 3-2-1 countdown → block with a visible time bar → result. Pause is **not** allowed in a block. Pressing Esc asks to quit; quitting a Progress block records nothing.
- **Seeded RNG** (`rng.ts`) drives every stimulus and generator, so a session can be regenerated for Review from `userId + date + gameId + sessionNo`.
- **Within-session adaptation** is limited to span-style games (span rises with success, three strikes end the game) and the staircase-free design elsewhere: difficulty comes from the level, not from live tuning. This keeps scores comparable across sessions.

**Timing and input rules (all brain games)**

1. Stimulus onset time = the `requestAnimationFrame` timestamp of the frame in which the stimulus is first painted. Response time = `event.timeStamp` of the key/pointer event minus that onset. Never use `Date.now()` or `setTimeout` durations as the RT source.
2. Fixed timing parameters (display time, inter-stimulus interval) are scheduled from the rAF clock and measured, not assumed. A trial where the actual display time deviates by more than 2 frames, or where a frame longer than 100 ms is detected, is **discarded and replaced**, never scored.
3. **Anticipations:** RT under 150 ms are not valid responses. Count as an error ("too early") and exclude from RT statistics.
4. **Lapses:** no response within the trial window is a timeout (an error for choice tasks, a miss or correct rejection for detection tasks as appropriate).
5. **Focus loss** (`visibilitychange`, window blur): the current trial is discarded; a timed block pauses its clock for at most 10 s, then voids the block (Progress mode records nothing).
6. RTs from different devices, browsers or refresh rates are **not comparable**; the dashboard shows RT trends per device class only and the spec makes no cross-device claims.
7. Keyboard is primary on laptop/desktop; every game is also playable with the mouse/trackpad. Touch and phone layouts are out of scope (consistent with `docs/spec-phase25-implementation-plan.md`).

**Accessibility and comfort**

- Colour-vision-safe default palette (Okabe–Ito set) and **never colour alone**: every colour-coded stimulus also carries a shape, pattern or text label (Colour Clash buttons show a pattern swatch plus position number).
- "Reduce motion" setting: shortens animations; games that depend on motion (Track the Dots, Equation Drop) slow the minimum speed and warn that scoring is unchanged.
- Sound is off by default. No flashing faster than 3 flashes per second anywhere (Grid Recall and Sequence Echo respect this by design: minimum 300 ms per flash with a gap).
- Font sizes scale with a Games zoom setting (80–150%).

### 17.4 Scoring for brain games

All brain games return `SessionScore` 0–100 and plug into the §6.2 level rules unchanged. Because chance-level guessing must score near 0, scores are **chance-corrected**.

- **Choice tasks (k options):** `skill = clamp((acc − 1/k) / (1 − 1/k), 0, 1)` where `acc` = correct valid trials / valid trials.
- **Detection tasks (go/no-go, n-back):** `skill = clamp(hitRate − falseAlarmRate, 0, 1)` (Youden's J). Always pressing or never pressing scores 0.
- **Speed factor:** `speedFactor = clamp((RT_slow − medianRT_correct) / (RT_slow − RT_fast), 0, 1)` with `RT_fast`/`RT_slow` per game and level in config.
- **Speed-emphasis games** (Speed category, Flanker Flock, Rule Switch, Flip Map): `SessionScore = round(100 × skill × (0.6 + 0.4 × speedFactor))`.
- **Accuracy-emphasis games** (memory, puzzles, word): the per-game formulas in §17.5.
- **Volume check:** if the player completed fewer than `minTrialsFrac` (default 0.6) of the expected trials for a timed block, multiply the score by `completed / (minTrialsFrac × expected)`, capped at 1. This stops "answer two perfectly and idle" runs from scoring high.
- **Required property (tested, §17.10):** a random responder scores ≤ 25 and a perfect responder ≥ 95 at every level of every game.

### 17.5 The 21 games

Common to all: instructions screen, 3-2-1 countdown, Practice/Progress choice, result screen with per-trial review (what was shown, what you answered, correct answer, RT). Level levers are given as **L1 → L20**; exact anchors live in `config/difficulty.json` and are interpolated per §6.1. "Stats" are the small numeric keys saved in the game's `stats` field (§8.5; ≤ 20 keys).

#### Speed

**1. Quick Match (`quick_match`)**
- *Skill:* fast perceptual comparison.
- *Trial:* two items appear side by side (or one above the other at higher levels). Press **S** (same) or **D** (different). Same/different split 50/50.
- *Items:* L1–5 coloured circles; L6–12 coloured polygons; L13–20 rotated and **mirrored** polygons (mirror = different), plus small size differences.
- *Levers:* display time unlimited → 1500 ms → 600 ms (then items vanish and the answer is still accepted for 400 ms); difficulty of "different" pairs (large → one-feature difference); response window 3000 → 1200 ms.
- *Scoring:* choice task, `k = 2`, speed-emphasis; `RT_fast/RT_slow` 450/1800 ms (L1) → 350/1100 ms (L20).
- *Stats:* median RT, accuracy, same-vs-different RT gap, errors by feature.

**2. Colour Clash (`colour_clash`)**
- *Skill:* inhibiting an automatic response (Stroop interference).
- *Trial:* a colour word is shown in an ink colour. Answer the **ink** colour by clicking the matching swatch or pressing its number key.
- *Levers:* colours 4 → 6; incongruent share 25% → 65%; response window 3000 → 1100 ms; at L12+ neutral trials (coloured bars, "XXXX") are mixed in; at L16+ the swatch order is **shuffled each trial** so position memory does not help.
- *Scoring:* choice task `k` = colours, speed-emphasis; `RT_slow` 2200 → 1400 ms.
- *Stats:* median RT congruent vs incongruent (the Stroop effect), accuracy, error rate on incongruent.

**3. Green Light (`green_light`)**
- *Skill:* response inhibition and sustained attention.
- *Trial:* a stream of symbols, one at a time. Press **Space** for GO symbols, withhold for NO-GO.
- *Levers:* L1–5 GO = green circle, NO-GO = red square; L6–12 GO = any circle, NO-GO = any square; L13–20 GO changes **mid-block** (a banner shows the new rule for 1.5 s, e.g. "GO = blue only"). Symbol display 1000 → 450 ms; interval jitter widens; NO-GO share 15% → 35% (prepotent response weakens as it rises).
- *Scoring:* detection task, `skill = HR − FAR`; `SessionScore = round(100 × skill × (0.7 + 0.3 × speedFactor))`.
- *Stats:* hit rate, false-alarm rate, median RT, RT variability (coefficient of variation).

#### Memory

**4. Grid Recall (`grid_recall`)**
- *Skill:* visuo-spatial working memory (spatial span).
- *Trial:* an n×n grid; `span` tiles light in sequence (or all at once at higher levels). After the display, click the tiles. Success raises `span` by 1 (or 2 at low levels), failure is a strike; **three strikes end the session**.
- *Levers:* grid 3×3 → 6×6; starting span 3 → 5; flash 700 → 300 ms with a 200 ms gap (sequential mode); simultaneous display from L8; **reverse order** recall from L12; at L18+ the grid **rotates** 90° or flips before recall (the player must mentally map).
- *Scoring:* `spanGain = peakSpan − startSpan + 1` (0 if the first trial failed); `progress = clamp(spanGain / gainTarget(level), 0, 1)`; `acc` = mean fraction of correct tiles over all trials; `SessionScore = round(100 × (0.7 × progress + 0.3 × acc))`. `gainTarget` defaults to 6.
- *Stats:* peak span, mean accuracy, strike count, trials played.

**5. Sequence Echo (`sequence_echo`)**
- *Skill:* serial-order memory (phonological/visual loop).
- *Trial:* a sequence of pads or digits is shown one by one; reproduce it in the same order (or reversed). Strikes and span progression as in Grid Recall.
- *Levers:* items 4 pads → 9 digits/letters; starting span 3 → 6; item time 800 → 300 ms; backward recall from L8; from L15 a **distractor** flash (different colour) appears between items and must be ignored and not entered.
- *Scoring:* as Grid Recall with `gainTarget` 6 (forward) or 5 (backward).
- *Stats:* peak span forward/backward, serial-position error profile (first/middle/last), distractor intrusion count.

**6. N-Back Stream (`n_back_stream`)**
- *Skill:* updating working memory.
- *Trial:* letters (or grid positions) appear one at a time. Press **M** when the current item equals the one **n** steps back.
- *Levers:* n = 1 (L1–5), 2 (L6–12), 3 (L13–18), 4 (L19–20); match share 25–30%; item time 2000 → 1200 ms (with a 500 ms gap); from L16 a **dual** version (position and letter, two keys); lure trials (n±1 matches, which must be rejected) from L10.
- *Scoring:* detection task, `skill = HR − FAR`; `SessionScore = round(100 × skill)`; the first `n` items of a block are not scored.
- *Stats:* hit rate, false-alarm rate, lure false-alarm rate, n reached.

#### Attention

**7. Flanker Flock (`flanker_flock`)**
- *Skill:* selective attention and distractor suppression (Eriksen flanker).
- *Trial:* a row of arrows or chevrons; the **middle** one is the target. Press ← or → for its direction. Flankers point the same way (congruent), the other way (incongruent) or are neutral.
- *Levers:* flankers 2 → 6 per side; incongruent share 33% → 66%; display 1500 → 500 ms; target position jitter; at L14+ a pre-cue marks the target row among two rows and one row is a decoy.
- *Scoring:* choice task `k = 2`, speed-emphasis; `RT_slow` 1400 → 800 ms.
- *Stats:* median RT congruent vs incongruent (flanker effect), accuracy, errors by condition.

**8. Needle Finder (`needle_finder`)**
- *Skill:* visual search and feature binding.
- *Trial:* find the single target among distractors and click it, or press **N** if the target is absent (20% of trials, rising to 30%).
- *Modes:* **feature search** (the target differs by one feature, e.g. a red bar among blue bars) at low levels; **conjunction search** (the target is "red vertical" among red horizontal and blue vertical bars) from L7.
- *Levers:* set size 8 → 60; time limit 15 → 5 s per trial; item jitter and overlap; at L15+ a second distractor feature.
- *Scoring:* per trial `trialScore = correct × (0.6 + 0.4 × speed)` where `speed = clamp(1 − t / T_trial, 0, 1)`; wrong click, false "absent" or timeout = 0. `SessionScore = round(100 × mean(trialScore))`.
- *Stats:* accuracy, median search time, search-slope estimate (time per extra item, feature vs conjunction), absent-trial accuracy.

**9. Track the Dots (`track_the_dots`)**
- *Skill:* divided and sustained attention (multiple-object tracking).
- *Trial:* `N` identical dots on a canvas; `t` flash as targets, then all look the same and move for `D` seconds with random bounces. When they stop, click the `t` targets.
- *Levers:* N 8 → 16; t 2 → 6; speed 80 → 220 px/s; D 5 → 10 s; from L12 dots pass behind a translucent occluder; from L16 brief distractor flicker. Trajectories use a **fixed timestep** and the seeded RNG so Review can replay them.
- *Scoring:* choice task with `chance = t/N`; `acc = targetsHit / t`; `SessionScore = round(100 × clamp((acc − t/N) / (1 − t/N), 0, 1))`, averaged over 8 trials.
- *Stats:* accuracy by t, speed reached, first-hit time.

#### Flexibility

**10. Rule Switch (`rule_switch`)**
- *Skill:* task-set shifting.
- *Trial:* each card shows a digit and a letter (e.g. "7 K"). A **cue** (frame colour plus a text tag) says which rule to apply: **number rule** (odd/even) or **letter rule** (vowel/consonant). Two response keys: **F** for odd/vowel, **J** for even/consonant.
- *Levers:* L1–5 predictable alternation (AABB) with a 1 s cue-to-card gap; L6–12 random switches (~50%), 500 ms gap; L13–20 the cue appears **with** the card (no preparation time) and a third rule is added at L16 (**size**: digit above or below 5 is "high/low").
- *Scoring:* choice task `k = 2`, speed-emphasis, `RT_slow` 2200 → 1200 ms.
- *Stats:* **switch cost** (switch RT − repeat RT), mixing cost, error switch cost, accuracy.

**11. Card Sorter (`card_sorter`)**
- *Skill:* learning a hidden rule from feedback and shifting when it changes (Wisconsin-style card sort).
- *Trial:* four fixed reference cards differ in colour, shape and count. Each new card must be matched to one reference by a **hidden rule** (colour, shape or count). Feedback only says "match" or "no match". After `runLength` consecutive correct matches the rule changes silently.
- *Levers:* rules in use 2 → 3 (L8+); `runLength` 10 → 5; ambiguous cards (matching a reference on more than one dimension) 0% → 25%; feedback delayed by 600 ms at L15+; 64 cards per session.
- *Scoring:* `categoriesCompleted` (rule changes passed) over `categoryTarget(level)` (default 6); `perseverationRate` = errors that apply the **previous** rule / total errors; `SessionScore = round(100 × clamp(categoriesCompleted / categoryTarget, 0, 1) × (1 − 0.5 × perseverationRate))`.
- *Stats:* categories completed, perseverative error rate, trials to first category, failures to maintain set.

**12. Flip Map (`flip_map`)**
- *Skill:* adapting a stimulus–response mapping.
- *Trial:* an arrow appears at one of four positions. A mapping rule applies: **SAME** (press the key of the arrow's direction), **OPPOSITE** (press the opposite key) or, from L16, **TURN** (press the key 90° clockwise). The rule changes every `4–12` trials.
- *Levers:* L1–6 a persistent banner shows the current rule; L7–12 the banner shows only for 1.5 s after a change; L13–20 **no banner**: the player infers a change from error feedback (a brief flash). Display 2000 → 900 ms.
- *Scoring:* choice task `k = 4`, speed-emphasis, `RT_slow` 1800 → 1000 ms.
- *Stats:* accuracy on the first 2 trials after a change vs steady state (adaptation cost), RT by rule, perseveration errors (old rule applied).

#### Math

**13. Number Sprint (`number_sprint`)**
- *Skill:* fast, accurate mental arithmetic.
- *Trial:* one problem at a time; type the answer and press Enter. Correct answers advance immediately; a wrong answer shows the right one for 1 s.
- *Levers:* operations `+ −` → `× ÷` → mixed two-step; operand size 1 digit → 3 digits; carries/borrows; negative results from L12; fractions-as-decimals (`0.5 + 0.25`) from L16; per-problem soft time `T_q` 12 → 4 s; division only with exact results.
- *Scoring:* per problem `w = +1 (correct) × (0.7 + 0.3 × speed)`, `−0.5` (wrong), `0` (skip/timeout); `SessionScore = round(100 × clamp(Σw / itemsTarget(level), 0, 1))`, where `itemsTarget` is the weighted total a full-skill player reaches in the block at that level (config, tuned in B0 from owner play).
- *Stats:* problems solved, accuracy by operation, median time, most-missed operation (feeds the Warm-up).

**14. Equation Drop (`equation_drop`)**
- *Skill:* arithmetic under moving time pressure and multitasking.
- *Trial:* equations ("14 + 9") fall from the top. Type the answer and press Enter: **every** falling equation with that value clears (so two equations with the same answer clear together and build a combo). An equation that reaches the bottom costs a life. Three lives or 90 s.
- *Levers:* fall speed rises through the block; simultaneous equations 2 → 6; operations as Number Sprint; at L12+ some drops are "reverse" (an answer falls, and the player types the missing operand).
- *Scoring:* `cleared` equations with combo weighting `Σ (1 + 0.1 × min(combo, 5))`; `SessionScore = round(100 × clamp(weightedCleared / target(level), 0, 1))`; losing all three lives before 60 s caps the score at 70.
- *Stats:* equations cleared, longest combo, lives lost, accuracy of typed answers.

**15. Make Target (`make_target`)**
- *Skill:* flexible arithmetic reasoning and planning.
- *Puzzle:* a target number and 4–6 given numbers. Combine them using `+ − × ÷`, each given number at most once, to reach the target. The UI builds the expression step by step (tap number, operator, number, producing a new number). Undo and reset are allowed.
- *Generation:* a **solver** (exhaustive search, small enough for ≤ 6 numbers) enumerates solutions; the generator only accepts puzzles with a solution and records the minimum number of operations as the difficulty. At low levels any intermediate result must be a positive integer; division only when exact.
- *Levers:* numbers 4 → 6; target 2-digit → 3-digit; minimum solution depth 2 → 5 operations; time per puzzle 60 → 30 s; at L1–6 "close enough" credit within ±2.
- *Scoring:* exact solution `1`; within tolerance (L1–6 only) `0.5`; else `0`; plus `0.2 × speed` bonus on exact solutions (capped at 1). `SessionScore = round(100 × mean)`.
- *Stats:* solved ratio, median solve time, average solution depth solved.

#### Reasoning

**16. Pattern Matrix (`pattern_matrix`)**
- *Skill:* abstract, rule-based visual reasoning (Raven-style).
- *Puzzle:* a 3×3 matrix of shapes with the last cell missing and 6–8 answer options. Shapes vary by **attributes** (shape, count, size, colour, rotation, shading); rules apply along rows, such as constant, progression (+1 step each cell), distribute-three (each value appears once per row) and, at high levels, a logical overlay (XOR/AND of two cells).
- *Generation:* rule-driven and fully procedural from the seeded RNG; the correct cell is derived from the rules and **verified unique**: each distractor differs from the correct answer in exactly one attribute (low levels: several), and no distractor also satisfies all rules (checked by the generator).
- *Levers:* simultaneous rules 1 → 4; options 6 → 8; time 90 → 40 s per puzzle; distractor similarity; logical overlay from L14.
- *Scoring:* choice task `k` = options, `skill` chance-corrected over 10 puzzles; `SessionScore = round(100 × skill × (0.85 + 0.15 × speedFactor))`.
- *Stats:* accuracy by rule type, median time, errors by distractor kind.

**17. Number Series (`number_series`)**
- *Skill:* inductive reasoning with numbers.
- *Puzzle:* a series with the next term missing (5–8 terms shown). Choose from 5 options (typed answer at L15+). Rule library: arithmetic, geometric, alternating add/multiply, second-order differences, Fibonacci-like (sum of previous two), squares and cubes ± c, two interleaved series, and digit-sum rules at the top.
- *Generation:* sample a rule and parameters, produce the prefix, and verify with a small **rule-solver** that no other rule in the library produces a different next term from the same prefix (puzzle is unambiguous). Distractors come from plausible mistakes (wrong rule, off-by-one in the step).
- *Levers:* rule complexity (1 rule → composite rules), terms shown 8 → 5, time 60 → 25 s, option plausibility.
- *Scoring:* as Pattern Matrix; 12 puzzles.
- *Stats:* accuracy by rule family, median time.

**18. Code Breaker (`code_breaker`)**
- *Skill:* deductive reasoning and hypothesis testing (Mastermind / Bulls-and-Cows style).
- *Puzzle:* a hidden code of `L` positions from `S` symbols (colours with shapes, or digits). Each guess returns **exact** (right symbol, right place) and **misplaced** (right symbol, wrong place) counts. Find the code within the guess limit. Six codes per session.
- *Levers:* L 3 → 5; S 4 → 8; repeats off → on (L10+); guess limit 10 → 8; at L16+ one feedback value is **hidden** ("uncertain" cell) once per code.
- *Scoring:* `par` = guesses a simple solver needs on that code; `puzzleScore = clamp(1 − (guesses − par) / par, 0, 1)` if solved, 0 if not; consistency bonus: `+0.1` if every guess was consistent with all earlier feedback. `SessionScore = round(100 × mean(min(1, puzzleScore)))`.
- *Stats:* mean guesses vs par, consistency rate (share of guesses that could still be the code), solve rate.

#### Word

**19. Anagram Dash (`anagram_dash`)**
- *Skill:* word retrieval and mental manipulation.
- *Trial:* scrambled letters; form a valid word using **all** letters. Any dictionary word that fits is accepted (not just the intended one). **Shuffle** and **Hint** (reveal the first letter, costs 0.3 of the word's score) are available; **Skip** costs nothing but time.
- *Levers:* word length 4 → 9; word frequency tier (common → less common); letter-pattern difficulty (few vowels, repeated letters); time per word 30 → 15 s soft cap; block 90 s.
- *Scoring:* per word `value = lengthWeight × (0.7 + 0.3 × speed) × (hinted ? 0.7 : 1)`; `SessionScore = round(100 × clamp(Σvalue / target(level), 0, 1))`.
- *Stats:* words solved, median time, longest word, hint rate.

**20. Letter Grid (`letter_grid`)**
- *Skill:* word search and flexible letter manipulation (Boggle-type).
- *Puzzle:* an n×n grid of letters. Form words by chaining **adjacent** (including diagonal) letters without reusing a cell. Select by click-and-drag or by typing the word (the game highlights a valid path if one exists).
- *Generation:* letters drawn from a realistic frequency distribution. A **solver** (trie + depth-first search) computes all valid words; the generator rejects grids with fewer than `minWords` solvable words or no word of length ≥ 6.
- *Levers:* grid 4×4 → 5×5; minimum word length 3 → 4; time 120 s; target share of possible score 25% → 55%.
- *Scoring:* word value by length (3: 1, 4: 2, 5: 4, 6: 7, 7+: 11); `SessionScore = round(100 × clamp(Σvalue / (targetShare(level) × maxPossibleValue), 0, 1))`. Repeats and invalid words score 0.
- *Stats:* words found, longest word, share of possible value found.

**21. Word Ladder (`word_ladder`)**
- *Skill:* lexical network search and planning.
- *Puzzle:* change one letter at a time to go from a start word to an end word; every step must be a valid word. The puzzle shows the shortest path length (**par**). Undo is allowed; a limited number of hints reveal the next word.
- *Generation:* neighbour graph built locally from the common word list by wildcard buckets (`c_t` → cat, cot, cut). The generator picks pairs whose shortest path is the target length and whose endpoints are **common** words.
- *Levers:* word length 3 → 5; par 3 → 8; time per puzzle 120 → 60 s; hints 3 → 0.
- *Scoring:* solved: `clamp(par / steps, 0, 1)` (extra steps reduce the score) × hint factor; unsolved: 0; five puzzles per session.
- *Stats:* mean steps vs par, solve rate, hint use.

### 17.6 Content assets and generators

- **Word lists** (`shared/games/brain/assets/words/`): a **common** list (about 20–30k words, used for targets, anagram answers and ladder endpoints) and a **valid** list (about 100k+ words, used only to accept player input and as the Letter Grid dictionary). Use only permissively licensed or public-domain lists and record each list's name, version and licence in a `NOTICE` file in the repo; **B0 chooses and verifies the licence** before any file is committed. Strip profanity and offensive terms from both lists. Do not scrape websites.
- Size budget: each list ≤ 1.5 MB raw and ≤ 500 KB gzipped, **lazy-loaded** only when a Word game starts, never in the main bundle or the trading window. A trie/graph built from them stays under 40 MB in memory and is released when the Games workspace closes.
- **Shapes and colours:** a small SVG/canvas symbol set drawn in code (circles, polygons, arrows), the Okabe–Ito palette (§17.3), and no third-party icon packs or fonts that need attribution.
- **Generators** live in `engine/generators/`: `matrix.ts` (Pattern Matrix rules and uniqueness check), `series.ts` (rules and ambiguity solver), `makeTarget.ts` (solver), `mastermind.ts` (par solver), `boggle.ts` (grid and trie solver), `ladder.ts` (graph and BFS), `arithmetic.ts`. Each is pure and fully unit-tested (§17.10).

### 17.7 Where the code lives, and isolation

```
shared/games/brain/
  engine/        trialEngine.ts, rt.ts, scoringBrain.ts, generators/*
  games/<id>/    index.ts (TrialGameDefinition), engine.ts, View.tsx
  ui/            Stimulus, ResponsePad, TimeBar, LivesBar, ProgressDots, KeyHint, TrialReview
  assets/words/  common.txt, valid.txt  (+ NOTICE entry)
  config/        difficulty.brain.json   (anchors for the 21 games)
```

- **Desktop:** the brain games appear in the existing Games window (same hub). No new Rust is needed beyond what G3 adds. Hub tabs: **Brain**, **Market**, **Dashboard**, **Warm-up**.
- **Website and webapp:** the lazy `GamesWorkspace` (G3) hosts the same hub. `webapp/` reuses the website code, so one website change covers both (`docs/spec-phase25-implementation-plan.md`).
- **Progress transport:** the existing `gamesRequest` transport (Rust command on desktop, `fetch` on the website) with the §8.4 `/state` routes. The website sends `X-User-Id`, which `get_desktop_user_id` already accepts (implementation plan, correction #13). **No** brain-game code calls `/availability` or `/window`.
- **Keyboard safety:** brain games attach key handlers **only to their own focused root element** (`tabIndex={0}`, focus on start, handlers on that element), never on `window` or `document`, and stop propagation of the keys they use. Esc handling follows the existing modal pattern. Nothing in the games registers a global shortcut.
- **Website layout:** open Games the way Browse opens (a workspace replacing the main view). If a live or real session is active, the trading layout stays **mounted but hidden** (not unmounted) so streams, alerts and notifications continue; the games window must never delay or block them. B0 verifies this against how Browse handles `idle`/active sessions in `frontend/src/App.tsx`.
- **Import boundary (extends §3.4):** `shared/games/brain/**` must not import trading modules (orders, tickets, sessions, strategies, guardrails, brokers, streams, analysis charts) or the market-data modules of Track G. A vitest/mjs scan fails on violation. Brain games must be shippable with Track G's data endpoints switched off.

### 17.8 Dashboard, Warm-up and Review with brain games

- **Category ratings** (§6.3) average **all** games in the category across both pools. The dashboard has a Brain/Market/All filter and shows per-category ratings, per-game level badges, last 30 sessions per game, and streaks. Brain-specific trend panels: **interference effects** (Stroop and flanker, ms), **switch cost** (Rule Switch), **adaptation cost** (Flip Map), **peak span** (Grid Recall, Sequence Echo), **n reached** (N-Back), and **perseveration rate** (Card Sorter).
- **Daily Warm-up pool setting** (`warmupPool`: `both` | `market` | `brain`, default `both`). For `both`, steps alternate pools:
  1. Physical warm-up: Hotkey Drill (market) or Quick Match 60 s when `brain`.
  2. Weakest category: a game from that category; in `both`, use the brain game when the category's brain rating is lower than its market rating (or the only game available).
  3. Second weakest category: same rule, preferring the **other** pool from step 2.
  4. Risk Calculator (6 questions), or Number Sprint (45 s) when `brain`.
  5. One random game from the remaining pool, short version.
  Seed, "not played in the last 2 days" rule and streak rule (≥ 4 of 5) as §7.2.
- **Review** (§7.3): brain sessions keep the seed and a compact **trial log** locally (≤ 250 trials × small tuples, last 20 sessions). Review shows per-trial stimulus, response and RT and can replay deterministic games (Track the Dots, matrices). Nothing is sent to the server.
- **Settings** (§7.4) gain: palette (colour-vision-safe default), reduce motion, sound, zoom, `warmupPool`, and the "practice tool, not a medical product" note.

### 17.9 Backend and data-model changes (small)

No new routes. Changes to the G2 work:

- `GameProfiles` validation (§8.5) accepts the **31 registry ids**; a brain game's `game#<id>` item uses the same schema (`level`, counters, `lastScores`, `stats`).
- To keep the per-user budget under about 1 MB with more games: day records get **`expires_at` ≈ 200 days** (not 400) and a cap of **2.5 KB**; monthly rollups (≤ 3 KB, no TTL) preserve history. Estimate: 31 × 3 KB + 200 × 2.5 KB + 24 × 3 KB + 4 KB ≈ **0.67 MB** at steady state.
- `stats` keys stay ≤ 20 per game; brain trial logs are **never** stored on the server.
- The `games` feature flag (appended to `DesktopCapabilities.features`) covers both pools; no separate flag.

### 17.10 Testing for Track B

- **Generators:** determinism for a fixed seed; uniqueness checks (Pattern Matrix correct answer unique; Number Series unambiguous under the rule-solver; Make Target puzzles solvable and depth recorded; Letter Grid minimum words; Word Ladder par equals BFS shortest path); no NaN/Infinity.
- **Simulated players** (`engine/simPlayers.test.ts`): a **perfect** player scores ≥ 95 and a **random** player ≤ 25 at levels 1, 10 and 20 for every game; for go/no-go and n-back, "always press" and "never press" score ≤ 5; a "fast but random" player scores ≤ 25 for choice games. This validates the chance correction in §17.4.
- **RT and timing utilities:** anticipation exclusion, lapse handling, discarded-trial replacement, focus-loss voiding (use fake timers and a mocked `performance.now`/`requestAnimationFrame`).
- **Scoring:** hand-computed cases for each game's `summarise`, bounds 0–100, volume-check scaling.
- **Word assets:** loader returns the expected counts, no word contains forbidden characters, offensive terms are absent (compare against the exclusion list), trie solver matches a brute-force solver on sample grids.
- **No network:** during a brain session, only the single progress write at the end may hit the transport (assert with a mocked transport).
- **Import boundary and key-handler tests:** scan for forbidden imports; assert no `window.addEventListener('key…')` in `shared/games/brain/**`.
- **Browser smoke (Playwright, website):** open Games → Brain → start Quick Match in Practice mode → complete a block → result screen → progress written; run in Chromium. Desktop vitest runs the engine tests (the desktop test environment is plain node, so UI components are tested through pure model functions).
- **Manual acceptance** (add a Track B section to `docs/phase25-manual-acceptance.md`): play every brain game at levels 1, 10 and 20 on the Windows build and in Chrome; check RT plausibility on both; run a Warm-up in each `warmupPool` mode; verify the website live-session behaviour in §17.7; check memory with the Word games open (tries/graphs) and after closing them.

### 17.11 Sprints for Track B

Track B starts when G2 (persistence, `/state`, `games` flag) and G3 (foundation: shared engine core, hub, `GameShell`, difficulty, scoring, outbox, website/webapp nav) are merged. It does **not** depend on G1 (market data) or G4–G7, so it can run in parallel with them, or ahead of them if the owner prefers brain games first.

| Sprint | Scope | Exit criteria |
|---|---|---|
| B0 | Discovery and calibration: confirm the G2/G3 interfaces, verify website live-session behaviour (§17.7), choose and verify word-list licences, finalise the palette and symbol set, set the first parameter anchors, write `docs/spec-phase25-implementation-plan.md` Track B section | Owner approves; no code changed |
| B1 | Framework: `TrialGameDefinition`, timed `GameShell`, `rt.ts`, simulated-player harness, UI primitives, import-boundary and key-handler tests. Games: **Quick Match, Colour Clash, Green Light** end to end on desktop and website | Three Speed games playable at all levels in both clients; simulated-player tests pass |
| B2 | Memory: **Grid Recall, Sequence Echo, N-Back Stream**. Attention: **Flanker Flock, Needle Finder, Track the Dots** | Six games playable; Track the Dots deterministic replay works in Review |
| B3 | Flexibility: **Rule Switch, Card Sorter, Flip Map**. Math: **Number Sprint, Equation Drop, Make Target** (with solver) | Six games playable; solver and generator tests pass |
| B4 | Reasoning: **Pattern Matrix, Number Series, Code Breaker** (generators with uniqueness checks) | Three games playable; uniqueness tests pass at every level |
| B5 | Word: word-list assets and licences, **Anagram Dash, Letter Grid, Word Ladder**; lazy loading and memory checks | Three games playable; asset loading verified; word lists absent from the main bundle |
| B6 | Hub tabs, dashboard filters and brain trend panels, Warm-up pools, Review for trial logs, settings, accessibility and performance pass, docs (`CLAUDE.md` row, architecture docs, §12 "How to add a game" with a `TrialGameDefinition` example), manual acceptance | Acceptance checklist passes on the Windows build and in Chrome |

Rules for every Track B sprint: one feature branch off `dev`, one PR into `dev`; tests green (`cd windowsapp && npm run build && npm test`, `cd frontend && node node_modules/typescript/bin/tsc --noEmit`, backend tests for touched areas, Playwright smoke where added); the PR lists shared files touched (expected: `frontend/src/App.tsx` for the single nav hook already added in G3, nothing else existing) and confirms no trading logic changed.

### 17.12 Acceptance criteria for Track B

1. All 21 brain games are playable on the desktop Games window, the website and the webapp, at levels 1–20, in Practice and Progress modes, with result screens, per-trial review and persisted progress.
2. Simulated-player tests prove chance-corrected scoring (random ≤ 25, perfect ≥ 95) for every game and level checked.
3. Brain games make no market-data or trading requests; the only server traffic is the §8.4 progress write at the end of a Progress session (and its offline-outbox flush).
4. Brain-game keyboard input cannot reach trading handlers; no global key listeners exist in `shared/games/brain/`.
5. Word assets are lazy-loaded, licensed and recorded in `NOTICE`, free of offensive terms, and absent from the main and trading bundles.
6. UI copy makes no claims of IQ, brain-age, clinical or trading-performance benefit.
7. Dashboard, Warm-up (all three pools) and Review work with both game pools; server data per user stays under about 1 MB.
