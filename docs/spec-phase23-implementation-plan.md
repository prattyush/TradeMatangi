# Phase 23 implementation plan

Requirements and design: [spec-phase23.md](spec-phase23.md). Work is on `dev` only, one branch and PR per sprint (`feature/phase23-sN-<name>` off `origin/dev`, PR into `dev`). **Each sprint's PR updates `spec-phase23.md` (status, decisions, results) and this document's sprint table.** Porting to `preprod`/`main` is a separate, reviewed step (`git cherry-pick -x`, then sync back into `dev`).

## Decisions and boundaries

- Behavior answers are yes/no per round trip; stored as rows only for "yes" in a new `BehaviorMarks` table. Existing `TradeLabels` writes and the real-session label projection (`real_broker_state.encode_label_fields`) are not modified.
- Questions live in `BehaviorQuestions` (per user), have a kind (`entry`/`exit`), and are archived/unarchived, never deleted.
- New analysis-proxy routes are GET/POST only (the desktop Rust command supports no PUT/PATCH) and must be added to all three allowlists: `backend/app/routers/desktop_analysis.py`, `windowsapp/src/analysisApi.ts`, `windowsapp/src-tauri/src/lib.rs`. Desktop in-session routes go under `trading/...` (no allowlist).
- Label Trades one-by-one auto-saves only trades the user edited; untouched trades are never written.
- Out of scope in v1: swing portfolios, TradeHistory "Behavior" column, per-trade-rate (percentage) stats.
- Desktop real labeling reuses `performance_service.load_session_cycles` + `trade_label_service.cycle_round_trips` for slots and the existing `save_labels` broker-revision handling.

## Sprints and acceptance

| Sprint | Work | Acceptance | Status |
|---|---|---|---|
| 0 | Spec + implementation plan docs; CLAUDE.md phase row | Every requirement maps to a sprint and verification scenario | In progress |
| 1 | Backend: tables, behavior service/router, `analysis_label_view` setting, session cleanup + ddb maintenance, setup script | pytest: CRUD/archive/restore, validation, ownership, mark idempotency, stats pagination, cascade delete, settings default | Not started |
| 2 | Desktop transport (3 allowlists), `desktop_trading` behavior routes, desktop real label state, capability flag | `cargo test`, vitest allowlist, pytest desktop real state/save; indices match website for same real session | Not started |
| 3 | Label Trades one-by-one core: split component, Prev/Next, strip, auto-save, setting plumbing, marker filtering by round trip | vitest helper/autosave tests; updated Playwright scripts; untouched trades never saved | Not started |
| 4 | Charts: `focusTime`, strike-chart marker text (Lightweight + KLine), stacked panes, `labeling.css`, webapp phone layout | Markers on Underlying and strike chart for the viewed trade; screenshots at 1440/900/390 px; webapp phone spec | Not started |
| 5 | Behavior manager, checklist, Analysis marks autosave, manager in Settings (website + desktop) and Label Trades header | Add/edit/archive/unarchive on all clients; archived keeps past marks muted | Not started |
| 6 | Live labeling in website popups, stepwise popup, desktop popup (incl. real) | Replay/paper/real on website and desktop; stepwise on website; marks visible later in Analysis | Not started |
| 7 | Habits view: trend chart, summary, drill-down, "Manage questions" | Zero-filled multi-day chart; website and desktop agree | Not started |
| 8 | Hardening: full suites, review, baseline comparison, manual checklist, preprod port assessment | All suites pass or only listed baseline failures; CLAUDE.md row Complete | Not started |

Dependencies: 1 → 2, 5, 7; 3 → 4; 5 → 6, 7.

## Verification matrix

- Session types: replay, paper, real, stepwise (labeling), swing excluded.
- Clients: website (Lightweight and KLine Analysis renderers), webapp (phone viewport), desktop.
- Labeling: entry-only, exit-only, both; partial save then resume; archived question with existing marks; CE and PE open at the same time (round-trip index consistency).
- Analysis: Prev/Next boundaries (first/last), single trade, multiple sessions in a group, read-only shared history, save failure + Retry, navigating away while saving, All-together mode parity with the old behavior.
- Stats: days with zero marks, archived questions, filters (symbol, dates, session type), large data (pagination).
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
