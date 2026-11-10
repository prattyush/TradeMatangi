# Phase 24 — Android phone app — sprint plan

Requirements: `docs/spec-phase24.md` ("Android phone app"). Architecture and screen design: `docs/architecture-phone.md`. Real-phone checks: `docs/phone-manual-acceptance.md`.
Branch: `feat/android-phone-app` (off `dev`), **one PR into `dev`** with a merge commit. Sprints are commits on that branch; every sprint updates these docs in the same commit.

## Decisions (2026-11-10)
- **Capacitor around a new phone-first `mobile/` entry** (option A), not a Tauri Android build of the desktop app (option D). Reasons are in `docs/architecture-phone.md`.
- **Landscape phone UI designed for the phone**, not the website layout.
- **Everything through the server.** Default `https://tradematangi.co.in`, editable in the app; the app tolerates a server on any branch (capability probe, per-feature "not available" states).
- **Google sign-in** with the existing Web client ID (native Credential Manager); email and password as the other way in. Optional app lock.
- **Read and review in v1**; the only writes are labels and behavior marks. No orders from the phone.
- The server-branch situation does **not** change the design. Promoting `preprod` to `main` and `dev` to `preprod` first is optional (it would only simplify testing) and stays the user's release decision.

## Status

| Sprint | Scope | Status |
|---|---|---|
| S0 | Requirements, plan, architecture doc; spikes (toolchain, YouTube embed, Google token, chart performance) | In progress: docs written; toolchain and device spikes pending |
| S1 | `mobile/` shell, auth core (password), server URL, capabilities, offline/error states, CI | Not started |
| S2 | Google sign-in, first-time account name, optional app lock, setup doc | Not started |
| S3 | Sessions list and session detail (Chart / Trades / Orders / Videos row) | Not started |
| S4 | One-at-a-time trade labeling (landscape) | Not started |
| S5 | Stats and Habits | Not started |
| S6 | Videos tab and embedded player (with fallback) | Not started |
| S7 | Browse (read-only) | Not started |
| S8 | Positions (swing and day, read-only) | Not started |
| S9 | Hardening, release signing, acceptance, final docs, PR into `dev` | Not started |

## Sprint scope

- **S0.** Docs above. Spikes, each written up here when done: (a) WSL toolchain: JDK, Android SDK command-line tools on the Linux filesystem, a Gradle build of a hello Capacitor app, install through Windows `adb.exe`; (b) **YouTube embed matrix** on a real phone: direct iframe with `server.hostname` set to a real https name, the same through a relay page on the server (`https://tradematangi.co.in/embed.html?v=<id>`), and the Open-in-YouTube intent; also fullscreen and landscape behavior; (c) native Google sign-in returns a token that `/api/auth/desktop/google-token` accepts; (d) KLine chart performance on the phone. Only the hello shell may be merged from the spikes.
- **S1.** `mobile/` scaffold and Capacitor project; theme tokens; NavRail, screen stack, back button; transport, token store, single-flight refresh; server config; email and password login with `device_name`; logout; capabilities probe; offline and error states; Settings stub; GitHub Actions `android-phone.yml`; `mobile/README.md`; constraints docs. Tests: refresh single-flight, one retry on 401, no token in logs, https enforcement; landscape Playwright login with a mocked API.
- **S2.** Native Google sign-in (Web client ID) to `/api/auth/desktop/google-token`; prompt for `account_name` for a first-time user; error mapping (including Credential Manager 28444); optional BiometricPrompt app lock; `docs/phone-google-signin-setup.md`.
- **S3.** Sessions master-detail; filters sheet; grouping; detail pane with the session chart and trade markers; label progress; date-bounded fetches.
- **S4.** Labeling: shared saver and model, tag pickers, behavior rows, unlabeled filter, notes sheet, keyboard handling, save-state footer, leave-guard.
- **S5.** Spike (reuse `PerformanceDashboard` with a phone layer, or recompose from `performance.ts` and `habits/*`), then Stats pager, KPI row, filter sheet, Habits scorecard and deep-dive; fallback when the behavior endpoints are missing.
- **S6.** Videos list and player with chapters using the S0 decision; private-video note; add and remove link; Open in YouTube; keep-screen-on while playing. If S0 shows a relay page is needed, add `frontend/public/embed.html` (static) and note that the server branch must include it.
- **S7.** Browse: symbol picker, date sheet, interval chips, Spot / CE / PE pickers from `option-metadata`, `historical/pages` with paging, read-only `KLineChart` with indicators (including VOL), crosshair read-out.
- **S8.** Decide between the existing positions endpoints and a small passive read endpoint (both have attach side effects today); then the Swing and Day columns, foreground-only polling, stale handling, Real gating by capability.
- **S9.** Back-stack audit, low-end performance pass, accessibility pass, R8 and signing check, diagnostics, final docs, merge `origin/dev`, full test runs, open the PR.

Later (not in this PR; the design leaves room): alerts (device-token table, registration endpoint, FCM sender on the existing event sources, deep links), swing trading actions (biometric confirm, guardrails on the server), exit scenarios, setups deep-dive.

## Your actions (outside the code)
1. **Google Cloud:** create an OAuth client of type *Android* with package `in.co.tradematangi.phone` and the SHA-1 of the debug keystore (the release keystore SHA-1 later); if the consent screen is in Testing, add your Google account as a test user. Changes can take up to a few hours to apply. Exact steps arrive in S2 (`docs/phone-google-signin-setup.md`).
2. **Server:** confirm `DESKTOP_JWT_SECRET` is set on the EC2 host (the repository default would let anyone forge a token).
3. **Windows:** install the Android platform-tools (`adb`) and enable USB debugging on the phone, or plan to install the APK from the CI artifact.
4. **Phone:** note the model / screen size so the layouts are checked on it.

## Spike results
(To be filled in as each spike finishes.)

## Risks
- Embedded YouTube can fail in a WebView (error 153) when the referrer or origin is missing. Mitigation: the S0 matrix; a relay page on the server's own https origin; Open in YouTube always visible.
- Google sign-in setup errors (28444, wrong SHA-1, consent-screen test users, propagation delay). Mitigation: a step-by-step guide; debug and release SHA-1 both registered.
- A server on another branch lacks endpoints. Mitigation: capability probe, per-feature 404 / 403 handling, About screen.
- Positions endpoints attach runtimes on the server. Mitigation: decided in S8; passive endpoint if needed.
- Gradle builds on `/mnt/d` can be slow or break on symlinks. Mitigation: SDK and Gradle caches on the Linux filesystem; CI is the reliable build.
- KLine bundle weight on low-end phones. Mitigation: lazy loading and a measured budget.
- Shared-code edits could touch real-trading screens. Mitigation: additive props with unchanged defaults; website and desktop suites run before the PR.
