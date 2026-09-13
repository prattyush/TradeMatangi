# Phase 15 — Multi-Session Implementation Plan

## Goal

Allow one logged-in user to run and switch between up to four compatible trading sessions without restarting their data feeds or losing their session state.

The first implementation supports **one active session group per user**:

| Group family | Allowed member session types | Clock behaviour |
|---|---|---|
| Replay | `sim` only | One shared replay timestamp and speed |
| Stepwise | `stepwise` only | One shared timestamp; one Next Bar advances all members |
| Live | `paper` and `real` | Market clock; neither type can be paused |

Every group member has the same trading date. A group has at most four active members. An exact duplicate of `symbol + session type + instrument type` is rejected. Different Paper and Real sessions for the same symbol remain valid because their session types differ.

This plan deliberately does not support several independent groups for the same user. The data model uses a durable group ID, so browser-scoped multiple groups can be added later without changing member records or public session IDs.

## Locked Product Decisions

- A real-authorized user explicitly chooses **Paper** or **Real** for a current-day live session. The default is Paper so an accidental real order is less likely.
- A compact, persistent top row of session tabs is the switcher. Its default label is `Symbol · Mode`; the user may add an editable alias without removing that safety label.
- Add Session opens the existing configuration UI in add mode. Date and replay speed are inherited and locked by the active group.
- A replay member added after the group has started begins at the current shared replay timestamp. It never catches up from 09:15 independently.
- Pause, Resume, and Next Bar are group-clock actions for Replay/Stepwise. Paper and Real do not expose pause controls.
- Stop stops only the selected member. The shared group remains active while it has members; it ends when its final member stops.
- Simulation members use one shared virtual user/date simulation wallet. Paper members use a shared virtual paper wallet for the live group. Real members use a separate broker-backed real ledger. No ledger may overwrite another ledger.
- A browser reload/crash restores the entire active group, the selected member, aliases, and each member's chart workspace. Server state remains authoritative.

## Data and API Contract

### Persistence

Create a `SessionGroups` DynamoDB table rather than trying to encode group state inside one Session item.

| Attribute | Purpose |
|---|---|
| `group_id` (PK) | UUID stable for the group lifetime |
| `user_id` | Owning authenticated user |
| `date` | Shared trading date (`YYYY-MM-DD`) |
| `clock_family` | `sim`, `stepwise`, or `live` |
| `state` | `running`, `paused`, or `ended` |
| `speed` | Shared replay speed; `1.0` for live |
| `current_time` | Shared replay clock timestamp/string; latest live time is informational |
| `strategy_interval_secs` | Required shared bar cadence for Stepwise groups |
| `member_session_ids` | Active member IDs, capped at four |
| `created_at`, `updated_at` | Epoch milliseconds |

Add a `UserIdIndex` GSI on `user_id` so active groups can be found without a table scan.

Extend each `Sessions` item and `SimulationSession` with:

- `group_id: str | None` — nullable for pre-feature historical sessions.
- `session_alias: str | None` — optional user-supplied label; use a length-limited, trimmed value.
- `wallet_ledger_id: str` — identifies the ledger used by all order/trade wallet mutations.

Do not change existing historical `session_id` values, existing trades, or analysis-session identifiers. Missing group fields mean a legacy, standalone completed session.

### Wallet isolation

The current `Wallet` key of `(user_id, date)` cannot represent separate Sim, Paper, and Real balances for a single day. Introduce a new `WalletLedgers` table (or a clearly named equivalent) with a composite key:

```text
PK: user_id
SK: ledger_id                 # e.g. sim:2026-09-13, paper:<group-id>, real:2026-09-13
Attributes: date, ledger_kind, current_balance, created_at, updated_at
```

Ledger rules:

- `sim:<date>` is shared by every simulation member in the active replay group.
- `paper:<group_id>` is shared by every Paper member in the live group.
- `real:<date>` is used only by Real sessions and is initialized/refreshed from Kotak funds.
- Each order persists the ledger identity it reserved against. Cancellation, fill, conversion, direct TradePanel trading, risk/funds sizing affordability checks, and reconciliation must use that persisted ledger instead of resolving only by user/date.
- Existing legacy `Wallet` records remain readable for completed historical sessions. On first multi-session use, initialize a new ledger from the appropriate legacy/default balance without mutating another ledger.
- Session cleanup must delete a ledger only when no active or retained session still references it. Deleting/restarting one member must never delete a sibling's funds.

### Request/response additions

Extend the start request with optional `group_id` and `session_alias`. A missing `group_id` creates the first group member; a present ID means Add Session.

Extend `SimulationStartResponse` and active-session responses with:

```typescript
group_id: string | null
clock_family: 'sim' | 'stepwise' | 'live' | null
group_state: 'running' | 'paused' | 'ended' | null
group_current_time: string | null
session_alias: string | null
wallet_ledger_id: string
```

Add authenticated endpoints, with ownership checks on every route:

| Endpoint | Behaviour |
|---|---|
| `GET /api/simulation/groups/active` | Return the user’s active group and ordered member attach metadata; empty when none exists. |
| `PATCH /api/simulation/groups/{group_id}/members/{session_id}` | Rename member alias only. |
| `POST /api/simulation/groups/{group_id}/pause` | Pause a Replay/Stepwise group; reject Live. |
| `POST /api/simulation/groups/{group_id}/resume` | Resume a Replay/Stepwise group; reject Live. |
| `POST /api/simulation/groups/{group_id}/next-bar` | Advance a Stepwise group; reject other group families. |

Keep existing per-session endpoints for compatibility. Route their pause/resume/next-bar operations through the group only when `group_id` is present, so old standalone sessions retain current behaviour.

## Sprint 1 — Group Model, Validation, and Restore APIs

### Backend work

1. Add Pydantic schemas for group summaries, group members, rename requests, and group control responses. Update TypeScript API types in parallel.
2. Implement `session_group_service.py`:
   - Create/load/upsert/end a group.
   - Add/remove a member atomically enough to enforce maximum four members.
   - Resolve active group by user and validate ownership.
   - Validate family compatibility, shared date, replay speed, Stepwise interval, and duplicate member context.
3. Modify `create_session`, `rebuild_session_from_db`, and DB upsert/load paths to carry group, alias, and ledger fields.
4. Modify `POST /api/simulation/start`:
   - With no active group, create one matching requested type.
   - With `group_id`, validate the requested addition and inherit locked group fields.
   - Reject a start lacking `group_id` when a user already has an active group, with an actionable Add Session error.
   - Retain Real whitelist and Kotak-auth checks only for a `real` request; never infer Real from user authorization.
5. Implement active-group listing and alias endpoints. Include full attach metadata for each active in-memory member so a browser reload does not need to reconstruct configuration from local storage.
6. Add a ledger-aware wallet-service facade while leaving legacy wallet reads intact. Update all new sessions to receive the correct `wallet_ledger_id`.
7. Audit `order_service`, `trading`, order router paths, strategy-created orders, direct Buy/Sell paths, Kotak reconciliation, and cleanup service so every mutation uses a ledger ID.

### Tests

- Group creation and response serialization.
- One user cannot read, rename, attach, or control another user’s group/member.
- Reject incompatible families, date/speed mismatches, fifth member, and exact duplicate context.
- Allow Paper + Real and two different simulation symbols.
- Verify a real-authorized user can create Paper without Kotak authentication, but Real still requires authorization/authentication.
- Verify legacy sessions without group fields still attach/analyze normally.
- Verify Sim, Paper, and Real ledger IDs are distinct; simulation members share exactly one ledger.

### Sprint acceptance

The server can persist and list a safe multi-session group, and all newly created sessions have an isolated, explicit wallet ledger. No frontend switcher is required yet.

## Sprint 2 — Shared Replay and Stepwise Clock

### Backend work

1. Extract the reusable per-session tick processing from `_run_session`:
   - Quote update, SSE event publishing, order checking/fills, entry-SL watcher, strategy evaluation, auto-close, and bar state must accept a session and a timestamp/tick.
   - Preserve the current event contracts, especially self-contained `order_filled`, `order_placed`, and `order_cancelled` events.
2. Implement a `SessionGroupRunner` for `sim` and `stepwise` groups:
   - Build one canonical sequence of market seconds beginning at the group start/current timestamp.
   - Prepare per-member equity/options iterators/lookups before the runner starts; cache required data for every member during Add Session.
   - At each shared timestamp, process every member’s available equity/options ticks before sleeping once for the group speed.
   - Keep session-specific prices, order books, strategy registries, queues, and SSE buffers separate.
   - Persist group current time and member last prices at a bounded cadence and on pause/end; avoid writing DynamoDB once per second for every member.
3. Implement group pause/resume using one shared event/task, not independent member pause events.
4. Implement shared Stepwise behavior:
   - Lock `strategy_interval_secs` from the first member.
   - Complete a group bar, emit each member’s bar-paused state, then wait for a single group Next Bar signal.
   - Do not allow a later member to silently choose a different interval.
5. Add a member at the runner’s current timestamp. Load its quote sources from that point forward and start emitting only future ticks; do not replay historical ticks/orders.
6. On selected-member stop, unregister its feeds, cancel only its strategies, end only its session, and remove it from the runner. Stop the runner/end the group only after the last member is gone.
7. Keep existing live Paper/Real session loops and shared broadcaster registration. Their independent live queues already continue receiving data while the user views another member.

### Tests

- Two replay members receive identical `current_time` progress despite different symbols and price streams.
- Group pause freezes both members; resume advances both without drift.
- A late-added replay member begins at the exact persisted group time and receives no earlier events.
- A Stepwise Next Bar advances all members by the same bar boundary; mismatched interval is rejected.
- Stopping one member does not stop or clear another member’s orders, positions, strategies, SSE queue, or ledger.
- Final member stop ends group runner and unregisters all sources.
- Existing single-session simulation, options dual-stream, order fill, strategy, and auto-close tests remain green.

### Sprint acceptance

Two simulation or Stepwise sessions can run concurrently with one clock and safely share simulated capital. Paper/Real feeds remain active while not selected.

## Sprint 3 — Session Tabs, Add Flow, and Switching

### Frontend state design

Replace the single saved `sessionId` workspace snapshot with a versioned multi-session snapshot:

```typescript
interface GroupWorkspaceSnapshot {
  version: 2
  groupId: string
  selectedSessionId: string
  members: Record<string, MemberWorkspaceSnapshot>
}

interface MemberWorkspaceSnapshot {
  alias?: string
  panes: PaneConfig[]
  layoutPreset: LayoutPreset
  activePaneId: number | null
  maximizedPaneId: number | null
  instrumentType: 'equity' | 'options'
  optionsReady: OptionsReadyConfig | null
  sessionControlsVisible: boolean
}
```

Persist user-interface workspace only in local storage. Never trust it to decide whether a server session is active, who owns it, its type, or its wallet.

### UI work

1. Add `SessionSwitcher` near the top of the trading workspace:
   - Render one compact tab/chip per active member, max four.
   - Always show `Symbol · Mode`; apply distinct mode colors and a strong selected state, especially red Real and green Paper.
   - Let the user edit a small alias, saved through the rename API.
   - Include Add Session and an overflow-safe layout; do not hide the currently selected Real/Paper mode.
2. Refactor `useSimulation` to support selecting/attaching a member:
   - On switch, stop the previous EventSource, attach selected member, then fetch trades, positions, open orders, strategies, labels, snapshots, and current quote state for that session.
   - Use a request generation/abort guard so late fetches from the previous session cannot overwrite selected-session state.
   - Reconnect SSE only for the selected member. Background backend queues/runners continue independently; attach hydration supplies missed state.
3. Save and restore chart/pane configuration per session, not globally. Switching NIFTY options to a different member must not leave stale CE/PE strikes or markers visible.
4. Update Session Controls:
   - Normal start creates the first member of a group.
   - Add mode inherits the group date and speed and disables those inputs.
   - For today and a user with real access, show an explicit Paper/Real segmented selector, default Paper.
   - For users without real access, show Paper only. For historical dates, preserve Simulation/Stepwise controls.
   - Keep option strike discovery and duplicate preflight checks, now group-aware.
5. Render group-level Replay/Stepwise controls once. In Live groups, do not show Pause/Resume. Selected-session Stop remains available and states that it affects only the selected tab.
6. Route wallet display and all active panel API calls through the selected session, including `wallet_ledger_id`/session-aware wallet fetches.

### Tests

- A real-authorized user sees a Paper/Real choice with Paper selected by default.
- Tabs show default labels, aliases, correct colors, selection, and no ambiguous Real state.
- Switch hydrates only selected-member position/orders/trades and disposes the old SSE stream.
- Per-member panes/options strikes/layout restore correctly on switch.
- Add mode locks date/speed and reports duplicate/family/cap errors clearly.
- Reload restores all active group members and selected tab; stale local storage falls back to server response without crashing.
- No pause controls appear in a Live group; simulation controls affect group clock only.

### Sprint acceptance

A user can create a Paper + Real live group or multi-symbol replay group, switch in one click, and retain the correct chart/order/session identity at all times.

## Sprint 4 — Wallet Migration, Recovery, and Regression Hardening

### Backend work

1. Add DynamoDB table creation/configuration and local-test setup for `SessionGroups` and `WalletLedgers`.
2. Implement legacy wallet initialization and read fallback. Document whether the first ledger copies the legacy balance or uses the project default when no prior balance exists.
3. Update `/api/wallet` (and `WalletWidget`) to resolve balance by active `session_id`, or require an explicit validated `ledger_id`; do not accept an unvalidated ledger ID supplied by the client.
4. Audit override/restart behavior:
   - An Add Session never silently deletes a group sibling.
   - Restart/override confirmation names the selected member and its effects.
   - Shared-ledger cleanup is reference-aware.
5. Ensure `GET /groups/active` reports ended/missing in-memory members safely after backend restart. Browser restoration must show a clear ended state instead of attaching a stale ID.
6. Add operational logging for group creation/end, member add/remove, runner lifecycle, rejected compatibility checks, and ledger selection. Do not log broker credentials, order secrets, or user-sensitive tokens.

### End-to-end scenarios

1. Start NIFTY Paper, add NIFTY Real, switch repeatedly, place orders in both, and verify Paper balance and Kotak-backed balance are independent.
2. Start NIFTY simulation, add BSESEN simulation, reserve capital in one, and verify the other cannot over-reserve the shared simulation wallet.
3. Pause a two-member replay group, reload the browser, restore both members, resume, and verify both timestamps remain synchronized.
4. Add an options replay member after the group has run for several minutes and verify it begins at current time with correct CE/PE strikes and no historical fills.
5. Stop one member with pending orders/strategies; verify only that member is cleaned up and the remaining member keeps running.
6. Force a stale local workspace snapshot and verify the active-group API controls the recovered UI.

### Sprint acceptance

The feature is safe under reload, ledger separation, member stop, and existing session cleanup/restart flows. All backend tests, frontend TypeScript checks, and relevant frontend test suites pass.

## Implementation Notes and Guardrails

- Preserve IST timestamp and epoch-aligned candle/bar rules documented in `CLAUDE.md` and backend constraints.
- Do not create a separate market websocket for each tab. Reuse the existing Kite/Kotak/Fyers shared broadcasters; register/unregister members by session ID.
- Do not expose one session’s orders, wallet, strategies, or SSE events after a tab switch. Treat all async hydration as cancellable/staleable.
- Do not make group membership client-authoritative. Validate user ownership and compatibility on the server.
- Do not use the legacy `(user_id, date)` wallet key for new order mutations once ledger IDs exist.
- Do not delete a wallet ledger as a side effect of deleting a single member.
- Keep trade analysis session-based. Group metadata improves active-session UX but must not merge unrelated historical trade records automatically.

## Expected Files

Likely touched areas include:

- `backend/app/services/simulation.py`, new group/ledger services, wallet/order/trading services, simulation and wallet routers, schemas, and DynamoDB setup/tests.
- `frontend/src/App.tsx`, `hooks/useSimulation.ts`, `components/SessionControls.tsx`, a new `SessionSwitcher.tsx`, `WalletWidget.tsx`, and `services/api.ts`.
- `backend/tests/` and frontend component/hook tests covering group coordination, restore, and ledger isolation.

Implementation should update this plan only if an unavoidable repository constraint changes one of the locked decisions above.

## Implementation Status (2026-09-13)

The Phase 15 multi-session foundation is implemented on the development branch. Delivered behavior covers group lifecycle, session isolation, add/override flow, reload recovery, and fast switching:

- Session groups support compatible Replay, Stepwise, Paper, and Real members (maximum four), ownership checks, duplicate validation, aliases, shared date/clock metadata, and active-group restore APIs.
- Simulation, Paper, and Real sessions receive explicit wallet ledger identities. Order, trade, wallet, cleanup, and reconciliation paths preserve ledger isolation; stopping or overriding one member does not remove a sibling's ledger.
- Add Session inherits the group's date and replay settings. Override performs scoped cascade cleanup and removes only the matching member/context before rebuilding it.
- Option contracts are normalized against the selected symbol/date. Stale cross-symbol strikes (for example a NIFTY strike submitted for BSESEN) and stale expiries are rejected or corrected after the selected underlying is loaded.
- Replay and Stepwise processing, group pause/resume/next-bar controls, current-time persistence, and member-specific SSE events are implemented while preserving standalone-session compatibility.
- The session switcher, per-member workspace persistence, reload recovery, selected-session wallet/panels, and locked Add Session controls are implemented. Live groups do not expose replay pause controls.

### Additional seamless-switching changes

The original Sprint 3 wording assumed one selected-member EventSource. The implementation extends that design so all active members remain current while only one tab is visible:

1. The frontend opens one SSE connection per active group member, up to the four-member cap. Hidden members continue receiving ticks and bar-paused events.
2. A per-session in-memory runtime cache retains latest equity/CE/PE ticks, prices, completed bars, bar index, and pause state. Selecting a tab immediately seeds the visible chart and clock from that cache.
3. Event routing is session-ID aware. Hidden events cannot overwrite the selected member's charts, orders, positions, wallet, or controls. Selection then hydrates authoritative trades, positions, orders, and strategies for that session.
4. Chart data uses a bounded in-memory cache keyed by session, symbol, date, pane, strike, and reload generation. Repeated switches reuse fetched history and only request a new generation after an explicit reload.
5. Backend runners/broadcasters continue processing every active member while a different tab is selected, so hidden-session limit orders and strategies continue to execute.

These additions keep the backend authoritative: browser caches accelerate display only and never decide group membership, ownership, wallet identity, or order state.

### Verification status

- Frontend TypeScript check: `node node_modules/typescript/bin/tsc --noEmit` — passed.
- Focused backend restart/resume/session tests — passed (28 tests).
- Full-suite and external market-provider checks remain deployment-environment checks because they require configured broker/data credentials.
