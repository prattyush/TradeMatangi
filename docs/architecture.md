# Trade Matangi — Architecture

---

## Phase XI — AI Helper

### Overview

Phase XI adds an LLM-powered AI assistant. Four core capabilities:

1. **Custom Entry** — NL conditions that trigger buy/sell orders
   - e.g. "When the first bar comes whose low is below the low of the previous bar, Buy L Ratio Quantity At Market Price"
2. **Custom Exit** — NL conditions that trigger exit strategies
   - e.g. "When the first pullback bar comes, start a TakeProfit strategy at the high of the bar before the pullback bar"
3. **Partial Exit** — profit-percentage-based staged exits
   - e.g. "When total Profit % reaches 6%, exit 50% position. Exit the rest when profit % of remaining quantity reaches 6%"
4. **Trade Analysis** — LLM reads trade history and surfaces improvement patterns
   - e.g. "Always entering at bad price w.r.t. bar open. Profits are smaller than losses. Averaging entries causing more losses."

A fixed DSL was deliberately rejected: complex patterns like Double Top, Trap setups for sellers, first pullback detection, etc. cannot be encoded in a finite schema. The LLM reasons over raw OHLC bars and the natural language command on every bar close.

---

### Entry Command Specification (Phase XI scope)

Every entry command must contain exactly **4 required fields**. The LLM validates these before registering a command. If any field is missing or ambiguous, aihelper returns the validation prompt below and waits for a corrected input — the command is **not registered** until all 4 fields are present.

| Field | Allowed Values | Notes |
|-------|---------------|-------|
| **Order Type** | `Market`, `Limit`, `Target` | Treated identically to the corresponding UI tab |
| **Quantity / Ratio** | `L`, `M`, `H` (ratio of session wallet) or a fixed number | L=3%, M=6%, H=12% of wallet at session start |
| **Symbol** | `CE` or `PE` for options sessions; implicit for equity | Must be explicit for options — never inferred |
| **Trigger Criteria** | Bar-parameter expressions only (see below) | No pattern names (no "double top", "trap") — must be explicit bar logic |

**Allowed bar parameters in trigger criteria:**

| Parameter | Meaning |
|-----------|---------|
| `low`, `high`, `close`, `open` | Current bar's OHLC values |
| `bear` / `bull` | Bar color — bear = close < open; bull = close > open |
| `previous bar low/high/close/open` | Prior bar's OHLC values |
| Fixed number | e.g. `89.5` |
| Derived expressions | e.g. `(open + close) / 2`, `close + 0.5` |
| `crosses` / `>` / `<` / `>=` / `<=` | Comparison operators |

Pattern names like "double top", "trap setup", "engulfing" are **out of scope** for Phase XI — users must express the condition explicitly using the bar parameters above.

**Validation prompt returned when command is incomplete:**

```
For adding a command, please mention all four of:

1) Order Type — Limit, Market, or Target
2) Quantity or Ratio — ratio values are L, M, or H (% of session wallet)
3) Symbol — CE or PE (required for options)
4) Entry Criteria — defined using bar parameters: low, high, close, open, bear, bull

Examples:
• "If CE bars low crosses low of previous bar, and the bar is a bear bar,
   then place a target order at the mid value of the bar (open + close) / 2
   with quantity of ratio L."
• "If CE bars close crosses 89.5, then place a target order at close + 0.5
   with trade quantity of ratio L."
```

**Strike selection from `right`** — since `right` (CE or PE) is a required field, the strike is always deterministic. The frontend always sends both current strikes; aihelper picks based on the extracted `right`:

```
strike = strike_ce   if right == "CE"
strike = strike_pe   if right == "PE"
strike = null        for equity sessions
```

No ambiguity follow-up questions are needed for strike — the validation step enforces `right` to be present first.

---

### Server Architecture

**Separate `aihelper` FastAPI server** running at port `8701`, isolated from the trading hot path. LLM bugs or timeouts cannot affect order placement or tick processing.

The aihelper **never watches ticks directly**. The backend pushes a bar-close hook (fire-and-forget POST) on each bar close, only when active AI commands exist for that session. aihelper returns `200` immediately and processes asynchronously.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend (port 5173)                                               │
│  ┌──────────────────────┐   ┌──────────────────────────────────┐   │
│  │  Trading UI          │   │  AIChatPanel (floating overlay)  │   │
│  │  (existing)          │   │  - type commands / questions     │   │
│  │                      │   │  - view command status           │   │
│  │                      │   │  - see LLM action decisions      │   │
│  └──────┬───────────────┘   └──────────────┬───────────────────┘   │
│         │ SSE / REST                        │ REST                  │
└─────────┼───────────────────────────────────┼───────────────────────┘
          │                                   │
          ▼                                   ▼
┌──────────────────────┐         ┌────────────────────────┐
│  Backend (port 8700) │         │  aihelper (port 8701)  │
│  FastAPI             │         │  FastAPI               │
│                      │─bar─────▶  bar-close hook        │
│  (existing trading,  │ close   │  (fire-and-forget)     │
│   orders, strategies,│ hook    │                        │
│   SSE stream)        │         │  LiteLLM               │
│                      │◀────────│  → LLM decision        │
│                      │ order/  │  → log to AIDecisionLog│
│  stop_session()      │ trade   └────────────────────────┘
│    │                 │ REST             │
│    └─── sync POST ──▶│ cancel commands  │
│         (await)      │                  ▼
└──────────────────────┘            DynamoDB Local
          │                    (AICommands, AIStrategies,
          │                      AIDecisionLog)
          ▼
    DynamoDB Local
    (existing tables)
```

---

### Request Flows

#### 1. Trading Command Registration

```
User types command in AIChatPanel
        │
        ▼  POST /ai/chat
           {message, session_id, user_id, symbol,
            strike_ce: 24400,    ← current CE strike from session state (null for equity)
            strike_pe: 24350}    ← current PE strike from session state (null for equity)
aihelper
        ├── LLM: classify intent → "command"
        │
        ├── VALIDATION: extract all 4 required fields from message
        │       order_type    : Market | Limit | Target          (required)
        │       quantity_type : ratio_l | ratio_m | ratio_h | fixed  (required)
        │       right         : CE | PE | null (equity)          (required for options)
        │       trigger       : explicit bar-parameter expression (required)
        │
        ├── If any field missing or ambiguous:
        │       return validation prompt with examples — DO NOT register command
        │
        ├── If all fields present:
        │       strike = strike_ce if right=="CE" else strike_pe if right=="PE" else null
        │       parse price_expression (e.g. "(open+close)/2", "close+0.5", "market")
        │
        ├── Parse optional hotword (e.g. "... save as 'pullback buy'")
        │       if hotword provided:
        │           GetItem AIStrategies {PK: user_id, SK: hotword}
        │           if exists → return error: "Hotword 'pullback buy' already in use."
        │           if not → save to AIStrategies
        │
        ├── Persist to DynamoDB AICommands:
        │       {command_id, user_id, session_id, symbol, right, strike,
        │        command_text, order_type, quantity_type, quantity_value,
        │        parsed_trigger, parsed_price_expr,
        │        status:"active", one_shot:true, hotword: <value or null>}
        │
        ├── Notify backend: POST /api/ai/commands/active {session_id}
        │       (backend sets session.ai_commands_active = True)
        │
        └── Return:
              {"status": "watching", "command_id": "...",
               "summary": "Watching CE (24400): target order at (open+close)/2, ratio L — fires when CE low < prev bar low AND bear bar",
               "hotword": "pullback buy" | null}
```

#### 2. Bar-Close Hook (backend → aihelper, fire-and-forget)

```
backend: bar close detected
        │
        ├── if session.ai_commands_active == False: skip (no calls to aihelper)
        │
        └── POST http://AI_HELPER_URL/hook/bar-close   (fire-and-forget, timeout=100ms)
                {user_id, session_id, symbol, right,
                 bars: [last 15 OHLC bars],              ← fixed 15-bar window
                 position: {side, qty, avg_entry, unrealized_pnl_pct},
                 timestamp}

aihelper: returns 200 immediately
        │
        └── BarCloseProcessor.submit(hook, active_commands)
                ├── fetch active commands for session from DynamoDB (SessionCommandsIndex GSI)
                ├── for each command → asyncio.gather(LLM calls in parallel):
                │       system prompt + bars JSON + position + command text
                │       → LLM returns {should_trade: bool, reason: "...", action: {...}}
                │
                ├── if should_trade == False:
                │       discard (no-op, no log entry)
                │
                └── if should_trade == True:
                        ├── validate action via guardrails
                        ├── POST backend /api/orders  or  /api/trading
                        ├── record result (success / failure / rejected by guardrail)
                        ├── write to AIDecisionLog:
                        │       {session_id, timestamp, command_id, command_text,
                        │        bar_time, reason, action, action_result}
                        ├── mark command: executed (one_shot=True) or active (one_shot=False)
                        └── LangFuse trace recorded
```

#### 3. Session End — Cancel All Commands (CRITICAL for real trading)

```
backend: stop_session(session_id) called
        │
        ├── (existing) strategy_service.cancel_all()
        │
        └── await POST http://AI_HELPER_URL/hook/session/{session_id}/stop
                ← SYNCHRONOUS, backend waits for 200 before completing stop_session
                   timeout = 2s (short but enough; aihelper only does DB writes, no LLM)

aihelper: POST /hook/session/{session_id}/stop
        ├── set all AICommands WHERE session_id = X AND status = "active" → status = "cancelled"
        ├── clear any in-flight BarCloseProcessor queue for this session
        └── return 200

backend: stop_session() completes
```

This is deliberately synchronous (not fire-and-forget) because a race between a bar-close hook and session stop must always resolve in favour of cancel in real trading.

#### 4. Action Decisions Visible in Chat

```
User opens AIChatPanel (or sends any message)
        │
        ▼  GET /ai/session/{session_id}/decisions?since={last_seen_ts}
aihelper
        ├── query AIDecisionLog for session, filtered by timestamp > last_seen_ts
        └── return list of decisions:
              [{command_id, command_text, bar_time, reason, action, action_result, timestamp}]

Frontend: renders each as an assistant message in chat history:
  "🤖 10:24 IST — Triggered 'buy when low < prev bar low'.
   Action: BUY 3 lots at ₹24,350 (market).
   Reason: Bar at 10:24 (low ₹24,340) closed below previous bar's low (₹24,355).
   Result: Order placed ✓"
```

Frontend stores `last_seen_ts` in component state. On each chat open or message send, fetches new decisions since last check and prepends them to the chat history as assistant messages.

#### 5. Trade Analysis

```
User: "Analyze my trades from last 7 days"  (on-demand only, user specifies range in chat)
        │
        ▼  POST /ai/chat  {message, user_id}
aihelper: detects analysis intent, parses date range from message
        │
        ├── GET backend /api/analysis/trades?user_id=...&from=...&to=...
        ├── LLM (analysis model): structured analysis prompt
        └── Return full response once complete (no streaming):
            {summary: "...", patterns: [...], suggestions: [...], notable_stats: {...}}
```

#### 6. Hotword Strategy Recall

```
User: "use pullback buy"
        │
aihelper: detects hotword intent
        ├── GET DynamoDB AIStrategies {PK: user_id, SK: "pullback buy"}
        ├── registers strategy_text as a new AICommand (same as regular command flow)
        └── Return: {"status": "watching", "summary": "Recalled 'pullback buy': ..."}
```

#### 7. List Commands

```
User: "show my commands" / "list active commands" / "what are my hotwords"
        │
aihelper: detects list_commands intent
        ├── query AICommands GSI: session_id = current_session, status = "active"
        └── return formatted list:
              "Active commands:
               1. [pullback buy] Watching: buy L ratio when low < prev bar low
               2. [no hotword] Watching: exit 50% when profit reaches 6%"
```

---

### DynamoDB Tables (aihelper — direct connection, same DynamoDB Local as backend)

#### `AICommands` — active commands per session

| Attribute | Type | Notes |
|-----------|------|-------|
| `user_id` | PK (S) | |
| `command_id` | SK (S) | UUID |
| `session_id` | S | GSI key |
| `symbol` | S | e.g. `NIFTY` |
| `right` | S | `CE` / `PE` / null (equity) |
| `strike` | N | Strike at command registration time; null for equity |
| `command_text` | S | Original natural language text (preserved for display) |
| `order_type` | S | `market` \| `limit` \| `target` |
| `quantity_type` | S | `ratio_l` \| `ratio_m` \| `ratio_h` \| `fixed` |
| `quantity_value` | N | Null for ratio types; lot count for fixed |
| `parsed_trigger` | S | Extracted trigger expression (e.g. `"CE low < prev_bar.low AND bear"`) |
| `parsed_price_expr` | S | Price expression string (e.g. `"(open+close)/2"`, `"close+0.5"`, `"market"`) |
| `status` | S | `active` \| `executed` \| `cancelled` |
| `cancel_reason` | S | Nullable — e.g. `"strike_changed"`, `"session_ended"`, `"user_cancelled"` |
| `one_shot` | BOOL | Default true; false = repeat until cancelled |
| `hotword` | S | Nullable — set if user saved with a hotword |
| `created_at` | S | ISO timestamp |
| `fired_at` | S | Nullable — timestamp of last trade trigger |

GSI: `SessionCommandsIndex` — PK: `session_id` (fast lookup per bar-close hook)

Hotword uniqueness is enforced per user in the `AIStrategies` table at command creation time (not at command level — a command's hotword is a reference to the saved strategy).

#### `AIStrategies` — saved strategies per user (persistent across sessions)

| Attribute | Type | Notes |
|-----------|------|-------|
| `user_id` | PK (S) | |
| `hotword` | SK (S) | e.g. `"pullback buy"` — unique per user, enforced at write time |
| `strategy_text` | S | Full natural language command text |
| `description` | S | Short summary generated by LLM |
| `created_at` | S | |
| `last_used_at` | S | Updated on each hotword recall |
| `use_count` | N | |

Duplicate hotword check: before writing, `GetItem {PK: user_id, SK: hotword}` → if found, return error to chat.

#### `AIDecisionLog` — LLM action decisions (shown in chat)

| Attribute | Type | Notes |
|-----------|------|-------|
| `session_id` | PK (S) | |
| `ts_command_id` | SK (S) | `{ISO_timestamp}#{command_id}` — sortable |
| `command_id` | S | Reference to AICommands |
| `command_text` | S | Copied for display (command may be executed/cancelled by query time) |
| `bar_time` | S | ISO timestamp of the triggering bar |
| `reason` | S | LLM's reason string |
| `action` | M | `{side, quantity_type, quantity_value, price_type, price_value}` |
| `action_result` | S | `"order_placed"` \| `"rejected_guardrail"` \| `"backend_error"` |
| `timestamp` | S | ISO timestamp of the decision |

Only written when `should_trade=True`. No-ops produce no log entry.
TTL: 7 days (set `ttl_epoch` attribute for DynamoDB TTL auto-expiry).

---

### `aihelper/` Project Structure

```
aihelper/
├── main.py                      # FastAPI app, port 8701, CORS, logging setup
├── config.py                    # reads data/accesskeys.ini:
│                                #   [langfusecloud] SECRET_KEY, PUBLIC_KEY, BASE_URL
│                                #   [llm] API keys per provider
│                                #   [llm-models] model names per role
│                                #   [paths] logs → LOG_DIR
│                                # AI_HELPER_PORT, BACKEND_URL, PROCESSOR_TYPE
├── requirements.txt             # fastapi, litellm, langfuse, boto3, httpx, pydantic
│
├── routers/
│   ├── chat.py                  # POST /ai/chat  (all user messages)
│   ├── hook.py                  # POST /hook/bar-close, POST /hook/session/{id}/stop
│   ├── decisions.py             # GET /ai/session/{id}/decisions
│   └── strategies.py            # GET/DELETE /ai/strategies  (hotword management)
│
├── services/
│   ├── llm_service.py           # LiteLLM wrapper — provider-agnostic, reads model from config
│   ├── intent_classifier.py     # LLM: command|analysis|question|hotword|list_commands
│   ├── command_evaluator.py     # LLM: bars + command → should_trade + action + reason
│   ├── analysis_service.py      # LLM: trade history → structured insights
│   └── backend_client.py        # httpx async client for backend REST calls
│
├── processors/
│   ├── base.py                  # Abstract BarCloseProcessor interface
│   ├── bounded_queue.py         # Default: bounded queue per session, MAX_DEPTH=10
│   ├── drop_if_busy.py          # Alt: discard hook if LLM already running for session
│   └── background_tasks.py      # Alt: asyncio.create_task per hook (no drop)
│
├── db/
│   ├── dynamo.py                # DynamoDB resource (reads accesskeys.ini, same pattern as backend)
│   ├── commands_store.py        # AICommands CRUD
│   ├── strategies_store.py      # AIStrategies CRUD (with duplicate hotword check)
│   └── decision_log_store.py    # AIDecisionLog write + query-since
│
├── guardrails/
│   └── validator.py             # Rule-based input/output validation (pluggable for NeMo later)
│
└── observability/
    └── tracing.py               # LangFuse Cloud: @observe decorator, no-op if keys absent
```

---

### Backend Extensions (minimal changes)

| File | Change |
|------|--------|
| `app/config.py` | Add `AI_HELPER_URL = "http://localhost:8701"` |
| `app/models/schemas.py` | `SimulationSession.ai_commands_active: bool = False` |
| `app/services/simulation.py` | On bar close: if `session.ai_commands_active`, fire async POST hook (httpx, timeout=100ms, swallow errors — fire-and-forget) |
| `app/services/simulation.py` | In `stop_session()`: after `strategy_service.cancel_all()`, await POST `aihelper/hook/session/{id}/stop` (synchronous, timeout=2s, log error if fails — do NOT block session stop on aihelper failure) |
| `app/routers/simulation.py` | Add `POST /api/ai/commands/active {session_id}` → sets `session.ai_commands_active = True` |

Note: if aihelper is unreachable on `stop_session()`, log the error and continue — never let aihelper downtime block a session stop.

### Frontend Additions

| File | Change |
|------|--------|
| `src/config.ts` | `AI_HELPER_URL = "http://localhost:8701"` |
| `src/api.ts` | `aiChat()`, `aiGetDecisions(sessionId, since)`, `aiGetStrategies()`, `aiDeleteStrategy()` |
| `src/components/AIChatPanel.tsx` | Floating button → overlay panel; chat history; command status badges; fetches decisions on open |

---

### LLM Configuration (LiteLLM — provider-agnostic)

API keys and model names are read from `data/accesskeys.ini`:

```ini
[llm]
OPENAI_API_KEY     = sk-...
DEEPSEEK_API_KEY   = sk-...
ANTHROPIC_API_KEY  = sk-ant-...
OPENROUTER_API_KEY = sk-or-...

[llm-models]
# Role → LiteLLM model string
intent_classifier  = deepseek/deepseek-chat
command_evaluator  = deepseek/deepseek-chat
analysis           = openai/gpt-4o-mini
fallback           = openrouter/meta-llama/llama-3.1-8b-instruct:free
```

**Rationale for defaults:**
| Role | Model | Reason |
|------|-------|--------|
| Intent classifier | `deepseek/deepseek-chat` | Called once per user message; DeepSeek credits available; cheap (~$0.27/M tokens) |
| Command evaluator | `deepseek/deepseek-chat` | Called on every bar close per active command; must be cheap; DeepSeek is fast and accurate for structured JSON output |
| Analysis | `openai/gpt-4o-mini` | Batch, quality matters; OpenAI credits available; strong reasoning for trade pattern analysis |
| Fallback | `openrouter/...free` | Free tier when credits run low; rate-limited but usable for testing |

Structured JSON output enforced via `response_format={"type": "json_object"}` for command evaluator and intent classifier — works across all four providers via LiteLLM.

---

### Logging

aihelper uses the same log directory as the backend (read from `accesskeys.ini [paths] logs`, same `LOG_DIR` pattern). File: `aihelper.log`, rotating daily at midnight with 30-day retention — identical `TimedRotatingFileHandler` setup as the backend.

```python
# main.py
handler = TimedRotatingFileHandler(
    LOG_DIR / "aihelper.log", when="midnight", backupCount=30
)
```

Rotated files: `aihelper.log.YYYY-MM-DD`. All routers, services, and processors log to the `aihelper` logger namespace.

---

### LLM Prompts (initial set — to be tuned during testing)

#### Intent Classifier

```
System:
You are a trading assistant for Indian markets (NSE/NFO). Classify the user's message
into exactly one of these intents:
- "command"       : an entry, exit, or partial-exit instruction tied to market conditions
- "analysis"      : a request to analyze past trades
- "question"      : a general question about the platform or markets
- "hotword"       : a reference to a saved strategy by name (e.g. "use pullback entry")
- "list_commands" : a request to see currently active commands or saved hotwords
Respond with JSON only: {"intent": "<type>", "confidence": 0.0–1.0}

User: {message}
```

If intent is `"command"`, the validation step then extracts and checks the 4 required
fields (order_type, quantity_type, right, trigger). If any field is missing, aihelper
returns the validation prompt — no further LLM call is made until the user corrects it.

#### Command Evaluator (called per bar-close hook per active command)

The evaluator receives pre-parsed structured fields from AICommands (not the raw command
text), making evaluation deterministic and reducing LLM hallucination risk. The LLM's
only jobs are: (1) evaluate the boolean trigger condition, (2) compute the order price.
Action construction is done by the aihelper service using the stored structured fields.

```
System:
You are a trading execution engine for Indian equity/options markets (NSE/NFO).
Evaluate whether the entry condition is met by the bar that just closed,
and compute the order price from the price expression.

Evaluate ONLY the most recent bar (last in the list). Previous bars are context only.
Do NOT fire on a condition already met in an earlier bar.

Current bar (just closed):
  open={open}  high={high}  low={low}  close={close}
  bar_color={"bear" if close < open else "bull"}

Previous bar:
  open={prev_open}  high={prev_high}  low={prev_low}  close={prev_close}

Current position (null if none):
{position_json}

All bars for additional context (oldest → newest, IST wall-clock timestamps):
{bars_json}

Entry condition to evaluate:
  Trigger      : {parsed_trigger}
  Price expr   : {parsed_price_expr}
  Order type   : {order_type}
  Quantity     : {quantity_type} {quantity_value if fixed else ""}

Rules:
- Respond with JSON only.
- Schema: {"should_trade": true|false, "reason": "<1-2 sentences>", "computed_price": <number|null>}
- computed_price is required (non-null) when should_trade is true.
- Price expression evaluation:
    "market"           → computed_price = null
    "(open+close)/2"   → computed_price = round((open+close)/2 to nearest 0.05)
    "close+0.5"        → computed_price = round(close+0.5 to nearest 0.05)
    "<fixed number>"   → computed_price = that number rounded to nearest 0.05
- All prices must be rounded to nearest ₹0.05 (NSE minimum tick size).
- If the trigger cannot be evaluated from available data, set should_trade=false.
```

The aihelper service constructs the final order using:
- `side = BUY` (for entry commands)
- `order_type`, `quantity_type`, `quantity_value` — from stored AICommands fields
- `price_value` — from evaluator's `computed_price`
- `symbol`, `right`, `strike` — from stored AICommands fields

#### Trade Analysis

```
System:
You are a trading performance coach analyzing trades from Indian equity/options markets.
You will receive a list of trades with entry/exit prices, P&L, timestamps, and session metadata.

Identify patterns — both positive and negative. Be specific and quantitative where possible.
Respond with JSON only:
{
  "summary": "<2–3 sentence overall assessment>",
  "patterns": [
    {
      "type": "negative" | "positive",
      "title": "<short title>",
      "detail": "<specific observation with numbers>",
      "frequency": "<e.g. '7 of 10 losing trades'>'"
    }
  ],
  "suggestions": ["<actionable improvement 1>", "<actionable improvement 2>"],
  "notable_stats": {
    "win_rate": "<e.g. 42%>",
    "avg_profit_pct": "<e.g. 1.8%>",
    "avg_loss_pct": "<e.g. 3.2%>",
    "best_time_of_day": "<e.g. '09:15–10:30'>",
    "worst_time_of_day": "<e.g. '13:00–14:00'>"
  }
}

Trades data:
{trades_json}
```

---

### BarCloseProcessor — Pluggable Async Strategy

```python
# processors/base.py
class BarCloseProcessor(ABC):
    @abstractmethod
    async def submit(self, hook: BarCloseHook, commands: list[AICommand]) -> None: ...
```

Selected via config `PROCESSOR_TYPE`:

| Type | Behaviour | Best for |
|------|-----------|----------|
| `bounded_queue` *(default)* | Per-session queue, max depth 10. Oldest dropped when full. | Paper / real trading |
| `drop_if_busy` | Discard hook if LLM call already in-flight for this session | Fast sim replay |
| `background_tasks` | `asyncio.create_task` per hook, no drop | Low-frequency sessions |

Multiple LLM calls per hook (one per active command) run as parallel `asyncio.gather` tasks inside the processor. With a maximum of 2–3 sessions per user, total concurrency is low.

---

### Command Lifecycle

| Status | Meaning |
|--------|---------|
| `active` | Watching — evaluated on every bar-close hook |
| `executed` | Fired (one_shot=True) — no longer evaluated |
| `cancelled` | User cancelled via chat, or session ended |

Default: `one_shot=True`. User can append "keep watching" or "repeat" to set `one_shot=False`.
Session stop always overrides to `cancelled` regardless of `one_shot`.

---

### Guardrails

Applied before LLM call (input sanitization) and before order execution (output validation):

- Reject hook processing outside market hours (09:15–15:30 IST)
- Allowlist `action.side`: `BUY` | `SELL` only
- Allowlist `action.quantity_type`: `ratio_l` | `ratio_m` | `ratio_h` | `pct_position` | `fixed`
- Block BUY commands when a long position already exists in the same direction (no unintended averaging)
- Block SELL commands when no position exists
- Input sanitization: strip special characters from command text before LLM call

NeMo Guardrails integration point: `guardrails/validator.py` is a pluggable step — swap implementation without changing callers.

---

### Observability: LangFuse Cloud

Credentials read from `data/accesskeys.ini [langfusecloud]`: `SECRET_KEY`, `PUBLIC_KEY`, `BASE_URL`.

```python
# observability/tracing.py
from langfuse.decorators import observe

@observe()   # auto-captures prompt, response, latency, token cost per call
async def evaluate_command(...):
    ...
```

Graceful no-op if keys absent. LangFuse Cloud free tier: 50k events/month — sufficient for single-user development and finalization.

---

### Scripts

```bash
scripts/start-aihelper.sh    # uvicorn aihelper.main:app --host 0.0.0.0 --port 8701
scripts/stop-aihelper.sh
```

---

### Build Sequence

| Step | Scope |
|------|-------|
| 1. Foundation | aihelper FastAPI skeleton, DynamoDB tables (AICommands, AIStrategies, AIDecisionLog), LiteLLM + LangFuse wiring, logging, backend_client, scripts |
| 2. Hook plumbing | Backend fires bar-close hook + session-stop hook; aihelper hook endpoints + BarCloseProcessor |
| 3. Command flow | `/ai/chat` endpoint, intent classifier, AICommands CRUD, command evaluator, hotword duplicate check |
| 4. Trade execution | aihelper → backend order placement on LLM yes-decision; AIDecisionLog write |
| 5. Decision visibility | `GET /ai/session/{id}/decisions`; frontend fetches and renders as assistant messages |
| 6. Hotword strategies | AIStrategies table, save/recall/list in chat |
| 7. Chat UI | AIChatPanel floating overlay, command status badges, decision messages |
| 8. Trade Analysis | Analysis prompt, backend trade fetch, response display |
| 9. Guardrails | Input sanitization, output allowlist, market-hours check |
| 10. Testing | Unit tests for command evaluator; integration test end-to-end (chat → bar hook → order placed → decision in chat) |

---

### Decisions Reference

| Question | Decision |
|----------|----------|
| Bars per hook | 15 (fixed) |
| Hook trigger | Only when `session.ai_commands_active = True` |
| Async processing | Pluggable `BarCloseProcessor`; default bounded queue per session |
| Command persistence | DynamoDB (aihelper direct) — AICommands table |
| Hotword strategies | AIStrategies table; duplicate hotword returns error in chat |
| Decision log | AIDecisionLog table; action decisions visible in chat on open; 7-day TTL |
| Session stop → cancel | Synchronous call from backend; aihelper failure must not block stop |
| Command lifecycle | One-shot default; user can specify repeat; session stop always cancels |
| Entry command fields | 4 required: order type, quantity/ratio, CE/PE, trigger criteria |
| Trigger criteria scope | Explicit bar params only (low/high/close/open/bear/bull); no pattern names in Phase XI |
| Validation on missing field | Return spec's example prompt; do not register until all 4 present |
| Strike selection | Always deterministic: CE → strike_ce, PE → strike_pe (right is required) |
| Ambiguity resolution | Covered by validation — CE/PE must be explicit; no follow-up guessing |
| Price computation | LLM evaluates price expression (e.g. `(open+close)/2`) from current bar; aihelper builds order |
| `/ai/chat` payload | Sends both `strike_ce` and `strike_pe` always; aihelper picks based on extracted `right` |
| Chat UI placement | Floating button → overlay panel |
| LLM response display | Wait for full response, then display |
| Trade Analysis trigger | On-demand; user specifies date range in chat |
| LLM provider | LiteLLM; DeepSeek for commands/classification, OpenAI gpt-4o-mini for analysis |
| Logging | Same LOG_DIR as backend; `aihelper.log` daily rotating |
| Observability | LangFuse Cloud (reads `data/accesskeys.ini [langfusecloud]`) |
