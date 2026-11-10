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
| S0 | Requirements, plan, architecture doc; spikes (toolchain, YouTube embed, Google token, chart performance) | Docs written; toolchain and embed spikes done; Google token spike waits for the Android OAuth client; chart performance is measured with the real chart in S3 |
| S1 | `mobile/` shell, auth core (password), server URL, capabilities, offline/error states, CI | Built on the branch: 30 unit tests, 17 landscape UI tests (4 sizes), debug and release (R8) APKs build locally; CI workflow written, not yet run on GitHub; not yet installed on a phone |
| S2 | Google sign-in, first-time account name, optional app lock, setup doc | Not started |
| S3 | Sessions list and session detail (Chart / Trades / Orders / Videos) | Built on the branch; first phone test (2026-11-10) found it working; feedback applied: the list hides once a day is chosen (Days button, Sessions tab, Back), one control row with a view menu replaces the tab row and carries Underlying / Option and a strike menu so the chart gets the height, maximize fixed (one chart, full screen, Back restores), chart details only while touching (setting in More). 37 unit and 45 landscape UI tests |
| S3b | Snapshots, Compare, day journey, execution details (the rest of Analysis) | Not started |
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
- **S3.** Sessions master-detail; filters sheet; grouping; detail pane with the session chart and trade markers; date-bounded fetches. The list shows P&L and trade counts; the per-day label progress (`4/6`) needs a label fetch per day, so it arrives with labeling in S4. Swing days show Trades and Videos only for now; the swing review screens come with Stats (S5).
- **S3b.** The rest of the Analysis section that the website session card offers, as phone screens inside the session view menu: **Snapshots** (the captured chart at each order event, a searchable event list on the left and the snapshot chart on the right, underlying and the option contract; read-only on a shared session, with delete for the owner), **Compare** (trades against pattern annotations, only when a saved pattern chart exists for that day), the **Day journey** chart (cumulative P&L through the day) and **execution details** (tap a trade for its broker order and fees). Reuses `api.getSnapshots`, `getSnapshotCandle`, `patternGetChartByDate` and the shared snapshot and comparison charts; the viewers get phone layouts, not the website's fixed-width columns.
- **S4.** Labeling: shared saver and model, tag pickers, behavior rows, unlabeled filter, notes sheet, keyboard handling, save-state footer, leave-guard.
- **S5.** Spike (reuse `PerformanceDashboard` with a phone layer, or recompose from `performance.ts` and `habits/*`), then Stats pager, KPI row, filter sheet, Habits scorecard and deep-dive; fallback when the behavior endpoints are missing.
- **S6.** Videos list and player with chapters using the S0 decision; private-video note; add and remove link; Open in YouTube; keep-screen-on while playing. The S0 spike showed the production iframe plays from the domain origin, so no relay page is needed.
- **S7.** Browse: symbol picker, date sheet, interval chips, Spot / CE / PE pickers from `option-metadata`, `historical/pages` with paging, read-only `KLineChart` with indicators (including VOL), crosshair read-out.
- **S8.** Decide between the existing positions endpoints and a small passive read endpoint (both have attach side effects today); then the Swing and Day columns, foreground-only polling, stale handling, Real gating by capability.
- **S9.** Back-stack audit, low-end performance pass, accessibility pass, R8 and signing check, diagnostics, final docs, merge `origin/dev`, full test runs, open the PR.

Later (not in this PR; the design leaves room): alerts (device-token table, registration endpoint, FCM sender on the existing event sources, deep links), swing trading actions (biometric confirm, guardrails on the server), exit scenarios, setups deep-dive.

## Your actions (outside the code)
1. **Google Cloud:** create an OAuth client of type *Android* with package `in.co.tradematangi.phone` and the SHA-1 of the debug keystore (the release keystore SHA-1 later); if the consent screen is in Testing, add your Google account as a test user. Changes can take up to a few hours to apply. Exact steps arrive in S2 (`docs/phone-google-signin-setup.md`).
2. **Server:** confirm `DESKTOP_JWT_SECRET` is set on the EC2 host (the repository default would let anyone forge a token).
3. **Embed spike:** copy `D:\TradeMatangi-spike\SpikeEmbed-localhost.apk` and `SpikeEmbed-domain.apk` to the phone (USB file copy), allow installing unknown apps, open each, rotate to landscape, and try the four buttons. Report, per app, which variant plays, which shows an error (and the code). Both can stay installed side by side.
3b. **Windows (later):** install the Android platform-tools (`adb`) and enable USB debugging on the phone for faster installs, or use the CI artifact.
4. **Phone:** note the model / screen size so the layouts are checked on it.

## Spike results

**(a) Toolchain, 2026-11-10: works in WSL.**
- Capacitor current stable is **8.6.0** (needs Node 22 or newer; this machine has Node 24). Its Android template uses minSdk **24**, compile and target SDK **36**, **Java 21** and Gradle **8.14.3**.
- Installed on the Linux filesystem: JDK 21 (already present), Android command-line tools, `platform-tools`, `platforms;android-36`, `build-tools;36.0.0` in `~/Android/Sdk` (about 460 MB). `ANDROID_HOME=$HOME/Android/Sdk`.
- A throwaway Capacitor app built with `./gradlew assembleDebug` in about 2 minutes (first run, includes the Gradle download) and produced a 4 MB debug APK with the expected package, min and target SDK.
- Sprint 1 repeated the build for the real app **in place on `/mnt/d`** (Gradle caches on the Linux filesystem via `GRADLE_USER_HOME`): debug and release together took 5m41s on a cold cache, no symlink problems. The R8-shrunk release APK is 1.1 MB (unsigned without a keystore) and still contains the Capacitor bridge, the secure-storage and preferences plugins and the app's `MainActivity`; the debug APK is 4.1 MB. Min SDK 24, target SDK 36.
- Not yet done: installing on a phone (copy the APK, or `adb` on Windows) and the first run of the GitHub Actions workflow.
- Plugin versions on npm today: `@capgo/capacitor-social-login` 8.7.7, `@aparajita/capacitor-biometric-auth` 10.0.0, `@aparajita/capacitor-secure-storage` 8.0.1, `@capacitor/app|keyboard|browser|status-bar|screen-orientation|preferences` 8.x. Compatibility with Capacitor 8 is re-checked when each is added.

**(b) YouTube embed matrix, 2026-11-10, on a real phone.** Two spike APKs from the same page (four variants on a left menu: the production iframe, nocookie + `enablejsapi` + `origin`, `youtube.com/embed` + `enablejsapi` + `origin`, and Open in YouTube through the Capacitor Browser plugin) that differ only in the app origin: A at `https://localhost`, B at `https://app.tradematangi.co.in`.

| Origin | 1. production iframe | 2. nocookie + origin | 3. youtube.com + origin | 4. Open in YouTube |
|---|---|---|---|---|
| A `https://localhost` | not tested | not tested | not tested | not tested |
| B `https://app.tradematangi.co.in` | **plays** | **plays** | **plays** | **opens the YouTube app** |

**Decision:** the app uses the domain origin `https://app.tradematangi.co.in` (`server.hostname` in `mobile/capacitor.config.ts`) and the **unchanged production iframe** (`shared/analysis/SessionVideos.tsx`, nocookie, `referrerpolicy strict-origin-when-cross-origin`). No relay page on the server is needed, so no server-side change is tied to the phone branch; Open in YouTube stays as the fallback. The hostname is never looked up on the network (the app answers it locally). The localhost origin was not tested, so it is not known whether it would fail; the app does not use it.

**(c) Google token accepted by `/api/auth/desktop/google-token`:** needs the Android OAuth client (user action 1). Not started.

**(d) KLine chart performance on the phone:** measured in Sprint 1 / 3 with the real chart bundle. Not started.

## Risks
- Embedded YouTube can fail in a WebView (error 153) when the referrer or origin is missing. Mitigation: the S0 matrix; the domain origin is verified on a real phone; Open in YouTube is always visible.
- Google sign-in setup errors (28444, wrong SHA-1, consent-screen test users, propagation delay). Mitigation: a step-by-step guide; debug and release SHA-1 both registered.
- A server on another branch lacks endpoints. Mitigation: capability probe, per-feature 404 / 403 handling, About screen.
- Positions endpoints attach runtimes on the server. Mitigation: decided in S8; passive endpoint if needed.
- Gradle builds on `/mnt/d` can be slow or break on symlinks. Mitigation: SDK and Gradle caches on the Linux filesystem; CI is the reliable build.
- KLine bundle weight on low-end phones. Mitigation: lazy loading and a measured budget.
- Shared-code edits could touch real-trading screens. Mitigation: additive props with unchanged defaults; website and desktop suites run before the PR.
