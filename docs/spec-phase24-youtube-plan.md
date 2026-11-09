# Phase 24 follow-up: YouTube upload, saved links, desktop player

Status (2026-11-09): Y1 merged (#789). Recording auto-stop in PR. Y2 upload, Y3 saved links, Y4 player planned, one PR each. Tool code stays on `dev` only. Builds on the Video Maker (see `spec-phase24-implementation-plan.md`).

## Decisions (user, 2026-11-09)
- **Permission:** upload only (`https://www.googleapis.com/auth/youtube.upload`). The app cannot edit, delete or list videos, and cannot set a thumbnail. Privacy/description changes are done in YouTube Studio.
- **Links:** kept on the server, tied to the trading session (so Analysis and other devices can show them).
- **Default visibility:** private.
- Playing: local mp4 in the desktop with clickable chapters. No YouTube embed (a private video will not play in an embed unless the window is signed in to YouTube); "Open on YouTube" opens the system browser.

## What Google needs (user does these, in the Google Cloud project that owns the desktop client id)
1. APIs & Services > Library > enable **YouTube Data API v3**.
2. OAuth consent screen > Data access / Scopes > add `youtube.upload`.
3. Add the uploading Google account as a **Test user** (while the app is in Testing).
4. Note: in Testing status the refresh token expires after about 7 days (reconnect weekly). Publishing the app (unverified is acceptable for personal use, it shows a warning screen) removes that.
5. Note: videos uploaded through the API from a project created after July 2020 that has not passed YouTube's API audit are forced to **private**. Change visibility in YouTube Studio, or apply for the audit. Both notes are to be re-checked against Google's current documentation in Sprint Y1.
6. The upload goes to the channel chosen on Google's consent screen (the login account may own several channels).
7. Quota: default 10,000 units/day; one upload costs 1,600, so about 6 uploads a day.

## Design
- **Connect YouTube** button in the Video Maker. A second OAuth round (same loopback callback as login, PKCE, `access_type=offline`, `prompt=consent`) asking only for `youtube.upload`. The login flow is not changed. The YouTube refresh token is stored in the Windows Credential Manager under its own entry, never sent to the server.
- **Upload** in Rust (`reqwest`, resumable upload protocol): start session with `snippet` (title up to 100 characters, description up to 5000 bytes with no `<` or `>`, tags, category) and `status` (`privacyStatus`, `selfDeclaredMadeForKids=false`), then send the file in chunks with progress events and cancel. Resume after a dropped connection. Needs a confirmation step before upload (it publishes content outside the app).
- **Saved links:** new table (for example `VideoLinks`, key `session_id` + `video_id`) written through a small desktop endpoint under `/api/desktop/v1/` that checks the session belongs to the caller. Fields: `youtube_video_id`, `url`, `title`, `privacy`, `uploaded_at`, `chapters`. Not part of any trading path. Analysis can later show the link next to the session.
- **Player:** a `<video>` element on the local mp4 using Tauri's local-file support (`asset:` protocol scope for the chosen folder, and `media-src` in the CSP), with the chapter list as clickable seek points. Videos whose local file is gone show only the YouTube link.

## Sprints (each one PR into `dev`, merge commit, docs inside; doc-only changes go straight to `dev`)
- **Y0:** this document (done) and the Google console steps by the user.
- **Y1: Connect YouTube.** Rust: second OAuth round, keyring entry, token refresh, `youtube_status` / `youtube_connect` / `youtube_disconnect` commands. UI: connect/disconnect and the connected channel name is not available with upload-only scope, so show "Connected" only. Tests: authorize URL, token form, refresh logic.
- **Y2: Upload.** Resumable upload, progress, cancel, retry, friendly errors (quota exceeded, not connected, channel missing, token expired). UI: title/description/visibility form with a confirm step. Tests: request building, chunking, resume with a local fake server.
- **Y3: Saved links.** Backend table, endpoints, ownership checks, tests (CI); desktop saves after a successful upload and lists links in the Video Maker. Optional: show the link in Analysis.
- **Y4: Player.** Local playback with chapter seek points, "Open on YouTube", "Open folder".

## Out of scope
Editing or deleting uploaded videos, thumbnails, playlists, scheduled publishing, the YouTube audit, and the website (desktop only).

## Y1 as built (connect)
- `windowsapp/src-tauri/src/youtube.rs`: second Google sign-in in the system browser (PKCE, loopback port 8765, same Google client and secret as the app login, fetched from the server's `google-config`), scope `youtube.upload` only, `access_type=offline`, `prompt=consent`. 3-minute wait for the browser, then a clear timeout message. Only the OAuth redirect counts (a stray `/favicon.ico` request is ignored). State is checked.
- The result is stored in Windows Credential Manager under its own target `TradeMatangi.Desktop.YouTube`: refresh token, current access token and expiry, and the client id/secret needed to refresh. Nothing goes to the server and the WebView never sees a token.
- If the consent screen is shown with the upload box unticked, the response lacks the scope and the app says so instead of saving a useless connection.
- `youtube_status` refreshes an expired access token. If Google answers `invalid_grant` (revoked, or the 7-day Testing expiry) the stored connection is deleted and the card says it ended. Offline keeps the connection. `youtube::access_token()` is what Y2 uses.
- `youtube_disconnect` asks Google to revoke the grant (best effort) and deletes the stored entry.
- UI: a "YouTube" card at the bottom of the Video Maker (`YoutubeConnect.tsx`): Connect / Disconnect and Google's error text (for example the Test users hint).
- A different Trade Matangi user on the same PC would share this YouTube connection (it is per Windows user, not per Trade Matangi account). Logging out of Trade Matangi does not disconnect it.
- Tests: 8 Rust unit tests (authorize URL, callback parsing, token response and scope check, refresh, freshness margin, error wording, storage format). The card was checked in a browser page with a mocked `invoke` (connect, waiting state, connected, disconnect, error). Not run against real Google.
- **Manual check (Windows build):** Video Maker > YouTube > Connect YouTube; the browser opens Google; pick the account/channel and tick the upload permission; the page says "connected"; the card shows "YouTube is connected". Close and reopen the app: still connected. Disconnect: back to Connect. Also try declining on Google's screen and confirm the message.

## Recording auto-stop (added 2026-11-09, dev only)
Stopping a trading session did not stop the screen recording, so the video kept recording dead footage. The recorder now stops 10 seconds after every session on screen has ended (see `docs/recording-metadata.md`, "Automatic stop"). Not on `preprod` yet.
