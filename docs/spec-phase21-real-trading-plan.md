# Phase 21 extension — Kite execution and desktop Real / linked screens

## Authority, delivery and current state

Approved 2026-10-09. All work is based on preprod; delivery PRs target preprod.
The user's explicit branch instruction supersedes the repository's older dev rule
for this extension. Main/dev promotion and deployment are manual after acceptance.
The earlier Phase 21 desktop UI delivery and Phase 20 results remain historical.
Do not treat those results as validation of this extension.

Implementation is complete on `feature/phase21-real-desktop`, based on preprod.
Automated validation and review are recorded below; native Windows and live-broker
acceptance remain separate gates before promotion.

## Scope and decisions

- One active Real session per application user across Kotak and Kite. Matching
  starts attach; another broker/underlying/instrument type requires closing first.
- Broker is a saved shared website/desktop preference, visible only with Real
  access, default Kotak. Change it after confirmed Stop, then start another run.
  Session execution identity is immutable and independent of market-data source.
- Keep brokerage accounts' money separate: funds, capital baselines, orders,
  executions, report/projection identities, operation claims, FIFO and history.
- Reuse central configured credentials. Application users do not gain independent
  brokerage accounts; existing shared-account behavior remains.
- One underlying and one instrument type per session. Desktop supports multiple
  CE/PE strikes and expiries in Paper, Replay, Stepwise and Real.
- Linked tabs and existing native pop-out support another monitor. Both trade one
  session; wallet/full orders/history/global controls live on the primary.
- Kite has normal entry SLs and strategy parity, but no Kotak cancellation repair.
  Manual cancellation/reduction must remain respected after later fills/restart.
- Stop confirms, cancels entry-producing work, closes exposure, verifies no pending
  orders and ends the session. It does not ban later trading.
- Done for day is manually requested and confirmed. Cancel changes nothing. Once
  confirmed, block entries while closing; finish the persistent user/IST-date ban
  after verified closure. The ban covers both brokers, including sequential use.
- Underlying Target/SL uses the selected reference contract's existing direction
  at creation, then closes all currently open contracts of that CE/PE right at
  trigger. Exit side is resolved for each contract. Later positions after trigger
  are excluded. Half/Full rounds separately per contract using existing rules.
- Advanced mixed-direction underlying strategy usage is unsupported for now:
  its simple all-right exit still closes opposing positions. Recommend separate
  exact-contract TargetProfit strategies for differing directions/targets.

## Deferred items

Simultaneous broker sessions; personal credentials/login infrastructure; mixed
underlyings or equity/options in a session; website multiple-strike picker;
global portfolio-profit strategy; advanced mixed-direction underlying strategies;
automatic recreation of externally cancelled Kite protection. No new DB tables,
queues, plugin framework, automatic main/dev merge or deployment.

## Design and interfaces

### Execution boundary and compatibility

A small resolver picks a broker adapter using persisted session execution identity.
Adapters provide authentication/status, account identity, exact instruments,
LIMIT/SL placement/modification/cancellation, reports and order callbacks. Reuse
allocation, freeze splitting, confirmed conversions, emergency exits and FIFO.
Kotak's SDK normalization and repair policy remain broker-specific. Do not infer
execution from selected chart provider. Market remains a marketable LIMIT.

Orders/trades expose neutral broker_order_id and execution_broker plus account,
exchange/product and execution IDs. Old Kotak fields remain readable aliases for
Kotak only. Legacy real records default to Kotak only where evidence establishes
that identity; missing analytical evidence stays unknown. Persist broker metadata
for application/strategy/imported/partial fills. Analysis/CSV/shared history read
stored metadata through the existing allowlist, never broker credentials or polling.

Settings use real_execution_broker = kotak | kite. Session/start and desktop
snapshots expose broker/account, committed state version, funds freshness and
closure/day state. Start, order and strategy actions verify owner and Real access.
Desktop uses verified bearer auth; native WebView never receives broker secrets.

### Books and session ownership

Broker/account/day scope financial records and caches. Refresh only matching
capital baselines. Preserve historical Kotak partitions and initialize new broker
records from coherent reports rather than copying money or rewriting history.
A per-user start lock and conditional active record in existing storage prevent
cross-client/worker double starts. Disconnect/missing engine is not proof of flat.
Restart reconciles the existing book. Release only after confirmed closure,
including unresolved submission/conversion/split work. Settings rejects a different
broker while active. Old records are compatible without bulk migration.

### Kite specifics

Reuse current client/central token/instrument cache/reactor. Resolve tradingsymbol,
exchange, expiry, strike, right, tick and lot from master metadata, not guessed
option names. Use regular MIS/DAY LIMIT and SL; retain application freeze splitting,
not Kite autoslice. Compact deterministic alphanumeric tags are <=20 characters.
ACK means accepted identity, not fill. Cumulative reports/events establish fills;
reconcile duplicates, corrections, callback-before-registration and reconnect.
Keep order observation alive without chart subscriptions. Coalesce account reports.
Writes are paced and never blindly retried after uncertain responses. Reads retain
bounded backoff. Same-account token renewal resumes; changed account identity
cannot silently adopt an existing book. Distinguish available funds/utilized margin/
realized/unrealized P&L. Unknown evidence is unavailable, not zero.

References: https://kite.trade/docs/connect/v3/orders/ ;
https://kite.trade/docs/connect/v3/websocket/ ;
https://kite.trade/docs/connect/v3/exceptions/ ;
https://kite.trade/docs/connect/v3/user/ ;
https://kite.trade/docs/connect/v3/portfolio/ .
Kotak cancellation incident: https://github.com/Kotak-Neo/kotak-neo-python/issues/45 .

### Exact contracts and strategies

Use symbol/expiry/strike/right keys throughout quote/order/position/strategy/
protection/P&L. Primary CE/PE convenience fields remain compatibility only. Validate
exact position before strategy registration; persist scope before activation.
Contract strategies consume only matching ticks. Underlying triggers evaluate once
then allocate exits contract by contract, tracking partial success without repeated
exits. Deduplicate repeated chart contracts. A removed pane does not remove exposed
contracts or their strategies/SLs. Execution uses fresh exact live quotes; historical
preparation/backfill cannot place Real orders. Replay/Stepwise never read future data.

Resume restores position/order/strategy/uncertainty contracts before premium presets.
Loading/missing data retains exposure visibly. More than five required contracts
use additional saved tabs. Preparation failures preserve the original workspace;
cleanup removes only request-owned chart resources, not a shared engine.

### Desktop UI and linked lifecycle

Add Real mode for enabled users, today IST and live clock, no Pause/Step/wallet reset.
Reuse floating order window, chart tickets, strategy/order controls, labels,
guardrails, snapshots and Analysis. Add broker/account status, committed funds,
Trade History Refresh/broker evidence, emergency exits, Stop and Done. Notifications
must not resize charts. Preserve KLine renderer ownership and chart instances.

Create linked screen clones chart configuration with new pane IDs and persisted
session/primary linkage; pop-out/bring-back uses current ownership handoff. Each
screen retains independent contracts/intervals/drawings/indicators/drafts/viewports.
Companions trade exact contracts and focus primary for full book/global controls.
Primary removal promotes earliest remaining linked tab. Companion close stops only
its display streams; all windows closed leaves the backend attachable. Replay and
Stepwise display streams follow one execution clock. Broadcast cursor recovery must
not let one consumer drain another's events. Refresh joins account in-flight work.

### Stop and Done data flow

Fetch current book → show open-contract/quantity/pending-order counts → Cancel
(no changes) or explicit confirm → block entries/cancel entry work → reuse/convert
exits → place only uncovered quantities → reconcile until flat/no pending/uncertain
operations → commit stopped/release active claim. Done additionally commits the
existing user-wide date lock. Timeouts/partial fills remain closing with retry/manual
management. Window close/logout only detach. No simulated flatten path for Real.

## Sprint plan

| Sprint | Deliverable | Status |
|---|---|---|
| 0 | Complete linked spec, decisions/exclusions/design, parity and baseline | Complete |
| 1 | Shared broker boundary and neutral identities; Kotak compatibility | Implemented; automated checks covered |
| 2 | Separate books/metadata and one active Real claim | Implemented; automated checks covered |
| 3 | Kite execution, events, funds/reports and uncertainty | Implemented; automated checks covered |
| 4 | Intended entry protection and strategy parity; Kotak repair isolation | Implemented; automated checks covered |
| 5 | Desktop exact-contract/multiple-strike/resume behavior | Implemented; automated checks covered |
| 6 | Confirmed Real Stop and Done lifecycle | Implemented; automated checks covered |
| 7 | Desktop Real parity and shared broker Settings | Implemented; automated checks covered |
| 8 | Linked tabs/native pop-out/primary promotion | Implemented; automated checks covered |
| 9 | Exhaustive integration, native acceptance and preprod review | Automated checks complete; manual acceptance/review pending |

### Sprint 0

Write this complete handoff and link it at the top of Phase 21, preserving original
edits/history. Inventory website Real parity, document baseline failures and native/
live limitations. Completion: complete decisions/scope/exclusions/interfaces/design/
dataflows/edge cases and sprint gates, plus reproducible baseline results.

### Sprint 1

Wrap Kotak and replace direct selection in ordinary orders, strategies, splits,
conversions, refresh, protection, emergency exits, engine start/stop. Neutral IDs
and report accessors retain legacy aliases. Test broker-independent routing and
focused Kotak regressions. High complexity: distributed assumptions; no framework.

### Sprint 2

Broker/account-scoped wallet/capital/projection/cache/FIFO/operation identity,
metadata persistence and analysis/export exposure. Conditional single-active start,
Settings fence and restart reconciliation. Test collisions, sequential switching,
concurrent cross-client starts, old records and refresh isolation. Medium complexity.

### Sprint 3

Implement Kite MIS LIMIT/SL lifecycle, normalization, independent order feed,
account verification and paced non-retrying writes. Test partial/rejected/duplicate/
out-of-order fills, lost ACK/tag adoption, reconnect, token renewal/account swap,
rate/modification limits and coherent funds. High complexity: actual report semantics.

### Sprint 4

Initial and incremental entry protection reuse allocation/claims. Respect manual
removals; no Kite external-cancel recreation. Preserve Kotak exclusions/delays/live
switch. All existing strategies route adapters. Test shared exits, late partial fills,
split/conversion links, restart/manual reductions and both broker parity. Medium/high.

### Sprint 5

Exact validation and tick routing; multiple strikes/expiry, subscriptions, hidden
exposure and resume-first contracts across four desktop modes. Underlying all-right
exit fan-out with per-contract Half/Full and failure state. Test two CE+PE, different
expiry, late/missing/stale quotes, no lookahead, >5 restored contracts. Medium.

### Sprint 6

Shared confirmed-close service, counts/confirmation, cancel-noop, entries fence,
protective exit reuse, per-contract retries, Stop claim release versus Done date ban.
Test fill/cancel races, flat with pending entries, broker outage, persistence failure,
duplicate requests/restart and no switching during uncertainty. Medium.

### Sprint 7

Shared saved preference and disabled-active selector; desktop bearer Real adapters,
mode/live clock, status/funds/broker evidence/refresh, full website parity, native
routes/wakeups and recording/Analysis continuity. Test auth/owner/access revocation,
stale responses, no Real practice reset/step and failed-refresh snapshot retention.
Medium: reuse existing controls. Do not enable before Sprint 6 closure is functional.

### Sprint 8

Persist linked screen/primary roles, clone panes/pop-out, independent drafts and
charts, shared broadcast state and replay followers, promotion and owned cleanup.
Test both-screen fills, one execution per clock step, reconnect/overflow, close-all
reattach, primary removal, failed handoff, bring-back and Analysis continuity.
Low/medium: existing tab/window/event facilities are the foundation.

### Sprint 9

Focused then full backend DynamoDB Local, desktop Vitest, website/shared tests,
both tsc/builds, isolated desktop build without frontend dependencies, Rust offline,
Windows installer CI, synthetic built-app workflows and Phase 20/21 regressions.
Native acceptance: two monitors, DPI/focus/wheel/drag/auth/pop-out/events. Live orders
are never submitted by synthetic automation. Record actual counts/commands/artifacts,
failures/remaining gates/commit/PR. Manual promotion only after acceptance.

## Parity inventory and verification matrix

| Website capability | Desktop delivery |
|---|---|
| Real access / broker connection / saved broker preference | Sprint 7 |
| Funds, capital/risk sizing, positions and P&L | Sprints 2/5/7 |
| Marketable LIMIT, Limit, Target, position SL / attached SL | Sprints 1/3/4/7 |
| Edit/cancel/split/convert/missing SL | Sprints 1/3/4/7 |
| All current strategies and settings | Sprints 4/5/7 |
| Trade History Refresh / broker orders | Sprints 2/3/7 |
| Guardrails / emergency exits / Stop / Done | Sprints 1/6/7 |
| Labels, recording/snapshots, Analysis / sharing / CSV | Sprints 2/7/9 |
| Real resume / reconnect / late events | Sprints 2/3/5/7/9 |

| Area | Required scenarios |
|---|---|
| Books | Kotak-close-Kite-close-Kotak, colliding IDs/accounts, separate money/capital/history, legacy reads |
| Starts | duplicate clicks/cross-client-worker races, changed type/symbol, failed prepare/start, restart unresolved book |
| Orders | ACK/event race, partial/full/rejected fills, corrections/duplicates, external edit/cancel, lost ACK, split/conversion fill race |
| Protection | multiple entries/two CE/expiry, later fills, intentional cancel/reduction, missing SL, manual switch/restart, no Kite cancellation repair |
| Strategies | each strategy both brokers, exact scope, Half/Full rounding, underlying all-right including pre-trigger additions, partial failure |
| Quotes | stale/missing/late first tick, duplicate/hidden contracts, different expiry, historical no-lookahead/no Real execution |
| Resume | open-order-only, positions without panes, >5 contracts, failed broker snapshot/history, preset must not replace exposure |
| Closure | cancel-noop, pending entry/no position, changed book after confirm, partial exits, outage/persistence error, repeat/restart, global day ban |
| Windows | independent drafts, shared fills, one clock, promotion, pop-out/return/failure, close/reopen, auth/account/server reset, gaps/overflow |
| UI/history | narrow/DPI/focus/wheel/drag/keyboards, metadata import/CSV/labels/snapshots/sharing, KLine/Analysis retention |

## Implementation record

2026-10-09/10: Sprint 0 specification was written before implementation. Sprints
1–8 are implemented together on `feature/phase21-real-desktop`; review targets
**preprod**. Delivery: ready-for-review [PR #632](https://github.com/prattyush/TradeMatangi/pull/632),
implementation commit `8a9528f`. Earlier Phase 20/21 results are not counted as
this extension's tests.

Delivered behavior: neutral broker execution identities, Kite MIS LIMIT/SL adapter
with order events and non-retrying uncertain writes, account-scoped books/funds,
durable single-Real-session claims and recovery, normal Kite entry protection,
exact/all-right strategies, desktop Real controls and verified close lifecycle,
multiple contracts, linked tabs using the existing native pop-out, primary promotion,
shared Settings, recording and Analysis metadata.

Design details established during implementation:
- Bind account identity to the authenticated client; reject a different account
  before refreshing an existing book. Central credentials remain central.
- Renew the preparation claim during slow startup; bind before starting execution.
  An incomplete/uncertain startup retains its claim and requires inspection/closure.
- Fence engine writes when ownership renewal expires. A recovered dead session
  can supervise explicit closure without starting a replacement market engine.
- Stop emits final state before disposing streams, releases ownership only after
  confirmed closure, and preserves history. Done persists/broadcasts the date lock.
- Previous-day recovery verifies current broker exposure without rewriting archived
  executions or recomputing archived P&L from today's reports. Nonflat previous-day
  exposure requires closure at the broker before application closure can finish.
- Kite margin `debits` is already the total; do not sum its components again.
  Day-opening capital is frozen by broker/account/date using reported opening funds.
- Kite event audits are coalesced and event-driven. Idle sessions do not poll books.
  External Kite protection cancellation is respected; no Kotak repair is applied.

Automated verification (local/synthetic; no live orders):
- Backend full suite: **1,966 passed, 4 failed** (71.71 seconds). The four environment
  baseline failures were reproduced from an untouched preprod archive: both options
  startup validation tests and both equity OHLC pattern-logger tests. Missing local
  ICICI configuration/fixture state prevents their expected responses.
- Account-isolation and adapter regression: 91 passed, including 21 extension tests.
- Desktop Vitest: 184 passed across 32 files.
- Website Node tests: 43 passed. AI-helper pytest: 303 passed.
- Both TypeScript checks and production Vite builds passed. Desktop clean-copy
  TypeScript/build passed with frontend source present but **no frontend dependencies**.
- Native Rust offline tests: 16 passed. No Rust implementation changes were needed.
- Original desktop built-app browser regression passed. Supplemental Real,
  Stepwise, Replay and Paper workflows passed, including linked creation, primary
  controls, detach without stopping, and Real Done cancel/confirm, with no page errors.
  Both harnesses use synthetic HTTP/SSE and no broker calls.
- Changed Python files pass Ruff F821/F822/F823; whitespace check passes.

Reproducible commands: Python environment `/home/pratt/venvs/tradematangi/bin/python`
with `-m pytest backend/tests -q` and `-m pytest aihelper/tests -q`; desktop
`node node_modules/vitest/vitest.mjs run`; website
`node --test src/*.test.mjs src/services/*.test.mjs`; both clients
`node node_modules/typescript/bin/tsc --noEmit` and
`node node_modules/vite/bin/vite.js build`; Rust `cargo test --offline`.
Browser scripts: `scripts/phase21-desktop-check.mjs` and
`scripts/phase21-real-linked-check.mjs`, with `PLAYWRIGHT_MODULE` pointing to an
installed Playwright module and `CHROME_BIN` to Chrome. Ignored local logs and
screenshots reside under `.cache/phase21-real-validation/`.

Remaining acceptance gates: reviewed preprod PR; Windows installer CI/native build;
two physical monitors, DPI, focus, wheel/drag, authentication, pop-out/bring-back and
reconnect; configured Kotak/Kite login and deliberate small live-order acceptance
for fills, partial fills, SLs, edits/cancellation, refresh and Stop/Done. Automated
mocks do not establish venue behavior or native multi-monitor correctness.
No credentials were changed, no live orders placed, and no deployment/main/dev
promotion is included. Deferred scope remains as listed above.

### PR #632 self-review — 2026-10-10

Reviewed execution routing, credential renewal, account fencing, durable session
ownership/recovery, unknown submissions, protection allocation, exact contracts,
Stop/Done closure and linked desktop state. Found and corrected:

1. Kite token renewal re-entered client resolution while recreating its existing
   order socket. Pass the resolved client to feed startup to avoid recursion.
2. After an earlier Kite SL was cancelled, later partial entry fills could reuse
   its protection ID and skip new coverage. Use cumulative allocated coverage for
   IDs and retain the entry's effective group even when it had no explicit group.
   Previously cancelled coverage remains intentionally cancelled.
3. An underlying strategy's fallback reference could select an open contract in a
   different expiry but validate the original expiry. Validate the selected expiry.
4. Refresh-only account checks were insufficient for operations immediately after
   a Kotak account change. The shared resolver checks the session's account before
   routing operations; callback cleanup can still use its explicit expired-owner path.
   Closure reports account failures visibly and remains pending rather than silently
   losing its supervisor before a retry.
5. Done's monitor did not retry failed exits while positions remained locally open.
   It now refreshes each pass, retries entry cancellations/exits, and requires a
   later verified snapshot before final completion. A failed cancellation does not
   prevent attempts to cancel other entries. The date barrier remains active.
6. Website Stop returned success for a missing runtime, including a saved Real book
   after restart. Saved Real books now use the same owned closure recovery as desktop;
   neutral summaries can reconstruct read-only evidence and stop cannot silently
   claim broker-confirmed closure from absence in memory.

Regression checks cover token-renewal reconnect, replacement-account rejection,
cancelled-SL/new-partial allocation and no recreation, cross-expiry reference,
Done retry after broker outage with subsequent verification, and website recovery.
Focused regression on the final changes: **363 passed**. The full backend review
run passed **1,972 tests**, with the same four reproduced baseline failures (74.14
seconds). The final closure-error visibility change was also covered by the focused
run; no client/native code changed during this review.
Windows/native and live-broker acceptance gates remain open; this review does not
claim venue or physical multi-monitor acceptance. Changes remain in PR #632 targeting
preprod, with no merge or deployment.


### Acceptance sequencing clarification — 2026-10-10

The user confirms the desktop app is built and opens successfully. PR #632 is
ready for code review and merge into **preprod**. Backend deployment requires that
merge, so deployed runtime, physical multi-monitor and configured Kotak/Kite
live-trading acceptance are **post-merge preprod steps**, not prerequisites for
merging this PR. Sprint 9 remains open for those acceptance results and any fixes.
The sequence is review → preprod merge → backend deployment → runtime acceptance
and fixes on preprod-targeted PRs → manual main/dev promotion after acceptance.
Opening the desktop app does not establish multi-monitor or live-order acceptance.

### Desktop toolbar and upstream UI sync — 2026-10-10

Follow-up preprod PR converts toolbar actions to SVG icon buttons with hover/focus
labels and unchanged accessible action names. Order stays textual; toolbar sequence,
action handlers and disabled states are retained. Screen names remain readable tabs;
the wallet uses an icon while keeping its amount visible. Snapshot on/off has a
pressed-state highlight and matching hover label.

`0e56139464e6f23d46ba0ed6654d692c44f19a37` was present in main (its constituent
changes are also in dev), but absent from preprod after PR #632. The follow-up
branch merges that main commit, including chart draft-price picking, edit LTP/chart
picking, stable popup close hitboxes and Stats layout updates. Merge resolution
retains Real mode, its live charts/settings and linked-screen primary controls.
The referenced commit contains price-picking changes, not a new date-picker widget.

Verification: desktop TypeScript, 184 Vitest tests, both production builds and
website TypeScript pass. Built-app desktop price-picking/Stepwise/Replay/Paper
regressions pass on rerun (one initial edit-price assertion failed during concurrent
browser runs); Real/linked regressions pass across four modes, including new icon,
hover tooltip and snapshot pressed-state assertions. No backend changes or live
orders are involved. Merge target remains preprod.

### Linked Replay candle latency investigation — 2026-10-10

Reported: linked underlying/PE Replay candles can lag by 2–3 minutes or more after
PE trading and Fibonacci creation/deletion, while order exits arrive immediately.
Two delivery weaknesses were found: native Replay updates depended solely on a
500ms renderer poll (unlike immediate committed trading wakeups), and the restored
linked-follower path could create its Replay without starting its native stream.
The native Replay renderer effect now subscribes before ensuring its stream starts,
including followers, and drains on Replay-specific native notifications scoped to
that stream's owning window. Reads are coalesced with the existing drain; the timer
remains a recovery fallback. Pop-out readiness is part of the effect lifecycle.
Trading notifications and drawing behavior remain independent of Replay delivery.
Chart incremental diagnostics now include contract identity to distinguish CE/PE.

Verification: 184 desktop tests, 17 Rust offline tests, 7 backend Replay tests,
desktop TypeScript and production build passed. Regular synthetic browser checks
passed in Real, Stepwise, Replay and Paper. A native-IPC browser probe suppresses
500ms renderer polling, creates a linked underlying/PE screen, applies a PE position,
creates/deletes Fibonacci and checks three subsequent PE candle updates via native
notifications within two seconds each. The probe passes with no page errors.
Run it with `NATIVE_REPLAY_CHECK=1` alongside the existing Playwright/Chrome variables
for `scripts/phase21-real-linked-check.mjs`. This checks the delivery mechanism;
it does not establish the exact cause of the user's physical Windows timing.
After preprod review/merge, rebuild/reinstall the Windows exe and retest the reported
workflow, including separate-window focus and the original Replay speed. No backend
code changed. Native Windows acceptance remains open.
