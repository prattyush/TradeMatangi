# Trade Matangi Project

All development should be done in dev branch and finally merging to main branch will be done manually. When raising a PR please create a new branch and when it is reviewed merge to dev.

@docs/spec.md

## Development Environment

### Running the stack locally (WSL)

```bash
# Terminal 1 — backend at http://localhost:8700
bash scripts/start-backend.sh

# Terminal 2 — frontend at http://localhost:5173
bash scripts/start-frontend.sh
```

### Running backend tests

```bash
cd backend
source ~/venvs/tradematangi/bin/activate
python -m pytest tests/ -v
```

### TypeScript check

```bash
cd frontend
node node_modules/typescript/bin/tsc --noEmit
```

## Key Technical Constraints

Look into backend technical constraints doc when needed which is located at docs/backend-technical-constraints.md

Look into frontend technical constraints doc when needed which is located at docs/frontend-technical-constraints.md


<!-- Shared invariants that span both sides — keep these here so they're always visible -->
- **IST timestamps**: data files (pickle and parquet) have tz-naive IST DatetimeIndex. The backend uses `df.index.tz_localize("UTC")` (NOT `tz_localize("Asia/Kolkata").tz_convert("UTC")`). This makes Unix timestamps encode IST wall-clock values so Lightweight Charts shows 09:15, not 03:45. Do not change this without updating all timestamp comparisons in `data_loader.py` and the frontend `CANDLE_INTERVAL_SECONDS` window math.
- **3-min candle boundaries**: both backend (`pandas resample("3min")`) and frontend (`Math.floor(time / 180) * 180`) must use the same epoch-aligned formula. These are intentionally kept in sync.

## Phase Completion Summary

| Phase | Status | Tests | Details |
|-------|--------|-------|---------|
| Phase III — BetaStage | ✅ Complete | 241 | `docs/spec-phase3.md` |
| Phase IV — BetaMinorUpdates | ✅ Complete | 278 | `docs/spec-phase4.md` |
| Phase V — TradeAnalysis | ✅ Complete | 299 | `docs/spec-phase5.md` |
| Phase VI — Strategies | ✅ Complete | 311 | `docs/spec-phase6.md` |
| Phase VII — PaperTrading | ✅ Complete | 350 | `docs/spec-phase7.md` |
| Phase VIII — Launch | ✅ Complete | 391 | `docs/spec-phase8.md` |
| Phase IX — RealTrading | ✅ Complete | 436 | `docs/spec-phase9.md` |
| Phase X — GuardRails | ✅ Complete | 495 | `docs/spec-phase10.md` |
| Phase XI — AI Helper | 🔨 In Progress (ExitFeatures done) | 513 backend / 136 aihelper | `docs/spec-phase11.md`, `docs/architecture.md` |

Full status, bugs fixed, and lessons learned for each phase are in the respective phase spec docs.

### Post-Phase IX features (merged to dev)

| Feature | PR | Status |
|---------|-----|--------|
| Kotak Neo live streaming + Admin Settings tab | #73 (feature/kotak-streaming-admin-tab) | ✅ merged to dev + main |
| Kotak Neo API corrections (scrip_master, token field, modify qty, isIndex) | #75 (fix/kotak-api-corrections) | ✅ merged to dev + main |
| Kotak Neo streaming bugs (wrong index segments, no reconnect on WS drop) | #88 (fix/kotak-streaming-bugs) | ✅ merged to dev + main |
| KiteBroadcaster race condition + Kotak WS auto-reconnect | #90 (fix/kite-broadcaster-race-condition-kotak-reconnect) | ✅ merged to dev + main |
| ST P&L label + P&L % display mode + wallet lock during session | #92 (feature/st-pnl-label-pct-mode-wallet-lock) | ✅ merged to dev + main |
| TargetProfit strategy + Breakeven overhaul + AggressiveStoploss 'only in profit' to Settings | #94 (feature/target-profit-breakeven-overhaul) | ✅ merged to dev + main |
| LTP button in price inputs + global button click animation | #96 (feature/ltp-button-click-animation) | ✅ merged to dev + main |
| Change Password in Settings General tab + remove admin credentials hint from login | #98 (feature/change-password-settings) | ✅ merged to dev + main |
| Drawing tools dropdown (H-Line, Trend, Fib Retracement, Parallel Channel) + LIFO Clear + free crosshair | #100 (feature/drawing-tools-fib-channel) | ✅ merged to dev + main |

### Phase XI — AI Helper (in progress)

| Item | PR | Status |
|------|-----|--------|
| Architecture planning: `docs/architecture.md`, `docs/spec-phase11.md` | #123 (docs/phase11-architecture-planning) | ✅ merged to dev + main |
| Step 1 Foundation: `aihelper/` server skeleton, DynamoDB stores, LiteLLM + LangFuse wiring, processor strategies, scripts | #125 (feature/phase11-step1-foundation) | ✅ merged to dev + main |
| Step 2 Hook Plumbing: backend bar-close + session-stop hooks; aihelper hook endpoints + BarCloseProcessor wired | #127 (feature/aihelper-step2-hook-plumbing) | ✅ merged to feature/aihelper |
| Step 3 Command Flow: `/ai/chat` intent dispatch, field extraction/validation, AICommand DynamoDB registration, hotword recall + save, list commands | #128 (feature/aihelper-step3-command-flow) | ✅ merged to feature/aihelper |
| Step 4 Trade Execution: `evaluate()` full impl — LLM bar-close eval → guardrail → `/api/trades/buy|sell` → AIDecisionLog write → mark executed | #129 (feature/aihelper-step4-trade-execution) | ✅ merged to feature/aihelper |
| Step 5 Decision Visibility: `AIChatPanel` floating overlay; `aiGetDecisions()` + `aiChat()` in api.ts; `AI_HELPER_URL` in config; decisions rendered as structured cards in chat | #130 (feature/aihelper-step5-decision-visibility) | ✅ merged to feature/aihelper |
| Step 6 Hotword Strategies: `StrategyItem` Pydantic model in strategies router (Decimal coercion); `aiGetStrategies()` + `aiDeleteStrategy()` in api.ts; Chat/Hotwords tab in AIChatPanel with list, Use, Delete | #131 (feature/aihelper-step6-hotword-strategies) | ✅ merged to feature/aihelper |
| Step 7 Chat UI: `GET /ai/session/{id}/commands` + `DELETE /ai/commands/{id}` in commands router; `CommandItem` + `aiGetCommands()` + `aiCancelCommand()` in api.ts; Commands tab in AIChatPanel with status badges (Watching/Executed/Cancelled), cancel buttons, trigger/order chips; 12 new aihelper tests | #132 (feature/aihelper-step7-chat-ui-commands) | ✅ merged to feature/aihelper |
| Step 8 Trade Analysis: `GET /api/analysis/trades` backend endpoint; `extract_date_range()` LLM date parser; `run_analysis()` + `parse_date_range()` complete in analysis_service; `_handle_analysis()` in chat.py; `AnalysisResult` types in api.ts; structured analysis card in AIChatPanel (stats chips, pattern cards, suggestions); 12 aihelper + 8 backend tests | #133 (feature/aihelper-step8-trade-analysis) | ✅ merged to feature/aihelper |
| Step 9 Guardrails: `sanitize_command_text()` wired in chat.py before LLM calls; `check_market_hours()` wired in hook.py (paper/real blocked outside 09:15–15:30, sim bypasses); `session_type` added to `BarCloseHook` + backend payload; 37 new guardrail tests | #134 (feature/aihelper-step9-guardrails) | ✅ merged to feature/aihelper |
| Step 10 Tests: 19 unit tests for `command_evaluator.evaluate()` (no-op, order placed, guardrail block, backend error, LLM failure, decision log structure); 25 e2e integration tests (chat → bar hook → evaluator → decision log → decisions endpoint); cross-file module isolation fixes; 105 total aihelper tests | #135 (feature/aihelper-step10-tests) | ✅ merged to feature/aihelper |
| E2E bug fixes: AIChatPanel draggable; Nifty chart blank on holidays (NSE_HOLIDAYS moved to utils.py, prior_trading_days holiday-aware, equity /historical skips missing dates); AI-placed trades appear in UI via new_trade SSE + addTradeFromSSE; limit/target orders route to /api/orders/place; cancel-via-chat (cancel_commands intent + _handle_cancel); backend.log not polluted by pytest mocks | #136 (fix/aihelper-e2e-bugs) | ✅ merged to feature/aihelper |
| Quantity ratio fix: `funds_ratio_{l,m,h}_pct` persisted to UserSettings DynamoDB; injected into bar-close hook payload so AI Helper uses live user-configured ratios instead of hardcoded defaults; both market and limit/target orders now respect ratio; buy/sell endpoints accept `funds_ratio_pct` for ratio-based quantity; LangFuse output `undefined` fix (`evaluate()` returns summary dict); 507 backend + 105 aihelper tests | #137 (fix/aihelper-quantity-ratio) | ✅ merged to feature/aihelper |
| Command stream filter: `trigger_right` field separates which bar-close stream activates a command (Nifty/CE/PE) from where the order is placed (`right`); CE commands no longer fire on Nifty ticks; Nifty stream flows through for future cross-instrument triggers; `extract_command_fields` schema extended with `trigger_right`; DynamoDB stores `trigger_right` when present | #138 (fix/aihelper-command-stream-filter) | ✅ merged to feature/aihelper |
| Full LangFuse tracing: `@observe` on all 8 public `llm_service` functions + `_chat_observed()` in chat router; LiteLLM callbacks wire every `acompletion()` as a nested generation under the active span; route handler stays unwrapped to preserve FastAPI request parsing; `tracing_enabled` exported from tracing module; `TestAnalysisChatEndpoint` test failures fixed (plain MagicMock observe stub replaced with `_noop_observe` identity decorator) | #139 (feature/aihelper-langfuse-tracing) | ✅ merged to feature/aihelper |
| AI Helper order/tracing fixes: (1) `POST /api/orders` emits `order_placed` SSE so AI-placed limit/target orders appear in UI open orders panel (all modes + instruments); (2) `placeOrder()` + `addOpenOrder()` both deduplicate by `order_id` (fixes duplicate entries + ghost ST chart lines from SSE-before-HTTP race); (3) pin `langfuse<3.0.0` + fix import to `langfuse.decorators.observe` (fixes LiteLLM `AttributeError: module has no attribute 'version'`); (4) chat label shows actual user-configured ratio % via `backend_client.get_user_funds_ratios()` instead of hardcoded 3/6/12%; (5) `tracing.py` gains `as_type` + `langfuse_context` export; `_complete` stamps model/cost_usd/tokens as `metadata` on calling span | #140 (fix/aihelper-limit-target-orders-visible) | ✅ merged to feature/aihelper |
| LangFuse 4.x upgrade + chat UI resize: (1) `langfuse>=4.0.0` — 4.x is near-realtime vs 3.x 10-min lag; `langfuse.decorators` removed in 4.x, `observe` now imported from `langfuse` directly; LiteLLM `success_callback=["langfuse"]` broken in 4.x (`sdk_integration` kwarg dropped from Langfuse constructor) — replaced with `@observe(as_type="generation")` on `_complete`; `types.SimpleNamespace` shim adds `langfuse.version` for LiteLLM compat; `update_current_generation(model, usage, metadata)` stamps model/tokens/cost_usd on each span; stale `"langfuse.decorators"` removed from all 5 test stub lists; (2) `AIChatPanel` width 380→480, height 520→640; message bubble + input textarea fontSize 12→14 | #141 (fix/langfuse-trace-linking) | ✅ merged to feature/aihelper |
| ExitFeatures: bar-close triggered exit commands — `exit_position`, `update_stoploss`, `start_takeprofit`; intent classifier `"command"` renamed `"entry_command"` / `"exit_command"`; `_backfill_bar_history()` seeds up to 15 historical bars on first hook fire; 7 new backend_client async functions; `validate_exit_action` guardrail; `_evaluate_exit()` in command_evaluator; advisory position check in chat router; 31 new tests; 510 backend + 136 aihelper tests | #142 (feature/exit-commands) | ✅ merged to feature/aihelper |
| Backfill gap fix (paper/real): `_backfill_bar_history()` now calls `fetch_kite_1min` / `fetch_kite_1min_options` for paper and real sessions so live bars streamed after session start are included; simulation sessions unchanged (Breeze parquet); 3 new tests; 513 backend tests | #143 (fix/backfill-paper-real-kite) | ✅ merged to feature/aihelper |

### Post-Phase X fixes (merged to dev + main)

| Fix | PR | Status |
|-----|-----|--------|
| GuardRail BLOCK reason: human-readable expiry time ("resumes after 09:35") + separate cooldown block bars (n) setting | #102 (feature/guardrails-phase10) | ✅ merged to dev + main |
| Time picker scroll throttle: 1 step per 180ms, prevents runaway jumps on Start Time input | #104 (fix/time-picker-scroll-throttle) | ✅ merged to dev + main |
| Settings: move Change Password to new Profile tab; TargetProfit chart price-pick (⊕) button; data/ added to .gitignore | #107 (feature/profile-tab-settings) | ✅ merged to dev + main |
| Settings modal: fixed width 440px + tab font 11px so 5 tab labels don't crowd; tab content scrollable | #110 (fix/settings-modal-fixed-width) | ✅ merged to dev + main |
| TargetProfit/BreakEven: emit order_cancelled SSE event when strategy cancels stoploss so UI removes it | #111 (fix/targetprofit-stoploss-cancel-event) | ✅ merged to dev + main |
| Strategy completed UI + SELL marker strike fix: emit strategy_completed SSE event; pass per-right strike on strategy LIMIT orders | #113 (fix/strategy-completed-sell-marker) | ✅ merged to dev + main |
| AutoStop guardrail bypass fix + button color: check_guardrails() added to AutoStop bar-close path; AutoStop button brighter green (#56d364 text, #1f4d2e bg, green border); 495 tests | #116 (fix/autostop-guardrail-button-color) | ✅ merged to dev + main |
| Avg entry FIFO fix: get_position() now uses FIFO lot matching so avg_entry_price shows only open lots, not full session history; 3 new tests; 498 tests | #119 (fix/position-avg-entry-fifo) | ✅ merged to dev + main |
| Pos P&L commission fix: entry_commission added to Position (FIFO-apportioned); Pos P&L = gross unrealized − entry_commission; Session P&L unchanged (already correct); 498 tests | #120 (fix/pnl-commission-and-fifo-avg-entry) | ✅ merged to dev + main |
| Pos P&L full round-trip commission: estimated exit commission (mirrored backend formula) subtracted on every tick; brokeragePerOrder added to SimulationState; works for all modes + equity + options | #121 (fix/pos-pnl-full-roundtrip-commission) | ✅ merged to dev + main |
