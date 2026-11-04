# Phase 23 implementation plan

Requirements and design: [spec-phase23.md](spec-phase23.md). Work is on `dev` only, one branch and PR per sprint (`feature/phase23-sN-<name>` off `origin/dev`, PR into `dev`). **Each sprint's PR updates `spec-phase23.md` (status, decisions, results) and this document's sprint table.** Porting to `preprod`/`main` is a separate, reviewed step (`git cherry-pick -x`, then sync back into `dev`).

## Decisions and boundaries

- Behavior answers are yes/no per round trip; stored as rows only for "yes" in a new `BehaviorMarks` table. Existing `TradeLabels` writes and the real-session label projection (`real_broker_state.encode_label_fields`) are not modified.
- Questions live in `BehaviorQuestions` (per user), have a kind (`entry`/`exit`) that never changes (archive and re-add to change it), and are archived/unarchived, never deleted. `BehaviorMarks` is created lazily; session cascade delete tolerates its absence.
- New analysis-proxy routes are GET/POST only (the desktop Rust command supports no PUT/PATCH) and must be added to all three allowlists: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`. Desktop in-session routes go under `trading/...` (no allowlist).
- Label Trades one-by-one auto-saves only trades the user edited; untouched trades are never written.
- Out of scope in v1: swing portfolios, TradeHistory "Behavior" column, price-path habit stats (time in profit, best price reached, automatic "profit then loss" detection — marked manually instead). Habits statistics (profit/loss %, capital %, bars, entries/exits, period comparison) are in scope — spec §10.
- Habits are computed from a **trade ledger** (`GET /api/behavior/habit-ledger`, one row per closed own trade, built with `load_cycles` so filters and real-alias de-duplication match the Stats overview); all statistics are computed in TypeScript from it. Marks join to cycles on `cycle["index"]` (intraday); unmatched marks are reported, not dropped.
- Desktop real labeling reuses `performance_service.load_session_cycles` + `trade_label_service.cycle_round_trips` for slots and the existing `save_labels` broker-revision handling.

## Sprints and acceptance

| Sprint | Work | Acceptance | Status |
|---|---|---|---|
| 0 | Spec + implementation plan docs; CLAUDE.md phase row | Every requirement maps to a sprint and verification scenario | PR #751 |
| 1 | Backend: tables, behavior service/router, `analysis_label_view` setting, session cleanup + ddb maintenance, setup script | pytest: CRUD/archive/restore, validation, ownership, mark idempotency, stats pagination, cascade delete, settings default | Implemented; `tests/test_behavior.py` (27 tests) |
| 2 | Desktop transport (3 allowlists), `desktop_trading` behavior routes, desktop real label state, capability flag | `cargo test`, vitest allowlist, pytest desktop real state/save; indices match website for same real session | Merged (PR #753); `tests/test_desktop_behavior.py` (10 tests), Rust `behavior_routes_are_exact_and_only_post_or_get`, vitest allowlist test. Manual: live linked real session. Full backend suite 2840 passed / 3 baseline swing failures; vitest 312 passed; `cargo test` 23 passed |
| 3 | Label Trades one-by-one core: split component, Prev/Next, strip, auto-save, setting plumbing, marker filtering by round trip | vitest helper/autosave tests; updated Playwright scripts; untouched trades never saved | Merged #754 (spec §6); `labeling.test.ts` (11), `website-label-trades-check.mjs`, extended `desktop-analysis-workflows.mjs`; vitest 323 |
| 4 | Charts: `focusTime`, strike-chart marker text (Lightweight + KLine), stacked panes, `labeling.css`, webapp phone layout | Markers on Underlying and strike chart for the viewed trade; screenshots at 1440/900/390 px; webapp phone spec | Merged #755 (spec §7); website check with both renderers incl. phone layout, `webapp/tests/label-trades.spec.ts`, whole webapp suite 22 pass, vitest 324 |
| 5 | Behavior manager, checklist, Analysis marks autosave, manager in Settings (website + desktop) and Label Trades header | Add/edit/archive/unarchive on all clients; archived keeps past marks muted | Merged #756 (spec §8); `behavior.test.ts` (9), website check both renderers, desktop workflow script, webapp Settings test; vitest 333, webapp 23 |
| 6 | Live labeling in website popups, stepwise popup, desktop popup (incl. real) | Replay/paper/real on website and desktop; stepwise on website; marks visible later in Analysis | Merged #757 (spec §9); fixes website round-trip numbering (open-time, like the backend); `roundTripIndexer.test.ts` (7), `behavior.test.ts` +1, `website-live-label-check.mjs`, `desktop-live-label-check.mjs`; vitest 341, webapp 23. Manual: live sessions |
| 7a | Habits ledger backend: `habit_ledger_service.py` (features `pnl_pct`, `capital_pct`, `risk_pct`, `bars`, entries/exits; join on cycle `index` with real-alias de-duplication; coverage and unmatched marks) and `GET /api/behavior/habit-ledger` (filters via `performance.filters()`, 20k-row cap); website `getHabitLedger`; desktop adapter + three allowlists (`desktop_analysis.py`, `analysisApi.ts`, `lib.rs`) | pytest: capital/bars derivation and fallbacks, join (intraday + alias dedupe), unmatched marks, open cycles excluded, own sessions only, filters honoured, **ledger totals reconcile with `report()["summary"]`**, desktop proxy; vitest allowlist/adapter; `cargo test` | In progress |
| 7b | Habits stats engine + scorecard: `shared/analysis/habits/habitStats.ts` (mean/median helpers, per-habit summaries, baseline, shares, verdicts), `Habits` tab in `PerformanceDashboard.tsx` (hidden for swing), controls (kind, archived, Mean/Median, %/₹), sortable scorecard, diverging net-% chart, coverage line, "Manage questions" | vitest on hand-computed fixtures for every metric incl. nulls; browser check (website both renderers + desktop) from a multi-day ledger fixture; phone layout | Not started |
| 7c | Habits across days: `MultiLineChart`, metric selector (occurrences, net/loss/profit %, capital %, bars, ≤1-bar share, entries/exits), legend, 5-day rolling mean, click-through; period comparison (last N vs prior N / custom) with improving/same/worse flags; days with vs without | vitest: zero-fill vs gaps, rolling mean, period split, favourable rules; browser check: metrics, toggles, compare, drill into the cycle drawer | Not started |
| 7d | Habits deep dive + polish: tiles, buckets (bars held, capital %, time of day, weekday), scatter, sortable trade list → cycle drawer; keyboard/aria; phone polish; stats glossary in the spec | vitest buckets/tercile edges/scatter data; browser check at 1440/900/390; whole webapp suite | Not started |
| 8 | Hardening and close-out: full backend/frontend/windowsapp/webapp/Rust suites, code review of Sprints 1–7, baseline comparison, **Habits reconciliation (ledger totals = Stats summary for identical filters) and a ledger performance check on a large seeded history (cache or restrict `load_cycles` to sessions with marks if over budget)**, manual acceptance checklist (live replay/paper/real labeling incl. CE+PE together on the website, real linked-day desktop labeling, Windows build with the new allowlist routes, Habits definitions read against real data), preprod port assessment | All suites pass or only listed baseline failures; reconciliation and performance checks pass; manual list handed to user; CLAUDE.md row set to Complete | Not started |

Dependencies: 1 → 2, 5, 7a; 3 → 4; 5 → 6; 7a → 7b → 7c → 7d.

## Verification matrix

- Session types: replay, paper, real, stepwise (labeling), swing excluded.
- Clients: website (Lightweight and KLine Analysis renderers), webapp (phone viewport), desktop.
- Labeling: entry-only, exit-only, both; partial save then resume; archived question with existing marks; CE and PE open at the same time (round-trip index consistency).
- Analysis: Prev/Next boundaries (first/last), single trade, multiple sessions in a group, read-only shared history, save failure + Retry, navigating away while saving, All-together mode parity with the old behavior.
- Stats / Habits: days with zero marks, archived questions, filters (symbol, dates, session type), ledger totals vs the Stats summary, unmatched marks, real-day aliases, missing capital %/bars, low-sample habits, improving/worsening multi-day series, large data (row cap).
- Backend: ownership/shared-read, idempotent marks, cascade delete, maintenance inventory.
- Regression: existing label flows (button panel, stepwise popup, desktop popup), `scripts/desktop-analysis-workflows.mjs`, webapp PWA/fullscreen specs.

## Verification commands

```bash
cd backend && source ~/venvs/tradematangi/bin/activate && python -m pytest tests/ -v
cd frontend && node node_modules/typescript/bin/tsc --noEmit
cd windowsapp && npm test
cd windowsapp/src-tauri && cargo test
```

Manual only: native Windows build with the new Rust allowlist; desktop real labeling against a live linked real session before any preprod port.
