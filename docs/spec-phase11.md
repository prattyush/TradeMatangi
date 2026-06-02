#### AI Helper
This phase includes support of LLM to enchance trading experience. It would be a chat based LLM which would provide users ability to give commands like:-
1. Custom Entry -> Let's say in a strong trend. The user says :- "When the first bar comes whose low is below the low of the previous bar, Buy L Ratio Quantity At Market Price."
2. Custom Exit -> Again when the user already has a position in a strong trend, the user says :- "When the first pullback bar (first bar of opposite color from the current trend) comes in this trend, start a TakeProfit Strategy at the high (BUY posiiton)/low (SELL Position) of the bar before the pullback bar"
3. Partial Exit -> "When total Profit % reaches 6%, exit 50% position, and exit the rest 50% when the profit percentage reaches 6% of the remaining quantity."
4. Trade Analysis -> The llm would analyze the traddes taken by user and come up with suggestions on how to improve, also pointing bad patterns. Like :- "Always entering at bad price w.r.t a bar open price. Losing % of trades increases in 2nd half of trading, after initial 2 hours etc. Also, averaging entries are causing more losses. Profits % are smaller compared to loss %." etc etc.


For Planning:- Please think yourself a principal engineer and plan for future complicated cases as well. We will also include Guardrails like (NeMo) and observability either through Galellileo AI or LangFuse to monitor LLM usaage. Also, think about whether the architecture should be that a new server is created which talks to the current present backend, gets ticks values through another SSE and gets chat prompts entered from UI. It interacts with backend for all trade actions. The trade actions can also be reflected on UI through SSE Events. Another architecture option is that the LLM server is called internally from backend server, The UI doesn't call the LLM Server directly. Third architeccture is no need of another server, the backend can be expanded to cover LLLM Use-cases. 

Feel free to write the architecture in the docs/architecture doc if required. Have created a new folder called aihelper if a new server is required for LLMs


##### EntryFeatures
1. Users can define entry criteria for taking trades. To keep it simple for now, entry criteria should have following information, it can be passed as form of chat. 
 a) Quantity or Ratio (Ratio of Wallet value at start of session, limited to values L, M, H). b) Order Type :- Order type can be market, limit or target. In case of all order types, the backend will always treat them as as they do for trades done from UI. c) Entry Symbol:- For Equity it is same one as shown. For Options. Whetehr it is PE or CE should be mentioned. d) Trigger Criteria:- For Simplicity now, the user needs to say exactly based on bars behavior, no inputs like double top or double bottom, it should be explicit like:- if CE bars low crosses low of previous bar, and the bar is a bear bar, then place a target order at the mid value of the bar (open + close)/2 with quantity of ratio of L.
 2. Validate if the entry criteria is valid based on above points. If not ask user to be more explicit. You can give the above example or below instruction.
 ```
For adding command, please mention
1) Order Type (Limit, Market, Target)
2) Quantity or Ratio of Wallet recorded at start of the session [Ratio values are L, M or H]
3) Symbol in case of Options - CE or PE.
4) Entry Criteria:- Definiing entry criteria based on bars parameters i.e ( low, high, close, open, bear, bull)

Examples:- 
1) "If CE bars low crosses low of previous bar, and the bar is a bear bar, then place a target order at the mid value of the bar (open + close)/2 with quantity of ratio of L."
2) "If CE bars close cross 89.5, then place a target order at close price + 0.5 with trade quantity of ratio L"

 ```


 ##### ExitFeatures
 1. Users can define exit criteria for exiting trades. To keep it simple for now, the same bar criteria would be used i.e. ( low, high, close, open, bear, bull) and comparison with previous bars. For now it would exit the entire position, we will complicate it later. The required parameters are:- a) Exit Criteria based on Bars. b) Symbol information, c) Action:- Can be update stoploss or exit position or start take profit strategy with exit price which can be calculated based on bars params. 
 2. For stoploss update, if possible it can find if a stoploss is already present, if yes update that, or create one if not present.
 3. For exit position, it can do something similar to what take profit strategy does, or internally, the system can trigger a take profit strategy such that the position is immediately exited like putting take profit at 10% below current market price, or percentage decrement against the last close price.
 4. All exit criterias for now will be evaluated at bar close as was with entry criterias.
 5. Exit features will be active till it is condition fulfils, session is stopped, or users cancels it or at bar close it finds no position is open to monitor.
 6. Validate if the exit criteria is valid based on above points. If not ask user to be more explicit. You can give the above example or below instruction.
 ```
For adding command, please mention
1) Symbol in case of Options - CE or PE. 
3) Action:- Can be update stoploss to some static price or calculated price or starting the take profit strategy at a calculated price or static price, or exit immediately.
4) Exit Criteria:- Definiing exit criteria based on bars parameters i.e ( low, high, close, open, bear, bull)

Examples:- 
1) "Exit the position in CE, when the first bar with bear body is encountered."
2) "Start a Take Profit Strategy in CE, at the open price of the bar which is the first bear body bar."
3) "Exit position in CE when a bull bar body comes whose total height (close-open) is greater than 30% of height when compared to last 5 bars ir-respective of bull or bear body."

 ```
7. Make sure other good practices are followed like strike price change etc.
8. One critical update, when the AIHelper command is triggered, the hook will be applied to backend to send last 15 bars on bar close. For the first bar close after aihelper command is started the backend sends only 1 bar. Can it be changed to send last 15 (max) bars of today. If the comamnd is fired at 09:30 we will have only 5 bars which is fine. This will apply for all hooks be it exit or entry criteria.
9. Checks can be added to see if a position is already open in the provided symbol for accepting the command.
---


 ##### TradeAnalysisFeatures
 This section features of trade analysis.
 1. User can ask AIHelper to analyze trades provided a start date and end date and a symbol (optional) and simulation trading or papertrading or real trading (optional).
 2. The AI should be able to go through the trades and also the actual ohlc data of the entry exit bars + surrounding 6 bars around every entry/exit. Can be combined to have 6 bars before entry and all bars in between entry, exit and 3 after exit.
 3. It should check how far from bar open value is the actual entry. If all trades consistently show that the entry prices are above from open price consistently by x%.
 4. It should check if after exit, the trade still moves in the favor. Basically an early exit.
 5. It should check if the exit was at a loss, did within 1-2 bars the price reverses. This is scared exit. 
 6. If the user is entering too soon or time gap between trades is too quick. Or worst if same bar has entry, exit and then entry again. This is panic buying.
 7. It should how many times, after user enters trades, the price immediately reverses, like buying on  top or selling on bottom.
 8. Find the direction of the trade by finding whether sell or buy order is placed before. If sell then it is a sell trade, if buy then it is a buy trade.
 9. Use the best model, given the choice of models in accesskeys.init [llm-models]

## PR Log (feature/aihelper branch)

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
| Intent classifier missing intents: `entry_command` + `exit_command` added to `VALID_INTENTS`; LLM was returning correct intent but classifier downgraded both to `question`, silently dropping all exit/entry commands | #144 (fix/intent-classifier-missing-intents) | ✅ merged to feature/aihelper |
| Position null in bar-close hook: `_fire_bar_close_hook` always sent `position=None` (unfilled Step 4 placeholder); exit commands immediately `auto_cancelled_no_position`; fix calls `trading_svc.get_position()` and builds `PositionInfo` dict (side, qty, avg_entry, unrealized_pnl_pct) before sending the hook; 513 backend tests | #145 (fix/bar-close-hook-position) | ✅ merged to feature/aihelper |
| Evaluator JSON field order: DeepSeek committed to `should_exit`/`should_trade` before writing arithmetic; model proved itself wrong in `reason` but couldn't backtrack; fix reorders schema so `reason` is last (before the boolean) in both `evaluate_command` and `evaluate_exit_command` prompts; 136 aihelper tests | #146 (fix/evaluator-json-field-order) | ✅ merged to feature/aihelper |
| AI decision auto-poll: `fetchAndAppendDecisions` was only called on user message send; AI-triggered decisions invisible until user typed; fix adds 10 s `setInterval` in `AIChatPanel`; skips polling when all known commands are `executed`/`cancelled`; `commandsRef` pre-fetched on session change so first tick has correct state; resumes automatically when new command registered via `handleSend` → `fetchCommands()` | #147 (fix/ai-decision-poll) | ✅ merged to feature/aihelper |
| Real trading bug fixes: (1) pending fill buffer in `KotakNeoService` (`_pending_fills` dict) fixes race where fast fills on liquid stocks arrive before `register_fill_callback` is called; (2) `kotak_reconcile` Pass 2 detects external/manual broker orders (not in `kotak_order_map`) by scanning all complete Kotak orders, emits `order_filled` SSE, deduplicates via `external_reconciled_kotak_ids`; CE/PE right inferred from Kotak symbol suffix; (3) wallet synced from `kotak_svc.get_funds()` on every reconcile (`wallet_service.reset`) to correct drift from external trades; (4) `EQUITY_MIS_MARGIN_RATE=0.20` applied in `place_order` and `_place_kotak_direct` fill callback (equity MIS is 5× leveraged, only 20% capital deducted); (5) `onRefresh` calls `fetchAndUpdatePosition()` (all 3 legs in parallel) so position and stoploss button update after reconcile, fixing P&L recalculation; 513 backend tests; TypeScript clean | #148 (fix/real-trading-bugs) | ✅ merged to dev |
