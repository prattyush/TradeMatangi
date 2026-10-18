# TradeMatangi webapp

An installable PWA at `/webapp/`. It renders `frontend/src/WebsiteApp.tsx` directly, including existing shared charts and all website features. There is no second implementation of trading, persistence or account state. Website and desktop chart-menu defaults remain unchanged.

## Local use

```bash
bash scripts/start-backend.sh
# Optional AI service: bash scripts/start-aihelper.sh
bash scripts/start-frontend.sh
```

Open `http://localhost:5173/` for the website, then choose **Install app**. The installed app launches `http://localhost:5173/webapp/`; the website tab stays at `/`. The two pages share the same manifest/app identity and existing backend. The button is available on the login screen and trading header. If the browser does not offer a native prompt (including private browsing), it shows instructions and an **Open webapp** link. On iPad, open that link in Safari before choosing **Share → Add to Home Screen**.

The normal frontend script builds both applications, copies the webapp into `frontend/dist/webapp/`, then serves the combined artifact with Vite preview on port 5173 for preprod testing. Re-run it after code changes; it does not use HMR. Stop it with `bash scripts/stop-frontend.sh`. The stop script uses its recorded PID and leaves other Vite processes alone. When upgrading from the old scripts, stop the old frontend process/service once before using the new scripts; the previous version did not record a PID.

Local preview proxies `/api` to port 8700 and `/ai` to 8701. `WEBAPP_API_PROXY` and `WEBAPP_AI_PROXY` override those targets. Export `VITE_API_BASE_URL` / `VITE_AI_HELPER_URL` before building to use explicit endpoints in both applications. The original website `.env` remains supported for its build. `start-frontend-ec2.sh` preserves the existing HTTPS endpoint settings, logging and port 5173; the existing domain proxy can continue forwarding `/` to that port, including `/webapp/`.

For webapp-only hot development, `bash scripts/start-webapp.sh` still serves `http://localhost:5174/webapp/` with no service worker. Stop it with `bash scripts/stop-webapp.sh`. The frontend's direct Vite development command also remains available for website work; use the combined startup script for root-site installation testing.

```bash
# From the repository root; installs missing dependencies with --no-bin-links.
bash scripts/build-frontend-with-webapp.sh
npm test --prefix webapp
```

Tests require Playwright Chromium or Google Chrome (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides the executable). They start their own servers on ports 5174/5175, so stop the webapp-only development server first. Build both applications before running the tests. A fresh, normal Chromium profile checks the website's native installability diagnostics; other browser scenarios use isolated private contexts. To regenerate installation icons from the checked-in SVG, run `npm run icons --prefix webapp`.

## Interaction

- Double-click or double-tap a chart price to open its trading menu. Opening a menu never places an order. A **Chart menu** button opens at the latest candle/tick price and also works with a keyboard.
- Touch and drag the chart background to pan. Pinch zoom continues to use the chart library. Drag an editable order/drawing line to move that line; updates retain existing release-only behavior. Drawing and price-pick modes take priority over menu recognition.
- The webapp has no additional title/install/fullscreen row. Its first trading row is the existing TradeMatangi header and controls; the workspace uses the viewport height, respecting device safe areas.
- Use the compact **Full screen** icon in the existing header (or login title) where supported. On desktop, move the pointer to the top eight pixels to reveal a floating **×** at the top center. It stays while hovered/focused and hides 1.5 seconds after leaving. Escape and browser exits also work. Touch devices keep a compact restore icon in their existing header while fullscreen.
- Install from the website at `/`. No installation button is rendered inside `/webapp/`, whether it is opened in a browser, installed window or fullscreen. The app does not need to detect installation to enforce this.
- Desktop and tablets from 768 CSS pixels wide are supported; no separate phone layout is provided.

## Hosting

Build from the whole repository: webapp imports `frontend`, `shared` and browser-safe desktop chart modules. For preprod testing, the startup scripts serve both builds on port 5173 behind the existing HTTPS proxy. For static production hosting, run the combined build script and deploy all of `frontend/dist/` to the site root. Keep the existing backend/AI reverse proxies at `/api` and `/ai`. Vite preview is the preprod testing server; use a static web server for production.

For example, with the combined artifact copied to `/srv/tradematangi/`, add these locations to the existing nginx server (preserving backend/AI locations):

```nginx
location / {
    root /srv/tradematangi;
    add_header Cache-Control "no-cache" always;
    try_files $uri $uri/ /index.html;
}

location = /webapp { return 308 /webapp/; }

location = /webapp/sw.js {
    root /srv/tradematangi;
    add_header Cache-Control "no-cache" always;
    try_files $uri =404;
}

location /webapp/assets/ {
    root /srv/tradematangi;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
}

location /webapp/ {
    root /srv/tradematangi;
    add_header Cache-Control "no-cache" always;
    try_files $uri $uri/ /webapp/index.html;
}
```

Deploy assets before HTML and retain older hashed assets while old app windows may still be open. Never return SPA HTML for missing JavaScript. Revalidate HTML, manifest, icons, offline page and worker; only hashed assets receive immutable caching. Keep HTTPS endpoint overrides free of trailing `/`; never use a production localhost AI URL.

Same-origin hosting uses the existing backend identity, browser storage and Google authorized origin. Installed-app storage sharing still depends on browser/OS behavior, so a platform may require signing in again. Verify Google and broker flows in the installed target browsers.

## Offline and updates

Both production-built pages register the same worker, scoped only to `/webapp/`. Registration from `/` does not make the worker control the website. It stores only `offline.html` under the `tradematangi-webapp-offline-*` cache prefix. API requests, streams, trading mutations and account data never enter worker caching or background queues. Existing website local-storage preferences/session recovery remain in use.

An offline launch shows a static connection page with Retry. An open app retains its workspace and the existing API/SSE recovery behavior. Connection-loss messages use the existing notification area and report browser network availability; it does not certify backend/broker health or order acknowledgement. Closing an app window does not stop server-side trading strategies.

New workers wait for existing controlled windows to close. No `skipWaiting`, forced reload, or `clients.claim` is used. Bump the offline cache version when changing the offline page. Browser HTTP caching of ordinary application assets follows the server headers above.

## Acceptance

Automated checks cover real chart gestures, contract menu context, offline navigation/retry, cache isolation, worker scope/update waiting, install/fullscreen controls and tablet sizing. Existing website chart regressions exercise the reused trading implementation. Live brokers, Google sign-in, physical iPad installation/gestures and multi-window installed-app acceptance require manual checks before deployment. No real orders are sent by these tests.
