# Phase 22 — Installable webapp

## Decisions

- The app is an installable PWA for desktop and tablets from 768 CSS pixels wide, hosted at the existing origin under `/webapp/`.
- Per the clarified requirement, implementation and review target `preprod`, the testing branch containing the current website/KLine work. No merge to `dev` or `main`, deployment or real-order testing is performed automatically.
- `webapp` imports the website application composition directly. It inherits every website feature and existing shared/desktop browser-safe chart implementation; there are no duplicated screens, API clients, session engines or persistence schemas.
- Double-click/double-tap opens chart trading menus. Touch-drag on the background pans; native pinch zoom remains with the chart library. Editing drawings/order lines and price picking take priority. A keyboard-accessible Chart menu button uses the latest candle/tick price. Website and desktop retain right-click by default.
- The existing website at `/` offers installation on its login screen and trading header, linking the same manifest as `/webapp/`. Installation leaves the website tab at `/`; launching the installed app opens `/webapp/`.
- Fullscreen uses the browser Fullscreen API where supported. Installation opens a standalone app window; fullscreen rejection/absence does not block trading or installation.

## Implementation

`frontend/src/WebsiteApp.tsx` owns the shared application/provider composition. The webapp adds a lightweight shell, fullscreen controls, scoped offline worker and targeted tablet styles. Installation controls live only on the website. The app uses the full viewport height, respecting safe areas, without an additional title or control row.

Shared chart components consume an optional `ChartMenuGesture` context, defaulting to `contextmenu`. The webapp supplies `doubleclick`. Gesture recognition observes pointer events without capturing/preventing background gestures, rejects drags/pinches/cancellation/long holds, and suppresses synthetic duplicate mouse menus. Existing chart-to-order routing retains exact session/pane/contract context. Lightweight Swing order-line handling accepts touch pointers in the PWA and preserves release-only callbacks and cancellation recovery. Existing nested chart menus also accept tap and keyboard activation.

Deployment uses the same `/api` and `/ai` paths as the website, with optional build-time endpoint overrides. Local Vite development proxies to localhost backend/AI services independently of the website's `.env`. There are no backend, DDB or public HTTP API changes. Build dependency versions match the website lockfile.

The production-built website and app register the same worker, which controls only `/webapp/` and caches only a static offline page. It never caches account responses or trading data, intercepts API/stream traffic, queues orders, forces reloads, or claims existing clients. Updates wait until old controlled windows close. Activation removes only obsolete `tradematangi-webapp-offline-*` caches. Existing application local-storage behavior and stream/session recovery remain in use.

## Verification

Focused browser checks cover both real chart renderers, native touch panning, double-tap menus, exact contract tickets, keyboard menu access, touch line-drag release/cancellation, installation controls, fullscreen state/failure, offline launch/retry, worker scope/cache cleanup/update waiting, and authenticated portrait/landscape tablet navigation.

Existing website browser checks and desktop/shared unit tests cover the reused trading, drawing, chart-renderer, account and recovery behavior. No backend test changes are necessary because backend behavior is unchanged.

Verified on 2026-10-18:

- Webapp and website installation: **19 browser scenarios pass**, including production-build PWA lifecycle tests, real chart-library touch interactions and native Chromium installability diagnostics.
- Existing website: **36 browser scenarios pass**.
- Desktop/shared: **298 unit tests pass** across 43 files.
- Webapp and website TypeScript checks/production builds pass; desktop TypeScript check passes. Vite reports the existing large-bundle advisory.
- Shell scripts and worker syntax checks pass; `git diff --check` passes.

Commands: `bash scripts/build-frontend-with-webapp.sh`, `npm test --prefix webapp`; from `frontend`, `node node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build` and `node node_modules/@playwright/test/cli.js test`; from `windowsapp`, `node node_modules/vitest/vitest.mjs run` and `node node_modules/typescript/bin/tsc --noEmit`.

See [webapp setup and hosting](../webapp/README.md) for startup scripts, build/test commands, nginx configuration and cache headers.

## Manual acceptance before deployment

- Install/relaunch in desktop Chromium and physical iPad Safari; check standalone storage/login behavior, both orientations, double-tap, pan, pinch and line editing.
- Verify Google sign-in and broker connection flows on the deployed HTTPS origin, including popup behavior.
- Verify live feeds, background/resume recovery and concurrent website/installed-app windows against the intended test environment. Browser connection notifications are not broker-health or order-acknowledgement evidence.
- Obtain explicit authorization before any real-order acceptance test. Deployment and merging remain manual.

## Installation from the existing website follow-up

The frontend startup scripts build both applications and serve the combined `frontend/dist/` artifact on the existing port 5173 using Vite preview for preprod testing. The root page remains the website; `/webapp/` serves the installed app. EC2 HTTPS backend settings and date-stamped logs are preserved. The stop script targets the recorded preview PID instead of stopping every Vite process. Direct Vite development and the separate port-5174 webapp script remain available; installation tests use the production-style combined build.

Shared installation state survives switching from the login screen to the authenticated trading header, retains the browser's one-shot prompt, prevents duplicate prompt requests and hides controls in standalone mode or after installation. Unsupported/private browsers receive instructions and a separate Open webapp link. A normal Chromium profile verifies native installability diagnostics; isolated browser tests check manifest identity, launch URL, installation controls and worker scope.

Follow-up verification on 2026-10-18: all **19 installation/webapp browser scenarios** and **5 focused existing website chart regressions** pass. The combined build passes both TypeScript checks and both production builds. The real startup script serves `/`, `/webapp/`, the manifest and the worker on port 5173 with revalidation headers. Stopping the managed frontend leaves an independently running Vite process available. Shell syntax and whitespace checks pass. The earlier 36 website browser/298 shared-unit results above are the original implementation baseline; no broad backend/full-suite rerun was needed for this follow-up.

## Fullscreen and chart-space follow-up

The permanent TradeMatangi app / Install app / fullscreen row and its reserved height are removed. The first trading row is the existing TradeMatangi header and controls. No installation control/provider is mounted in the webapp, so entering fullscreen cannot make an Install app button reappear; website installation remains unchanged.

A shared optional header control slot is empty by default in the website/desktop and populated only by the webapp shell. Compact fullscreen icons reuse login, Day, Swing, Pattern, Structures and Analysis control areas. In desktop fullscreen the entry icon is hidden; passive pointer observation reveals a floating top-center exit button when the pointer reaches the top eight pixels. It consumes no layout space and no invisible hit area; hovering/focusing pins it, otherwise it hides after 1.5 seconds away. Keyboard focus reveals it, Escape and browser-initiated exits update the state, and touch devices keep a restore icon in their existing header. Unsupported APIs render no fullscreen controls. Errors and connection-loss messages use the existing notification system.

The app/manifest identity, backend, worker cache behavior and chart/order gestures are unchanged. Deployed installed windows pick up this change on reopening after the new frontend build is deployed; reinstalling is unnecessary. Physical device/browser-native fullscreen acceptance remains manual.

Fullscreen follow-up verification (2026-10-18): **21 webapp/installation browser checks**, **5 focused website chart regressions** and **29 focused shared/desktop unit tests** pass. Both production builds and their TypeScript checks pass, as does the desktop TypeScript check. Browser checks cover zero reserved app-bar height, no webapp installation controls, top-edge reveal/hover/focus/auto-hide, keyboard and browser exits, touch restore, main-page control placement, unsupported/rejected APIs and preserved chart canvas identity across fullscreen transitions. The tablet screenshots show the existing trading header as the first row. No backend or real-order tests were required for this UI-only change.
