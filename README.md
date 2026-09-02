# CrowdDJ-style Song Request Site — Project Status

Last updated: 2026-09-02. Written so any Claude session (or human) can pick this up cold.

## What this is

A multi-tenant, browser-based song request system. Each event is an independent
slug (`/e/<slug>`) with its own queue, settings, and Spotify DJ connection.
Single Node/Express server (`server.js`), file-backed event store
(`eventStore.js`, one JSON file per event under `data/events/`), no database.

Pages: `index.html` (guest), `kiosk.html` (shared on-site device), `admin.html`
(DJ dashboard), `new-event.html` (event creation).

## Architecture notes worth knowing before touching this

- **Auth**: admin routes use a per-event password (scrypt-hashed), sent as an
  `x-admin-password` header on every request — not a session cookie. This is
  deliberate: it makes CSRF a non-issue since the header can't be set by a
  cross-site page automatically.
- **Guest identity**: an httpOnly `crowddj_vid` cookie assigns each guest a
  voter ID, used for per-voter request/vote cooldowns and credit tracking.
- **Spotify integration**: DJ connects their own Spotify (PKCE-ish flow,
  `user-modify-playback-state` + `user-read-playback-state` scopes). Guest
  requests get pushed to the DJ's live Spotify queue (`spotifyAutoQueueEnabled`).
  The now-playing poller hits `/v1/me/player` (not `/currently-playing`) so it
  also captures device name, volume, shuffle, and repeat state in one call.

## Features that exist and work

- Guest request/vote/credit system with admin overrides, genre/decade filters,
  explicit/radio-edit toggles, queue cap.
- Kiosk mode (shared device, always requests as a fixed identity, no per-guest
  UI like "My Requests").
- **Admin Playback tab** (added this project): real transport controls —
  play/pause/next/previous/seek/volume/shuffle/repeat — riding the DJ's
  existing Spotify scope. No new auth needed, just routes that were never
  wired up before. Backend: `/e/:slug/api/admin/playback/*`. Also surfaces a
  live "Up Next" preview.
  - **Known Spotify limitation, not a bug**: `GET /v1/me/player/queue` only
    ever returns the current track + next 20 items, hard API cap, not
    adjustable. Anything auto-queued beyond that is still really queued and
    will still play — it just won't show in the "Up Next" panel.
- **Venue location** (this diverged across sessions — see below).

## ⚠️ Two different "venue location" features exist — reconcile before shipping

Mid-project, work happened in two different Claude sessions/accounts in
parallel and they built genuinely different things under the same name:

1. **Geofencing check-in** (built in one session, later chat-only, may not be
   in your current files): DJ captures venue lat/lng once via browser
   geolocation while standing at the venue; guest's own phone does a silent
   geolocation check on load and is blocked from requesting until verified
   (within a radius) or they enter a venue code — matches how the real
   crowdDJ app does it (GPS + fallback code shown on a physical screen,
   24h verification window).
2. **Venue pin at creation + map picker** (what's in the current uploaded
   files): organizer drops a pin for the venue when creating the event
   (`new-event.html`), stored as `venueLatitude`/`venueLongitude`/`venueName`
   on the event itself. Guest-facing "Change Venue" screen with a venue
   list + map (`getActiveEventsSummary()` in `eventStore.js`) lets guests
   *find* events near them.

These solve different problems (#1 = "prove you're physically here before you
can request", #2 = "help guests discover which event to join") and could
coexist, but weren't designed together. **Decide whether you want both, and
if so, wire #1's guest-side verification gate into the current codebase** —
right now the "prove you're here" gate doesn't exist in the live version.

## Known gap — not yet fixed

**No per-IP rate limiting on `/api/request`, `/api/vote`, `/api/kiosk-request`,
or `/api/search`.** Only event creation and admin login attempts are
rate-limited (`createEventLimiter`, `adminAuthLimiter` in `server.js`). Guest
identity is a self-issued cookie with no server-side requirement to send one
back — a script that simply omits the `Cookie` header gets a fresh voter ID
(and fresh credits/cooldowns) on every single call, fully bypassing the
credit/cooldown system and able to spam `/api/search` (3 parallel Spotify
calls per hit) hard enough to burn the DJ's Spotify API quota for everyone.

**Fix**: add `express-rate-limit` (already a dependency) per-IP to those four
routes, on top of the existing per-voter checks.

## Smaller open items

- Admin password minimum is 4 characters — cheap to raise to 8+.
- `playedHistory` array has no cap (unlike `queueHistoryLog`, capped at 3000)
  — could grow unbounded over a very long-running event.
- Consider labeling the "Up Next" panel to make the Spotify 20-item cap less
  surprising (e.g. "Up Next (next 20)").

## How to avoid re-losing context like this again

This doc exists because two sessions diverged with no way to reconcile.
Recommended going forward:
1. Put this project in a git repo (GitHub) — one source of truth, real
   history, any session can pull latest instead of re-uploading `.txt` files.
2. Keep this file updated as the running status doc — paste/attach it at the
   start of any new chat or account before asking for changes.
