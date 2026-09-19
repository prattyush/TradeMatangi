# Phase 16 — Trade Matangi Desktop Charts

## Purpose

Build a standalone Windows desktop application for market-data visualisation,
historical replay, and chart study. It is a desktop companion to the existing
Trade Matangi backend, not a rewrite of the current trading application.

The first release validates KLineCharts, the Windows desktop lifecycle, and a
data-only backend API before any trading-screen migration is considered.

The initial product contains no order placement, paper trading, real trading,
wallet, positions, strategies, guardrails, trade labelling, or Pattern Library
workflows.

## Current Desktop Live Status

- The chart-only Live hub is active and isolated from trading services. It
  supports up to four independently configured tiles, including duplicate
  instruments, whose provider ticks are fanned out to every matching tile.
- Live snapshots currently reach the desktop once per second through the
  existing browser/native request bridge. Native-host SSE recovery remains
  Sprint 6 work.
- Refresh safely replaces completed provider history while retaining the
  in-memory, tick-built active candle; per-chart close timers use each tile's
  selected interval.
- Live interval switching is being moved to interval-neutral one-second tick
  delivery with local per-tile aggregation. This avoids restarting provider
  routes or disturbing other tiles when a chart interval changes.

### Live Interval Switching Tradeoff

The desktop keeps interval-neutral one-second ticks in an active Live-session
cache keyed by canonical instrument, not by tile. Duplicate instrument tiles
share the same tick cache immediately, and changing only a chart interval
rebuilds visible candles from the historical baseline plus those raw ticks
without restarting the provider route. The cache is cleared when Live stops,
when the user logs out, or when a new Live stream starts. Completed history
remains backend-authoritative; Refresh replaces completed provider candles and
merges the active session's raw ticks back over the returned history to cover
provider lag while preserving the active live candle.

The website chart keeps only a 15-minute recent tick cache for this same
refresh backfill purpose. Drawing persistence remains Sprint 3 work, and full
screen persistence remains in the later desktop shell persistence scope rather
than this Live/cache pass.

## Desktop Technology

- Ship as a Windows desktop application, initially targeting Windows 10 and
  Windows 11, using Tauri and a React frontend.
- Use KLineCharts for every chart surface in this desktop application.
- Keep the existing Trade Matangi backend as the authoritative source of
  market-data, replay state, authentication, and data availability.
- Use the Tauri native host process for durable desktop responsibilities such
  as background data subscriptions, local state buffering, secure credential
  storage, application logs, and native window lifecycle events.
- The frontend WebView renders charts and controls. It must not be the sole
  owner of a live market-data subscription or replay state.

## Basic Desktop App

### Login and Application State

1. Users can log in and log out using the existing backend authentication
   service.
2. Authentication tokens and refresh credentials must use Windows-secure
   storage and must never be written to plaintext configuration files.
3. The app must show a clear connection state: connected, reconnecting,
   offline, or authentication required.
4. On startup, restore the user's saved screens, layouts, chart selections,
   indicator settings, drawings, and last active screen after authentication.
5. Application errors and data-stream failures must be written to local desktop
   logs suitable for support and debugging.

### Symbols and Instruments

1. Support selection and search of NIFTY 100 equity symbols, NIFTY 50 (NSE),
   SENSEX (BSE), and other backend-supported indexes.
2. Support option-chart viewing for supported index and equity underlyings.
3. An option selector must let the user choose the underlying, expiry, strike,
   and CE or PE right. It must show the contract identity clearly on the chart.
4. The symbol catalogue, supported expiries, strikes, and data availability
   must come from the backend rather than a duplicate desktop-only list.
5. A new empty chart defaults to NIFTY 50. Users can replace it with an equity,
   index, CE option, or PE option independently of other charts.

### Screens, Tabs, and Layouts

1. Provide TradingView-style named tabs, called **screens**, which users can
   create, rename, duplicate, reorder, close, and switch between.
2. A screen saves its layout, chart tiles, selected instruments, intervals,
   chart settings, indicator configuration, and operating mode. Drawings are
   stored separately at the user-and-instrument level so they can be shared by
   matching charts in more than one screen.
3. Support the current Trade Matangi chart-layout concepts, including a single
   chart and multiple chart tiles. A layout may contain different equities,
   indexes, and option contracts at the same time.
4. When a user creates a screen or selects a layout with no configured tiles,
   every tile displays the default NIFTY 50 chart until changed.
5. Saving a screen persists its state across application restarts and later
   trading days. Live screens resume live data; replay screens restore their
   selected historical context and replay configuration.
6. Screen and layout changes must be local and immediate. The app must protect
   against data loss if it closes before a delayed persistence operation runs.

## Charting with KLineCharts

### Chart-Engine Decision and Isolation

1. KLineCharts is selected for this desktop validation product because it
   provides built-in technical indicators, multi-pane indicators, and
   interactive overlays (including selection, drag, lock, and removal). These
   are first-class product requirements, not merely rendered lines.
2. Lightweight Charts is not treated as incapable of these features: its newer
   plugin and pane-primitive APIs can implement custom drawings, indicators,
   and panes. However, they require Trade Matangi to own the drawing renderer,
   hit-testing, selection state, editing lifecycle, and persistence mapping.
   That additional custom interaction layer is intentionally out of scope for
   this desktop validation product.
3. Put all KLineCharts calls behind a desktop chart-adapter boundary. The rest
   of the desktop client and the backend must use Trade Matangi candle,
   indicator, drawing, selection, and viewport contracts rather than KLineCharts
   instance objects, identifiers, or undocumented internal state.
4. Pin a supported KLineCharts major/minor version for each desktop release.
   A library upgrade must run chart, drawing, indicator, live-update, replay,
   and restore compatibility tests before it can change production behaviour.

### Candles and Interactions

1. Render OHLC candles for historical, replay, and live data using KLineCharts.
2. Support the currently available chart intervals and allow each live chart
   tile to choose its own interval.
3. Preserve the Trade Matangi timestamp invariant: backend timestamps encode
   IST wall-clock market time using the existing UTC-labelled convention. The
   desktop chart adapter must not change the displayed market-time basis.
4. Provide crosshair, zoom, pan, time-scale navigation, price scale, chart
   resize, fullscreen/maximized tile view, and high-DPI rendering.
5. Validate that live ticks update the current candle correctly and that a
   completed replay bar appears exactly once.
6. Charts must handle empty data, unavailable contracts, holidays, incomplete
   live sessions, and backend errors without crashing the containing screen.
7. The chart adapter must distinguish a full, ordered historical snapshot from
   an incremental current-bar update. It must reject or reconcile duplicate,
   out-of-order, and stale updates so an SSE reconnect, screen restore, or
   minimized-window redraw cannot overwrite a newer candle with an older one.
8. Display market timestamps consistently as IST, independent of the Windows
   system timezone or locale. Persist and restore the user-visible time range,
   price-scale preference, and chart interval for each tile without changing
   the project timestamp invariant.

### Indicators and Drawings

1. Expose KLineCharts built-in indicators and drawing tools by default.
2. Users can add, configure, hide, reorder, and remove multiple indicators per
   chart. Indicators may render on the main pane or their own pane as supported
   by KLineCharts.
3. Users can create, hover, select, edit, drag, lock, hide, and remove
   KLineCharts drawings. A selected drawing must show visible control points or
   other selection feedback so that the user can tell it is the active object.
4. A selected drawing can be deleted through a visible drawing toolbar and the
   Delete/Backspace key. Right-click must offer a delete action. The app may use
   KLineCharts' default right-click deletion only when it also makes that action
   clear to the user.
5. Persist indicator configuration with the chart tile. Persist each drawing in
   the backend per user and canonical instrument identity: equity/index symbol,
   or option underlying plus expiry, strike, and CE/PE right. A drawing must
   load on every chart tile displaying that same instrument or contract across
   all saved screens, regardless of layout or chart interval.
6. Horizontal support/resistance lines, trend lines, Fibonacci drawings, and
   other saved overlays must retain their KLineCharts type, points, styles,
   visibility, lock state, grouping data, and stable drawing ID. Creating,
   editing, locking, hiding, or deleting a drawing must update the backend and
   every currently open matching chart in the desktop app.
7. Maintain a local cache for offline rendering, but the backend is the
   authoritative source for drawings. On login, reconnect, and screen restore,
   reconcile local drawings with the current backend version for that user and
   instrument.
8. Persist drawing points as canonical market timestamp-and-price coordinates,
   never only as a chart data index or pixel coordinate. A saved drawing must
   remain anchored to the intended candles when history is loaded in pages,
   the visible range changes, or the same instrument is viewed at another
   interval.
9. Persist indicators as a normalized Trade Matangi definition (indicator
   type, parameters, styles, pane placement/order, and visibility), rather
   than serialising a KLineCharts indicator instance. Indicators are scoped to
   the chart tile; drawings remain scoped to the user and instrument.
10. The desktop shell must provide a drawing palette, selection state, an
    edit/style panel, and clear keyboard behaviour: Escape cancels an active
    drawing, Delete/Backspace removes only the selected drawing, and Undo/Redo
    reverses or reapplies the user's latest local drawing changes. These
    commands must not accidentally pan, zoom, or modify another chart tile.
11. The proof of concept must explicitly validate the KLineCharts API for all
    required drawing and indicator behaviour, including pane add/remove/resize,
    custom indicators, and overlays across live and replay data. Unsupported
    or unreliable capability must be recorded before it becomes a dependency
    of a future Trade Matangi trading-chart migration.

## Data Modes

### Live Data

1. A live screen streams currently available market data for every configured
   tile.
2. Live data flows through the existing backend's authorised market-data
   providers and cache. The desktop application must not embed broker secrets
   or call brokers directly.
3. The app receives ordered updates with a replayable event identifier and can
   request a current REST snapshot for any tile or screen.
4. A temporary data-provider, network, or backend interruption shows a visible
   reconnecting state and resumes from the last known event identifier when
   possible.

### Historical Replay

1. A replay screen lets the user choose a historical trading date, start time,
   replay speed, and applicable candle/replay interval.
2. Every chart tile in the same replay screen shares one replay date, clock,
   pause/resume state, and speed. Different symbols and option contracts must
   advance against the same replay timestamp.
3. Replay controls include start, pause, resume, stop, speed selection, current
   simulated time, and progress.
4. Support a Stepwise replay mode without any trading capability. Stepwise shows
   a Next Bar control and advances exactly one completed shared bar boundary per
   user action.
5. In Stepwise mode, every chart tile in the same layout/screen must share the
   same historical date, current timestamp, candle/replay interval, and bar
   number. A chart with missing data at that timestamp must retain the shared
   clock and show its unavailable-data state rather than drifting from the
   other charts.
6. The backend owns normal replay and Stepwise clock progression. It must reject
   incompatible multi-chart replay configuration rather than allowing charts in
   the same screen to advance independently.
7. Historical data acquisition and option-contract validation remain backend
   responsibilities. Missing data, holidays, expired contracts, and data-fetch
   errors must be presented clearly in the affected chart tile.
8. The backend remains the replay-clock authority. The desktop app renders the
   received state and restores from backend snapshots.

## Background, Minimized, and Recovery Behaviour

1. Minimizing the desktop window, switching to another application, or placing
   the app in the background must not stop its market-data subscription,
   historical replay clock, or local latest-state buffer.
2. The native Tauri host owns the durable SSE subscription. It records the last
   event identifier and retains the latest market-data, session, and replay
   state while the WebView UI is hidden or rendering is throttled.
3. When the window becomes visible or focused, the UI must receive a current
   desktop-host snapshot, reconcile it with a backend REST snapshot, and redraw
   each affected chart immediately.
4. The visual chart does not need to animate while Windows does not render a
   minimized window. On restore it must show the current candle and replay
   position without losing or duplicating data.
5. If the SSE connection breaks because of a server, provider, or network issue,
   the native host retries with bounded backoff, resumes from the last event ID
   when available, and reports its state to the UI.
6. After laptop sleep, system resume, application restart, or a long offline
   period, the app reconnects and obtains an authoritative backend snapshot.
   It must not assume its local buffer is complete.

## Backend Boundary

1. Add or extract a data-only backend surface for authentication, symbol
   discovery, instrument metadata, historical OHLC, live subscriptions, replay
   sessions, SSE replay, and state snapshots.
2. Reuse existing broker integrations, historical fetch/cache services, option
   services, live broadcasters, and normal/Stepwise session-replay code where
   they are already reliable. Avoid a duplicate data-fetching system.
3. Do not expose trading endpoints, order endpoints, wallet endpoints, or
   broker credentials to the desktop charts application.
4. Desktop API authorization must enforce the same user ownership checks as the
   current backend.
5. Add user-authorised drawing APIs for listing, creating, updating, and
   deleting a drawing by canonical instrument identity. Drawing records require
   stable IDs and revision/version information so concurrent updates from two
   open screens do not silently overwrite each other.
6. Define versioned payloads for candles, ticks, replay state, screen snapshots,
   connection state, event replay, and drawings so the desktop client can be
   upgraded independently of the web frontend.

## Windows Distribution

1. Produce a signed Windows installer for direct testing and release.
2. Prepare the application for Microsoft Store submission, including product
   identity, app icons, publisher metadata, silent installation, update
   delivery, and Store-required code signing.
3. Support an installer path that includes the required WebView2 runtime for
   Microsoft Store and offline installation scenarios.
4. Build Windows release artifacts in reproducible CI on Windows and keep the
   release version visible in the application and support logs.

## Validation Before Trade Matangi Migration

The standalone desktop charts app is a validation product. It must prove the
following before KLineCharts is adopted in any active Trade Matangi trading
screen:

1. KLineCharts handles live OHLC updates, historical loading, replay, intervals,
   indicators, drawings, multiple panes, and high-DPI Windows displays reliably.
   It retains correct candle order and IST display after reconnect, restore,
   historical backfill, and a minimized-window refresh.
2. Minimize/background, focus restore, network loss, backend restart, and system
   sleep recovery never cause user-visible missed or duplicated candle state.
3. Saved screens restore with correct layout, symbols, option contracts,
   indicators, and drawings.
4. Drawings can be selected, moved, locked, hidden, and deleted. Their changes
   persist per user and appear on every open or restored matching chart across
   different screens.
5. Stepwise replay advances all charts in one screen by one shared bar without
   data duplication, timestamp drift, or any trading feature.
6. Multi-symbol and multi-option layouts remain responsive under live streaming.
   Drawing selection, editing, keyboard shortcuts, and pane resizing remain
   confined to the intended chart tile.
7. The data-only backend API is stable, authorised, and does not expose trading
   capability.
8. The desktop app passes Windows smoke tests for live, normal replay, and
   Stepwise replay modes before
   planning migration of analytical or trading features from Trade Matangi.

## Future Migration Direction

If the desktop application validates the approach, reuse its KLineCharts adapter,
timestamp helpers, data contracts, indicator/drawing persistence model, and
desktop lifecycle strategy in Trade Matangi. Migrate lower-risk analysis/chart
surfaces before considering the existing live trading chart. Any live-trading
migration must remain reversible until it passes simulation, stepwise, paper,
and real-trading smoke tests.

## Implementation Plan

### Delivery Strategy

Build the desktop app in an isolated `Windows app/` workspace using Tauri v2,
Rust, React, TypeScript, and KLineCharts 10.x. Validate the complete core flow
with the existing five symbols before adding the NIFTY 100 catalogue in the
final sprint.

The application has two deliberately distinct states:

- **Browse mode:** each tile independently owns its instrument or option,
  anchor date, interval, viewport, and historical navigation.
- **Run mode:** an explicit Start Live, Start Replay, or Start Stepwise action
  makes the screen the owner of one shared date and clock. Tiles retain their
  selected instruments and chart settings but cannot advance independently.

### Locked Product Behaviour

1. Selecting a date in a Browse tile loads that trading day and the five prior
   trading days. Panning beyond a cached edge fetches the adjacent
   trading-day page.
2. Browse tiles may show unrelated instruments and dates.
3. Replay and Stepwise require one shared date, start time, and candle
   interval. Normal Replay also requires a speed. Starting Live is explicit.
4. Starting a run resets all tiles to the common date and cursor while
   retaining their selected instruments and chart settings.
5. Stopping leaves the final shared cursor visible. Returning to Browse must
   be explicit at tile or screen level.
6. An invalid option is never substituted automatically. It remains selected
   and shows an unavailable, expired, or no-data state while the shared clock
   continues.
7. Option selection is date-aware in this order: underlying, as-of market
   date, valid expiry, strike, then CE/PE. Expiry is evaluated against the
   chart or replay date, never the current date.
8. Live, Replay, and Stepwise are chart-only: no wallet, orders, positions,
   strategies, broker credentials, or trading controls are exposed.
9. Version 1 supports a maximum of four tiles.
10. Replay advances second by second. Stepwise processes seconds until exactly
    the next shared completed candle boundary.

### Sprint 0 — Tauri and KLineCharts Hard Gate

- Create the isolated workspace with Tauri v2, React, TypeScript, Rust,
  KLineCharts 10.x, tests, type checking, and build scripts.
- Restrict WebView CSP and Tauri permissions; browser code receives no
  credentials.
- Prove with static data: IST-as-UTC display, snapshots plus one-second
  incremental updates, four-chart layouts, resizing, high-DPI, pan/zoom,
  crosshair, fullscreen tile, indicator panes, and drawing interaction.
- Validate drawing create/select/drag/lock/hide/delete/restore, keyboard and
  right-click handling.
- Add a Rust fake-SSE test proving host state keeps updating with no active
  WebView listener.
- Define renderer-neutral contracts: `InstrumentKey`, `Candle`, `ChartEvent`,
  `ChartSnapshot`, `DrawingDefinition`, `IndicatorDefinition`,
  `ViewportState`, `BrowseState`, and `RunState`.
- Gate all later work on Windows/WebView2 POC validation.

### Sprint 1 — JWT Authentication and Desktop API Foundation

- Add access and refresh tokens, refresh/revoke endpoints, hashed persisted
  refresh tokens, expiry, and device metadata.
- Accept bearer authentication while preserving legacy web `X-User-Id`
  compatibility.
- Add a versioned `/api/desktop/v1` router, capability endpoint, schemas,
  ownership enforcement, and common error payloads.
- Ensure desktop routes cannot invoke or expose trading services.
- Store tokens in Windows Credential Manager, refresh only in the native host,
  provide typed Tauri commands, redacted logs, and secure logout cleanup.
- Test the auth lifecycle, revocation, ownership, legacy compatibility, and
  logout cleanup.

### Sprint 2 — Current Symbols, Browse Mode, and Historical Data

- Expose NIFTY 50, SENSEX, Tata Power, Tata Motors CV, and Reliance through a
  desktop catalogue with exchange, chart type, option eligibility, supported
  intervals, and availability.
- Define canonical equity/index and option instrument identities.
- Add date-aware option metadata for valid expiries, strike increments,
  supported CE/PE rights, and availability.
- Add ordered historical candles, date-range pages, context days, interval
  resampling, and option history using existing prior-day cache/fetch rules.
- Implement independent Browse date, loaded range, interval, and viewport;
  include adjacent-page fetch on pan and clear unavailable states for future,
  non-trading, or unavailable dates.
- Add asynchronous preflight jobs for slow history and option fetches.
- Test symbols, option validation, navigation, prior-day options, holidays,
  ordering, unavailable data, and IST timestamps.

### Sprint 3 — Screens, Layouts, and Drawing Persistence

- Persist DynamoDB desktop screens: named tabs; create, rename, duplicate,
  reorder, close; active-screen restore; layouts; up to four tiles; Browse
  state; indicators; viewport; and current/final Run state.
- Persist user-and-canonical-instrument drawings with stable ID, normalized
  tool type, timestamp-price points, style, visibility, lock/group state,
  revision, mutation ID, and deletion tombstone.
- Load drawings on matching charts across screens and intervals.
- Add SQLite cache and offline mutation queue for screens and drawings.
- Test ownership, restore, Browse persistence, cross-screen drawing
  propagation, interval-safe anchors, offline mutations, tombstones, and
  last-write-wins reconciliation.

### Sprint 4 — Chart-Only Live Stream Backend

- Build a desktop market-data hub separate from trading simulation sessions.
  It may reuse authorised provider/cache infrastructure but must never invoke
  orders, wallets, strategies, positions, or trading effects.
- Add explicit Start/Stop Live endpoints for a screen's configured instruments.
  Return snapshots first; mark invalid options per tile without blocking valid
  tiles.
- Add authenticated SSE envelopes with version, stream ID, generation,
  monotonic event ID, timestamp, tile identity, connection status, candle
  update, unavailable, provider error, and stream-reset events.
- Support bounded replay buffering and snapshot fallback after missed events.
- Test four tiles, duplicate instruments, invalid options, reconnect, buffer
  reset, provider failure, and absence of trading-service invocation.

### Sprint 5 — Shared Replay and Stepwise Backend

- Build a desktop replay controller separate from existing trading session
  loops. A run belongs to one screen and owns date, start time, interval,
  speed, cursor, mode, and configured instruments.
- On replay or Stepwise start, validate/fetch all tiles, retain instruments,
  synchronize their date/cursor, and render expired or unavailable options as
  unavailable rather than replacing them.
- Emit a common one-second timeline containing every tile's candle update,
  partial state, or `no_data`; aggregate tile intervals from that raw timeline.
- Provide normal Replay start, pause, resume, stop, speed update, snapshot,
  and reconnect support.
- Implement Stepwise Next Bar to advance precisely to the next completed
  shared interval, report cursor/bar index/total bars/every tile state, and
  reject concurrent Next Bar requests.
- Persist controls and completed-bar boundaries for restart recovery without
  per-tick DynamoDB writes.
- Test run takeover, missing data, normal replay, exact stepping, reconnect,
  restart, and final display after stop.

### Sprint 6 — Native Host Streaming and Background Recovery

- Implement Rust SSE clients for live and replay with bearer auth,
  Last-Event-ID resume, bounded reconnects, stream reset, snapshot
  reconciliation, and a latest-state cache.
- Keep streams and replay buffers active while minimized, unfocused, or while
  WebView rendering is throttled.
- On restore, deliver the host snapshot, fetch the backend authoritative
  snapshot, reconcile generation/event ID/candle timestamp, and display the
  newest state once.
- Reconnect and reconcile after sleep/resume, backend restart, offline periods,
  token expiry, or network failure.
- Test minimized/no-listener/focus restore/sleep recovery/backend restart/auth
  refresh/forced gaps/offline changes.

### Sprint 7 — Desktop Workspace and Chart UI

- Build login and server configuration, workspace shell, screens/tabs, approved
  layouts, tile controls, symbol search, option picker, connection indicators,
  loading, and unavailable-data states.
- Provide Browse date picking, paged history on pan, independent Browse badges
  and viewports, and date-aware option expiry selection.
- Provide explicit Live, Replay, and Stepwise setup plus a synchronization
  confirmation, shared controls/progress/bar counter, pause/resume/stop, and
  final-run display.
- Add KLine adapter safeguards for snapshot/incremental ordering, stale events,
  IST display, resize, and restore.
- Test transitions, all current symbols, invalid options, live/replay UI,
  final stopped state, and manual Windows smoke tests.

### Sprint 8 — Indicators, Drawings, and Offline UI

- Add an OHLC-compatible indicator browser with configuration, reorder, hide,
  remove, and main/separate-pane placement; explain unavailable volume/turnover
  indicators.
- Add drawing palette, selection/style controls, lock/hide, toolbar and
  right-click delete, Escape, Delete/Backspace, and Undo/Redo.
- Immediately apply drawing changes to all open matching desktop tiles.
- Make offline, synchronizing, and failed queued changes visible.
- Test drawing behavior in Browse/Run, across matching screens/options/
  intervals/pages, offline mutation handling, and last-write-wins results.

### Sprint 9 — NIFTY 100 Expansion and Final Validation

- After all prior sprints pass, add the reviewed NIFTY 100 catalogue.
- Add `scripts/update_nifty100_catalogue.py` for manually supplied
  constituent/provider mapping updates; do not automatically refresh from NSE.
- Keep desktop catalogue eligibility separate from trading `SUPPORTED_SYMBOLS`.
- Extend search, history, preflight, live, replay, Stepwise, and option
  eligibility to NIFTY 100 equities.
- Validate every catalogue mapping and representative workflows, including
  four-tile mixed layouts, paging, run takeover, minimized recovery, drawings,
  and indicators.
- Produce unsigned internal Windows prototype artifacts, release notes,
  log-collection instructions, and a Windows 10/11 smoke-test checklist.

### Desktop API Additions

- Existing authentication gains JWT token bundles plus refresh and
  logout/revocation.
- `/api/desktop/v1` adds capabilities, catalogue, option metadata, historical
  pages, preflight jobs, screen CRUD with Browse/Run state, drawing CRUD,
  explicit live start/stop/snapshot/SSE, and replay/Stepwise controls,
  snapshots, and SSE.
- Stream payloads contain a version, generation, event ID, shared timestamp,
  tile identity, and per-tile availability.
- Persistence responses contain stable IDs, mutation IDs, and server revisions.

### Implementation Assumptions

1. The five currently supported symbols are the initial validation scope;
   NIFTY 100 is final-sprint work only.
2. A stopped run remains visible at its final shared state until a user
   explicitly returns to Browse.
3. Invalid option contracts stay selected and blank with an explanation; they
   are never automatically replaced.
4. Background continuity applies while the desktop process remains running.
   Sleep, termination, server restart, and external stream loss reconcile from
   authoritative snapshots.
5. Microsoft Store signing, certification, updater hosting, and production
   telemetry follow internal prototype validation.
