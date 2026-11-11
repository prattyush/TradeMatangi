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
  src/screens/              Login, Sessions, SessionDetail, Labeling, Stats, Videos, Browse, Swing, Settings
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
| Swing | request shapes and order rules of `shared/SwingPortfolioPanel.tsx`, `swingOrderPrice.ts`, `swingStream.ts` (the phone has its own screens; the Day-trading `DesktopTradingSnapshot` is not used) |

Rule: compose phone-specific **layout** components around shared **logic / data / chart** pieces. Shared UI components are touched only with small additive props whose default is today's behavior.

---

## Server access and authentication

- **Base URL.** `VITE_API_BASE_URL` at build time (default `https://tradematangi.co.in`, no trailing slash); editable in Settings and on the login screen. Release builds accept `https` only; `http` only in debug builds. The WebView origin is `https://<server.hostname>`, so a relative `/api` would not work and is never used.
- **Bearer only.** `POST /api/auth/desktop/token` (email, password, `device_name`), `POST /api/auth/desktop/google-token`, `POST /api/auth/desktop/refresh`, `POST /api/auth/desktop/logout`. Access token about 24 h, refresh token 30 days and rotated on every refresh. The website's `X-User-Id` header is never sent.
- **Token handling.** The refresh token lives in Android Keystore-backed secure storage; the access token in memory. One in-flight refresh at a time; a `401` triggers one refresh and one retry. Tokens are never logged.
- **Google.** Native Credential Manager sign-in with the existing **Web** client ID; the ID token's audience is already accepted by the backend (`user_service.py`), so no backend change. A first-time Google user is asked for an `account_name`. Setup steps: `docs/phone-google-signin-setup.md`.
- **App lock.** Optional BiometricPrompt (fingerprint / face, or the screen lock) on cold start and after 30 s in the background (`mobile/src/app/lockPolicy.ts`); off by default, switch in More, turned off by signing out. The screens stay mounted under an opaque, `inert` cover (`mobile/src/app/AppLock.tsx`).
- **Capabilities and older servers.** The app probes `GET /api/desktop/v1/capabilities` and handles `404` / `403` per feature with a "not available on this server" state (for example Habits when the Phase 23 endpoints are missing). Settings > About shows the app version, server URL and capability summary.
- **Server prerequisite.** `DESKTOP_JWT_SECRET` must be set on the server. The repository default would let anyone forge a token.

---

## Native plugins written for this app (Sprint 2)

Two small Capacitor plugins live in `mobile/android/app/src/main/java/in/co/tradematangi/phone/` and are registered in `MainActivity` (no third-party sign-in plugin, so no extra provider code ships in the APK):
- `GoogleSignInPlugin` (`signIn({serverClientId})` → `{idToken, email, name}`): Android Credential Manager with `GetSignInWithGoogleOption`; maps failures to `cancelled`, `no_account`, `provider`, `unsupported`, `failed`. The web side (`mobile/src/native/googleSignIn.ts`) turns them into plain messages, including Google's 28444 as a setup problem.
- `AppLockPlugin` (`isAvailable()`, `authenticate({title})`): AndroidX BiometricPrompt, strong biometrics or the screen lock (weak biometrics on Android 9 and 10, which cannot combine strong with the screen lock).
- The web side reaches them through `AppServices.google` and `AppServices.appLock` (replaceable in tests). In a browser the plugins have a web fallback that only works when a UI test provides `window.__TM_GOOGLE_SIGNIN__` / `window.__TM_APP_LOCK__`; the Google button and the App lock switch are hidden or disabled otherwise.

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

**Shell.** A 56 px left navigation rail (Sessions, Stats, Browse, Swing, Videos, More) that respects the left safe area. No global top bar; a screen has at most one 36 to 40 px title row.

**Sessions.** A list of trading days (one line each: date, symbol and instrument, mode badge, P&L, trades) that gives way to the chosen day: choosing a day hides the list, and the Days button, the Sessions rail item or Back brings it back. Filters live in one side sheet (7 d / 30 d / 90 d / 1 y / custom, Day or Swing, mode, symbol, instrument; default last 30 days). The chosen day has **one control row** (Days, a view menu with Chart, Trades, Orders, Videos and later Snapshots, Compare and Journey, then for the chart Underlying | Option, the strike menu and the chart controls); the candles take everything below it. Chart details over the candles show only while touching.

**Trade labeling** (full screen, rail hidden). Left about 56 %: chart zoomed to the trade window. Right about 44 %: a scrolling form with the header `Trade 3 of 12 - NIFTY 24500 CE - +1,240`, Entry and Exit tag pickers, notes (opens a full-screen sheet so the keyboard cannot squeeze the form), and behavior questions as large Yes / No / N/A rows. A fixed 56 px footer has Prev, the save state, Next and an "Unlabeled only" toggle. Autosave through the shared `LabelSaver`; leaving with an unsaved change is blocked.

**Stats.** The shared `PerformanceDashboard` itself (so every number, section and fix stays identical to the website and desktop) re-laid out by `mobile/src/screens/stats/stats.css` through the dashboard's own class names: a vertical tab strip (Overview, Entries, Exits, Sizing, Behavior, Habits) on the left with a Filters button under it; one scrolling pane with a sideways-scrolling KPI row; the filters open as a panel over the pane; a trade's story opens over the pane too. Back closes the details drawer first, then the filters. Swing keeps its own header. The phone wraps the data calls (`phoneStatsEnvironment`) so errors read as sentences ("not available on this server") and drops the writers (actual-charges editor); three additive classNames in shared code (`pa-export`, `hb-manage`) let the phone hide Export CSV and "Manage questions". "Open cycle" in the execution details hands the cycle identity to Stats through `StatsFocus`.

**Videos.** `GET video-links/mine` lists every saved video (grouped once per video, by upload day). Choosing one hides the list (like Sessions) and shows the player on the left, as large as the pane allows (a CSS size container: `min(100cqw, 177.78cqh)` at 16:9), and a side column with ← Videos, YouTube, Copy, the title, privacy badge, linked sessions and the chapter list (`parseChapters` reads the saved `M:SS Title` text). The player is the shared `youtube-nocookie` embed and loads only when Play is pressed (nothing goes to YouTube before); a chapter reloads it with `start=<seconds>&autoplay=1`, which is deterministic and needs no YouTube script. Private videos cannot be embedded: the stage explains it and offers Open on YouTube. The screen stays awake while playing (Screen Wake Lock, re-acquired on return from the background). A device spike showed the embed plays from the app origin `https://app.tradematangi.co.in` (see the sprint plan), which is why the app is served from that origin and not from `localhost`. Adding or removing links stays in Sessions > Videos. The shared `VideoLinksSource` gained an optional `listMine` for this.

**Browse** (read-only). The shared `AnalysisChart` (so volume, `VOL`, EMA and the interval chips match Sessions) with no trades, fed by the same analysis `data/historical`, `data/pre-session` and `data/options-historical` routes; the one control row is its `toolbarStart`: symbol button (a search sheet over `GET /api/desktop/v1/catalogue`, recents in local storage), a day stepper (weekday stepping; a date sheet with the phone's picker; opens on the last completed trading day, never today), Spot | CE | PE (only for `option_eligible` symbols) and a strike menu. **CE and PE keep separate picks** (`RightPick`: manual strike, or Max price with a premium cap), so switching side does not move the other one. **Max price** is the strike menu's pinned first command (it opens `MaxPriceSheet`: presets from `shared/optionPremiumPresets`, a typed cap): the picked side's strike comes from `POST /api/desktop/v1/trading/prepare-session` (`mode: browse`, one option pane, `selection_mode: max_price`, reference time 09:30:00, the desktop picker's server-side search of up to 30 strikes from the money), asked again for each day, symbol and side; a failed search offers Try again or Manual strike and an older server (404) shows Not available. For an option the screen reads `GET /api/desktop/v1/option-metadata` (the day's expiry and strike gap) and the underlying's morning price to build 43 strikes around the money; a day with no listed options says why instead of drawing. No order, no drawing tools (the phone environment gives none). The chart loads the day plus 2 prior days; paging further back is not in the first version. **Minute data:** the phone adds `granularity=minute` to the three `data/*` history routes (`withMinuteGranularity` in `env/analysisEnvironment.tsx`; 60 s timeout for them) and Max price scans minute candles on the server, so Browse no longer waits for Breeze second-level downloads; see `docs/live-history-providers.md`. The pure parts (trading-day stepping, symbol search, strike ladder, recents) are in `browseModel.ts` with unit tests.

**Browse Live.** On today (India date, `marketDate()`) the control row shows **Live**, the desktop's flow: `POST /api/desktop/v1/live/start` (one tile, the spot or the chosen option, at the chart's interval), server-sent events from `/live/{id}/events` read with the Bearer token (`ApiClient.stream`; reconnect with `last_event_id`, a 15 s snapshot health check that refreshes a provider error, a restart if the server forgot the stream), and `PUT /live/{id}/tiles/browse` when the interval changes. The candles are the desktop's own aggregation (`windowsapp/src/liveCandles.ts`, `liveStreamState.ts`): the server's history baseline plus every received one-second candle, volume included. They go to the shared `AnalysisChart` through its new optional `liveCandles` prop, which then fetches nothing and pushes only the last bar to the chart while the history is unchanged. The stream is stopped when Live is turned off, the instrument changes, Browse closes or the app leaves the foreground (and restarted on return). It is chart-only and read-only; no order route is touched. Code: `browse/live/{liveModel,useLiveBrowse}.ts`.

**Swing** (phase 2; `docs/spec-phase24-phone-swing-plan.md`). The rail's Swing tab trades the Swing portfolio through the website's own routes at `/api/desktop/v1/swing/portfolios/*` (Bearer): no new trading endpoint; the only server change is the order tag `client: "phone"`. `useSwingPortfolio` loads the active portfolio of the chosen account once (this attaches it on the server, as the website does) and then follows its event stream (`followPortfolio`, `SwingSseDecoder`; the full snapshot arrives on connect and on every change, reconnect with backoff, closed while the app is in the background, no polling). One control row (Paper | Real, mode badge, Live / Reconnecting with the age of the last update, Refresh, Manage), a summary strip (P&L, cash, capital, notices: entries paused, loss limit, funds short, reconciling, prices not live), then Positions and Orders lists; a missing price is "Waiting for prices", never 0. Actions live in sheets: a position (Exit, Add stoploss, Buy more, Chart), a pending order (change price or quantity, cancel with a second tap), Manage (pause or resume entries, close with the acknowledgements the server asks for) and the order ticket. **Ticket rules** (`orderTicket.ts`, the same as the website panel and the server): no market orders; entries are Limit or Target, exits Limit or Stoploss; equity and options are long only; futures go both ways (SELL opens a short or exits a long, BUY covers a short or opens a long, and an order against the open position is an exit); options and futures are entered in lots; capital-% sizing and every futures order get a server `order-preview` first and carry its `capital_revision` (futures also `approved_budget` and `fee_hash`); prices snap to the contract tick; selling more than is free (held minus open exit orders) is refused. A **summary sheet** (PAPER or REAL in large type, instrument, action, units and lots, price, value, margin and fees) must be confirmed before anything is sent. **One request id per set of instructions** (`RequestIdentity`): pressing Confirm again after "no answer" or a broker `502` reuses it, so the server returns the first order instead of a second; writes are never retried by the transport. Errors say what is known (`swingErrors.ts`): `402` funds, `403` paused or no access, `409` changed (refresh), `502` / no answer "may or may not be placed: refresh and look". **Real** needs the real-trading capability **and** the App lock on; the phone's own lock (`AppLockClient.authenticate`) is asked when the user switches to Real and when a real portfolio is closed, and keeps Real open for 5 minutes (`REAL_UNLOCK_MS`); starting a real portfolio also needs the broker session connected (checked with `broker-status`; connecting it is done on the website or desktop). A position's **chart** is the shared `AnalysisChart` fed minute candles from `POST {id}/charts/history` (`liveCandles`), with the average entry and the contract's pending orders drawn; its interval is the chart's own control. Real funding, import, allocation and reconcile controls, Day positions and alerts are not on the phone.

**More.** Account, logout, Server URL, app lock, keep-screen-on for video, immersive toggle, clear cache, About / diagnostics (copy diagnostics: versions and recent errors, no secrets).

Reserved room: Alerts, an email OTP as a second factor for real swing orders, Setups deep-dive.

---

## Build, signing and CI

- Toolchain (verified in Sprint 0): JDK 21, Node 22 or newer, Capacitor 8.6 (minSdk 24, compile and target SDK 36, Gradle 8.14.3), Android SDK command-line tools plus `platform-tools`, `platforms;android-36` and `build-tools;36.0.0` in `~/Android/Sdk` on the Linux filesystem (not `/mnt/d`). Install on a USB phone with Windows `adb.exe` from WSL, or download the APK from the CI artifact.
- `npm install --no-bin-links` (WSL `/mnt/d` rule); Capacitor CLI is run as `node node_modules/@capacitor/cli/bin/capacitor`.
- GitHub Actions `android-phone.yml` (ubuntu): debug APK for every push touching `mobile/**`, `shared/**`, `frontend/src/services/**` or `windowsapp/src/analysisApi.ts`; a signed release APK when the signing secrets exist. The keystore and passwords live in GitHub secrets only. Debug APKs (CI and local) are signed with one fixed debug key (`ANDROID_DEBUG_KEYSTORE_*` secrets, `~/.android/tradematangi-debug.env` locally) so a new build installs over the old one; its SHA-1 is also the one registered in the Google OAuth Android client.

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

- **Analysis environment** (`mobile/src/env/analysisEnvironment.tsx`): the phone is the third host of the shared `AnalysisEnvironment`. It builds the data layer with the desktop's `createAnalysisApi` and `createVideoLinksApi`, fed by one request function that goes through the phone's Bearer transport to `/api/desktop/v1/analysis/<path>` (the desktop's `validAnalysisPath` allowlist still applies, and `204` becomes `null` as the shared code expects). Saved videos open in the YouTube app or a Custom Tab through `@capacitor/browser`. The data layer is built once per client; the chart-details setting is layered on top.
- **Screen** (`mobile/src/screens/sessions/`): `SessionsScreen` (the list pane, 230 to 310 px and proportional, plus the detail pane), `FilterSheet`, `SessionRow`, `SessionDetail`, `PhoneChartPanel`, `TradesList`.
- **The days list hides once a day is chosen** so the chart gets the whole width. It comes back with the **Days** button, by tapping **Sessions** in the rail again, or with Back (which shows the list before it leaves the screen). With no day chosen the list always shows. The chosen day and filters are remembered while the user visits another tab.
- **One control row.** There is no tab row. The *view menu* (Chart, Trades, Orders, Videos) and the Days button live in the same 44 px row as the chart's own controls: for the Chart view that row is the shared chart's header, which takes a new additive `toolbarStart` slot. In that row: Days, view menu, **Underlying | Option**, then for Option the **strike menu** (a popover over the chart, or a plain label when the day has one contract), then the chart's marker filter, interval, indicators, fit and maximize. Views other than Chart show the same Days and view menu in a plain 44 px bar, with the symbol, date and P&L at the right.
- **Maximize** is owned by `PhoneChartPanel` (not the shared panel): one chart fixed over the whole screen, Underlying / Option and the strike menu stay, Days and the view menu are hidden, and Back or Restore returns. (An earlier version used the shared two-pane panel; its CSS hides panes with the `hidden` attribute, so the phone now has a global `[hidden] { display: none !important }` rule as well.)
- **Chart details** (candle time, open/high/low/close, indicator values) are drawn only while the crosshair is active (touch and hold) by default. More > Charts offers **While touching / Always / Never**, remembered on the phone. The shared environment has a new optional `chartInfo` for this (`always` when absent, so other hosts are unchanged).
- **Requests are date-bounded** (7 days, 30 days default, 90 days, 1 year, or a custom range of at most 400 days).
- **Shared-code changes made for the phone, additive and unchanged for other hosts:** the Analysis chart passes `volume` to the chart (it was dropped) and skips VOL and VWAP when the data has none; `toolbarStart` slot; `chartInfo` environment option.
- **Control sizes.** The list rows and the rail are 44+ px. The controls in the chart row are 36 px tall so the candles keep the height (checked by the UI tests).
- **Not in this sprint:** snapshots, day journey and execution details (S3b), Compare (S3c); per-day label progress (S4); the swing review screens (S5).

## Sprint 3c notes (Compare)
- The view menu has **Compare** (intraday days). It mounts the shared `PatternVsTradeComparison` full screen (`compare/CompareOverlay.tsx`, Back closes) and restyles it in `compare.css`: one header row (title, category and strategy filters, Close), each pane with its own button row and chart header, safe-area padding. The shared component's header parts got additive class names (`analysis-comparison-*`) so the phone can restyle inline-styled elements; its behavior is unchanged for other hosts.

## Sprint 3b notes (Snapshots, Day journey, execution details)

- **Snapshots** (`mobile/src/screens/sessions/snapshots/`): `SnapshotsView` loads `getSnapshots` for every session of the day and orders them with the shared `sortSnapshots`. One 44 px strip steps through the events (◀ ▶, or the event button which opens `EventListSheet`: time, description, type and the session or position result, with `filterSnapshots` search where `*` is a wildcard) and has a **Details** button (`SnapshotDetailsSheet`: wallet and capital in use, open and session P&L, open orders with stoploss marks, positions per contract). `PhoneSnapshotChart` is the shared Analysis chart with the same props the website's viewer gives it, and the Days and view-menu controls plus **Underlying | CE strike | PE strike** go in the chart's own header row (only the contracts the snapshot has are offered). The chart stays mounted from event to event, so the zoom and scroll position are kept. No delete on the phone.
- **Shared module** `shared/analysis/snapshotModel.ts` (`sortSnapshots`, `filterSnapshots`, `eventIcon`): the website's viewer now uses it too, so the event ordering and search are one implementation (unit tests in `windowsapp/src/analysisSnapshotModel.test.ts`).
- **Day journey:** the shared `DayJourneyChart` over `sessionJourney(cycles, capitals)`; day sessions only.
- **Execution details:** tapping a trade row opens the desktop's `ExecutionInspector` as a panel over the right edge of the pane (Back closes it). Its "Open cycle" button is hidden until the phone has Stats.

## Sprint 4 notes (Trade labeling)

- **Reuse, not a copy.** `LabelingOverlay` (`mobile/src/screens/sessions/labeling/`) mounts the shared `TradeLabeling` with a copy of the environment whose `charts.LabelCharts` is `PhoneLabelCharts`, `labelView` is `one_by_one`, and the dirty / saving callbacks are tracked. All label logic (loading round trips and labels, debounced autosave, behavior marks, tag suggestions, the save status, Prev / Next saving first) therefore stays in one place for the website, the desktop and the phone.
- **Phone chart.** `PhoneLabelCharts` is `PhoneChartPanel` (the session chart, Underlying | Option and the strike menu in the chart's header row) with `getMarkerText` / `focusTime` / `labelContractMarkers` passed through, the maximize button off, and a ← Back button in front. The strike menu follows the viewed trade's contracts.
- **Layout** (`labeling.css`, rules more specific than the shared file's width-based ones so every size gets the same layout): the overlay covers the screen including the rail; chart column 58 %, form column the rest; the shared header uses `display: contents` so only the Prev / counter / Next row sticks to the top of the form column while the identity row, trade chips and summary scroll; the save status sticks to the bottom; chips are 36 px in one scrolling row; inputs 40 px; behavior switches 44 px; the Maximize and "All together" controls are hidden. When the viewport is under 300 px tall (keyboard open) the chart, identity row, chips and summary step aside and the form takes the whole screen.
- **Leaving.** Back (the Android button or ←) closes straight away when nothing is pending; otherwise it shows "Saving labels…" and closes as soon as the saves finish; after 6 seconds without success it asks whether to leave without saving.
- **Progress.** `useLabelProgress` loads a day's round trips and labels (two requests per session) only for the open day and shows `labeled/total` beside the menu item; it refreshes when labeling closes.
- **P&L display.** The environment reads the user's `desktop_pnl_display_mode` (money or % of capital) from `/api/desktop/v1/trading/settings/current`; an older server or no access keeps money.
- **Not in this sprint:** swing labeling (with S5, because swing labels use the swing endpoints), managing behavior questions as a separate screen (the shared "Manage questions" dialog is available inside labeling).

---

## Status by sprint

See `docs/spec-phase24-android-plan.md`.

## Walkthrough and What If (Phase 24)
Both are full-screen overlays opened from the day's view menu (not for swing), built on the shared screens in `shared/analysis/walkthrough/` and `shared/analysis/whatif/`, with Label trades' landscape layout (`.phone-labeling` grid, `PhoneLabelCharts`) and phone CSS in `mobile/src/screens/sessions/{walkthrough,whatif}/`. The option chart's markers carry no text in all three phone screens (`PhoneLabelCharts` always passes `labelContractMarkers={false}`: the colour says buy or sell and one trade is shown); on the other hosts the shared `RoundTripSplitLayout` takes `labelContractMarkers`, which Walkthrough and What If turn off and Label Trades keeps on (KLine charts only; the chart section exposes it as `data-contract-labels`). What If's Entries and Exits blocks are set apart on the phone by a coloured title band, a thick bar on each fill row and a thick line between the blocks (`mobile/src/screens/sessions/whatif/whatif.css`).
- **Walkthrough** (`WalkthroughOverlay`): read-only; the day's P&L before and after, entries and exits with colour-coded codes; ▸ before a time opens more.
- **What If** (`WhatIfOverlay`): the day and the trade, actual against what-if; fills as two-line rows (label and capital, then price and quantity boxes; the ⌖ button puts the chart in pick mode and a tap on the chart sets the price); the saved-what-ifs bar is one line that opens; Compare days is a modal list. Back cancels a pick (it re-dispatches Escape to the chart), then asks before dropping unsaved changes, then closes. Saved scenarios go through the analysis transport (`/api/desktop/v1/analysis/whatif`, allowed by `validAnalysisPath`) and are the only writes; `chartPicking: true` on the phone environment enables picking.
