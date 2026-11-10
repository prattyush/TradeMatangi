# Trade Matangi — Phone App Architecture (Android)

Requirements: `docs/spec-phase24.md` ("Android phone app"). Sprint plan and status: `docs/spec-phase24-android-plan.md`. Manual checks: `docs/phone-manual-acceptance.md`.
Status of this document: skeleton written in Sprint 0; each sprint updates the sections it changes.

---

## Overview

An Android app for **leisure-time analysis on a landscape phone**: Sessions and the whole Analysis section, one-at-a-time trade labeling, Stats and Habits, session videos, Browse (read-only charts), and read-only open positions for swing and day trading. Day trading itself stays on the desktop, website or a tablet.

It is a **web app packaged with Capacitor**: a new React entry (`mobile/`) that reuses the shared code, installed as an APK. All data comes from the TradeMatangi server over HTTPS.

Design principles:
- **One code base for analysis.** Logic, data access, charts and forms are reused from `shared/` and the Tauri-free desktop modules. Only the phone *layout* is new.
- **The server is the integration point.** The app talks to whatever server URL it is given (default `https://tradematangi.co.in`) and tolerates a server that lacks a feature.
- **Read and review first.** The only writes are trade labels and behavior marks. No order can be placed from the phone.
- **Landscape phone, not a shrunk website.** Height (about 340 to 440 px) is the scarce resource.

---

## Why Capacitor (A) and not a Tauri Android build of the desktop app (D)

| | A. Capacitor + new `mobile/` entry (chosen) | D. Tauri 2 Android build of `windowsapp` |
|---|---|---|
| Reuse | `shared/analysis/*` has no Tauri imports; every host injects an `AnalysisEnvironment` (`shared/analysis/environment.tsx`). The phone is a third host next to the website and the desktop | Same shared code, but inside the 2,867-line `windowsapp/src/App.tsx` workspace (windows, tiles, handoffs), which does not suit a phone. A phone entry would be needed anyway |
| Changes flow to the phone | Any change in `shared/` reaches website, webapp, desktop and phone. Tauri-free desktop files (`windowsapp/src/analysisApi.ts`, `DesktopAnalysisSessions.tsx`, `tools/videoLinks.ts`, `historyPaging.ts`) are imported in place, so edits there flow too | Same for `shared/`; desktop edits flow, but an Android Rust port has to be owned |
| Native work | No Rust. Small plugins: secure storage, Google sign-in, biometric, browser / intents, later push | Replace `keyring` (no Android backend, silently falls back to memory), gate `rfd`, ffmpeg, youtube and window commands behind `cfg(desktop)`, fix `open_external_url` (Google login would wait forever), rusqlite on the NDK, custom Kotlin plugins for push and biometric. Tauri Android is also the less mature path |
| Embedded video | Android System WebView. We choose the origin (`server.hostname`, https), can add a relay page or a native-intent fallback, and can write a small Kotlin plugin if a native player is ever needed | Same WebView, origin `http://tauri.localhost`, fewer levers |
| Future (alerts, deep links, biometric, background work) | Capacitor plugin ecosystem (push via FCM, App, Browser, Keyboard, Preferences) | Each one is custom Kotlin + Rust glue |

D's only real advantage is Rust-side token refresh and no CORS. A gets the same from a little TypeScript, and the server's CORS is already open.

---

## Folder layout (`mobile/`, mirrors `webapp/`)

```
mobile/
  capacitor.config.ts       appId in.co.tradematangi.phone, webDir dist, server.hostname app.tradematangi.co.in (https origin), androidScheme https
  android/                  committed Capacitor project (landscape lock, immersive, https-only network config, allowBackup=false)
  src/main.tsx              providers, theme, in-memory screen stack + Android back button
  src/shell/                NavRail, Screen, Sheet, SegmentedTabs, EmptyState, ErrorState, OfflineBanner
  src/api/                  transport, tokenStore, auth, serverConfig, capabilities, polling
  src/env/                  analysisEnvironment (builds the AnalysisEnvironment for shared/analysis)
  src/screens/              Login, Sessions, SessionDetail, Labeling, Stats, Videos, Browse, Positions, Settings
  src/theme.css             design tokens (CSS variables) and phone density rules
  tests/                    Playwright landscape specs, vitest
```

`mobile/vite.config.ts` copies `webapp/vite.config.ts`: the same aliases that pin `react`, `react-dom`, `klinecharts` and `react-klinecharts-ui` to `mobile/node_modules`, and `fs.allow` for the repository root, so files under `../shared` and `../frontend` resolve the same copies. `mobile` does **not** mount `WebsiteApp`.

---

## Reuse map

| Need | Reused from |
|---|---|
| Session grouping | `groupSessions` in `shared/analysis/TradeAnalysis.tsx` |
| Analysis data access | `createAnalysisApi` / `analysisRequest` in `windowsapp/src/analysisApi.ts` (Bearer; plain `fetch`) |
| Session chart | `shared/analysis/kline/AnalysisChart.tsx` on `shared/charts/KLineChart.tsx` |
| Labeling logic | `shared/analysis/labeling/{saver,model}.ts`, `RoundTripLabelForm`, `shared/analysis/behavior/*` |
| Stats and Habits maths | `shared/analysis/performance.ts`, `shared/analysis/habits/{habitStats,habitSeries}.ts`, chart primitives in `habits/` |
| Videos | `shared/analysis/{SessionVideos,AddVideoLink,videoLinks}`, `windowsapp/src/tools/videoLinks.ts` |
| Browse | `shared/SymbolSearch.tsx`, `shared/charts/KLineChart.tsx` (read-only via `tradingEnabled=false`), `windowsapp/src/historyPaging.ts` |
| Positions | request shapes of `shared/SwingPortfolioPanel.tsx` (`Snapshot`) and `DesktopTradingSnapshot` |

Rule: compose phone-specific **layout** components around shared **logic / data / chart** pieces. Shared UI components are touched only with small additive props whose default is today's behavior.

---

## Server access and authentication

- **Base URL.** `VITE_API_BASE_URL` at build time (default `https://tradematangi.co.in`, no trailing slash); editable in Settings and on the login screen. Release builds accept `https` only; `http` only in debug builds. The WebView origin is `https://<server.hostname>`, so a relative `/api` would not work and is never used.
- **Bearer only.** `POST /api/auth/desktop/token` (email, password, `device_name`), `POST /api/auth/desktop/google-token`, `POST /api/auth/desktop/refresh`, `POST /api/auth/desktop/logout`. Access token about 24 h, refresh token 30 days and rotated on every refresh. The website's `X-User-Id` header is never sent.
- **Token handling.** The refresh token lives in Android Keystore-backed secure storage; the access token in memory. One in-flight refresh at a time; a `401` triggers one refresh and one retry. Tokens are never logged.
- **Google.** Native Credential Manager sign-in with the existing **Web** client ID; the ID token's audience is already accepted by the backend (`user_service.py`), so no backend change. A first-time Google user is asked for an `account_name`. Setup steps: `docs/phone-google-signin-setup.md`.
- **App lock.** Optional BiometricPrompt on cold start and after 60 s in the background; off by default.
- **Capabilities and older servers.** The app probes `GET /api/desktop/v1/capabilities` and handles `404` / `403` per feature with a "not available on this server" state (for example Habits when the Phase 23 endpoints are missing). Settings > About shows the app version, server URL and capability summary.
- **Server prerequisite.** `DESKTOP_JWT_SECRET` must be set on the server. The repository default would let anyone forge a token.

---

## Network rules

- Every Sessions / Stats request is date-bounded (`start_date`, `end_date`); `GET /api/analysis/sessions` has no pagination.
- Reads time out and retry with backoff; writes are never retried automatically (labels use the existing debounced saver with a visible Saved / Saving / Retry state).
- Requests abort when the screen goes away. Positions poll about every 10 s in the foreground only; polling stops in the background and a "stale" badge appears after 30 s.
- No SSE on the phone: it uses snapshot GETs.

---

## UI design (landscape)

Design box 740 to 960 CSS px wide by 340 to 440 px tall (checked at 915x412, 851x393, 740x360 and 960x432; must not break at 1280x800). Orientation is locked to sensor-landscape with immersive bars and `env(safe-area-inset-*)` for notches. Touch targets are at least 44 px (40 px in dense lists). Dark theme from the existing palette, expressed as CSS variables.

Principles: no stacked headers; master-detail panes instead of modals; filters in sheets; summaries first, detail one tap away; horizontal pagers instead of long vertical pages; the Android back button always pops one level.

**Shell.** A 56 px left navigation rail (Sessions, Stats, Browse, Positions, Videos, More) that respects the left safe area. No global top bar; a screen has at most one 36 to 40 px title row.

**Sessions.** Left 300 to 320 px list, right detail pane. Filters live in one sheet (7 d / 30 d / 90 d / custom, Day or Swing, mode, symbol, instrument; default last 30 days). A list row is one line: date, symbol and instrument, net P&L, trade count, label progress (`4/6`). The detail pane has a segmented control (Chart | Trades | Orders | Videos) and a Label action; the chart takes the full pane height with trade markers, interval chips and an Underlying / Option toggle.

**Trade labeling** (full screen, rail hidden). Left about 56 %: chart zoomed to the trade window. Right about 44 %: a scrolling form with the header `Trade 3 of 12 - NIFTY 24500 CE - +1,240`, Entry and Exit tag pickers, notes (opens a full-screen sheet so the keyboard cannot squeeze the form), and behavior questions as large Yes / No / N/A rows. A fixed 56 px footer has Prev, the save state, Next and an "Unlabeled only" toggle. Autosave through the shared `LabelSaver`; leaving with an unsaved change is blocked.

**Stats.** A vertical tab strip (Overview, Entries, Exits, Sizing, Behavior, Habits); each tab is a horizontal pager of single-purpose cards with a scrolling KPI row and a filter sheet. Tables become condensed lists. Habits goes scorecard to deep-dive.

**Videos.** Left list grouped by date; right a 16:9 player sized to the available height with the chapters beside it. Tapping a chapter seeks. Private videos show the existing note to make them Unlisted; Open in YouTube is always available. The player is the shared `youtube-nocookie` iframe; a device spike showed it plays from the app origin `https://app.tradematangi.co.in` (see the sprint plan), which is why the app is served from that origin and not from `localhost`.

**Browse** (read-only). A full-bleed chart with an auto-hiding slim control bar: symbol (full-screen search), date (calendar sheet, previous / next day), interval chips, Spot / CE / PE with expiry and strike, indicators. Long-press shows an OHLC and volume read-out. No trading menu, no drawings.

**Positions** (read-only). Swing and Day columns, each with a mode badge, as-of time, total P&L, wallet and a list of positions with open-order counts.

**More.** Account, logout, Server URL, app lock, keep-screen-on for video, immersive toggle, clear cache, About / diagnostics (copy diagnostics: versions and recent errors, no secrets).

Reserved room: Alerts, Swing orders (biometric confirm; guardrails stay on the server), Setups deep-dive.

---

## Build, signing and CI

- Toolchain (verified in Sprint 0): JDK 21, Node 22 or newer, Capacitor 8.6 (minSdk 24, compile and target SDK 36, Gradle 8.14.3), Android SDK command-line tools plus `platform-tools`, `platforms;android-36` and `build-tools;36.0.0` in `~/Android/Sdk` on the Linux filesystem (not `/mnt/d`). Install on a USB phone with Windows `adb.exe` from WSL, or download the APK from the CI artifact.
- `npm install --no-bin-links` (WSL `/mnt/d` rule); Capacitor CLI is run as `node node_modules/@capacitor/cli/bin/capacitor`.
- GitHub Actions `android-phone.yml` (ubuntu): debug APK for every push touching `mobile/**`, `shared/**`, `frontend/src/services/**` or `windowsapp/src/analysisApi.ts`; a signed release APK when the signing secrets exist. The keystore and passwords live in GitHub secrets only.

---

## How changes reach the phone

- Edit in `shared/` -> website, webapp, desktop and phone all pick it up on their next build.
- Edit in an imported Tauri-free desktop module -> desktop and phone.
- Edit in `frontend/` (website only) or `windowsapp/src/App.tsx` (desktop only) -> does not reach the phone, by design.
- A shared change that alters a props contract must keep the default behavior; the phone build and its tests run in CI for every `shared/**` change.

---

## Sprint 1 notes (shell, auth core)

- **API layer** (`mobile/src/api/`): `transport.ts` (Bearer; 20 s timeout; one in-flight token refresh shared by concurrent calls; one retry after a 401 and only if no other call refreshed in the meantime; reads retry twice on network errors and 502/503/504, writes never; a pre-cancelled request never reaches `fetch`), `tokenStore.ts` (refresh token in secure storage, access token in memory), `auth.ts` (password and Google ID-token sign-in, sign-out that revokes the refresh token on the server but always signs out locally), `capabilities.ts` (`ok | old | forbidden | unreachable | unknown`), `serverConfig.ts` (normalises and validates the server address, `https` only unless a debug build), `diagnostics.ts` (ring buffer that redacts tokens), `errors.ts` (`ApiError`, `isMissingEndpoint`, `isNotAvailable`, `describeError`).
- **App layer** (`mobile/src/app/`): `services.ts` builds the singletons once; `AppContext.tsx` provides services, auth state (`loading | signedIn | signedOut`; an `onAuthLost` event from the transport signs the user out) and the capability probe; `Nav.tsx` holds the current tab, a stack of screens opened on top of it, and the back button: handlers registered with `useBackHandler` run first (newest first), then pop one screen, then go to Sessions from any other tab, then a second press within 2 s exits. The Capacitor `backButton` event drives it in the app; the Escape key stands in for it in a browser.
- **Android project** (`mobile/android/`, committed): sensor-landscape, immersive bars (`MainActivity`), `adjustResize`, `allowBackup=false`, data-extraction rules that exclude everything, `usesCleartextTraffic=false` with a `network_security_config` that a debug build overrides to allow a LAN dev server, R8 and resource shrinking on release with keep rules for Capacitor and the secure-storage plugin, release signing read from the environment, `versionCode` and `versionName` from Gradle properties.
- **Screens in this sprint:** sign-in (brand left, form right, server address editable), the shell with the 56 px rail, a placeholder for each screen built in later sprints, and More (account, sign-out with confirmation, server address, About with the server capability summary, copy diagnostics).

## Sprint 3 notes (Sessions)

- **Analysis environment** (`mobile/src/env/analysisEnvironment.tsx`): the phone is the third host of the shared `AnalysisEnvironment`. It builds the data layer with the desktop's `createAnalysisApi` and `createVideoLinksApi`, fed by one request function that goes through the phone's Bearer transport to `/api/desktop/v1/analysis/<path>` (the desktop's `validAnalysisPath` allowlist still applies, and `204` becomes `null` as the shared code expects). Saved videos open in the YouTube app or a Custom Tab through `@capacitor/browser`.
- **Screen** (`mobile/src/screens/sessions/`): `SessionsScreen` (list pane 230 to 310 px, proportional, and detail pane), `FilterSheet` (period, style, mode, instrument, symbol; edits a draft until Apply), `SessionRow` (date, symbol and instrument, mode badge, P&L, trade count; uses the shared `groupSessions` so two sessions on one day are one row), `SessionDetail` (tabs Chart, Trades, Orders, Videos; the P&L and date sit at the right of the tab row because the selected list row already shows them), `TradesList` (a six-column table that fits 400 px).
- **Requests are date-bounded** (7 days, 30 days default, 90 days, 1 year, or a custom range of at most 400 days).
- **Chart.** The shared `AnalysisPanels` in `layout="single"` (one pane at a time with an Underlying / Option toggle). `sessions.css` overrides the desktop CSS that assumes a 450 px card: the panel fills the pane, the chart title and footnote are hidden, the toggle and header controls are compacted.
- **Shared-code fixes made for the phone, additive and unchanged for other hosts:** the Analysis chart now passes `volume` to the chart (it was dropped), and `useKLineIndicators` takes an optional `hasVolume` so `VOL` and `VWAP` are skipped for an index.
- **Not in this sprint:** per-day label progress (S4), the swing review screens (S5), tapping a trade to focus the chart (S4, with labeling).

---

## Status by sprint

See `docs/spec-phase24-android-plan.md`.
