const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const events = require('./eventStore');
// @distube/ytdl-core checks GitHub for its own updates on require by
// default - harmless normally, but seen 403'ing in production (GitHub
// rate-limiting the check itself) and adds noise/latency for something
// that has nothing to do with actually serving requests. Must be set
// before the require() below; setting it in Render's own env vars would
// also work, but doing it here means it's not a step anyone deploying
// this can forget.
process.env.YTDL_NO_UPDATE = '1';
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 10000;

// --- Rate limiting ---
// Event creation needs no auth at all (anyone can spin one up), so without a
// limit it's a free unauthenticated way to burn disk, memory, and CPU (every
// create does a real scrypt hash). 20/hour/IP is generous for someone
// legitimately setting up an event and still shuts down a flood.
const createEventLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many events created from this address recently. Try again later.' }
});

// Applies to every /e/:slug/api/admin/* call. skipSuccessfulRequests means a
// DJ typing their correct password repeatedly is never affected - only wrong
// guesses count against the limit, which is what actually matters for both
// brute-force resistance and stopping a flood of bad guesses from queuing up
// expensive scrypt verifications.
const adminAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.params.slug}`,
    message: { error: 'Too many failed admin attempts. Try again later.' }
});

// Account signup/login - same shape as adminAuthLimiter (only failures
// count), keyed by IP alone since there's no per-event slug to scope it to.
const accountAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts. Try again later.' }
});

// Forgot-password is rate-limited harder and on BOTH outcomes (not just
// failures) - each successful call sends a real email through Brevo's daily
// quota, so this needs to cap total volume, not just brute-force guessing.
const forgotPasswordLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reset requests from this address. Try again later.' }
});

// Render (and most hosts) terminate HTTPS at a proxy in front of your app -
// needed so secure cookies and req.protocol behave correctly.
app.set('trust proxy', 1);

app.use(express.json());

const VOTER_COOKIE = 'crowddj_vid';

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
}

// Assigns every guest a server-issued, HttpOnly identity cookie, scoped to
// this one event's path (/e/{slug}) rather than the whole site. This is what
// credits/votes/request-history are keyed on, instead of a voterId the client
// generates itself - a value the client fully controls can be reset just by
// clearing localStorage, which defeats the point of a "credit limit". Scoping
// the cookie's path per-event also means the same guest visiting two
// different events on the same phone gets two independent identities/credit
// banks, same as if they were two totally separate sites.
function voterIdentityMiddleware(req, res, next) {
    const slug = req.params.slug;
    const cookieName = VOTER_COOKIE;
    const cookies = parseCookies(req);
    let vid = cookies[cookieName];
    // Because the cookie is path-scoped, a guest with no cookie for THIS event's
    // path may still be sending a cookie of the same name scoped to a different
    // event's path - the browser only sends the one matching the current path,
    // so this is safe, but we always re-issue if it's missing rather than trust
    // a value that might have leaked in from elsewhere.
    if (!vid) {
        vid = crypto.randomUUID();
        res.cookie(cookieName, vid, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: `/e/${slug}`,
            maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
        });
    }
    req.serverVoterId = vid;
    next();
}

// { index: false } stops express.static from auto-serving public/index.html
// for GET '/' - without this, requests to the bare root would silently serve
// the guest page directly, bypassing new-event.html and every /e/:slug route
// below entirely (since static-file serving runs before our own routes).
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
// Optional - the Music Videos lane (see getActiveMusicVideoRule) simply
// never matches anything without this set, same as any other Spotify/
// Brevo feature here degrading gracefully when its key is absent.
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || '').trim();

// --- Account sessions -------------------------------------------------
// Deliberately in-memory only, never written to Redis. That's not a
// shortcut - it's what makes "log back in after a Render restart" true for
// free: a restart wipes this Map by definition, no separate expiry logic
// needed for that case. Sliding inactivity timeout and manual logout both
// just operate on the same Map.
const ACCOUNT_COOKIE = 'crowddj_session';
const SESSION_IDLE_TIMEOUT_MS = 72 * 60 * 60 * 1000; // 72 hours of inactivity
const accountSessions = new Map(); // token -> { username, lastUsedAt }

function createAccountSession(username) {
    const token = crypto.randomUUID();
    accountSessions.set(token, { username, lastUsedAt: Date.now() });
    return token;
}

// Reads the session cookie, validates + slides its expiry, and returns the
// logged-in username or null. Called on every request that cares about
// account state - cheap, since it's just a Map lookup, not a Redis call.
function getSessionUsername(req) {
    const cookies = parseCookies(req);
    const token = cookies[ACCOUNT_COOKIE];
    if (!token) return null;
    const session = accountSessions.get(token);
    if (!session) return null;
    if (Date.now() - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) {
        accountSessions.delete(token);
        return null;
    }
    session.lastUsedAt = Date.now();
    return session.username;
}

function destroySessionFromCookie(req) {
    const cookies = parseCookies(req);
    const token = cookies[ACCOUNT_COOKIE];
    if (token) accountSessions.delete(token);
}

function setSessionCookie(res, token) {
    res.cookie(ACCOUNT_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 1000 * 60 * 60 * 24 * 30 // 30-day cap on the cookie itself; the
        // 60-hour idle timeout above is what actually ends a session sooner
    });
}

// Periodic sweep so a browser that never explicitly logs out doesn't leave
// its entry sitting in memory forever - mirrors evictIdleEvents in eventStore.js.
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of accountSessions.entries()) {
        if (now - session.lastUsedAt > SESSION_IDLE_TIMEOUT_MS) accountSessions.delete(token);
    }
}, 1000 * 60 * 15);

// Gate for routes that require a logged-in account (creating an event,
// viewing "My Events", etc).
function requireAccountAuth(req, res, next) {
    const username = getSessionUsername(req);
    if (!username) return res.status(401).json({ error: 'Please log in first.' });
    req.accountUsername = username;
    next();
}

// --- Password-reset email (Brevo) --------------------------------------
// Plain REST call, same style as the Upstash calls in eventStore.js - no
// SMTP driver or SDK needed. BREVO_FROM_EMAIL must be verified as a sender
// in the Brevo dashboard before this will deliver to real recipients (their
// shared/unverified state only delivers to the Brevo account's own inbox).
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const BREVO_FROM_EMAIL = (process.env.BREVO_FROM_EMAIL || '').trim();
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'Song Request Station';

async function sendPasswordResetEmail(toEmail, resetUrl) {
    if (!BREVO_API_KEY || !BREVO_FROM_EMAIL) {
        console.error('[EMAIL] Missing BREVO_API_KEY / BREVO_FROM_EMAIL env vars - reset email not sent.');
        return false;
    }
    try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'api-key': BREVO_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                sender: { email: BREVO_FROM_EMAIL, name: BREVO_FROM_NAME },
                to: [{ email: toEmail }],
                subject: 'Reset your Song Request Station password',
                htmlContent: `
                    <p>Someone requested a password reset for your Song Request Station account.</p>
                    <p><a href="${resetUrl}">Click here to set a new password</a> (expires in 30 minutes).</p>
                    <p>If this wasn't you, you can safely ignore this email - your password hasn't changed.</p>
                `
            })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[EMAIL] Brevo send failed (${res.status}):`, text);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[EMAIL] Brevo send error:', err.message);
        return false;
    }
}

// Optional master admin password (set as ADMIN_PASSWORD in Render's env vars).
// Lets you get into ANY event's admin page - and close it - without knowing
// that event's individual password. If it's not set, this feature is simply
// off and every event falls back to needing its own password, same as before.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// --- DJ Spotify Queue Relay ---
// Separate from the client-credentials token below (which only reads the public
// catalog for search) and separate from guests' own read-only PKCE login. This is
// a one-time Authorization Code login as the DJ's own Spotify account, which is
// the only kind of token Spotify accepts for POST /me/player/queue - adding to
// *your* actual playback queue requires the user-modify-playback-state scope,
// which can only be granted by that account logging in, not by an app-only token.
//
// Every event gets its own DJ connection/refresh token (stored on the event
// itself, see eventStore.js) - but Spotify's redirect URI has to be one fixed,
// exactly-registered URL, it can't vary per event. So the login flow's `state`
// param is what carries "which event is this for" through the round trip to
// the one shared callback route below.
//
// Required env vars:
//   SPOTIFY_REDIRECT_URI - e.g. https://your-app.onrender.com/admin/spotify-callback
//                           Must be registered exactly (including https and path)
//                           in your Spotify Developer Dashboard app settings.
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const DJ_QUEUE_SCOPES = 'user-modify-playback-state user-read-playback-state';

// Exchanges an event's stored DJ refresh token for a fresh access token,
// caching it on the event until shortly before it expires. Returns null
// (rather than throwing) if DJ queueing isn't set up yet for this event, so
// callers can treat "not configured" and "temporarily failed" the same way:
// just skip queueing, never block a guest's request.
async function getDjAccessToken(event) {
    const sp = event.spotify;
    if (!sp.djRefreshToken) return null;
    if (sp.djAccessToken && Date.now() < sp.djAccessTokenExpiresAt - 30000) return sp.djAccessToken;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(sp.djRefreshToken)
        });
        const data = await response.json();
        if (!data.access_token) {
            console.error(`[SPOTIFY QUEUE] Refresh failed for "${event.slug}":`, data.error_description || data.error);
            return null;
        }
        sp.djAccessToken = data.access_token;
        sp.djAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        // Spotify occasionally rotates the refresh token on use. Persisted state
        // means we just save the new one - no manual env var update needed.
        if (data.refresh_token && data.refresh_token !== sp.djRefreshToken) {
            sp.djRefreshToken = data.refresh_token;
        }
        events.scheduleSave(event.slug);
        return sp.djAccessToken;
    } catch (err) {
        console.error(`[SPOTIFY QUEUE] Token refresh error for "${event.slug}":`, err.message);
        return null;
    }
}

// Adds a track to the DJ's live Spotify playback queue. Fails silently (logged,
// not thrown) so a guest's request always succeeds locally even if the DJ's
// Spotify isn't open, isn't Premium, or hasn't been connected yet.
async function queueTrackOnSpotify(event, trackId) {
    const token = await getDjAccessToken(event);
    if (!token) return false;
    try {
        const uri = `spotify:track:${trackId}`;
        const res = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204 || res.status === 200) {
            console.log(`[SPOTIFY QUEUE] (${event.slug}) Added to live queue:`, trackId);
            return true;
        } else if (res.status === 404) {
            console.warn(`[SPOTIFY QUEUE] (${event.slug}) No active device - open Spotify and play something first.`);
        } else if (res.status === 403) {
            console.warn(`[SPOTIFY QUEUE] (${event.slug}) Forbidden - this usually means the account is not Spotify Premium.`);
        } else {
            const body = await res.text();
            console.error(`[SPOTIFY QUEUE] (${event.slug}) Unexpected response`, res.status, body);
        }
        return false;
    } catch (err) {
        console.error(`[SPOTIFY QUEUE] (${event.slug}) Request failed:`, err.message);
        return false;
    }
}

// Extracts a bare playlist ID from whatever format the DJ pastes in -
// a full open.spotify.com URL (with or without query params), a spotify:
// URI, or just the bare ID itself.
function extractSpotifyPlaylistId(input) {
    if (!input) return null;
    const str = input.trim();
    let match = str.match(/playlist[\/:]([a-zA-Z0-9]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9]+$/.test(str)) return str; // already a bare ID
    return null;
}

// Immediately switches Spotify's active playback to a new playlist. Unlike
// queueTrackOnSpotify (which adds one track ahead of whatever's already
// queued), this REPLACES the current context entirely - Spotify clears
// whatever it had lined up next from the old playlist and starts fresh
// from the new one. This is what "kill the old playlist's up-next and
// switch" actually requires; there's no way to just clear Spotify's
// auto-generated queue without starting new context playback.
async function switchDjPlaylist(event, playlistUri) {
    const token = await getDjAccessToken(event);
    if (!token) return { success: false, error: 'Admin Spotify account is not connected yet.' };

    const playlistId = extractSpotifyPlaylistId(playlistUri);
    if (!playlistId) return { success: false, error: 'Could not parse a playlist ID from that link.' };

    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/play', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ context_uri: `spotify:playlist:${playlistId}` })
        });
        if (res.status === 204 || res.status === 200) {
            console.log(`[SPOTIFY QUEUE] (${event.slug}) Switched playlist to:`, playlistId);
            return { success: true };
        } else if (res.status === 404) {
            return { success: false, error: 'No active device - open Spotify and play something first, then try switching again.' };
        } else if (res.status === 403) {
            return { success: false, error: 'Forbidden - this usually means the account is not Spotify Premium.' };
        } else {
            const body = await res.text();
            console.error(`[SPOTIFY QUEUE] (${event.slug}) Switch failed`, res.status, body);
            return { success: false, error: `Spotify rejected the switch (status ${res.status}).` };
        }
    } catch (err) {
        console.error(`[SPOTIFY QUEUE] (${event.slug}) Switch request failed:`, err.message);
        return { success: false, error: 'Request to Spotify failed.' };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Shared by every transport-control route below (play/pause/next/previous/
// volume/shuffle/repeat) - same token lookup and same 404 (no active
// device)/403 (not Premium) handling switchDjPlaylist already uses, just
// generalized to any method/path/query on the /me/player resource instead
// of only the "start context playback" call.
async function spotifyPlayerCommand(event, method, playerPath, query = '') {
    const token = await getDjAccessToken(event);
    if (!token) return { success: false, error: 'Admin Spotify account is not connected yet.' };
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player${playerPath}${query}`, {
            method,
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204 || res.status === 200) {
            // Spotify accepting the command (204) doesn't mean GET /me/player
            // reflects it yet - Spotify Connect's own state propagation
            // commonly lags 0.5-1.5s behind the command being accepted,
            // regardless of how fast we ask. Re-syncing instantly just reads
            // the pre-command state back into our cache, which is worse than
            // not syncing at all - the admin UI shows the button flip, then
            // immediately shows it flip back, then has to wait for the next
            // 4s background tick to catch the real change. A short wait here
            // means the sync this request already does is actually current
            // by the time it lands, instead of a guaranteed-stale read.
            await sleep(500);
            await syncNowPlayingForEvent(event);
            return { success: true };
        }
        if (res.status === 404) return { success: false, error: 'No active device - open Spotify and play something first.' };
        if (res.status === 403) return { success: false, error: 'Forbidden - this usually means the account is not Spotify Premium.' };
        const body = await res.text();
        console.error(`[SPOTIFY PLAYER] (${event.slug}) ${method} ${playerPath} failed`, res.status, body);
        return { success: false, error: `Spotify rejected the request (status ${res.status}).` };
    } catch (err) {
        console.error(`[SPOTIFY PLAYER] (${event.slug}) ${method} ${playerPath} request failed:`, err.message);
        return { success: false, error: 'Request to Spotify failed.' };
    }
}

// --- Music Scheduler ---------------------------------------------------
// A day/time timetable (event.musicScheduler.rules) that drives playlist
// switches, volume, and requests-open/closed automatically, so a venue
// doesn't need someone flipping settings by hand throughout the day. This
// is meant to be the main way playback is driven once it's set up - the
// timetable is expected to usually cover the whole week. The admin's
// manually-set Fallback Playlist (systemConfigs.fallbackPlaylistUri) is
// just the safety net for whatever gaps remain, not the normal case.
//
// The tricky part is the playlist switch: switchDjPlaylist() above is
// immediate and will cut off whatever's currently playing. A schedule
// boundary firing mid-song should NEVER do that - not even by a couple of
// seconds. Instead, a due switch is held in schedulerRuntime.pendingSwitchUri
// until it's actually safe:
//   1. Any guest-requested songs still in the local queue play out first
//      (they always take priority over the schedule).
//   2. Once the guest queue is empty, we wait for the track that's
//      currently playing to actually finish, then switch.
//
// "Waiting for it to finish" used to be a one-shot timer sized to the
// track's predicted remaining duration (durationMs - progressMs). That's a
// PREDICTION of when the track ends, and predictions can be wrong: Spotify
// crossfade moves the real audible boundary earlier than the reported
// duration implies, and progressMs is only as fresh as the last poll, so
// the estimate drifts. Either one lets an entire extra track from the old
// playlist start - and the switch would then land in the middle of it.
//
// This is now reactive instead of predictive: we track the trackId that
// was playing when the switch became pending (schedulerBoundaryWatch,
// below) and only fire the switch once a poll observes the trackId has
// actually changed - i.e. Spotify itself has already moved past that
// track. There's no more guessing about *when* it'll end. The only
// remaining source of delay is polling latency itself (we only know a
// change happened once we next poll), which is why syncAllLoadedEvents
// polls an event with a pending switch every tick instead of every 4s -
// see SCHEDULER_FAST_POLL_MS below - to keep that gap as small as
// possible rather than up to a full normal poll interval late.

// HH:MM -> minutes since midnight. Returns null for anything malformed so
// callers can just skip a bad rule instead of crashing on it.
function parseHHMM(str) {
    if (typeof str !== 'string') return null;
    const m = str.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// The HH:MM values on every rule are wall-clock times in whatever timezone
// the DJ was in when they built the schedule (event.musicScheduler.timezone,
// sent by scheduler.html on every save) - NOT the server process's own
// timezone. A server on Render runs in UTC regardless of where any given
// event's venue is, so comparing "now" via now.getHours()/getDay() (the
// server's own local time) against those HH:MM values would check them
// against the wrong hours entirely for anyone outside UTC+0 - rules would
// just never fire at the times they were actually dragged onto the
// timeline. This resolves "now" inside the event's own saved zone instead,
// via Intl's IANA tz database rather than a fixed numeric offset (so DST
// transitions are handled automatically, same as they would be for a
// person actually standing at the venue).
function getEventLocalTime(event, now = new Date()) {
    const tz = event.musicScheduler?.timezone;
    if (!tz) {
        // No timezone on file yet - this is either a schedule saved before
        // this fix existed, or one that was never saved at all. Falling
        // back to the server's own local time keeps this from throwing,
        // but it's almost certainly wrong for the DJ's actual venue; the
        // scheduler.html banner tells them to re-save once to attach a
        // real zone.
        return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
    }
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(now);
        const map = {};
        for (const p of parts) map[p.type] = p.value;
        const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday];
        let hour = parseInt(map.hour, 10);
        if (hour === 24) hour = 0; // some locales render midnight as "24" with hour12:false
        return { day: weekdayIndex, minutes: hour * 60 + parseInt(map.minute, 10) };
    } catch (err) {
        console.error(`[SCHEDULER] (${event.slug}) Invalid saved timezone "${tz}", falling back to server local time:`, err.message);
        return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
    }
}

// Finds whichever rule in `candidateRules` should be "on" right now, or null
// if none match. Supports overnight windows (e.g. 22:00-02:00) by checking
// the wrapped range separately from the normal same-day range. If two rules
// somehow overlap, the first match in array order wins - the Scheduler UI is
// expected to prevent admins from creating overlaps in the first place
// (within a lane - see findOverlappingRulePair's per-lane grouping).
function findActiveRuleAmong(candidateRules, event, now) {
    if (candidateRules.length === 0) return null;
    const { day, minutes } = getEventLocalTime(event, now);
    for (const rule of candidateRules) {
        const start = parseHHMM(rule.start);
        const end = parseHHMM(rule.end);
        if (start === null || end === null || !Array.isArray(rule.days) || rule.days.length === 0) continue;
        const overnight = end <= start;
        if (!overnight) {
            if (rule.days.includes(day) && minutes >= start && minutes < end) return rule;
        } else {
            // e.g. 22:00-02:00: "on" either from `start` to midnight on a
            // listed day, or from midnight to `end` on the day AFTER a
            // listed day (yesterday's window spilling into today).
            const yesterday = (day + 6) % 7;
            if (rule.days.includes(day) && minutes >= start) return rule;
            if (rule.days.includes(yesterday) && minutes < end) return rule;
        }
    }
    return null;
}

// Music-lane rules only (crowdDJ/Karaoke) - this is what actually drives
// playlist switching, volume, and requests-open/closed, so an Ambient
// Visuals block (laneType 'ambient') or a Music Videos block (laneType
// 'musicvideo') must never be returned here even though they live in the
// same `rules` array. Rules saved before laneType existed are music rules
// by definition (Ambient Visuals/Music Videos didn't exist yet).
function getActiveScheduleRule(event, now = new Date()) {
    const rules = (event.musicScheduler?.rules || []).filter(r => r.laneType !== 'ambient' && r.laneType !== 'musicvideo');
    return findActiveRuleAmong(rules, event, now);
}

// Ambient-lane rules only - parallel to getActiveScheduleRule above, used
// by whatever eventually renders the Ambient Visuals lane's output (a kiosk
// screen, a standalone display, etc.) rather than by the audio-switching
// logic. Can be "on" at the same time as a music rule - visuals and audio
// aren't mutually exclusive the way two music blocks are.
function getActiveAmbientRule(event, now = new Date()) {
    const rules = (event.musicScheduler?.rules || []).filter(r => r.laneType === 'ambient');
    return findActiveRuleAmong(rules, event, now);
}

// Music-Videos-lane rules only - parallel to getActiveAmbientRule above.
// Whatever eventually decides "should we even try to show a music video
// right now" should gate on this first, then apply its own per-track
// matching/confidence rules on top - this only answers the scheduling
// half of that question. Shares the screen with Ambient Visuals (see
// findOverlappingRuleAcrossLanes), so it can be "on" at the same time as
// a music rule but never at the same time as an ambient rule.
function getActiveMusicVideoRule(event, now = new Date()) {
    const rules = (event.musicScheduler?.rules || []).filter(r => r.laneType === 'musicvideo');
    return findActiveRuleAmong(rules, event, now);
}

// --- Music Videos matching (YouTube) --------------------------------------
// Deliberately strict, per explicit rule: a video is only ever offered if
// (1) it comes from a channel that IS one of the track's own artists -
// never a fan channel, compilation, reaction video, etc. - (2) its title
// actually names this song, not just any video of theirs with a similar
// runtime, and (3) it isn't a lyric video or an audio-only upload. There's
// no "good enough" tier below that; anything that fails any of them is
// treated exactly like no match at all, and the display falls back to
// Ambient Visuals.

// Strips everything but letters/digits down to lowercase so "Ed Sheeran",
// "EdSheeranVEVO", and "ed-sheeran official" all normalize to something
// that can be reliably substring-matched against each other regardless of
// spacing, punctuation, or a VEVO/Official suffix glued onto the name.
function normalizeForMatch(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Checked against every credited artist (not just the first), since a
// channel belonging to any one of them - e.g. a featured artist uploading
// the same official video - is legitimate too.
function channelMatchesAnyArtist(channelTitle, artistNames) {
    const normalizedChannel = normalizeForMatch(channelTitle);
    if (!normalizedChannel) return false;
    return artistNames.some(name => {
        const normalizedName = normalizeForMatch(name);
        return normalizedName.length > 0 && normalizedChannel.includes(normalizedName);
    });
}

// \baudio\b (a word boundary, not a plain substring) so this never
// wrongly rejects a title that happens to contain "audio" as part of an
// unrelated word - it's still meant to catch "Official Audio", "(Audio)",
// "Audio Only", etc.
//
// Item 3: extended with the same word-boundary approach to also exclude
// live/concert recordings from VIDEO candidate selection - "live," "concert,"
// "in concert," "tour," "live at," "live performance," "unplugged," and
// "acoustic session" all describe real footage of a real performance, so
// this is a different problem from item 4's static-image check or item 5's
// content-moderation check: a live cut is legitimate, watchable content
// that's simply the wrong ARTIFACT for this feature, which drives the
// display in lockstep with Spotify's STUDIO audio - a live version's
// different tempo/arrangement/crowd noise will never actually stay in sync,
// no matter how good the offset detection is. Several of these patterns
// overlap (any "live at ..." title already matches the bare \blive\b
// pattern) - kept as separate entries anyway so the list reads as an
// explicit, auditable checklist rather than relying on one broad pattern
// to implicitly cover the rest.
// Deliberately NOT applied to getReferenceAudioEnvelope's search (the
// ground-truth audio lookup) - that path already avoids "video" heuristics
// like this one on purpose, for a different reason (see its own comment).
//
// TUNING NOTE: this is a title heuristic sitting in front of the real
// backstop - the audio cross-correlation step in findAudioVerifiedMusicVideo
// - so it can in principle wrongly exclude a legitimate official video that
// happens to be built from live-performance footage but is synced to
// studio audio underneath. The audio check is what should actually be
// trusted if that turns out to be a real problem in practice; if false
// rejections from this list become common, consider relaxing it from a
// hard exclusion to a "deprioritize, don't reject outright" signal (e.g.
// sort these candidates to the back of the queue instead of dropping them)
// rather than removing the check entirely. Not implemented now - noted
// here for whoever tunes this next.
const DISQUALIFYING_TITLE_PATTERNS = [
    /lyric/i,
    /\baudio\b/i,
    /\blive\b/i,
    /\bconcert\b/i,
    /\bin concert\b/i,
    /\btour\b/i,
    /\blive at\b/i,
    /\blive performance\b/i,
    /\bunplugged\b/i,
    /\bacoustic session\b/i
];
function titleLooksDisqualified(title) {
    return DISQUALIFYING_TITLE_PATTERNS.some(re => re.test(title || ''));
}

// A video whose length differs from the song's by more than this almost
// certainly isn't a genuine candidate at all (wrong song, a compilation, a
// full alternate edit) - not worth the bandwidth of even downloading its
// audio to check further. This is DELIBERATELY loose: it's only a cheap
// pre-filter for "is this worth analyzing", not the thing that decides
// whether a video is actually in sync. That decision now belongs to the
// audio-verification step below (findAudioVerifiedMusicVideo), which
// listens to the actual audio instead of guessing from total runtime - a
// video can pass this duration check and still fail verification (a
// different edit that happens to be a similar length), and in principle a
// video could fail a tighter duration check yet still be a perfectly
// synced upload (a long spoken intro) - verification is what actually
// decides that now, this just avoids wasting a download on the obviously
// wrong ones.
const MUSIC_VIDEO_MAX_DURATION_DIFF_MS = 60000;

// "PT3M45S" / "PT1H2M3S" -> milliseconds (null if unparseable, e.g. live "P0D").
function parseIsoDurationMs(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso || '');
    if (!m) return null;
    const ms = ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
    return ms > 0 ? Math.round(ms) : null;
}

// --- Item 9: minimize YouTube Data API quota usage --------------------------
// Default quota is 10,000 units/day per project. search.list costs 100
// units/call; playlistItems.list, channels.list and videos.list each cost
// only 1. Every new track used to cost at least 200 units (one search.list
// for the video candidate, one for the reference audio) before any actual
// matching happened - easily exhausted once a few events are running at
// once (this project has already hit 429 quotaExceeded in production). The
// functions below try a 1-unit path first - an artist's own channel
// uploads, once that channel is known - and only fall back to the 100-unit
// search.list when a channel can't be confidently identified or its
// uploads don't contain anything usable.

const YOUTUBE_DAILY_QUOTA_BUDGET = Number(process.env.YOUTUBE_DAILY_QUOTA_BUDGET) || 10000;
const YOUTUBE_QUOTA_SAFETY_MARGIN_UNITS = 300; // stop issuing search.list well before actually hitting the wall

let youtubeQuotaUsedToday = 0;
let youtubeQuotaDayKey = null;

// Resets at midnight Pacific, matching Google's own daily quota reset.
// Uses Intl's timezone handling rather than a manual UTC offset so DST is
// handled for free.
function youtubeQuotaDateKey() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
}

function youtubeQuotaRolloverIfNeeded() {
    const key = youtubeQuotaDateKey();
    if (key !== youtubeQuotaDayKey) {
        youtubeQuotaDayKey = key;
        youtubeQuotaUsedToday = 0;
    }
}

// Call BEFORE issuing a request of the given cost. Cheap (1-unit) calls are
// allowed right up to the real limit; only the expensive search.list calls
// respect the extra safety margin, since those are what actually drives
// exhaustion, and it's safe to just skip one (falling back to "couldn't
// verify this track right now") rather than degrade a 1-unit lookup that
// was already going to happen anyway.
function youtubeQuotaAvailable(units) {
    youtubeQuotaRolloverIfNeeded();
    const margin = units >= 100 ? YOUTUBE_QUOTA_SAFETY_MARGIN_UNITS : 0;
    return (youtubeQuotaUsedToday + units) <= (YOUTUBE_DAILY_QUOTA_BUDGET - margin);
}

// Counts every moment a YouTube lookup FAILED or was SKIPPED (quota budget out,
// HTTP error, network error, missing key). An empty result that follows any
// of these is "we couldn't ask", not "there's nothing there" - callers snapshot
// this before a lookup and compare after, and must never cache or persist a
// "no match" conclusion if it moved. (Being global, an unrelated failure in a
// concurrent lookup can also move it - that only errs toward "retry later",
// never toward wrongly caching a miss.)
let youtubeFailureCount = 0;
function youtubeNoteFailure(reason) {
    youtubeFailureCount++;
    console.warn(`[MUSIC VIDEO] YouTube lookup failed/skipped (${reason}) - result will not be cached as a miss.`);
}

function youtubeQuotaRecord(units, callType, detail) {
    youtubeQuotaRolloverIfNeeded();
    youtubeQuotaUsedToday += units;
    console.log(`[MUSIC VIDEO] YouTube API: ${callType} cost ${units} unit(s) (${youtubeQuotaUsedToday}/${YOUTUBE_DAILY_QUOTA_BUDGET} used today)${detail ? ' - ' + detail : ''}`);
}

// Wraps a single YouTube Data API fetch with capped exponential backoff on
// 429 specifically (quota/rate-limit responses). Previously a 429 just got
// logged and given up on immediately, re-triable by the very next poll,
// which did nothing but spend the retry hitting the same wall again. Any
// other failure (network error, 5xx, malformed response) still fails
// immediately, same as before - backoff only makes sense for "the server is
// telling me to wait", not general errors.
async function youtubeFetchWithBackoff(url, maxRetries = 2) {
    let attempt = 0;
    while (true) {
        const res = await fetch(url);
        if (res.status !== 429 || attempt >= maxRetries) return res;
        const waitMs = 500 * Math.pow(3, attempt); // 500ms, then 1500ms
        await new Promise(r => setTimeout(r, waitMs));
        attempt++;
    }
}

// videoIds -> Map<videoId, durationMs>. Pulled out of youtubeSearchVideos so
// both the search.list path and the new cheap artist-uploads path below can
// share this exact 1-unit lookup instead of each keeping their own copy.
async function youtubeFetchDurations(videoIds) {
    if (videoIds.length === 0) return new Map();
    if (!youtubeQuotaAvailable(1)) { youtubeNoteFailure('videos.list skipped, quota budget exhausted'); return new Map(); }
    try {
        const res = await youtubeFetchWithBackoff(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`);
        youtubeQuotaRecord(1, 'videos.list', `${videoIds.length} video(s), duration lookup`);
        if (!res.ok) { youtubeNoteFailure(`videos.list returned ${res.status}`); return new Map(); }
        const data = await res.json();
        return new Map((data.items || []).map(i => [i.id, parseIsoDurationMs(i.contentDetails?.duration)]));
    } catch (e) {
        console.error('[MUSIC VIDEO] YouTube duration lookup failed:', e.message);
        youtubeNoteFailure('videos.list threw');
        return new Map();
    }
}

// artistNameNormalized -> uploads playlist ID, or null if none could be
// confidently identified. Deliberately permanent/in-memory only (not
// persisted like verifiedMusicVideoCache) - losing it on a restart just
// costs the next track by that artist one extra search.list call, a far
// smaller loss than losing real audio-verification work would be.
// artistChannelInFlight de-dupes concurrent lookups the same way
// verificationInFlight does for trackId in triggerMusicVideoVerification -
// several tracks by the same artist queued close together share one search
// instead of each starting their own.
const artistChannelCache = new Map();
const artistChannelInFlight = new Map();

// Cheap first guess at an artist's channel: many official artist/VEVO
// channels have a predictable handle (@artistname, @artistnameVEVO). This
// costs 1 unit per guess via channels.list?forHandle= - trying two guesses
// (2 units total) before ever reaching for the 100-unit search.list below
// is a strict improvement whenever it hits, and costs nothing extra when it
// doesn't (the search.list fallback still runs exactly as before). Verifies
// the returned channel's own title actually contains the artist name before
// trusting it - a handle guess resolving to some unrelated channel that
// happens to exist under that name is the one way this could go wrong, so
// it gets the same sanity check the search.list path already applies.
async function tryResolveChannelByHandle(artistName) {
    const slug = artistName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!slug) return null;
    const key = normalizeForMatch(artistName);
    for (const handle of [slug, `${slug}vevo`]) {
        if (!youtubeQuotaAvailable(1)) { youtubeNoteFailure('channels.list skipped, quota budget exhausted'); return null; }
        try {
            const res = await youtubeFetchWithBackoff(`https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent('@' + handle)}&key=${YOUTUBE_API_KEY}`);
            youtubeQuotaRecord(1, 'channels.list', `handle guess "@${handle}" for "${artistName}"`);
            if (res.ok) {
                const data = await res.json();
                const item = data.items?.[0];
                if (item && normalizeForMatch(item.snippet?.title || '').includes(key)) {
                    return item.contentDetails?.relatedPlaylists?.uploads || null;
                }
            } else {
                youtubeNoteFailure(`channels.list returned ${res.status}`);
            }
        } catch (e) {
            console.error(`[MUSIC VIDEO] Handle guess "@${handle}" failed for "${artistName}":`, e.message);
            youtubeNoteFailure('channels.list threw');
        }
    }
    return null;
}

// The reference-audio lookup and the video-candidate lookup for the SAME
// track both end up calling youtubeListArtistUploads for the same artist -
// without this, that's two playlistItems.list + two videos.list calls per
// track instead of one. Short TTL (not permanent, unlike artistChannelCache
// above) because an artist's actual uploads genuinely change over time; this
// is about collapsing near-simultaneous calls for the same track (and
// nearby calls for other tracks by the same artist), not caching a channel's
// contents indefinitely.
//
// artistUploadsListInFlight closes a real race the cache alone didn't:
// several DIFFERENT tracks by the same artist verified concurrently (e.g.
// a big backlog of queued tracks all triggering at once on server
// restart) each call this function before any of them finish, so each one
// sees an empty cache and fetches independently - four duplicate
// playlistItems.list calls for the same artist within a couple of seconds
// was observed in production logs. Same fix as artistChannelInFlight above,
// applied one level down: the first caller's in-flight promise is what
// every concurrent caller for that playlist ID awaits, not a fresh fetch.
const ARTIST_UPLOADS_LIST_TTL_MS = 10 * 60 * 1000;
const artistUploadsListCache = new Map(); // uploadsPlaylistId -> { videos, fetchedAt }
const artistUploadsListInFlight = new Map(); // uploadsPlaylistId -> Promise<videos>

async function fetchArtistUploadsList(uploadsPlaylistId, artistName, maxResults) {
    if (!youtubeQuotaAvailable(1)) { youtubeNoteFailure('playlistItems.list skipped, quota budget exhausted'); return []; }
    try {
        const res = await youtubeFetchWithBackoff(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${maxResults}&playlistId=${uploadsPlaylistId}&key=${YOUTUBE_API_KEY}`);
        youtubeQuotaRecord(1, 'playlistItems.list', `uploads for "${artistName}"`);
        if (!res.ok) { youtubeNoteFailure(`playlistItems.list returned ${res.status}`); return []; }
        const data = await res.json();
        const videos = (data.items || [])
            .map(item => ({
                videoId: item.snippet?.resourceId?.videoId,
                title: item.snippet?.title || '',
                channelTitle: item.snippet?.channelTitle || '',
                durationMs: null
            }))
            .filter(v => v.videoId);
        if (videos.length > 0) {
            const durations = await youtubeFetchDurations(videos.map(v => v.videoId));
            videos.forEach(v => { v.durationMs = durations.get(v.videoId) ?? null; });
        }
        return videos;
    } catch (e) {
        console.error(`[MUSIC VIDEO] Artist-uploads lookup failed for "${artistName}":`, e.message);
        youtubeNoteFailure('playlistItems.list threw');
        return [];
    }
}

// The cheap path: list an artist's own uploads (1 unit) and let the
// existing downstream filtering (title/duration matching in
// getReferenceAudioEnvelope, disqualification rules in
// findAudioVerifiedMusicVideo) pick out whatever's usable from it - same
// shape of result as youtubeSearchVideos, so callers can fall back to that
// without a special case. Tries each artist name in order (a feat. credit
// after the primary artist, say) and stops at the first channel that
// actually has uploads to offer.
async function youtubeListArtistUploads(artistNames, maxResults = 50) {
    for (const artistName of artistNames) {
        const uploadsPlaylistId = await resolveArtistUploadsPlaylistId(artistName);
        if (!uploadsPlaylistId) continue;

        const cached = artistUploadsListCache.get(uploadsPlaylistId);
        if (cached && (Date.now() - cached.fetchedAt) < ARTIST_UPLOADS_LIST_TTL_MS) {
            if (cached.videos.length > 0) return cached.videos;
            continue;
        }

        let promise = artistUploadsListInFlight.get(uploadsPlaylistId);
        if (!promise) {
            const failuresBefore = youtubeFailureCount;
            promise = fetchArtistUploadsList(uploadsPlaylistId, artistName, maxResults).then(videos => {
                // A list fetched during a failure (quota out, HTTP error, or
                // durations missing) is incomplete - don't let it sit in the
                // cache for the TTL and keep every track by this artist
                // looking like it has no usable video.
                if (youtubeFailureCount === failuresBefore) {
                    artistUploadsListCache.set(uploadsPlaylistId, { videos, fetchedAt: Date.now() });
                }
                return videos;
            });
            artistUploadsListInFlight.set(uploadsPlaylistId, promise);
            promise.finally(() => artistUploadsListInFlight.delete(uploadsPlaylistId));
        }

        const videos = await promise;
        if (videos.length > 0) return videos;
    }
    return [];
}

async function resolveArtistUploadsPlaylistId(artistName) {
    const key = normalizeForMatch(artistName);
    if (!key) return null;
    if (artistChannelCache.has(key)) return artistChannelCache.get(key);
    if (artistChannelInFlight.has(key)) return artistChannelInFlight.get(key);

    const promise = (async () => {
        const failuresBefore = youtubeFailureCount;
        let uploadsPlaylistId = await tryResolveChannelByHandle(artistName);
        try {
            if (!uploadsPlaylistId && !youtubeQuotaAvailable(100)) youtubeNoteFailure('channel search.list skipped, quota budget exhausted');
            if (!uploadsPlaylistId && youtubeQuotaAvailable(100)) {
                const searchRes = await youtubeFetchWithBackoff(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=3&q=${encodeURIComponent(artistName + ' official')}&key=${YOUTUBE_API_KEY}`);
                youtubeQuotaRecord(100, 'search.list', `channel lookup for "${artistName}"`);
                if (!searchRes.ok) youtubeNoteFailure(`channel search.list returned ${searchRes.status}`);
                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const candidateId = (searchData.items || [])
                        .map(i => ({ channelId: i.id?.channelId, title: i.snippet?.channelTitle || '' }))
                        .find(c => c.channelId && normalizeForMatch(c.title).includes(key))?.channelId;
                    if (candidateId && youtubeQuotaAvailable(1)) {
                        const channelRes = await youtubeFetchWithBackoff(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${candidateId}&key=${YOUTUBE_API_KEY}`);
                        youtubeQuotaRecord(1, 'channels.list', `uploads playlist for "${artistName}"`);
                        if (channelRes.ok) {
                            const channelData = await channelRes.json();
                            uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
                        } else {
                            youtubeNoteFailure(`channels.list returned ${channelRes.status}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`[MUSIC VIDEO] Channel resolution failed for "${artistName}":`, e.message);
            youtubeNoteFailure('channel resolution threw');
        }
        // Cache the miss too, not just a hit - an artist with no confidently
        // identifiable channel shouldn't cost a fresh search.list on every
        // single track of theirs that ever gets requested.
        // ...but only a REAL miss. A miss recorded while the quota was out
        // (or a request failed) would otherwise stick for the life of the
        // process, long after the quota resets.
        if (uploadsPlaylistId || youtubeFailureCount === failuresBefore) {
            artistChannelCache.set(key, uploadsPlaylistId);
        }
        return uploadsPlaylistId;
    })();

    artistChannelInFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        artistChannelInFlight.delete(key);
    }
}

// Tries the cheap artist-uploads path first, only spending a search.list
// call if that comes back empty (no identifiable channel, or that channel's
// uploads don't contain anything usable). This is what both call sites
// below should use instead of calling youtubeSearchVideos directly.
async function youtubeFindCandidates(artistNames, fallbackQuery, songTitle) {
    const cheap = await youtubeListArtistUploads(artistNames);
    if (cheap.length > 0) {
        // The uploads list is only the channel's most recent ~50 videos. For
        // anything older, or a song whose video lives elsewhere, that list is
        // non-empty but contains nothing for THIS song - and returning it
        // meant the paid search below never ran, so the track was then
        // (wrongly) recorded as "no video exists". Only trust the cheap list
        // if at least one entry's title actually names the song.
        const core = normalizeForMatch(coreSongTitle(songTitle));
        if (!core || cheap.some(v => normalizeForMatch(v.title).includes(core))) return cheap;
    }
    return youtubeSearchVideos(fallbackQuery);
}

// Raw YouTube Data API v3 text search, restricted to embeddable videos.
// Returns [] on any failure (missing key, quota exhausted, network) rather
// than throwing - a YouTube outage should just mean "no music video for
// this track", never a broken poll for the display. This is the expensive
// fallback (100 units) - see youtubeFindCandidates above, which tries the
// cheap artist-uploads path first and only reaches this when that comes up
// empty.
async function youtubeSearchVideos(query, maxResults = 10) {
    if (!YOUTUBE_API_KEY) {
        console.error('[MUSIC VIDEO] YOUTUBE_API_KEY is not set - skipping search.');
        youtubeNoteFailure('YOUTUBE_API_KEY not set');
        return [];
    }
    if (!youtubeQuotaAvailable(100)) {
        console.warn(`[MUSIC VIDEO] Skipping search.list for "${query}" - daily YouTube quota budget exhausted, falling back to ambient visuals for this track.`);
        youtubeNoteFailure('search.list skipped, quota budget exhausted');
        return [];
    }
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
        const res = await youtubeFetchWithBackoff(url);
        youtubeQuotaRecord(100, 'search.list', query);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`[MUSIC VIDEO] YouTube search returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
            youtubeNoteFailure(`search.list returned ${res.status}`);
            return [];
        }
        const data = await res.json();
        const videos = (data.items || [])
            .map(item => ({
                videoId: item.id?.videoId,
                title: item.snippet?.title || '',
                channelTitle: item.snippet?.channelTitle || '',
                durationMs: null
            }))
            .filter(v => v.videoId);
        // One cheap videos.list call (1 unit for all candidates together) to
        // get each video's real length. If it fails, durationMs stays null
        // and pickBestMusicVideo then refuses every candidate: a video whose
        // length can't be checked can't be trusted to be in sync.
        if (videos.length > 0) {
            const durations = await youtubeFetchDurations(videos.map(v => v.videoId));
            videos.forEach(v => { v.durationMs = durations.get(v.videoId) ?? null; });
        }
        return videos;
    } catch (e) {
        console.error('[MUSIC VIDEO] YouTube search failed:', e.message);
        youtubeNoteFailure('search.list threw');
        return [];
    }
}

// Strips everything from the first bracketed qualifier - "(feat. X)",
// "(Radio Edit)", "[Explicit]" - or the first " - " separator onward,
// whichever comes first, leaving just the song's own name to match
// against. Spotify decorates track titles with all sorts of suffixes
// after one of those two separators - "- Sped Up Version", "- Remix",
// "- Radio Edit", "- Live", "- feat. X", "(with X)" - that essentially
// never appear on the actual official video's title, so keeping them in
// the string being matched was rejecting plenty of genuinely correct
// videos, not just wrong ones. A bare hyphen with no surrounding spaces
// (as in "Anti-Hero") isn't a separator here and is left alone.
function coreSongTitle(title) {
    return (title || '')
        .split(/[\(\[]/)[0]
        .split(/\s-\s/)[0]
        .trim();
}

// Runs every strictness rule in one place, in order, against the search
// results for one track - the first candidate to pass all of them (and
// that hasn't already failed sync/playback for this exact track - see
// excludeVideoIds) is the one offered. No candidate passing means no
// match at all, not a fallback to a looser rule.
function pickBestMusicVideo(candidates, artistNames, excludeVideoIds, trackDurationMs, trackTitle) {
    if (!trackDurationMs) return null;
    // Without this, a candidate only had to come from the right channel,
    // not lyric/audio, and land within the duration window to be offered -
    // nothing ever actually confirmed it was a video FOR THIS SONG. An
    // artist with several tracks of similar length could have a totally
    // different one of their own videos picked and pass every check. This
    // is deliberately a substring match on the core title (not exact
    // equality) so "Official Video" suffixes, punctuation, and spelled-out
    // features don't sink an otherwise-correct match.
    const trackCore = normalizeForMatch(coreSongTitle(trackTitle));
    if (!trackCore) return null;
    const eligible = [];
    candidates.forEach((v, index) => {
        if (excludeVideoIds.has(v.videoId)) return;
        if (titleLooksDisqualified(v.title)) return;
        if (!channelMatchesAnyArtist(v.channelTitle, artistNames)) return;
        if (!normalizeForMatch(v.title).includes(trackCore)) return;
        if (typeof v.durationMs !== 'number') return; // length unknown -> can't verify sync
        const diff = Math.abs(v.durationMs - trackDurationMs);
        if (diff > MUSIC_VIDEO_MAX_DURATION_DIFF_MS) return;
        // Closest length wins (bucketed to 0.5s so YouTube's whole-second
        // rounding doesn't outrank search relevance); ties keep search order.
        eligible.push({ v, bucket: Math.round(diff / 500), index });
    });
    eligible.sort((a, b) => (a.bucket - b.bucket) || (a.index - b.index));
    return eligible.length ? eligible[0].v : null;
}

// --- Audio-verified matching ---------------------------------------------
// The old approach only checked total video length against the track's
// length, then guessed the intro offset by looking for literal silence at
// the front. Both were weak proxies for the thing that actually matters:
// is this video's audio the SAME RECORDING as the track, in step with it,
// start to finish? A video can be the right length while being a
// different edit throughout (a longer bridge, a shorter outro cancelling
// each other out) - no fixed offset fixes that, and it can have a
// perfectly real, non-silent cold open (dialogue, a sound effect, a drum
// count-in) that the silence detector simply never saw.
//
// This replaces both checks with one: pull a chunk of audio from a
// candidate video, pull a chunk of REFERENCE audio for the same track
// (a plain official-audio upload - see getReferenceAudioEnvelope), and
// directly compare them. That gives both a precise offset (however the
// intro is built, silent or not) AND a confidence score that tells us
// whether the video is really the same recording all the way through
// (see findAudioVerifiedMusicVideo below) - not just "the same length".

// How many seconds of audio to pull from the front of each track/video for
// comparison. Long enough to give the correlation something to lock onto
// even through a real intro; short enough to keep every download+decode
// bounded regardless of how long the actual song runs.
const MUSIC_VIDEO_AUDIO_WINDOW_SEC = 100;
// Coarse loudness samples per second. Deliberately low-resolution: this
// compares OVERALL ENERGY OVER TIME (like a rough amplitude envelope), not
// raw waveform, which is what makes it tolerant of two different YouTube
// encodes of the same recording (different loudness normalization, EQ,
// bitrate) - the actual waveforms differ, but the loudness contour over
// time doesn't.
const MUSIC_VIDEO_ENVELOPE_RATE_HZ = 50;
const MUSIC_VIDEO_PCM_SAMPLE_RATE = 4000; // decode rate fed into the envelope reducer, not the final resolution
const MUSIC_VIDEO_SAMPLES_PER_ENVELOPE_POINT = MUSIC_VIDEO_PCM_SAMPLE_RATE / MUSIC_VIDEO_ENVELOPE_RATE_HZ;
// How far off the front the true offset could plausibly be - generous
// enough for any real cold open, tight enough to keep the search cheap.
const MUSIC_VIDEO_MAX_OFFSET_SEARCH_SEC = 20;
// A genuine full-length match against a same-length window scores at or
// near 1.0 even across different encodes/loudness (tested up to ~1.0 on
// clean and re-encoded audio); a video that only matches for PART of the
// window (a different edit partway through) lands roughly mid-range
// (~0.4-0.5); unrelated audio scores near 0. 0.55 sits cleanly above the
// "partial match" band, so a video only has to clear it if the correlation
// found a genuine match across the WHOLE analyzed window, not just a
// portion of it.
const MUSIC_VIDEO_MATCH_ACCEPT_CONFIDENCE = 0.55;
// Reference audio (see getReferenceAudioEnvelope) is expected to be the
// exact studio master - its own runtime should match Spotify's reported
// duration almost exactly, unlike a "video" candidate which may
// legitimately run longer. A wide gap here means we found someone's cover,
// a remix, or the wrong song entirely - not something worth trusting as
// ground truth.
const MUSIC_VIDEO_REFERENCE_MAX_DURATION_DIFF_MS = 4000;
const MUSIC_VIDEO_MAX_CANDIDATES_TO_VERIFY = 5;
const MUSIC_VIDEO_AUDIO_DOWNLOAD_TIMEOUT_MS = 20000;
// A small negative measured offset is just noise around a true ~0 (the
// video's content genuinely starts right at its own front) - the display
// already clamps the applied offset at 0 (see mvTargetSec), so nothing
// further to do there. A LARGE negative offset means something different:
// the video is missing content the reference has at ITS start (a trimmed
// intro) - the video's own 0:00 is actually already partway into the song.
// A positive-only "start further into the video" offset cannot fix that
// (there's no "start further into the song" equivalent on this side), so
// past this tolerance the candidate is rejected outright rather than
// clamped, same as any other confirmed non-match.
const MUSIC_VIDEO_NEGATIVE_OFFSET_NOISE_TOLERANCE_MS = 500;

// Downloads audioonly from a YouTube video and reduces it to a coarse
// loudness-over-time envelope. Resolves to null (never throws/rejects) on
// any failure - a broken download just means "can't verify this one",
// never a crash or a hung request; callers already treat null as "skip
// this candidate" or "couldn't confirm anything either way", per their own
// comments below.
function extractAudioEnvelope(videoId, maxDurationSec) {
    return new Promise((resolve) => {
        let audioStream;
        try {
            audioStream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
                quality: 'lowestaudio',
                filter: 'audioonly'
            });
        } catch (e) {
            console.error(`[MV-MATCH] Could not open audio stream for ${videoId}:`, e.message);
            return resolve(null);
        }

        let ff;
        try {
            ff = spawn(ffmpegPath, [
                '-i', 'pipe:0',
                '-t', String(maxDurationSec),
                '-ac', '1',
                '-ar', String(MUSIC_VIDEO_PCM_SAMPLE_RATE),
                '-f', 's16le',
                'pipe:1'
            ]);
        } catch (e) {
            console.error(`[MV-MATCH] Could not start ffmpeg for ${videoId}:`, e.message);
            return resolve(null);
        }

        const chunks = [];
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            try { ff.kill('SIGKILL'); } catch (e) { /* already gone */ }
            finish(null);
        }, MUSIC_VIDEO_AUDIO_DOWNLOAD_TIMEOUT_MS);

        ff.stdout.on('data', (chunk) => chunks.push(chunk));
        ff.stderr.on('data', () => {}); // ffmpeg's own progress chatter - not needed here
        ff.on('error', (e) => {
            console.error(`[MV-MATCH] ffmpeg error for ${videoId}:`, e.message);
            finish(null);
        });

        audioStream.on('error', (e) => {
            console.error(`[MV-MATCH] Audio stream error for ${videoId}:`, e.message);
            try { ff.kill('SIGKILL'); } catch (e2) { /* already gone */ }
            finish(null);
        });
        audioStream.pipe(ff.stdin);

        ff.on('close', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length < MUSIC_VIDEO_PCM_SAMPLE_RATE * 2 * 3) return finish(null); // <3s decoded - not enough to compare
            const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
            const envLen = Math.floor(samples.length / MUSIC_VIDEO_SAMPLES_PER_ENVELOPE_POINT);
            const envelope = new Float64Array(envLen);
            for (let i = 0; i < envLen; i++) {
                let sum = 0;
                const base = i * MUSIC_VIDEO_SAMPLES_PER_ENVELOPE_POINT;
                for (let j = 0; j < MUSIC_VIDEO_SAMPLES_PER_ENVELOPE_POINT; j++) {
                    sum += Math.abs(samples[base + j] / 32768);
                }
                envelope[i] = sum / MUSIC_VIDEO_SAMPLES_PER_ENVELOPE_POINT;
            }
            finish(envelope);
        });
    });
}

// Slides `probeEnvelope` against `refEnvelope` across every lag in the
// search window and returns the lag that maximizes their correlation,
// plus a confidence score (a true Pearson correlation coefficient, -1..1,
// of just the overlapping window at that lag).
//
// IMPORTANT: normalization is computed fresh from each lag's own
// overlapping slice, not from the whole envelope up front. Reusing a
// whole-signal z-score here let short, edge-of-search-range overlaps
// occasionally look like a "perfect" match purely by chance, since a small
// enough slice can agree by coincidence - requiring a large minimum
// overlap AND normalizing per-window is what makes the confidence score
// mean what it's supposed to mean.
function crossCorrelateEnvelopes(refEnvelope, probeEnvelope, maxLagSec, minOverlapFraction = 0.8) {
    const maxLagSamples = Math.round(maxLagSec * MUSIC_VIDEO_ENVELOPE_RATE_HZ);
    const minOverlapSamples = Math.floor(Math.min(refEnvelope.length, probeEnvelope.length) * minOverlapFraction);

    let bestLag = 0;
    let bestScore = -Infinity;

    for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
        const start = Math.max(0, lag);
        const end = Math.min(refEnvelope.length, probeEnvelope.length + lag);
        const overlapLen = end - start;
        if (overlapLen < minOverlapSamples) continue;

        let sumR = 0, sumP = 0;
        for (let i = start; i < end; i++) { sumR += refEnvelope[i]; sumP += probeEnvelope[i - lag]; }
        const meanR = sumR / overlapLen, meanP = sumP / overlapLen;
        let varR = 0, varP = 0, cov = 0;
        for (let i = start; i < end; i++) {
            const dr = refEnvelope[i] - meanR;
            const dp = probeEnvelope[i - lag] - meanP;
            varR += dr * dr; varP += dp * dp; cov += dr * dp;
        }
        const score = cov / (Math.sqrt(varR * varP) || 1e-9);
        if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    // bestLag > 0 means the PROBE (candidate video) needed to be shifted
    // backward to line up - i.e. it has that much extra lead-in content
    // the reference doesn't. videoLeadMs is the app's existing convention
    // (see mvTargetSec in visual-display.html): a POSITIVE number means
    // "the video needs to seek further ahead of the raw song position by
    // this much" - which is exactly -bestLag in this loop's own indexing
    // (probe[i - lag] means a positive lag shifts probe's timeline back).
    return {
        videoLeadMs: Math.round((-bestLag / MUSIC_VIDEO_ENVELOPE_RATE_HZ) * 1000),
        confidence: bestScore
    };
}

// --- Item 4: static "album cover" rejection, + Item 5: content-moderation
// gate - combined, because item 5 explicitly reuses item 4's sampled
// frames instead of sampling the video twice -----------------------------
// Some uploads billed as the "official video" are just a static image (the
// album cover, usually) with the whole song playing behind it - audio-
// verified genuinely real, since the audio itself is often the actual
// studio master, but not a real MUSIC VIDEO in any sense worth putting on a
// screen at an event. The audio cross-correlation above can't catch this -
// the audio is fine - so item 4 is a second, independent signal: motion.
// Separately, item 5 is a content-safety check: some sampled frame content
// simply shouldn't be shown, regardless of how well it syncs. Both checks
// need frames sampled evenly across the CANDIDATE'S ENTIRE RUNTIME (not
// just the front, unlike the audio check's MUSIC_VIDEO_AUDIO_WINDOW_SEC
// window - a static cover, or a brief inappropriate clip, tacked onto the
// front or back of an otherwise-fine video would sail past a front-loaded
// sample either way) - so rather than each running its own sampling pass,
// they share one: grabFramePairAt below grabs a single frame per timestamp
// and produces BOTH the small JPEG item 5's moderation check needs and the
// even-smaller downscaled grayscale buffer item 4's motion-diff needs, in
// one ffmpeg invocation per timestamp (two mapped outputs, not two seeks).

// How many frames to sample across the whole video. Low - this only needs
// to distinguish "basically nothing ever changes" from "this is a real
// video" (item 4), and to give item 5's moderation check reasonable
// coverage without exploding cost - not to produce a precise motion curve.
// Every extra sample is another ffmpeg process spawned per candidate.
const MUSIC_VIDEO_MOTION_SAMPLE_COUNT = 10;
// Per-frame grab timeout - one stuck/slow sample (a network hiccup on just
// that one ranged request) shouldn't hang the whole check; grabFramePairAt
// just resolves null for that sample instead, same convention as
// everything else in this feature.
const MUSIC_VIDEO_MOTION_FRAME_TIMEOUT_MS = 8000;
// The grayscale frame used for item 4's motion diff is downscaled hard -
// cheap to diff, and coarse enough that ordinary video-compression noise
// between two visually identical frames of a genuinely static image
// doesn't register as "motion".
const MUSIC_VIDEO_MOTION_FRAME_WIDTH = 32;
const MUSIC_VIDEO_MOTION_FRAME_HEIGHT = 18;
// The JPEG frame handed to item 5's moderation check needs to actually be
// legible to a classifier (or a human reviewing flagged content later),
// so it's kept much larger than the motion-diff frame - still small enough
// to keep bandwidth/API payload size down.
const MUSIC_VIDEO_MODERATION_FRAME_WIDTH = 160;
const MUSIC_VIDEO_MODERATION_FRAME_HEIGHT = 90;
// Average per-pixel grayscale difference (0-255 scale) between consecutive
// sampled frames, below which a candidate is treated as a static image.
// START CONSERVATIVE (per the implementation prompt) - this constant has
// not been empirically tuned against a real library of static-cover
// uploads yet, so treat it as a first guess: revisit once there's real
// data on where genuine static-image uploads land versus real videos that
// happen to have long, genuinely still moments (a slow ballad's static
// shot, a held closeup). A low, permissive threshold here only lets more
// through, so it's the safer direction to start from than a high one that
// might reject real videos.
const MUSIC_VIDEO_MOTION_MIN_AVG_DIFF = 4;

// Grabs ONE frame from a YouTube video at a given timestamp and produces
// both representations items 4 and 5 need from it, in a single ffmpeg
// invocation rather than seeking to the same timestamp twice: the JPEG
// (item 5's moderation input) comes out ffmpeg's normal stdout (fd 1), and
// the downscaled grayscale raw buffer (item 4's motion-diff input) comes
// out a second, explicitly mapped output on an extra pipe (fd 3) - Node's
// spawn() is given a 4th stdio slot to receive it. Seeks with `-ss` before
// `-i` against the video's own direct CDN URL (a ranged HTTP request, not
// a full download) rather than piping the whole stream through ytdl the
// way extractAudioEnvelope does - there's no reason to pull minutes of
// video just to grab one frame.
// Resolves to null (never throws/rejects) on any failure, same convention
// as extractAudioEnvelope - a failed sample just means "skip this sample
// point", not a crash.
function grabFramePairAt(videoUrl, timestampSec) {
    return new Promise((resolve) => {
        let ff;
        try {
            ff = spawn(ffmpegPath, [
                '-ss', String(Math.max(0, timestampSec)),
                '-i', videoUrl,
                '-map', '0:v:0', '-frames:v', '1',
                '-vf', `scale=${MUSIC_VIDEO_MODERATION_FRAME_WIDTH}:${MUSIC_VIDEO_MODERATION_FRAME_HEIGHT}`,
                '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
                '-map', '0:v:0', '-frames:v', '1',
                '-vf', `scale=${MUSIC_VIDEO_MOTION_FRAME_WIDTH}:${MUSIC_VIDEO_MOTION_FRAME_HEIGHT},format=gray`,
                '-f', 'rawvideo', 'pipe:3'
            ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        } catch (e) {
            console.error('[MV-MATCH] Could not start ffmpeg for frame grab:', e.message);
            return resolve(null);
        }

        const jpegChunks = [];
        const grayChunks = [];
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            try { ff.kill('SIGKILL'); } catch (e) { /* already gone */ }
            finish(null);
        }, MUSIC_VIDEO_MOTION_FRAME_TIMEOUT_MS);

        ff.stdout.on('data', (chunk) => jpegChunks.push(chunk));
        ff.stdio[3].on('data', (chunk) => grayChunks.push(chunk));
        ff.stderr.on('data', () => {}); // ffmpeg's own progress chatter - not needed here
        ff.on('error', (e) => {
            console.error('[MV-MATCH] ffmpeg error during frame grab:', e.message);
            finish(null);
        });
        ff.on('close', () => {
            const jpeg = Buffer.concat(jpegChunks);
            const grayBuf = Buffer.concat(grayChunks);
            const expectedGrayBytes = MUSIC_VIDEO_MOTION_FRAME_WIDTH * MUSIC_VIDEO_MOTION_FRAME_HEIGHT; // 1 byte/pixel, grayscale
            if (jpeg.length === 0 || grayBuf.length < expectedGrayBytes) return finish(null);
            finish({ jpeg, gray: grayBuf.subarray(0, expectedGrayBytes) });
        });
    });
}

// Pure helper for item 4: average per-pixel grayscale difference between
// each consecutive pair of already-sampled frames. Low means "looks
// static", high means "looks like a real video". Returns null if fewer
// than 2 frames came back (not enough to compare), which callers treat as
// "couldn't verify this signal" rather than a rejection.
function averageConsecutiveFrameDiff(grayFrames) {
    if (grayFrames.length < 2) return null;
    let totalDiff = 0;
    for (let i = 1; i < grayFrames.length; i++) {
        const a = grayFrames[i - 1], b = grayFrames[i];
        let diff = 0;
        for (let p = 0; p < a.length; p++) diff += Math.abs(a[p] - b[p]);
        totalDiff += diff / a.length;
    }
    return totalDiff / (grayFrames.length - 1);
}

// --- Item 5: content-moderation gate ---------------------------------------
// Abstracted behind this one function so the underlying image-moderation
// provider - AWS Rekognition, Google Cloud Vision SafeSearch, Azure Content
// Moderator, a self-hosted classifier, whatever ends up chosen - can be
// swapped without touching any of the calling code below it. No provider
// is wired up yet (that needs real API credentials/config this codebase
// doesn't have), so this is currently a stub that reports "not flagged"
// for everything; replace the body with a real call once a provider is
// picked, keeping the same {flagged} shape so nothing else has to change.
//
// REJECT-ONLY: this filter's only job is to catch what it can - a `false`
// here means "nothing was detected", NOT "this frame is confirmed safe",
// and it does not guarantee zero unsafe content ever reaches a screen. See
// item 8's family-mode allowlist for a second, human-reviewed layer for
// events that need a stronger guarantee than an automated classifier can
// give. Newly auto-approved matches (family mode off) should ideally be
// surfaced for a human to review AFTER THE FACT, not gated on that review
// before playing at all - there's no admin surface in this codebase for
// that review queue yet. That's a real feature in its own right, so this
// is left as a documentation/architecture note for whoever builds it next,
// not an implementation here.
async function checkFrameSafety(frameBuffer) {
    // TODO: wire up a real provider here. Example shape, for AWS Rekognition:
    //   const res = await rekognitionClient.send(new DetectModerationLabelsCommand({
    //       Image: { Bytes: frameBuffer }, MinConfidence: 80
    //   }));
    //   return { flagged: (res.ModerationLabels || []).length > 0 };
    return { flagged: false };
}

// Per-video (not per-track) cache of the combined item 4 + item 5 result -
// both are properties of the YOUTUBE VIDEO itself, same reasoning as
// referenceAudioEnvelopeCache below, and combined into one cache (rather
// than one each) because they now share a single frame-sampling pass - see
// the comment above grabFramePairAt. Runtime-only, like the other
// per-video caches on this page: rebuilt fresh on restart, which is fine
// for the motion score (a performance cache, not a safety-critical
// judgment) - the moderation half is reproduced fresh on every restart
// too, which is an intentional trade-off: a persisted moderation verdict
// that later turns out to be wrong (a classifier bug fixed upstream, a
// deliberately reconsidered case) would otherwise survive indefinitely
// with no way to invalidate it, whereas today it's naturally rechecked
// against whatever the provider currently returns after any restart.
// Value: undefined = not checked yet, or { motionScore: number|null,
// moderationFlagged: boolean }.
const frameVerificationCache = new Map();

async function computeFrameVerification(videoId, durationMs) {
    if (!durationMs || durationMs <= 0) return { motionScore: null, moderationFlagged: false };
    let info;
    try {
        info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    } catch (e) {
        console.error(`[MV-MATCH] Could not fetch video info for frame checks on ${videoId}:`, e.message);
        return { motionScore: null, moderationFlagged: false, failed: true }; // couldn't RUN the check - not evidence about the video
    }
    // Only pixels matter here - grab the smallest video stream available
    // rather than spending bandwidth on a high-res one just to immediately
    // downscale everything pulled from it.
    const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'videoandaudio' })
        || ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'video' });
    if (!format || !format.url) return { motionScore: null, moderationFlagged: false, failed: true };

    const durationSec = durationMs / 1000;
    const timestamps = [];
    for (let i = 0; i < MUSIC_VIDEO_MOTION_SAMPLE_COUNT; i++) {
        // Evenly spaced, offset half a slot in from both ends so a sample
        // doesn't land right on a black intro/outro frame that wouldn't be
        // representative of the video's actual content either way.
        timestamps.push(durationSec * (i + 0.5) / MUSIC_VIDEO_MOTION_SAMPLE_COUNT);
    }

    // The one shared sampling pass - see grabFramePairAt's comment for why
    // this replaces what would otherwise be two separate sampling passes
    // (one for item 4, one for item 5).
    const frames = (await Promise.all(timestamps.map(t => grabFramePairAt(format.url, t)))).filter(Boolean);

    // Fewer than two frames means the sampling itself failed (ytdl/ffmpeg
    // errors, timeouts) - there's nothing to diff, and that says nothing
    // about whether the video is static.
    if (frames.length < 2) {
        console.error(`[MV-MATCH] Frame sampling produced ${frames.length} usable frame(s) for ${videoId} - treating the check as failed, not as a rejection.`);
        return { motionScore: null, moderationFlagged: false, failed: true };
    }

    const motionScore = averageConsecutiveFrameDiff(frames.map(f => f.gray));

    // Item 5's moderation check, run across every sampled frame IN PARALLEL
    // (not sequentially, and not sequentially after the motion score above
    // either - Promise.all here, motion diffing already done synchronously
    // above it). Any single flagged frame rejects the candidate outright;
    // scores are never averaged the way the motion score is.
    let moderationFlagged = false;
    if (frames.length > 0) {
        const results = await Promise.all(frames.map(f => checkFrameSafety(f.jpeg).catch(e => {
            console.error(`[MV-MATCH] Moderation check failed for a frame of ${videoId}:`, e.message);
            return { flagged: false }; // a check that couldn't RUN is not evidence of anything - never treated as a flag
        })));
        moderationFlagged = results.some(r => r && r.flagged);
    }

    return { motionScore, moderationFlagged };
}

// Cached wrapper around computeFrameVerification - see frameVerificationCache
// above. The only call site today (findAudioVerifiedMusicVideo below) can
// call this freely per candidate without worrying about re-sampling the
// same video on a replay or a re-verification at a different event.
async function getFrameVerification(videoId, durationMs) {
    if (frameVerificationCache.has(videoId)) return frameVerificationCache.get(videoId);
    const result = await computeFrameVerification(videoId, durationMs);
    if (!result.failed) frameVerificationCache.set(videoId, result); // never cache a check that couldn't run
    return result;
}

// Per-track cache of "what's the ground-truth audio for this song", global
// across every event on the server (not per-event) - whether video X syncs
// with track Y is a fact about those two YouTube uploads, not about which
// venue happens to be playing it. Runtime-only like the rest of this
// feature's state (musicVideoRuntime, schedulerBoundaryWatch): rebuilt from
// scratch on a restart rather than persisted, which is fine here since
// it's just a performance/reliability cache, never the source of truth.
// Value is `undefined` (key absent) = not looked up yet, `null` = looked up
// and no usable reference audio exists for this track, or the envelope
// itself.
const referenceAudioEnvelopeCache = new Map();

// Per-track cache of the FINAL, audio-verified answer: which video (if any)
// actually syncs with this song, and at what offset. Separate from
// referenceAudioEnvelopeCache above (that one caches the ground-truth audio
// itself; this one caches the conclusion reached from it) and, like it,
// global across every event and never persisted - once any event on the
// server has verified a song, every other event that plays it (including
// a replay at the same event) gets the answer instantly with no re-search,
// no re-download, and no waiting on the placeholder-then-upgrade dance
// below. Value is `undefined` (key absent) = not resolved yet, `null` =
// resolved and confirmed no video syncs, or {videoId, introOffsetMs,
// confidence} for a confirmed match.
const verifiedMusicVideoCache = new Map();

// Converts the live Map to a plain object for JSON persistence (see item 2:
// loadMusicVideoCache/scheduleMusicVideoCacheSave in eventStore.js). Read
// fresh at write time by the debounce in eventStore, not snapshotted here -
// see that function's own comment for why.
// Persisted snapshots are stamped with a schema version. Snapshots written
// before the version existed (or by older code) may contain `null` entries
// that were really "the lookup failed" (quota out, ytdl blocked) recorded as
// "no video exists" - on load those are dropped once so the tracks get
// re-verified. Matches (non-null) are always kept.
const MV_CACHE_SCHEMA_KEY = '__schemaVersion';
const MV_CACHE_SCHEMA_VERSION = 3; // 3: earlier "no match" entries came from candidate lists truncated by the cheap-uploads path - purge once
function musicVideoCacheSnapshot() {
    return { ...Object.fromEntries(verifiedMusicVideoCache), [MV_CACHE_SCHEMA_KEY]: MV_CACHE_SCHEMA_VERSION };
}

// --- Item 8: family-mode safety lists ---------------------------------------
// Independent of verifiedMusicVideoCache above, which only answers "is this
// genuinely the same recording" - a technical-match question. These answer
// "is this appropriate to show a family/school audience", a judgment
// verifiedMusicVideoCache was never meant to carry and that automated content
// moderation (item 5) can't fully guarantee on its own - see the Maroon 5
// "This Love" case: a correctly-matched, official, moderation-passing video
// that's still not appropriate for that audience. Both are global (not
// scoped to one event), since a track that's inappropriate at one school
// event is inappropriate everywhere, and a track a human has already vetted
// as family-safe shouldn't need re-vetting at every event either.
//
// musicVideoDenylist: a hard block, trackId only. Checked ahead of
// everything else - triggerMusicVideoVerification refuses to even start the
// verification pipeline for a denylisted track, and the display route below
// refuses to show one regardless of what verifiedMusicVideoCache says,
// covering the case where a track was verified and cached BEFORE it was
// added to the denylist.
// musicVideoAllowlist: the opposite direction, trackId -> the specific
// {videoId, introOffsetMs} a human has manually approved for family-mode
// playback. Only consulted when an event has familyModeEnabled on (see
// ensureVisualsConfigs) - with family mode on, a track plays its video ONLY
// if it's here, regardless of what the automated pipeline concluded. This
// flips the default from "show unless automatically rejected" to "don't
// show unless a human already approved it", which is the actual point of
// family mode.
const musicVideoDenylist = new Set();
const musicVideoAllowlist = new Map();

function familyListsSnapshot() {
    return { denylist: [...musicVideoDenylist], allowlist: Object.fromEntries(musicVideoAllowlist) };
}

// Finds a plain-audio upload of the track itself (not the "official music
// video" - a topic-channel auto-upload, a lyric video, an "Official Audio"
// post) to use as ground truth for comparison. This deliberately does NOT
// reuse titleLooksDisqualified/the video-matching rules above - a lyric
// video or an audio-only upload is disqualified as a VIDEO candidate
// because there's nothing worth watching, but it's exactly what we want as
// a REFERENCE, since it's the most likely upload to be an untouched rip of
// the actual master rather than a re-cut video edit.
async function getReferenceAudioEnvelope(trackId, artistNames, title, durationMs) {
    if (referenceAudioEnvelopeCache.has(trackId)) return referenceAudioEnvelopeCache.get(trackId);
    let result = null;
    let lookupFailed = false;
    const failuresBefore = youtubeFailureCount;
    try {
        const trackCore = normalizeForMatch(coreSongTitle(title));
        const candidates = await youtubeFindCandidates(artistNames, `${artistNames.join(' ')} ${title} audio`, title);
        const eligible = candidates
            .filter(v => channelMatchesAnyArtist(v.channelTitle, artistNames))
            .filter(v => !trackCore || normalizeForMatch(v.title).includes(trackCore)) // same song, not just a similarly-timed one by the same artist
            .filter(v => typeof v.durationMs === 'number' && Math.abs(v.durationMs - durationMs) <= MUSIC_VIDEO_REFERENCE_MAX_DURATION_DIFF_MS)
            .sort((a, b) => Math.abs(a.durationMs - durationMs) - Math.abs(b.durationMs - durationMs));
        if (eligible.length > 0) {
            result = await extractAudioEnvelope(eligible[0].videoId, MUSIC_VIDEO_AUDIO_WINDOW_SEC);
            if (!result) lookupFailed = true; // download/decode failed - a broken ytdl isn't proof there's no reference
        }
    } catch (e) {
        console.error(`[MV-MATCH] Reference audio lookup failed for "${title}":`, e.message);
        lookupFailed = true;
    }
    if (youtubeFailureCount !== failuresBefore) lookupFailed = true; // the YouTube search/lookups themselves failed
    // Only a genuine "no usable reference exists" is remembered. A failure
    // (quota out, ytdl blocked, network) used to be cached as null for the
    // life of the process, which silently disabled verification for this
    // track until a restart.
    if (!lookupFailed) referenceAudioEnvelopeCache.set(trackId, result);
    return result;
}

// Tries each candidate (best-ranked first, same ordering pickBestMusicVideo
// would use) against the real reference audio and accepts the first one
// that's genuinely a match across the whole analyzed window, offset and
// all. Returns:
//   - {videoId, introOffsetMs, confidence} - a verified match, use it
//   - null - reference audio exists and NONE of the candidates matched it;
//     we now know none of them are actually in sync, so don't show one
//   - undefined - couldn't get reference audio at all (none found, or the
//     download failed) - we simply don't know, so callers should leave
//     whatever they were already showing alone rather than tear it down
//     over an infrastructure hiccup.
async function findAudioVerifiedMusicVideo(candidates, artistNames, excludeVideoIds, trackDurationMs, trackTitle, trackId, diag = {}) {
    const trackCore = normalizeForMatch(coreSongTitle(trackTitle));
    if (!trackCore) return undefined;

    // Stepwise (instead of one chain) so `diag` can record how many
    // candidates each rule removed - surfaced as `detail` on /api/music-video
    // so "why no video for this song" can be answered without guessing.
    const notExcluded = candidates.filter(v => !excludeVideoIds.has(v.videoId));
    const notDisqualified = notExcluded.filter(v => !titleLooksDisqualified(v.title));
    const fromArtist = notDisqualified.filter(v => channelMatchesAnyArtist(v.channelTitle, artistNames));
    const namesSong = fromArtist.filter(v => normalizeForMatch(v.title).includes(trackCore));
    const rightLength = namesSong.filter(v => typeof v.durationMs === 'number' && Math.abs(v.durationMs - trackDurationMs) <= MUSIC_VIDEO_MAX_DURATION_DIFF_MS);
    const ranked = rightLength
        .sort((a, b) => Math.abs(a.durationMs - trackDurationMs) - Math.abs(b.durationMs - trackDurationMs))
        .slice(0, MUSIC_VIDEO_MAX_CANDIDATES_TO_VERIFY);
    diag.songCore = trackCore;
    diag.candidatesFound = candidates.length;
    diag.afterNotLiveLyricAudioTitle = notDisqualified.length;
    diag.afterChannelIsArtist = fromArtist.length;
    diag.afterTitleNamesSong = namesSong.length;
    diag.afterLengthWithin60s = rightLength.length;
    diag.sampleOfCandidates = candidates.slice(0, 6).map(v => `${v.title} [${v.channelTitle}] ${v.durationMs ? Math.round(v.durationMs / 1000) + 's' : 'no length'}`);
    diag.checked = [];

    if (ranked.length === 0) return null; // nothing even worth trying - same as "confirmed no match" (the caller refuses to cache this if the candidate lookup itself failed)

    // Set whenever a candidate couldn't be CHECKED (download failed, frame
    // sampling failed) as opposed to being checked and found wanting. If no
    // candidate matches and this is set, the honest answer is "unknown", not
    // "no match" - see the return at the bottom.
    let sawTransientFailure = false;

    const refEnvelope = await getReferenceAudioEnvelope(trackId, artistNames, trackTitle, trackDurationMs);
    diag.referenceAudioFound = !!refEnvelope;
    if (!refEnvelope) return undefined; // couldn't establish ground truth - stay agnostic, don't reject

    for (const candidate of ranked) {
        // Items 4 & 5: the combined motion + moderation check runs alongside
        // the audio download/decode for this same candidate, not after it -
        // independent checks on the same video, none waiting on another.
        const [candidateEnvelope, frameVerification] = await Promise.all([
            extractAudioEnvelope(candidate.videoId, MUSIC_VIDEO_AUDIO_WINDOW_SEC),
            getFrameVerification(candidate.videoId, candidate.durationMs)
        ]);
        const row = { title: candidate.title, audioDownloaded: !!candidateEnvelope, frameCheckFailed: !!frameVerification.failed, motionScore: frameVerification.motionScore, moderationFlagged: frameVerification.moderationFlagged };
        diag.checked.push(row);
        if (!candidateEnvelope) { sawTransientFailure = true; continue; } // this one failed to download - try the next, not a rejection
        if (frameVerification.failed) { sawTransientFailure = true; continue; } // frame checks couldn't run - not a rejection either
        const { motionScore, moderationFlagged } = frameVerification;
        // Item 5 first and unconditionally - a moderation flag rejects the
        // candidate outright regardless of anything else, audio match
        // included. Item 4 next: no usable frames, or it looks static.
        if (moderationFlagged) continue;
        if (motionScore === null || motionScore < MUSIC_VIDEO_MOTION_MIN_AVG_DIFF) continue;
        const { videoLeadMs, confidence } = crossCorrelateEnvelopes(refEnvelope, candidateEnvelope, MUSIC_VIDEO_MAX_OFFSET_SEARCH_SEC);
        row.audioConfidence = Math.round(confidence * 1000) / 1000;
        row.videoLeadMs = videoLeadMs;
        if (confidence < MUSIC_VIDEO_MATCH_ACCEPT_CONFIDENCE) continue;
        if (videoLeadMs < -MUSIC_VIDEO_NEGATIVE_OFFSET_NOISE_TOLERANCE_MS) continue; // trimmed-intro case - see constant comment above, no offset can fix this
        return { videoId: candidate.videoId, introOffsetMs: Math.max(0, videoLeadMs), confidence };
    }
    // Every candidate that could be checked was checked against real audio
    // and none matched -> a confirmed miss. But if some couldn't be checked
    // at all (ytdl blocked, network, timeouts), we don't actually know:
    // return undefined so nothing gets cached and it's retried later.
    return sawTransientFailure ? undefined : null;
}

// --- Item 1: eager (queue-time) verification --------------------------------
// Previously findAudioVerifiedMusicVideo only ran once a track was flagged
// isNewTrack inside /api/music-video - i.e. after the song had already
// started playing, with no guaranteed lead time to finish the check before
// the audience needed an answer. This runs the exact same pipeline the
// moment a track ID is known to be coming up - added to this app's own
// guest-request queue, or spotted in Spotify's own /me/player/queue - so
// verification gets as much of a head start as the queue is deep, instead
// of racing the song itself.
//
// Deliberately idempotent per trackId: verifiedMusicVideoCache.has() and
// verificationInFlight together make every call after the first one for a
// given track a no-op, so every call site (the request routes, the
// upcoming-queue diff, and the /api/music-video fallback below) can call
// this freely - on every poll, for every track still sitting in a queue -
// without worrying about re-triggering work or racing itself.
const verificationInFlight = new Set();
// Why the last verification of each track ended the way it did (filter
// counts, per-candidate audio/motion results). In-memory only; shown as
// `detail` by /api/music-video.
const verificationDiagCache = new Map();

// Caps how many verification pipelines run at once. Without this, a big
// backlog hitting all at once (e.g. an existing 15-track queue seen right
// after a server restart) fires that many simultaneous ytdl audio
// downloads AND that many simultaneous YouTube Data API calls in the same
// instant - exactly the traffic pattern YouTube's own bot-detection looks
// for ("Sign in to confirm you're not a bot" errors were observed in
// production immediately following a burst like this), and it front-loads
// a big chunk of the daily quota budget into one moment instead of
// spreading it out. Extra triggers beyond the cap just wait their turn in
// a plain FIFO queue - correctness is unaffected (verificationInFlight
// above already guarantees no duplicate work per track), this only paces
// how many run at the same instant.
const MV_VERIFICATION_MAX_CONCURRENT = 3;
let mvVerificationActiveCount = 0;
const mvVerificationQueue = [];

function mvVerificationRunNext() {
    if (mvVerificationActiveCount >= MV_VERIFICATION_MAX_CONCURRENT) return;
    const job = mvVerificationQueue.shift();
    if (!job) return;
    mvVerificationActiveCount++;
    job().finally(() => {
        mvVerificationActiveCount--;
        mvVerificationRunNext();
    });
}

function mvVerificationSchedule(job) {
    mvVerificationQueue.push(job);
    mvVerificationRunNext();
}

// Retry pacing for verifications that couldn't reach a conclusion (quota out,
// ytdl blocked, network trouble). Nothing is cached in that case, so without
// pacing every 3-second display poll would re-run the whole pipeline. Backs
// off per track: 45s, 90s, 3min ... capped at 30min. Cleared on success.
const MV_VERIFICATION_RETRY_BASE_MS = 45000;
const MV_VERIFICATION_RETRY_MAX_MS = 30 * 60 * 1000;
const verificationRetryState = new Map(); // trackId -> { attempts, notBefore }
function mvVerificationNoteInconclusive(trackId) {
    const prev = verificationRetryState.get(trackId);
    const attempts = (prev ? prev.attempts : 0) + 1;
    const delay = Math.min(MV_VERIFICATION_RETRY_MAX_MS, MV_VERIFICATION_RETRY_BASE_MS * Math.pow(2, attempts - 1));
    verificationRetryState.set(trackId, { attempts, notBefore: Date.now() + delay });
}

function triggerMusicVideoVerification(trackId, artistNamesRaw, title, durationMs, excludeVideoIds = new Set()) {
    if (!trackId || !title || !durationMs) return;
    if (musicVideoDenylist.has(trackId)) return; // item 8 - a denylisted track never enters the pipeline, full stop
    if (verifiedMusicVideoCache.has(trackId)) return; // already resolved (a match, or confirmed no-match)
    if (verificationInFlight.has(trackId)) return; // a run for this track is already in progress
    const retry = verificationRetryState.get(trackId);
    if (retry && Date.now() < retry.notBefore) return; // last attempt was inconclusive - wait out the backoff
    verificationInFlight.add(trackId);

    const artistNames = (artistNamesRaw || '').split(',').map(s => s.trim()).filter(Boolean);
    mvVerificationSchedule(async () => {
        try {
            const failuresBefore = youtubeFailureCount;
            const candidates = await youtubeFindCandidates(artistNames, `${artistNames.join(' ')} ${title} official music video`, title);
            const diag = {};
            const result = await findAudioVerifiedMusicVideo(candidates, artistNames, excludeVideoIds, durationMs, title, trackId, diag);
            verificationDiagCache.set(trackId, diag);
            if (verificationDiagCache.size > 500) verificationDiagCache.delete(verificationDiagCache.keys().next().value);
            if (result === undefined) { // couldn't verify either way (no reference audio, downloads failed) - don't cache, retry after backoff
                mvVerificationNoteInconclusive(trackId);
                return;
            }
            if (result === null && youtubeFailureCount !== failuresBefore) {
                // "No match" reached only because YouTube lookups failed or were
                // skipped (quota budget out, HTTP errors) - an empty candidate
                // list is not evidence that no video exists. Caching this used to
                // permanently (and persistently) mark the track as having no video.
                console.warn(`[MV-MATCH] "${title}": no match, but YouTube lookups failed during this run - not caching, will retry.`);
                mvVerificationNoteInconclusive(trackId);
                return;
            }
            verificationRetryState.delete(trackId);
            verifiedMusicVideoCache.set(trackId, result);
            events.scheduleMusicVideoCacheSave(musicVideoCacheSnapshot); // item 2: debounced Redis persist
        } catch (e) {
            console.error(`[MV-MATCH] Eager verification failed for "${title}":`, e.message);
            mvVerificationNoteInconclusive(trackId);
        } finally {
            verificationInFlight.delete(trackId);
        }
    });
}

// Per-event runtime state for the feature above - none of this is
// persisted (events.scheduleSave is never called for it), so it's rebuilt
// fresh on every process restart, same as schedulerRuntime.
// Admin -> Settings -> Content overrides (Mute Visuals, Mute All, Show Queue,
// Music Videos, Subtitles, Video Offset). Lazily created so events saved
// before this feature existed pick up the defaults instead of crashing on
// undefined.
const MUSIC_VIDEO_OFFSET_DEFAULT_MS = 600;
const MUSIC_VIDEO_OFFSET_MIN_MS = -5000;
const MUSIC_VIDEO_OFFSET_MAX_MS = 5000;
function ensureVisualsConfigs(event) {
    if (!event.visualsConfigs || typeof event.visualsConfigs !== 'object') event.visualsConfigs = {};
    const v = event.visualsConfigs;
    for (const key of ['muteVisuals', 'muteAll', 'showQueue', 'musicVideosEnabled', 'musicVideoSubtitlesEnabled', 'pausedByMuteAll', 'familyModeEnabled']) {
        if (typeof v[key] !== 'boolean') v[key] = false;
    }
    // How far ahead (positive) or behind (negative) of the raw Spotify
    // position the ENTIRE video stream should target - moves where the
    // whole video is at once, not a one-off nudge. See mvTargetSec() in
    // visual-display.html, which is the only place this is applied.
    if (typeof v.musicVideoOffsetMs !== 'number' || !Number.isFinite(v.musicVideoOffsetMs)) {
        v.musicVideoOffsetMs = MUSIC_VIDEO_OFFSET_DEFAULT_MS;
    }
    return v;
}

function ensureMusicVideoRuntime(event) {
    // Guard against a Set that got flattened to {} by JSON.stringify on a
    // Redis save (Sets don't survive round-tripping through JSON) - treat
    // that the same as "doesn't exist yet" instead of trusting it blindly.
    if (!event.musicVideoRuntime || !(event.musicVideoRuntime.blacklist instanceof Set)) {
        event.musicVideoRuntime = {
            cache: { trackId: null, searchedTrackId: null, matched: false, videoId: null },
            blacklist: new Set(), // "trackId|videoId" pairs that already failed sync/playback once
            cycleCount: 0,
            lastActiveRuleId: undefined
        };
    }
    return event.musicVideoRuntime;
}

// Whether the block active right now on the Music Scheduler is a Karaoke
// block, so the search route can lock guest/kiosk results down to karaoke
// versions only for the duration of that slot. Only enabled schedules count -
// a disabled scheduler shouldn't silently restrict search just because a
// karaoke rule is still sitting in its (currently inert) timetable.
function musicSchedulerActiveIsKaraoke(event, now = new Date()) {
    if (!event.musicScheduler?.enabled) return false;
    const activeRule = getActiveScheduleRule(event, now);
    if (!activeRule) return false;
    const playlist = (event.musicScheduler.playlists || []).find(p => p.id === activeRule.playlistId);
    return !!playlist && playlist.type === 'karaoke';
}

// Per-slug "which trackId are we waiting to finish" state for the reactive
// boundary check. Deliberately kept out of the event object - it's pure
// runtime bookkeeping, not something that needs to survive a restart (the
// next tick just re-observes whatever's currently playing and starts
// waiting on that instead).
const schedulerBoundaryWatch = new Map();

function clearSchedulerBoundaryWatch(slug) {
    schedulerBoundaryWatch.delete(slug);
}

// Drops any switch the scheduler currently has queued up, without touching
// what's actually playing right now. Needed anywhere something else can
// make the scheduler's queued plan stale or unwanted:
//   - an admin manually switches the playlist themselves (that pick should
//     win outright, not get silently overwritten once the current song
//     ends and the old queued switch fires)
//   - the timetable itself gets edited/saved, which can delete or change
//     the very rule a switch was queued for
function cancelPendingSchedulerSwitch(event) {
    clearSchedulerBoundaryWatch(event.slug);
    event.schedulerRuntime.pendingSwitchUri = null;
    event.schedulerRuntime.pendingSwitchLabel = null;
}

// Actually performs the held-pending playlist switch, if one is still due
// and still safe (re-checked here rather than trusting the state from when
// the timer was set, in case something changed - e.g. a new guest request
// landed - in the meantime).
async function fireScheduledSwitch(event) {
    const uri = event.schedulerRuntime.pendingSwitchUri;
    if (!uri) return;
    if (event.activeQueue.length > 0 || event.pushedNextTrackId) return; // a guest request beat us to it - wait again
    const result = await switchDjPlaylist(event, uri);
    if (result.success) {
        event.systemConfigs.lastSwitchedPlaylist = uri;
        event.schedulerRuntime.pendingSwitchUri = null;
        event.schedulerRuntime.pendingSwitchLabel = null;
        clearSchedulerBoundaryWatch(event.slug);
        events.scheduleSave(event.slug);
        console.log(`[SCHEDULER] (${event.slug}) Seamless playlist switch complete.`);
    }
    // On failure (e.g. no active device), pendingSwitchUri is deliberately
    // left set - the next tick will just try the whole flow again.
}

// Called once per event on every sync tick (see syncAllLoadedEvents).
// Cheap when the scheduler is off or nothing's changed: one array scan plus
// a couple of comparisons.
async function tickMusicScheduler(event) {
    if (!event.musicScheduler?.enabled) return;

    const currentRule = getActiveScheduleRule(event);
    const currentRuleId = currentRule ? currentRule.id : null;

    if (currentRuleId !== event.schedulerRuntime.activeRuleId) {
        event.schedulerRuntime.activeRuleId = currentRuleId;

        if (currentRule) {
            // Volume and requests-open/closed aren't disruptive to listen
            // to, so those apply the moment the boundary is crossed - only
            // the playlist content itself needs to wait for a clean handoff.
            if (typeof currentRule.volume === 'number') {
                spotifyPlayerCommand(event, 'PUT', '/volume', `?volume_percent=${currentRule.volume}`).catch(() => {});
            }
            if (typeof currentRule.requestsAllowed === 'boolean') {
                event.systemConfigs.requestsAllowed = currentRule.requestsAllowed;
            }
            const playlist = (event.musicScheduler.playlists || []).find(p => p.id === currentRule.playlistId);
            if (playlist && playlist.uri && playlist.uri !== event.systemConfigs.lastSwitchedPlaylist) {
                event.schedulerRuntime.pendingSwitchUri = playlist.uri;
                event.schedulerRuntime.pendingSwitchLabel = playlist.label;
                console.log(`[SCHEDULER] (${event.slug}) "${currentRule.id}" now active - queued handoff to "${playlist.label}".`);
            }
        } else {
            // We just walked off the end of a scheduled block into a gap
            // the timetable doesn't cover. The scheduler is meant to be the
            // main driver of playback, so a gap should be the rare/edge
            // case, not silently left running whatever the last block was -
            // seamlessly hand back to the admin's own Fallback Playlist,
            // the same way a rule boundary would hand off to a new one.
            const fallbackUri = event.systemConfigs.fallbackPlaylistUri;
            if (fallbackUri && fallbackUri !== event.systemConfigs.lastSwitchedPlaylist) {
                event.schedulerRuntime.pendingSwitchUri = fallbackUri;
                event.schedulerRuntime.pendingSwitchLabel = 'Fallback Playlist';
                console.log(`[SCHEDULER] (${event.slug}) No rule covers this time - queued handoff back to the Fallback Playlist.`);
            }
        }
        events.scheduleSave(event.slug);
    }

    if (!event.schedulerRuntime.pendingSwitchUri) {
        clearSchedulerBoundaryWatch(event.slug);
        return;
    }

    // A guest request is still playing out (or staged next) - hold off and
    // re-check on the next tick. Don't leave a stale watch armed from a
    // previous check while we're in this holding pattern - once the queue
    // clears we need to re-observe whatever's playing THEN, not compare
    // against a track that was current before the guest request cut in.
    if (event.activeQueue.length > 0 || event.pushedNextTrackId) {
        clearSchedulerBoundaryWatch(event.slug);
        return;
    }

    // Nothing playing at all (e.g. paused, or no device) - nothing to wait
    // for, switch right away.
    if (!event.cachedNowPlaying.isPlaying || !event.cachedNowPlaying.trackId) {
        clearSchedulerBoundaryWatch(event.slug);
        await fireScheduledSwitch(event);
        return;
    }

    // Something's genuinely playing (the old playlist's own continuation,
    // since the guest queue is confirmed empty above). We never predict
    // when it'll end - we only switch once a poll has actually OBSERVED the
    // boundary: the trackId changing away from whatever was playing when we
    // started watching. First tick after the switch becomes pending (or
    // after a guest request finishes ahead of it), there's nothing to
    // compare against yet, so just record what's currently playing and wait
    // for the next poll.
    const watchedTrackId = schedulerBoundaryWatch.get(event.slug);
    const currentTrackId = event.cachedNowPlaying.trackId;
    if (watchedTrackId === undefined) {
        schedulerBoundaryWatch.set(event.slug, currentTrackId);
        return;
    }
    if (currentTrackId === watchedTrackId) {
        // Same track still playing - keep waiting, re-check next tick.
        return;
    }
    // The track actually changed since we started watching - the old
    // playlist's track is genuinely done (crossfade or not), so this is the
    // real boundary. Switch now, immediately, before this new track plays
    // any further.
    clearSchedulerBoundaryWatch(event.slug);
    await fireScheduledSwitch(event);
}

// Turns one rule into the day-segments it actually occupies, unrolling an
// overnight window (e.g. Fri 22:00-02:00) into two pieces - Friday
// 22:00-24:00, and Saturday 00:00-02:00 - so overlap checking never has to
// special-case the wraparound itself; it just compares plain same-day
// ranges.
function ruleToDaySegments(rule) {
    const start = parseHHMM(rule.start);
    const end = parseHHMM(rule.end);
    const overnight = end <= start;
    const segments = [];
    for (const day of rule.days) {
        if (!overnight) {
            segments.push({ day, start, end });
        } else {
            segments.push({ day, start, end: 1440 });
            segments.push({ day: (day + 1) % 7, start: 0, end });
        }
    }
    return segments;
}

// Finds the first pair of rules *within the given list* that share any
// overlapping time on any day, or null if that list is clean. O(n^2) in
// rule count, which is fine - safeRules is capped at 200.
function findOverlappingRulePair(rules) {
    const withSegments = rules.map(r => ({ rule: r, segments: ruleToDaySegments(r) }));
    for (let i = 0; i < withSegments.length; i++) {
        for (let j = i + 1; j < withSegments.length; j++) {
            for (const segA of withSegments[i].segments) {
                for (const segB of withSegments[j].segments) {
                    if (segA.day === segB.day && segA.start < segB.end && segB.start < segA.end) {
                        return [withSegments[i].rule, withSegments[j].rule];
                    }
                }
            }
        }
    }
    return null;
}

// crowdDJ and Karaoke share one physical output (the venue's speakers), so
// they're checked as a single "music" group - two music blocks can never
// overlap regardless of which of those two lanes either one is in (mirrors
// the existing "share the lane's blocks as solid" behavior). Ambient Visuals
// and Music Videos share a different output entirely (a screen, not the
// speakers), so together they get their own independent overlap check - a
// screen block is free to run concurrently with a music block, just not
// with another screen block (a Music Videos block takes over the screen
// from Ambient Visuals, so the two can never be scheduled at once either).
function findOverlappingRuleAcrossLanes(rules) {
    const musicRules = rules.filter(r => r.laneType !== 'ambient' && r.laneType !== 'musicvideo');
    const screenRules = rules.filter(r => r.laneType === 'ambient' || r.laneType === 'musicvideo');
    return findOverlappingRulePair(musicRules) || findOverlappingRulePair(screenRules);
}

// Manual queue position, independent of vote count - see the admin reorder
// route below. New tracks always land at the end of the DJ's manual order;
// dragging in the admin UI is what actually moves them from there.
function nextQueueOrder(event) {
    return event.activeQueue.reduce((max, t) => Math.max(max, t.order || 0), 0) + 1;
}

function isQueueFull(event) {
    return event.systemConfigs.queueCapEnabled && event.activeQueue.length >= event.systemConfigs.maxQueueLength;
}

// Curated genre buckets mapped to the keywords Spotify actually uses in an
// artist's `genres` array (which is a long tail of very specific micro-genres,
// e.g. "chicago rap" - matching by substring against a curated list is far
// more usable for a DJ than trying to expose Spotify's raw genre taxonomy.
// Shared across every event - this is fixed reference data, not per-event config.
const GENRE_CATEGORIES = {
    pop: ['pop'],
    hiphop: ['hip hop', 'rap', 'trap'],
    rock: ['rock', 'metal', 'punk', 'grunge'],
    rnb: ['r&b', 'soul', 'funk'],
    country: ['country'],
    electronic: ['edm', 'house', 'techno', 'electro', 'dance', 'dubstep', 'trance', 'drum and bass'],
    latin: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia'],
    indie: ['indie', 'alternative'],
    jazz: ['jazz', 'blues'],
    classical: ['classical', 'orchestra', 'opera'],
    reggae: ['reggae', 'dancehall', 'ska'],
    kpop: ['k-pop', 'korean pop'],
    afrobeats: ['afrobeat', 'afro pop', 'afrobeats']
};

// Display labels for the categories above - mirrors GENRE_OPTIONS in
// admin.html (keep both in sync if a category is ever added/renamed). Used
// by the Blocked tab's combined search so a DJ can find "Hip-Hop/Rap" by
// typing "hip", not just the internal key.
const GENRE_LABELS = {
    pop: 'Pop',
    hiphop: 'Hip-Hop/Rap',
    rock: 'Rock/Metal',
    rnb: 'R&B/Soul',
    country: 'Country',
    electronic: 'Electronic/Dance',
    latin: 'Latin',
    indie: 'Indie/Alt',
    jazz: 'Jazz/Blues',
    classical: 'Classical',
    reggae: 'Reggae',
    kpop: 'K-Pop',
    afrobeats: 'Afrobeats'
};

// Batch-fetches genres for a list of artist IDs. Track objects from Spotify's
// search endpoint don't include genre info directly - only the artist objects
// do - so genre filtering costs one extra API call per search (only made when
// a genre filter is actually active). Uses the shared app-level catalog token
// below, not any event's DJ token - reading public genre data isn't event-specific.
async function getArtistGenres(artistIds) {
    const map = new Map();
    if (!artistIds || artistIds.length === 0) return map;
    if (!spotifyAccessToken) await getSpotifyToken();
    try {
        const res = await fetch(`https://api.spotify.com/v1/artists?ids=${artistIds.slice(0, 50).join(',')}`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        const data = await res.json();
        (data.artists || []).forEach(a => { if (a && a.id) map.set(a.id, a.genres || []); });
    } catch (err) {
        console.error("[SPOTIFY] Artist genre lookup failed:", err.message);
    }
    return map;
}

// Shared app-level catalog token (client-credentials grant) - used for search
// and genre lookups across ALL events. Not tied to any DJ's account, so there's
// nothing per-event about it.
let spotifyAccessToken = "";

// --- Abuse/spam control ---
const MIN_VOTE_INTERVAL_MS = 400;
const MIN_REQUEST_INTERVAL_MS = 1500;

// A song that just left the active queue (played OR dropped) can't be
// requested again until this many OTHER songs have also departed in
// between. Unlike the per-voter rate limits above, this is global and
// per-song - it doesn't matter who's asking or how long it's been in
// minutes, only how many other songs have come and gone. Applies for the
// rest of the event, with no override - see isSongOnCooldown below.
const SONG_REQUEST_GAP = 20;

// How close a guest's device has to be to the event's pinned venue location
// to be allowed to actually add a song - browsing/viewing the queue is never
// gated, only the request itself. Loose enough to allow for GPS drift and a
// venue that spans a building/parking lot, tight enough that someone across
// town can't request. Events created without a venue pin (venueLatitude/
// venueLongitude are both null - see new-event.html's optional map picker)
// have nothing to check distance against, so they're never gated by this.
// This is only the fallback default now - each event can override it via
// systemConfigs.locationRadiusMeters on the admin's Location settings tab.
const REQUEST_RADIUS_METERS = 300;

function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// True if this voterId has been blocked by the DJ (see the admin
// block-voter/unblock-voter routes). Checked at the top of both the
// request and vote handlers - a blocked guest can still browse the queue,
// just not add to it or vote on it.
function isVoterBlocked(event, voterId) {
    return !!(event.blockedVoters && event.blockedVoters[voterId]);
}

// True if this specific artist has been blocked (Blocked tab). Matched
// against a track's primary artist, both in search results and at
// request time - defensive `event.blockedArtists &&` guards events created
// before this field existed.
function isArtistBlocked(event, artistId) {
    return !!(artistId && event.blockedArtists && event.blockedArtists[artistId]);
}

// True if this specific track has been blocked (Blocked tab), independent
// of any artist-level block.
function isTrackBlocked(event, trackId) {
    return !!(event.blockedTracks && event.blockedTracks[trackId]);
}

function getOrCreateVoterCreditState(event, voterId, maxCredits) {
    let state = event.voterCreditState[voterId];
    if (!state) {
        state = { available: maxCredits, lastRefill: Date.now() };
        event.voterCreditState[voterId] = state;
    }
    return state;
}

function refillVoterCredits(state, maxCredits, countdownLength) {
    const now = Date.now();
    const cycleMs = Math.max(1, countdownLength) * 1000;
    const elapsed = now - state.lastRefill;
    const cycles = Math.floor(elapsed / cycleMs);
    if (cycles > 0) {
        state.available = Math.min(maxCredits, state.available + cycles);
        state.lastRefill += cycles * cycleMs;
    }
    if (state.available > maxCredits) state.available = maxCredits;
}

function markRequestLogStatus(event, trackId, newStatus) {
    event.requestLog.forEach(entry => {
        if (entry.trackId === trackId && entry.status === 'queued') {
            entry.status = newStatus;
            entry.resolvedAt = Date.now();
        }
    });
}

function logDepartedTrack(event, track, outcome) {
    // Tick the gap counter and stamp this track's id with the count it left
    // on, regardless of outcome - a drop counts the same as a play for
    // spacing purposes. See SONG_REQUEST_GAP.
    event.songDepartureCounter = (event.songDepartureCounter || 0) + 1;
    if (!event.songLastDeparture) event.songLastDeparture = {};
    event.songLastDeparture[track.id] = event.songDepartureCounter;

    event.queueHistoryLog.push({
        id: track.id,
        title: track.title,
        artist: track.artist,
        artwork: track.artwork,
        // "system-generated" is an internal marker (see /api/request) for a
        // duplicate request re-upvoting an existing queue entry, not a real guest.
        ups: (track.upvoters || []).filter(v => v !== 'system-generated' && v !== 'forced-admin-boost').length,
        downs: (track.downvoters || []).length,
        requesters: track.requesters || [],
        outcome, // 'played' | 'dropped'
        timestamp: Date.now()
    });
    // Keep this from growing forever across a long-running event.
    if (event.queueHistoryLog.length > 3000) event.queueHistoryLog = event.queueHistoryLog.slice(-3000);
}

// True if this track departed the queue too recently (fewer than
// SONG_REQUEST_GAP other departures ago) to be requested again. A track
// that has never departed (or never existed) is never on cooldown.
function isSongOnCooldown(event, trackId) {
    const lastDeparture = event.songLastDeparture && event.songLastDeparture[trackId];
    if (lastDeparture === undefined) return false;
    return (event.songDepartureCounter - lastDeparture) < SONG_REQUEST_GAP;
}

// Used only where user-supplied data (eventName) gets interpolated directly
// into a server-rendered HTML response, rather than returned as JSON for the
// client to render (where the client's own escapeHtml already handles it).
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Detects extended/club/dub/DJ-style mixes by the descriptor Spotify usually
// puts in the track title, e.g. "Song Name - Extended Mix" or "(Club Mix)".
// Deliberately does NOT flag "radio edit"/"radio mix"/"radio version" or plain
// titles with no descriptor at all - those are exactly what should stay
// available when this filter is on.
const EXTENDED_MIX_PATTERN = /\b(extended|club|dub|instrumental|maxi[\s-]?mix|12["']?\s*mix|full[\s-]?length|uncut|dj\s*mix|extended\s*version|extended\s*edit)\b/i;
function isExtendedOrClubMix(trackName) {
    if (!trackName) return false;
    return EXTENDED_MIX_PATTERN.test(trackName);
}

// Flags karaoke/backing-track versions by the descriptor Spotify's karaoke
// catalog (Karaoke Universe, Sing Karaoke, etc.) puts in the title or album,
// e.g. "Song Name - Karaoke Version" or an album called "Karaoke Hits". Used
// to lock guest/kiosk search down to karaoke-only results while a Karaoke
// block is active on the Music Scheduler (see musicSchedulerActiveIsKaraoke).
const KARAOKE_PATTERN = /\bkaraoke\b/i;
function isKaraokeVersion(trackName, albumName) {
    return KARAOKE_PATTERN.test(trackName || '') || KARAOKE_PATTERN.test(albumName || '');
}

async function getSpotifyToken() {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("[SPOTIFY] Missing credentials in environment.");
        return;
    }
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        const data = await response.json();
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
            console.log("[SPOTIFY] Master token refreshed.");
        }
    } catch (err) {
        console.error("[SPOTIFY] Auth error:", err.message);
    }
}
setInterval(getSpotifyToken, 1000 * 60 * 50);

// Public queue shape: NEVER includes "requesters" - keeps requester identity DJ-only.
function buildSortedQueue(event) {
    return event.activeQueue.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        artwork: t.artwork,
        explicit: t.explicit,
        duration: t.duration,
        ups: t.upvoters?.length || 0,
        downs: t.downvoters?.length || 0,
        upvoters: t.upvoters || [],
        downvoters: t.downvoters || []
    })).sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs));
}

// Admin queue shape: includes "requesters" so the DJ dashboard can show who added each song.
function buildSortedQueueForAdmin(event) {
    return event.activeQueue.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        artwork: t.artwork,
        explicit: t.explicit,
        duration: t.duration,
        ups: t.upvoters?.length || 0,
        downs: t.downvoters?.length || 0,
        upvoters: t.upvoters || [],
        downvoters: t.downvoters || [],
        requesters: t.requesters || [],
        order: t.order || 0
        // Sorted by the DJ's own manual order (see the admin reorder route),
        // NOT by votes - votes are shown as a signal, but the admin's Live
        // Queue is drag-reordered directly rather than vote-ranked. The
        // guest-facing queue (buildSortedQueue above) is unaffected and
        // still sorts by net votes.
    })).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Ensures at most one upcoming track is ever sitting in Spotify's real
// playback queue - "the next song that should play", rather than every
// accepted request getting pushed the moment it's accepted. Called right
// after a track leaves activeQueue as played (see markTrackPlayedByIndex,
// which covers both the admin "Played" button and the auto-sync poller
// noticing the current track changed) and after a new request lands
// (buildRequestHandler below), so the first request into a previously-empty
// queue still gets staged even though nothing "just finished playing".
//
// event.pushedNextTrackId records which track (if any) has already been
// pushed, so the same one never gets pushed twice and a newly-voted-to-top
// track doesn't jump the queue while something is already staged. A staged
// track is considered done/consumed once it's no longer in activeQueue
// (because it started playing and was spliced out) - at that point the next
// call here treats the slot as free and stages whatever is now on top of
// buildSortedQueue().
//
// The "is anything staged" check and the "claim this track" write both
// happen synchronously, with no await in between - so if this fires more
// than once in quick succession (e.g. the 4s auto-sync poller ticking again
// before a prior call's queueTrackOnSpotify() has resolved), only the first
// call can ever see an empty slot and reach the network; every other call
// sees the slot already claimed and returns immediately.
async function pushNextTrackToSpotifyIfNeeded(event) {
    if (!event.systemConfigs.spotifyAutoQueueEnabled) return;

    if (event.pushedNextTrackId) {
        const stillStaged = event.activeQueue.some(t => t.id === event.pushedNextTrackId);
        if (stillStaged) return; // something's already lined up - leave it alone
        event.pushedNextTrackId = null;
    }

    const top = buildSortedQueue(event)[0];
    if (!top) return; // queue's empty - nothing to stage

    // Claim the slot before awaiting the network call, not after, so a
    // second call landing while this one is still in flight sees it as
    // already taken instead of also picking the same (or another) track.
    event.pushedNextTrackId = top.id;
    events.scheduleSave(event.slug);

    const pushed = await queueTrackOnSpotify(event, top.id);
    if (!pushed && event.pushedNextTrackId === top.id) {
        // Spotify rejected it (no active device, not Premium, etc) - release
        // the slot so the next trigger retries instead of leaving the event
        // with nothing queued on Spotify for the rest of the night.
        event.pushedNextTrackId = null;
    }
}

// Shared by the admin "Played" button and the auto-sync poller below - moves a
// track out of the live local queue into playedHistory/stats. trackIndex must
// already be a valid index into activeQueue.
function markTrackPlayedByIndex(event, trackIndex) {
    const [track] = event.activeQueue.splice(trackIndex, 1);
    markRequestLogStatus(event, track.id, 'played');
    event.playedHistory.unshift({
        title: track.title,
        artist: track.artist,
        artwork: track.artwork,
        explicit: track.explicit,
        duration: track.duration,
        requesters: track.requesters || []
    });
    logDepartedTrack(event, track, 'played');
    // Fire-and-forget: whoever called markTrackPlayedByIndex (the admin
    // action route, or syncNowPlayingForEvent below) doesn't need to wait on
    // Spotify before finishing its own response/poll tick.
    pushNextTrackToSpotifyIfNeeded(event).catch(err => {
        console.error(`[SPOTIFY QUEUE] (${event.slug}) Failed to stage next track:`, err.message);
    });
    return track;
}

// ============================================================
// Global (non-event) routes: creating events, and the one fixed
// Spotify OAuth callback URL every event's login flow shares.
// ============================================================

// The person picks a slug + admin password here; this is the only route that
// doesn't require an existing event to already exist.
// Guests no longer type or get given a custom URL - they find events
// through the venue list/map - so the slug is now purely an internal
// identifier, generated from the event name instead of chosen by the
// organizer. Falls back to "event" if the name has no usable characters
// (e.g. an emoji-only name), and appends a short random suffix on a
// collision instead of failing the whole request.
function slugifyEventName(str) {
    return (typeof str === 'string' ? str : '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30); // leaves room for the "-xxxxxx" suffix below, under the 40-char slug cap
}

// Creating an event now requires a logged-in account (see requireAccountAuth
// above) - anyone-can-create is gone. The account's username is stamped
// onto the event as ownerUsername, which is what lets that account's
// current password double as an admin credential later (requireAdminAuth
// below) and what makes the event show up in "My Events".
app.post('/api/events', createEventLimiter, requireAccountAuth, async (req, res) => {
    const { eventName, adminPassword, latitude, longitude, venueName, templateConfig } = req.body || {};
    // A venue location is now required at creation time - a client-side
    // check enforces this in new-event.html, but that's bypassable via a
    // direct API call, so it's re-checked here too.
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return res.status(400).json({ error: 'A venue location is required to create an event.' });
    }
    const venue = { latitude, longitude, venueName };

    const base = slugifyEventName(eventName) || 'event';
    let result;
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidateSlug = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString('hex')}`;
        result = await events.createEvent(candidateSlug, eventName, adminPassword, venue, templateConfig, req.accountUsername);
        if (!result.error || result.error !== 'That event URL is already taken.') break;
    }
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, slug: result.event.slug });
});

// The account store returns a plain { error } object for both "that's
// invalid" (400) and "Redis is unreachable" (503) cases - this tells them
// apart by message so a transient DB outage isn't reported the same way as
// a bad username, without threading a status code through every store
// function. `fallback` is the status for anything that isn't the DB error.
function statusForAccountError(message, fallback) {
    return message && message.startsWith('Could not reach the database') ? 503 : fallback;
}

// ============================================================
// Accounts: signup / login / logout / session / My Events
// ============================================================

app.post('/api/account/signup', accountAuthLimiter, async (req, res) => {
    const { username, email, password } = req.body || {};
    const result = await events.createUser(username, email, password);
    if (result.error) return res.status(statusForAccountError(result.error, 400)).json({ error: result.error });
    const token = createAccountSession(result.user.username);
    setSessionCookie(res, token);
    res.json({ success: true, username: result.user.username });
});

app.post('/api/account/login', accountAuthLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = await events.verifyUserCredentials(username, password);
    if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });
    const token = createAccountSession(user.username);
    setSessionCookie(res, token);
    res.json({ success: true, username: user.username });
});

app.post('/api/account/logout', (req, res) => {
    destroySessionFromCookie(req);
    res.clearCookie(ACCOUNT_COOKIE, { path: '/' });
    res.json({ success: true });
});

// Lightweight "am I logged in" check - used by new-event.html and
// admin.html on load to decide whether to show the account bar or the
// login/signup screen. Always 200; loggedIn:false is not an error.
app.get('/api/account/me', (req, res) => {
    const username = getSessionUsername(req);
    res.json({ loggedIn: !!username, username: username || null });
});

app.get('/api/account/my-events', requireAccountAuth, async (req, res) => {
    const list = await events.getUserOwnedEventsSummary(req.accountUsername);
    res.json({ events: list });
});

// Always responds the same way regardless of whether the email is
// registered, so this can't be used to enumerate accounts by email.
app.post('/api/account/forgot-password', forgotPasswordLimiter, async (req, res) => {
    const { email } = req.body || {};
    const generic = { success: true, message: 'If that email is registered, a reset link has been sent.' };
    if (!events.isValidEmail(email)) return res.json(generic);
    const user = await events.getUserByEmail(email);
    if (user) {
        const token = await events.createPasswordResetToken(user.username);
        if (token) {
            const origin = `${req.protocol}://${req.get('host')}`;
            const resetUrl = `${origin}/reset-password.html?username=${encodeURIComponent(user.username)}&token=${encodeURIComponent(token)}`;
            sendPasswordResetEmail(user.email, resetUrl).catch(err => console.error('[EMAIL] Unexpected send error:', err.message));
        }
        // If token creation failed (DB hiccup), we still return the generic
        // response below rather than surfacing that - same reasoning as the
        // no-such-email case, so this endpoint never confirms which emails exist.
    }
    res.json(generic);
});

app.post('/api/account/reset-password', accountAuthLimiter, async (req, res) => {
    const { username, token, newPassword } = req.body || {};
    if (typeof username !== 'string' || typeof token !== 'string') {
        return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const valid = await events.verifyAndConsumeResetToken(username, token);
    if (!valid) return res.status(400).json({ error: 'That reset link is invalid or has expired. Request a new one.' });
    const result = await events.setUserPassword(username, newPassword);
    if (result.error) return res.status(statusForAccountError(result.error, 400)).json({ error: result.error });
    res.json({ success: true });
});

// Public (no auth) - powers the guest-facing "Change Venue" screen (Venue
// List + Map tabs). Only ever returns what a guest is allowed to see (see
// getActiveEventsSummary in eventStore.js) - never admin credentials, tokens,
// or queue/request data for events the guest hasn't selected.
app.get('/api/venues', async (req, res) => {
    res.json({ venues: await events.getActiveEventsSummary() });
});

// Named ":candidateSlug" (not ":slug") deliberately - it must NOT trigger the
// app.param('slug', ...) loader below, since the whole point of this route is
// checking a slug that doesn't have an event yet. Sharing the param name would
// make every available-but-unclaimed slug 404 before this handler even ran.
app.get('/api/events/:candidateSlug/available', async (req, res) => {
    const slug = req.params.candidateSlug.trim().toLowerCase();
    if (!events.isValidSlug(slug)) return res.json({ available: false, reason: 'invalid' });
    const exists = !!(await events.getEvent(slug));
    res.json({ available: !exists });
});

// One-time login: DJ's browser is sent here (full-page navigation, so no
// custom header is possible) carrying the ticket obtained above instead of
// the password itself. The redirect_uri Spotify sends the browser back to is
// fixed and shared by every event (see comment above SPOTIFY_REDIRECT_URI) -
// the `state` param is what lets the shared callback route below know which
// event this login belongs to.
app.get('/e/:slug/admin/spotify-login', (req, res) => {
    const event = req.event;
    const ticket = event.spotify.loginTicket;
    const provided = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const valid = ticket && provided && ticket.value === provided && Date.now() < ticket.expiresAt;
    event.spotify.loginTicket = null; // single-use, valid or not
    events.scheduleSave(event.slug);
    if (!valid) {
        return res.status(401).send('This login link expired or was already used - go back to the admin dashboard and click "Connect Spotify" again.');
    }
    if (!SPOTIFY_REDIRECT_URI) {
        return res.status(500).send('SPOTIFY_REDIRECT_URI is not set in your environment variables. Set it to this app\'s URL + /admin/spotify-callback, add that exact URL to your Spotify Developer Dashboard app\'s Redirect URIs, then try again.');
    }
    const state = `${event.slug}:${crypto.randomUUID()}`;
    event.spotify.pendingLoginState = state;
    events.scheduleSave(event.slug);
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: DJ_QUEUE_SCOPES,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        state
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Fixed, single callback URL shared by every event - must exactly match what's
// registered in the Spotify Developer Dashboard, so it can't itself contain a
// slug. Figures out which event a login belongs to from the `state` param.
app.get('/admin/spotify-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Spotify login failed: ${error}`);
    const slug = typeof state === 'string' ? state.split(':')[0] : null;
    const event = slug ? await events.getEvent(slug) : null;
    if (!event || !state || state !== event.spotify.pendingLoginState) {
        return res.status(400).send('State mismatch - please restart the login from that event\'s admin dashboard.');
    }
    event.spotify.pendingLoginState = null;

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: SPOTIFY_REDIRECT_URI
            }).toString()
        });
        const data = await response.json();
        if (!data.refresh_token) {
            return res.status(500).send('Spotify did not return a refresh token: ' + (data.error_description || JSON.stringify(data)));
        }
        event.spotify.djRefreshToken = data.refresh_token;
        event.spotify.djAccessToken = data.access_token;
        event.spotify.djAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        events.scheduleSave(event.slug);

        const displayName = escapeHtml(event.systemConfigs.eventName || event.slug);
        res.send(`
            <html><body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height: 1.5;">
                <h2>Spotify connected</h2>
                <p>Auto-queueing is now active for <strong>${displayName}</strong>, and this connection is saved - it'll still be there after a server restart.</p>
                <p><a href="/e/${encodeURIComponent(event.slug)}/admin">Back to the admin dashboard</a></p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Token exchange failed: ' + err.message);
    }
});

// ============================================================
// Event-scoped routes: everything under /e/:slug/*
// ============================================================

app.param('slug', async (req, res, next, slug) => {
    try {
        const event = await events.getEvent(slug);
        if (!event) return res.status(404).send('Event not found. Double check the link, or create a new one at /new.');
        req.event = event;
        next();
    } catch (err) {
        next(err);
    }
});

app.get('/e/:slug', voterIdentityMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/e/:slug/admin/scheduler', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'scheduler.html'));
});
app.get('/e/:slug/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/e/:slug/kiosk', voterIdentityMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});
// Signage screen (Ambient Visuals slideshow, falling back to an "up next"
// board) - unauthenticated like the kiosk page, since this is meant to run
// unattended on a TV/tablet at the venue rather than be logged into.
app.get('/e/:slug/visuals', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'visuals.html'));
});

// Constant-time compare against the master password. Hashing both sides
// first (instead of comparing the raw strings/buffers directly) means a
// length mismatch can't short-circuit the comparison and leak timing info,
// and it lets us bail out cleanly when ADMIN_PASSWORD isn't set at all.
function verifyMasterPassword(provided) {
    if (!ADMIN_PASSWORD || typeof provided !== 'string') return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
}

// Real, server-side admin auth - gates every /e/:slug/api/admin/* route below.
// Accepts any of three passwords: the master password, this event's own
// password, or - if the event has an owning account - that account's
// CURRENT password (checked live against the account record each time, not
// a snapshot taken at event-creation time, so changing your account
// password later doesn't lock you out of events you made before the
// change). Any one of the three is enough to manage (and close) the event.
async function requireAdminAuth(req, res, next) {
    const provided = req.headers['x-admin-password'];
    if (verifyMasterPassword(provided)) {
        return next();
    }
    if (await events.verifyPassword(provided, req.event.adminPasswordHash)) {
        return next();
    }
    if (req.event.ownerUsername && await events.verifyUserPassword(req.event.ownerUsername, provided)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized.' });
}
app.use('/e/:slug/api/admin', adminAuthLimiter, requireAdminAuth);

// Master-only, not scoped to any one event: lists every event that exists
// (slug, name, venue, created date) so a DJ who's lost track of an event's
// slug or forgotten its individual password can find it and close it
// without hunting through old links. There's no :slug on this route for the
// usual requireAdminAuth/adminAuthLimiter pairing to attach to (those are
// registered on '/e/:slug/api/admin' specifically), so this checks the
// master password directly and gets its own rate limiter on the same terms.
const masterAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many failed attempts. Try again later.' }
});

// --- Public-route rate limiting ---
// Search/request/vote/kiosk-request were previously ungated by anything but
// per-voter throttling (MIN_REQUEST_INTERVAL_MS/MIN_VOTE_INTERVAL_MS), which
// is keyed on the crowddj_vid cookie - a scripted client that just never
// sends that cookie gets treated as a brand-new voter (fresh credits, no
// rate-limit history) on every request, bypassing that throttling entirely.
// Each of those calls can also hit Spotify's API (search/track lookup),
// and every event shares one spotifyAccessToken - so an unthrottled flood
// against one event's public URL can burn through Spotify's rate limit and
// break search/requests for every other event on the server too. Keyed by
// IP + slug so one noisy event can't eat another event's allowance, and
// vice versa a flood against many events from one IP still gets capped.
// NOTE ON THE KEY: guests at the same venue are very often on the same WiFi,
// which commonly means they share one public IP via NAT - so this can't be
// keyed tightly per-person the way adminAuthLimiter is. These limits are set
// high enough to absorb a whole room of legitimate simultaneous guests on
// one shared IP while still capping a scripted flood; if you regularly run
// bigger venues (100+ phones on one WiFi) and see false-positive 429s in
// the logs, raise these further rather than tighten them.
const publicActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.params.slug}`,
    message: { error: 'Too many requests from this network - slow down and try again in a moment.' }
});

// Looser limiter for cheap, read-only polling endpoints (queue/now-playing
// state, served straight from the in-memory cache) - these are hit every
// few seconds by every connected guest/kiosk/admin tab during normal use,
// so this exists mainly to cap a scripted client hammering them, not to
// throttle real usage. Same shared-IP caveat as above, hence the high ceiling.
const publicReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.params.slug}`,
    message: { error: 'Too many requests from this network - slow down and try again in a moment.' }
});
app.get('/api/master/events', masterAuthLimiter, async (req, res) => {
    if (!verifyMasterPassword(req.headers['x-admin-password'])) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const list = await events.getAllEventsForMaster();
        res.json({ events: list });
    } catch (err) {
        res.status(500).json({ error: 'Could not load events.' });
    }
});

// Generates a brand new admin password for an event the master password
// holder is helping recover access to - everything else about the event
// (queue, history, Spotify connection, settings) is left untouched. The new
// password is returned once in the response; it's never stored in plain
// text or logged, only its hash (see resetEventPassword in eventStore.js).
app.post('/api/master/events/:slug/reset-password', masterAuthLimiter, async (req, res) => {
    if (!verifyMasterPassword(req.headers['x-admin-password'])) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    const result = await events.resetEventPassword(req.params.slug);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ success: true, newPassword: result.newPassword });
});

// Master-panel-only: resets an account's password the same way
// reset-password above resets an event's - generates a fresh one, returns
// it once so it can be handed to the account holder out of band. Covers the
// "forgot password, and email isn't set up / didn't arrive" case without
// needing Brevo at all.
app.post('/api/master/users/:username/reset-password', masterAuthLimiter, async (req, res) => {
    if (!verifyMasterPassword(req.headers['x-admin-password'])) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    const result = await events.resetUserPasswordByMaster(req.params.username);
    if (result.error) return res.status(statusForAccountError(result.error, 404)).json({ error: result.error });
    res.json({ success: true, newPassword: result.newPassword });
});

// Serves the master dashboard itself. The page is just a static shell behind
// its own password lock (same pattern as admin.html) - nothing here is
// served without the correct master password, so there's no auth need on
// this particular route.
app.get('/master', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'master.html'));
});

// Mints a short-lived, single-use ticket that stands in for the admin
// password on the full-page redirect used by /e/:slug/admin/spotify-login
// below. Protected by the requireAdminAuth middleware just registered above,
// so this still requires the real password - it just avoids ever putting
// that password itself in a URL, where it would land in server/proxy access
// logs and the browser's own history.
app.post('/e/:slug/api/admin/spotify-login-ticket', (req, res) => {
    const event = req.event;
    const ticket = crypto.randomUUID();
    event.spotify.loginTicket = { value: ticket, expiresAt: Date.now() + 60 * 1000 };
    events.scheduleSave(event.slug);
    res.json({ ticket });
});

// Permanently closes/deletes this event. Protected by requireAdminAuth like
// everything else under /api/admin - there's no undo, so the client makes
// the person confirm before calling this.
app.delete('/e/:slug/api/admin', async (req, res) => {
    try {
        await events.deleteEvent(req.event.slug);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not delete the event. Try again.' });
    }
});

// The guest page's "Connect Spotify" button needs the Client ID (not the secret) to run
// its own PKCE login. Client IDs aren't sensitive - this is safe to expose publicly.
// Shared across events - it identifies your app, not any one event.
app.get('/e/:slug/api/public-config', (req, res) => {
    res.json({ spotifyClientId: CLIENT_ID });
});

// SEARCH ROUTE - Now strictly blocked if DJ turns off requests
app.get('/e/:slug/api/search', publicActionLimiter, async (req, res) => {
    const event = req.event;
    if (!event.systemConfigs.requestsAllowed || isQueueFull(event)) {
        return res.json({ tracks: [] });
    }

    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    if (!spotifyAccessToken) await getSpotifyToken();

    // While a Karaoke block is active on the Music Scheduler, guests/kiosk
    // should only be able to find and request karaoke versions - appending
    // "karaoke" steers Spotify's own search toward that catalog, and the
    // isKaraokeVersion() filter below drops anything that slipped through
    // without actually being one.
    const karaokeMode = musicSchedulerActiveIsKaraoke(event);
    const spotifyQuery = karaokeMode ? `${query} karaoke` : query;

    try {
        // Spotify's Feb 2026 API changes capped a single search request's `limit`
        // at 10 (down from 50). To still return a longer result list (25, i.e.
        // 2.5x the old default of 10), page through with `offset` across 3
        // parallel requests instead of one bigger one.
        const PAGE_SIZE = 10;
        const TOTAL_RESULTS = 25;
        const offsets = [];
        for (let offset = 0; offset < TOTAL_RESULTS; offset += PAGE_SIZE) offsets.push(offset);

        const responses = await Promise.all(offsets.map(offset =>
            fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(spotifyQuery)}&type=track&limit=${PAGE_SIZE}&offset=${offset}`, {
                headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
            })
        ));

        const failed = responses.find(r => !r.ok);
        if (failed) {
            const errBody = await failed.json().catch(() => ({}));
            console.error('[SEARCH] Spotify rejected the request:', failed.status, JSON.stringify(errBody));
            spotifyAccessToken = null;
            return res.status(502).json({ error: "Spotify search temporarily unavailable." });
        }

        const pages = await Promise.all(responses.map(r => r.json()));
        const trackItems = pages.flatMap(page => page.tracks?.items || []).slice(0, TOTAL_RESULTS);

        let tracks = trackItems.map(track => {
            const releaseYear = parseInt((track.album?.release_date || '').slice(0, 4), 10) || null;
            return {
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
                explicit: track.explicit || false,
                duration: formatDuration(track.duration_ms),
                _releaseYear: releaseYear,
                _primaryArtistId: track.artists?.[0]?.id || null,
                _albumName: track.album?.name || ''
            };
        });

        if (karaokeMode) {
            tracks = tracks.filter(track => isKaraokeVersion(track.name, track._albumName));
        }

        if (event.systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }

        if (event.systemConfigs.radioEditsOnly) {
            tracks = tracks.filter(track => !isExtendedOrClubMix(track.name));
        }

        // Blocked tab: drop anything the DJ has specifically blocked, by
        // track or by its primary artist, before it ever reaches a guest.
        tracks = tracks.filter(track => !isTrackBlocked(event, track.id) && !isArtistBlocked(event, track._primaryArtistId));

        // Same rule the request endpoint enforces (see SONG_REQUEST_GAP) -
        // filtered out of search too, so a guest never sees a song only to
        // have it rejected the moment they try to actually request it.
        tracks = tracks.filter(track => !isSongOnCooldown(event, track.id));

        if (event.systemConfigs.decadeFilter && event.systemConfigs.decadeFilter.length > 0) {
            tracks = tracks.filter(track => {
                if (!track._releaseYear) return false;
                const decade = Math.floor(track._releaseYear / 10) * 10;
                return event.systemConfigs.decadeFilter.includes(decade);
            });
        }

        if (event.systemConfigs.genreFilter && event.systemConfigs.genreFilter.length > 0 && tracks.length > 0) {
            const artistIds = [...new Set(tracks.map(t => t._primaryArtistId).filter(Boolean))];
            const genresByArtist = await getArtistGenres(artistIds);
            // genreFilter is a block-list here (the genres the admin picked
            // as ones they DON'T want played), not an allow-list - so a
            // track is kept unless its artist matches one of the blocked
            // keywords.
            const blockedKeywords = event.systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
            tracks = tracks.filter(track => {
                const artistGenres = genresByArtist.get(track._primaryArtistId) || [];
                return !artistGenres.some(g => blockedKeywords.some(keyword => g.includes(keyword)));
            });
        }

        tracks = tracks.map(({ _releaseYear, _primaryArtistId, _albumName, ...publicFields }) => publicFields);

        res.json({ tracks });
    } catch (err) {
        console.error('[SEARCH] Failed:', err.message);
        res.status(500).json({ error: "Search feature unavailable" });
    }
});

// Which config (system vs kiosk) applies used to be decided by an `isKiosk`
// flag the CLIENT sent in the request body - trivially spoofable by anyone
// on the regular guest page, letting them borrow the kiosk's (often more
// permissive) requestsAllowed/maxCredits/countdownLength, or keep requesting
// after the DJ paused the main page while the kiosk toggle was still on.
// Now it's determined purely by which route the request came in on, so a
// guest can't opt themselves into kiosk rules from the guest page, and vice
// versa. buildRequestHandler(isKiosk) is shared by both routes below since
// the actual request-processing logic is otherwise identical.
function buildRequestHandler(isKiosk) {
    return async (req, res) => {
        const event = req.event;
        const { track, username } = req.body;
        const modeConfig = isKiosk ? event.kioskConfigs : event.systemConfigs;

        if (!modeConfig.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
        if (isQueueFull(event)) return res.status(403).json({ error: `Queue is full (max ${event.systemConfigs.maxQueueLength} songs) - wait for it to drain.` });
        if (!track || !track.id) return res.status(400).json({ error: "Missing track ID." });
        const voterId = req.serverVoterId;

        // A kiosk is a fixed device with a hardcoded identity (android_kiosk) -
        // there's no per-guest name to collect there. Every other guest must
        // have entered a name client-side before this route is ever reachable;
        // this is the server-side backstop for that requirement (the client
        // check alone is trivially bypassable via a direct API call).
        const requesterNameRaw = typeof username === 'string' ? username.trim() : '';
        if (!isKiosk && requesterNameRaw === '') {
            return res.status(400).json({ error: "A name is required to request a song." });
        }

        if (isVoterBlocked(event, voterId)) {
            return res.status(403).json({ error: "You've been blocked from requesting songs at this event." });
        }

        // Kiosk requests skip this - a kiosk is a fixed device physically at
        // the venue by definition. Only the guest's own phone (isKiosk ===
        // false) needs to prove it's actually near the pinned venue location,
        // and only if the organizer actually pinned one at creation AND
        // hasn't switched off Location Lock (defaults to on - see
        // systemConfigs.locationLockEnabled).
        if (!isKiosk && event.systemConfigs.locationLockEnabled !== false && typeof event.venueLatitude === 'number' && typeof event.venueLongitude === 'number') {
            const lat = parseFloat(req.body.lat);
            const lng = parseFloat(req.body.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return res.status(403).json({ error: "Location needed to request a song here.", locationRequired: true });
            }
            const distanceMeters = haversineMeters(lat, lng, event.venueLatitude, event.venueLongitude);
            const radiusMeters = event.systemConfigs.locationRadiusMeters || REQUEST_RADIUS_METERS;
            if (distanceMeters > radiusMeters) {
                return res.status(403).json({
                    error: `You're too far from the venue to request a song here (${Math.round(distanceMeters / 1000 * 10) / 10}km away).`,
                    locationTooFar: true,
                    distanceMeters: Math.round(distanceMeters)
                });
            }
        }

        const lastRequestAt = event.voterLastRequestAt[voterId] || 0;
        if (Date.now() - lastRequestAt < MIN_REQUEST_INTERVAL_MS) {
            return res.status(429).json({ error: "Please slow down." });
        }
        event.voterLastRequestAt[voterId] = Date.now();

        if (!/^[A-Za-z0-9]{22}$/.test(track.id)) {
            return res.status(400).json({ error: "Invalid track ID." });
        }

        let verifiedTrack;
        let releaseYear = null;
        let primaryArtistId = null;
        try {
            if (!spotifyAccessToken) await getSpotifyToken();
            const lookupRes = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(track.id)}`, {
                headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
            });
            if (!lookupRes.ok) return res.status(400).json({ error: "Track not found on Spotify." });
            const t = await lookupRes.json();
            if (!t || !t.id) return res.status(400).json({ error: "Track not found on Spotify." });
            verifiedTrack = {
                id: t.id,
                name: t.name,
                artist: (t.artists || []).map(a => a.name).join(', ') || 'Unknown Artist',
                artwork: t.album?.images?.[0]?.url || 'https://picsum.photos/48',
                explicit: t.explicit || false,
                duration: formatDuration(t.duration_ms || 0),
                durationMs: t.duration_ms || 0 // raw ms, for the music-video eager verification trigger below - `duration` above is already formatted for display
            };
            releaseYear = parseInt((t.album?.release_date || '').slice(0, 4), 10) || null;
            primaryArtistId = t.artists?.[0]?.id || null;
        } catch (err) {
            return res.status(500).json({ error: "Could not verify track with Spotify." });
        }

        if (isSongOnCooldown(event, verifiedTrack.id)) {
            return res.status(403).json({ error: "That song was just played - it needs to sit out a while before it can be requested again." });
        }

        // Blocked tab: same track/artist block guest search already filters
        // out, re-checked here since a request can arrive with a track ID
        // the guest already had cached before it was blocked.
        if (isTrackBlocked(event, verifiedTrack.id) || isArtistBlocked(event, primaryArtistId)) {
            return res.status(403).json({ error: "That song isn't available at this event." });
        }

        if (event.systemConfigs.explicitBlockActive && verifiedTrack.explicit) {
            return res.status(403).json({ error: "Explicit content is currently restricted by the admin." });
        }

        if (event.systemConfigs.radioEditsOnly && isExtendedOrClubMix(verifiedTrack.name)) {
            return res.status(403).json({ error: "Only radio edits are currently allowed - try searching for the standard version." });
        }

        if (event.systemConfigs.decadeFilter && event.systemConfigs.decadeFilter.length > 0) {
            const decade = releaseYear ? Math.floor(releaseYear / 10) * 10 : null;
            if (decade === null || !event.systemConfigs.decadeFilter.includes(decade)) {
                return res.status(403).json({ error: "That song's decade isn't part of tonight's theme." });
            }
        }
        if (event.systemConfigs.genreFilter && event.systemConfigs.genreFilter.length > 0) {
            const genresByArtist = await getArtistGenres(primaryArtistId ? [primaryArtistId] : []);
            const artistGenres = genresByArtist.get(primaryArtistId) || [];
            // Block-list, same as the search-time check above.
            const blockedKeywords = event.systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
            const isBlocked = artistGenres.some(g => blockedKeywords.some(keyword => g.includes(keyword)));
            if (isBlocked) {
                return res.status(403).json({ error: "That song's genre has been blocked for tonight." });
            }
        }

        const creditState = getOrCreateVoterCreditState(event, voterId, modeConfig.maxCredits);
        refillVoterCredits(creditState, modeConfig.maxCredits, modeConfig.countdownLength);
        if (creditState.available <= 0) {
            return res.status(429).json({ error: "You are out of credits! Wait for the regeneration cycle." });
        }
        creditState.available -= 1;

        // Kiosk still falls back to 'Anonymous' if somehow blank (its identity
        // is always fixed to android_kiosk client-side, so this is just a
        // defensive default) - every other guest already had to pass the
        // non-empty check above, so requesterNameRaw is guaranteed non-blank here.
        const requesterName = requesterNameRaw !== '' ? requesterNameRaw.slice(0, 30) : 'Anonymous';

        // Blocked tab guest directory - records/refreshes this voter's last-used
        // name so the admin can find and block them by name later. Defensive
        // check guards events created before voterNames existed.
        if (!event.voterNames) event.voterNames = {};
        event.voterNames[voterId] = { label: requesterName, lastSeenAt: Date.now() };

        const trackId = verifiedTrack.id;

        const existingTrack = event.activeQueue.find(t => t.id === trackId);
        if (existingTrack) {
            if (!existingTrack.upvoters.includes('system-generated')) {
                existingTrack.upvoters.push('system-generated');
            }
            if (!existingTrack.requesters) existingTrack.requesters = [];
            existingTrack.requesters.push(requesterName);
        } else {
            event.activeQueue.push({
                id: trackId,
                title: verifiedTrack.name,
                artist: verifiedTrack.artist,
                artwork: verifiedTrack.artwork,
                explicit: verifiedTrack.explicit,
                duration: verifiedTrack.duration,
                upvoters: [],
                downvoters: [],
                requesters: [requesterName],
                order: nextQueueOrder(event)
            });
            // Don't push to Spotify's real queue here - only the one track
            // that's actually next ever gets pushed, and that's decided by
            // pushNextTrackToSpotifyIfNeeded (staged when a track finishes,
            // or here if the queue was empty and nothing is staged yet).
            pushNextTrackToSpotifyIfNeeded(event).catch(err => {
                console.error(`[SPOTIFY QUEUE] (${event.slug}) Failed to stage next track:`, err.message);
            });
        }

        // Item 1: this track is now guaranteed to be sitting in a queue -
        // start music-video verification for it immediately rather than
        // waiting for it to actually start playing. No-op if it's already
        // resolved or already running (see triggerMusicVideoVerification).
        triggerMusicVideoVerification(trackId, verifiedTrack.artist, verifiedTrack.name, verifiedTrack.durationMs);

        event.requestLog.push({
            trackId,
            title: verifiedTrack.name,
            artist: verifiedTrack.artist,
            artwork: verifiedTrack.artwork,
            explicit: verifiedTrack.explicit,
            voterId,
            username: requesterName,
            status: 'queued',
            requestedAt: Date.now()
        });
        if (event.requestLog.length > 2000) event.requestLog = event.requestLog.slice(-2000);

        events.scheduleSave(event.slug);
        res.json({ success: true });
    };
}

app.post('/e/:slug/api/request', publicActionLimiter, voterIdentityMiddleware, buildRequestHandler(false));
app.post('/e/:slug/api/kiosk-request', publicActionLimiter, voterIdentityMiddleware, buildRequestHandler(true));

// Registers/refreshes this voter's name in the Blocked tab's guest directory
// as soon as they set or change it - not just the first time a request goes
// through. Lets the admin see (and block) every guest who's logged in, even
// ones who never actually requested a song.
app.post('/e/:slug/api/set-username', publicActionLimiter, voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    const voterId = req.serverVoterId;
    const name = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 30) : '';
    if (name === '') return res.status(400).json({ error: 'A name is required.' });
    if (!event.voterNames) event.voterNames = {};
    event.voterNames[voterId] = { label: name, lastSeenAt: Date.now() };
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/vote', publicActionLimiter, voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    const { id, type } = req.body;
    const voterId = req.serverVoterId;

    if (isVoterBlocked(event, voterId)) {
        return res.status(403).json({ error: "You've been blocked from voting at this event." });
    }

    const lastVoteAt = event.voterLastVoteAt[voterId] || 0;
    if (Date.now() - lastVoteAt < MIN_VOTE_INTERVAL_MS) {
        return res.status(429).json({ error: "Please slow down." });
    }
    event.voterLastVoteAt[voterId] = Date.now();

    const track = event.activeQueue.find(t => t.id === id);
    if (!track) return res.status(404).json({ error: "Track missing from live pool." });

    if (!track.upvoters) track.upvoters = [];
    if (!track.downvoters) track.downvoters = [];

    const clearUp = () => { track.upvoters = track.upvoters.filter(v => v !== voterId); };

    // Downvoting has been removed - guests can only upvote (or take back
    // their own upvote by pressing it again). This only ever affects the
    // vote tally/highlight shown to guests (song.ups, the green thumbs-up
    // for whoever voted) - it does NOT touch the track's real queue
    // position (`order`), which stays purely a manual/admin-driven thing.
    // track.downvoters/downs is left in place purely so any votes cast
    // under the old system still display correctly; nothing can add to it
    // anymore.
    if (type === 'up') {
        if (track.upvoters.includes(voterId)) {
            clearUp();
        } else {
            track.upvoters.push(voterId);
        }
    }

    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.get('/e/:slug/data', publicReadLimiter, voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    res.json({
        maxCredits: event.systemConfigs.maxCredits,
        countdownLength: event.systemConfigs.countdownLength,
        requestsAllowed: event.systemConfigs.requestsAllowed,
        explicitBlockActive: event.systemConfigs.explicitBlockActive,
        radioEditsOnly: event.systemConfigs.radioEditsOnly,
        eventName: event.systemConfigs.eventName || '',
        venueName: event.venueName || '',
        // Only sent when Location Lock is on - this is what drives the
        // client-side geofence watch/"too far" messaging, so turning the
        // lock off (systemConfigs.locationLockEnabled === false) hides the
        // pin entirely rather than just disabling the server-side check,
        // keeping the guest UI in sync with the actual rule in effect.
        venueLatitude: event.systemConfigs.locationLockEnabled !== false ? event.venueLatitude : null,
        venueLongitude: event.systemConfigs.locationLockEnabled !== false ? event.venueLongitude : null,
        venueRadiusMeters: event.systemConfigs.locationRadiusMeters || REQUEST_RADIUS_METERS,
        queueCapEnabled: event.systemConfigs.queueCapEnabled,
        maxQueueLength: event.systemConfigs.maxQueueLength,
        queueFull: isQueueFull(event),
        genreFilter: event.systemConfigs.genreFilter || [],
        decadeFilter: event.systemConfigs.decadeFilter || [],
        spotifyConnectEnabled: event.systemConfigs.guestSpotifyConnectEnabled,
        queue: buildSortedQueue(event),
        history: event.playedHistory,
        // This guest's own block status (Blocked tab) - lets the guest page
        // grey out the search bar for just this one browser/device, instead
        // of only finding out when a request/vote gets rejected.
        blocked: isVoterBlocked(event, req.serverVoterId)
    });
});

app.get('/e/:slug/kiosk-data', publicReadLimiter, voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    res.json({
        maxCredits: event.kioskConfigs.maxCredits,
        countdownLength: event.kioskConfigs.countdownLength,
        requestsAllowed: event.kioskConfigs.requestsAllowed,
        explicitBlockActive: event.systemConfigs.explicitBlockActive,
        radioEditsOnly: event.systemConfigs.radioEditsOnly,
        eventName: event.systemConfigs.eventName || '',
        venueName: event.venueName || '',
        queueCapEnabled: event.systemConfigs.queueCapEnabled,
        maxQueueLength: event.systemConfigs.maxQueueLength,
        queueFull: isQueueFull(event),
        genreFilter: event.systemConfigs.genreFilter || [],
        decadeFilter: event.systemConfigs.decadeFilter || [],
        spotifyConnectEnabled: event.kioskConfigs.spotifyConnectEnabled,
        displayOnlyMode: event.kioskConfigs.displayOnlyMode,
        queue: buildSortedQueue(event),
        history: event.playedHistory,
        blocked: isVoterBlocked(event, req.serverVoterId)
    });
});

app.get('/e/:slug/api/admin/data', (req, res) => {
    const event = req.event;
    res.json({
        maxCredits: event.systemConfigs.maxCredits,
        countdownLength: event.systemConfigs.countdownLength,
        requestsAllowed: event.systemConfigs.requestsAllowed,
        explicitBlockActive: event.systemConfigs.explicitBlockActive,
        radioEditsOnly: event.systemConfigs.radioEditsOnly,
        eventName: event.systemConfigs.eventName || '',
        venueName: event.venueName || '',
        queueCapEnabled: event.systemConfigs.queueCapEnabled,
        maxQueueLength: event.systemConfigs.maxQueueLength,
        queueFull: isQueueFull(event),
        genreFilter: event.systemConfigs.genreFilter || [],
        decadeFilter: event.systemConfigs.decadeFilter || [],
        guestSpotifyConnectEnabled: event.systemConfigs.guestSpotifyConnectEnabled,
        spotifyAutoQueueEnabled: event.systemConfigs.spotifyAutoQueueEnabled,
        locationLockEnabled: event.systemConfigs.locationLockEnabled !== false,
        locationRadiusMeters: event.systemConfigs.locationRadiusMeters || REQUEST_RADIUS_METERS,
        djSpotifyQueueConnected: !!event.spotify.djRefreshToken,
        lastSwitchedPlaylist: event.systemConfigs.lastSwitchedPlaylist || '',
        fallbackPlaylistUri: event.systemConfigs.fallbackPlaylistUri || '',
        kiosk: event.kioskConfigs,
        visuals: ensureVisualsConfigs(event),
        queue: buildSortedQueueForAdmin(event),
        history: event.playedHistory,
        blockedVoters: Object.entries(event.blockedVoters || {}).map(([voterId, info]) => ({
            voterId,
            label: info.label,
            blockedAt: info.blockedAt
        })).sort((a, b) => b.blockedAt - a.blockedAt),
        blockedArtists: Object.entries(event.blockedArtists || {}).map(([artistId, info]) => ({
            artistId,
            name: info.name,
            blockedAt: info.blockedAt
        })).sort((a, b) => b.blockedAt - a.blockedAt),
        blockedTracks: Object.entries(event.blockedTracks || {}).map(([trackId, info]) => ({
            trackId,
            name: info.name,
            artist: info.artist,
            blockedAt: info.blockedAt
        })).sort((a, b) => b.blockedAt - a.blockedAt),
        // Every guest who's set a name - whether or not they've actually
        // requested a song - most-recently-seen first. Powers the Blocked
        // tab's "Guests" section. `blocked` lets the UI show the right
        // button (Block vs already-blocked) without a second lookup against
        // blockedVoters.
        guests: Object.entries(event.voterNames || {}).map(([voterId, info]) => ({
            voterId,
            label: info.label,
            lastSeenAt: info.lastSeenAt,
            blocked: !!(event.blockedVoters && event.blockedVoters[voterId])
        })).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    });
});

app.get('/e/:slug/api/admin/stats', (req, res) => {
    const event = req.event;
    const allRequests = [];
    event.queueHistoryLog.forEach(entry => {
        const names = entry.requesters.length > 0 ? entry.requesters : ['Anonymous'];
        names.forEach(name => {
            allRequests.push({
                title: entry.title,
                artist: entry.artist,
                artwork: entry.artwork,
                username: name,
                outcome: entry.outcome,
                timestamp: entry.timestamp
            });
        });
    });
    allRequests.sort((a, b) => b.timestamp - a.timestamp);

    const usernameCounts = new Map();
    allRequests.forEach(r => {
        usernameCounts.set(r.username, (usernameCounts.get(r.username) || 0) + 1);
    });
    const topRequesters = [...usernameCounts.entries()]
        .map(([username, count]) => ({ username, count }))
        .sort((a, b) => b.count - a.count);

    const totals = {
        played: event.queueHistoryLog.filter(e => e.outcome === 'played').length,
        dropped: event.queueHistoryLog.filter(e => e.outcome === 'dropped').length,
        stillQueued: event.activeQueue.length
    };

    const topLiked = [...event.queueHistoryLog]
        .filter(e => e.ups > 0)
        .sort((a, b) => b.ups - a.ups)
        .slice(0, 5)
        .map(e => ({ title: e.title, artist: e.artist, artwork: e.artwork, count: e.ups }));

    const topDisliked = [...event.queueHistoryLog]
        .filter(e => e.downs > 0)
        .sort((a, b) => b.downs - a.downs)
        .slice(0, 5)
        .map(e => ({ title: e.title, artist: e.artist, artwork: e.artwork, count: e.downs }));

    // Individual, per-request entries (not aggregated like allRequests above)
    // carrying voterId - this is what the admin "Recent Requests" list uses
    // to offer a Block button next to a specific guest. Excludes tracks the
    // DJ added manually (voterId 'admin-added') since there's no guest there
    // to block. Capped at 50 - this is a moderation tool, not a full log.
    const recentRequests = [...event.requestLog]
        .filter(r => r.voterId !== 'admin-added')
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, 50)
        .map(r => ({
            voterId: r.voterId,
            username: r.username || 'Anonymous',
            title: r.title,
            artist: r.artist,
            artwork: r.artwork,
            requestedAt: r.requestedAt,
            blocked: !!(event.blockedVoters && event.blockedVoters[r.voterId])
        }));

    res.json({ allRequests, topRequesters, totals, topLiked, topDisliked, recentRequests });
});

app.get('/e/:slug/api/my-requests', publicReadLimiter, voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    const voterId = req.serverVoterId;

    const mine = event.requestLog
        .filter(entry => entry.voterId === voterId)
        .sort((a, b) => b.requestedAt - a.requestedAt)
        .slice(0, 25)
        .map(entry => ({
            trackId: entry.trackId,
            title: entry.title,
            artist: entry.artist,
            artwork: entry.artwork,
            explicit: entry.explicit,
            status: entry.status,
            requestedAt: entry.requestedAt
        }));

    res.json({ requests: mine });
});

app.post('/e/:slug/api/admin/config', (req, res) => {
    const event = req.event;
    const { maxCredits, countdownLength, eventName, venueName, maxQueueLength, genreFilter, decadeFilter } = req.body;
    if (maxCredits !== undefined) event.systemConfigs.maxCredits = parseInt(maxCredits) || event.systemConfigs.maxCredits;
    if (countdownLength !== undefined) event.systemConfigs.countdownLength = parseInt(countdownLength) || event.systemConfigs.countdownLength;
    if (typeof eventName === 'string') event.systemConfigs.eventName = eventName.trim().slice(0, 60);
    // Venue name is separate from the event name - e.g. eventName "Sarah's
    // 30th Birthday" but venueName "The Blind Pig, Ann Arbor". Same 120-char
    // cap as the one set at creation time from the new-event map picker.
    if (typeof venueName === 'string') event.venueName = venueName.trim().slice(0, 120);
    if (maxQueueLength !== undefined) {
        const parsed = parseInt(maxQueueLength);
        if (parsed > 0) event.systemConfigs.maxQueueLength = parsed;
    }
    if (Array.isArray(genreFilter)) {
        event.systemConfigs.genreFilter = genreFilter.filter(key => Object.prototype.hasOwnProperty.call(GENRE_CATEGORIES, key));
    }
    if (Array.isArray(decadeFilter)) {
        event.systemConfigs.decadeFilter = decadeFilter.map(y => parseInt(y)).filter(y => Number.isInteger(y));
    }
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-queue-cap', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.systemConfigs.queueCapEnabled = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

// Disconnects the DJ's own Spotify account from this event - clears the
// stored tokens so djSpotifyQueueConnected goes back to false and auto-queue
// stops relaying. Doesn't touch guestSpotifyConnectEnabled (guests' own
// optional Spotify connect) or anything about the queue/history.
app.post('/e/:slug/api/admin/spotify-disconnect', (req, res) => {
    const event = req.event;
    event.spotify.djRefreshToken = null;
    event.spotify.djAccessToken = null;
    event.spotify.djAccessTokenExpiresAt = 0;
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-guest-spotify', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.systemConfigs.guestSpotifyConnectEnabled = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-spotify-auto-queue', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.systemConfigs.spotifyAutoQueueEnabled = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

// The admin's manual Fallback Playlist "Switch Now" action. This is an
// explicit human decision, so it wins outright over the scheduler: it
// cancels any switch the scheduler currently has queued up (rather than
// letting that queued switch silently fire and undo this pick once the
// current song ends), and it updates fallbackPlaylistUri - the baseline
// the scheduler hands back to during a timetable gap - not just
// lastSwitchedPlaylist.
app.post('/e/:slug/api/admin/switch-playlist', async (req, res) => {
    const event = req.event;
    const { playlistUrl } = req.body;
    if (!playlistUrl) return res.status(400).json({ error: 'Missing playlistUrl.' });
    cancelPendingSchedulerSwitch(event);
    const result = await switchDjPlaylist(event, playlistUrl);
    if (result.success) {
        event.systemConfigs.lastSwitchedPlaylist = playlistUrl.trim();
        event.systemConfigs.fallbackPlaylistUri = playlistUrl.trim();
    }
    events.scheduleSave(event.slug);
    res.status(result.success ? 200 : 400).json(result);
});

// --- Music Scheduler --------------------------------------------------
// Returns everything the Scheduler page needs to render itself: the saved
// playlist palette, the timetable rules, whether the whole thing is turned
// on, and (for a small status readout) whatever switch is currently pending.
app.get('/e/:slug/api/admin/scheduler', (req, res) => {
    const event = req.event;
    res.json({
        enabled: !!event.musicScheduler.enabled,
        playlists: event.musicScheduler.playlists,
        rules: event.musicScheduler.rules,
        timezone: event.musicScheduler.timezone || null,
        activeRuleId: event.schedulerRuntime.activeRuleId,
        pendingSwitchLabel: event.schedulerRuntime.pendingSwitchLabel,
        // The Ambient Visuals media library - not runtime state like the
        // fields above, but the scheduler page needs it up front to render
        // the palette and resolve each ambient block's items to actual
        // files, so it rides along with this same GET rather than a
        // separate round-trip.
        ambientMedia: event.ambientMedia
    });
});

// ---------- Ambient item validation ----------
// Mirrors the whitelist scheduler.html applies when importing a visuals
// file (see VISUALS_FIELDS/importSanitizeItem there), but trusted
// server-side: an ambient rule's "items" ride along on every Save Schedule
// and get rendered straight onto a venue screen, so they're re-checked
// here rather than trusted from the client. Anything that doesn't hold up
// is dropped, same as everywhere else in this handler.
const AMBIENT_ITEM_TYPES = ['photo', 'video', 'queue', 'clock', 'ad', 'customVisual'];
const AMBIENT_LAYER_TYPES = ['text', 'photo', 'video', 'clock', 'queue', 'countdown', 'shape'];
const AMBIENT_HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const AMBIENT_FIELDS = {
    numbers: {
        x: [0, 100], y: [0, 100], width: [1, 100], height: [1, 100], opacity: [0, 100],
        rotation: [-360, 360], fontSize: [4, 400], bgOpacity: [0, 100], maxItems: [1, 10],
        borderRadius: [0, 100], borderWidth: [0, 50], thickness: [1, 100], tintOpacity: [0, 100],
        angle: [0, 360], dimOpacity: [0, 100]
    },
    bools: ['flipH', 'flipV', 'lockAspect', 'bold', 'italic', 'outline', 'bgEnabled', 'showDate',
            'showSeconds', 'showArtwork', 'tintEnabled', 'dimEnabled'],
    colors: ['color', 'outlineColor', 'bgColor', 'borderColor', 'tintColor', 'color1', 'color2', 'dimColor'],
    enums: {
        align: ['left', 'center', 'right'],
        fit: ['cover', 'contain'],
        format: ['12h', '24h'],
        shapeType: ['rectangle', 'circle', 'line'],
        fontFamily: ['inherit', 'Poppins', 'Bebas Neue', 'Playfair Display', 'Space Mono']
    },
    strings: { text: 500, title: 60, label: 60 }
};

function pickAmbientFields(src) {
    const out = {};
    for (const [k, [lo, hi]] of Object.entries(AMBIENT_FIELDS.numbers)) {
        if (typeof src[k] === 'number' && Number.isFinite(src[k])) out[k] = Math.max(lo, Math.min(hi, src[k]));
    }
    for (const k of AMBIENT_FIELDS.bools) if (typeof src[k] === 'boolean') out[k] = src[k];
    for (const k of AMBIENT_FIELDS.colors) if (typeof src[k] === 'string' && AMBIENT_HEX.test(src[k])) out[k] = src[k];
    for (const [k, allowed] of Object.entries(AMBIENT_FIELDS.enums)) {
        if (allowed.includes(src[k])) out[k] = src[k];
    }
    for (const [k, max] of Object.entries(AMBIENT_FIELDS.strings)) {
        if (typeof src[k] === 'string') out[k] = src[k].slice(0, max);
    }
    if (typeof src.targetDateTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(src.targetDateTime)) {
        out.targetDateTime = src.targetDateTime;
    }
    return out;
}

function sanitizeAmbientBackground(raw, ambientMediaIds) {
    const black = { type: 'color', color: '#000000', fit: 'cover' };
    if (!raw || typeof raw !== 'object') return black;
    const f = pickAmbientFields(raw);
    if (raw.type === 'gradient') {
        return { type: 'gradient', color1: f.color1 || '#1DB954', color2: f.color2 || '#121212', angle: f.angle != null ? f.angle : 135 };
    }
    if ((raw.type === 'photo' || raw.type === 'video') && typeof raw.mediaId === 'string' && ambientMediaIds.has(raw.mediaId)) {
        const bg = { type: raw.type, mediaId: raw.mediaId, fit: f.fit || 'cover' };
        if (f.dimEnabled) {
            bg.dimEnabled = true;
            bg.dimColor = f.dimColor || '#000000';
            bg.dimOpacity = f.dimOpacity != null ? f.dimOpacity : 40;
        }
        return bg;
    }
    return { type: 'color', color: f.color || '#000000', fit: 'cover' };
}

function sanitizeAmbientLayer(raw, ambientMediaIds) {
    if (!raw || typeof raw !== 'object' || !AMBIENT_LAYER_TYPES.includes(raw.type)) return null;
    const layer = { id: crypto.randomUUID(), type: raw.type, ...pickAmbientFields(raw) };
    for (const [k, d] of [['x', 30], ['y', 40], ['width', 30], ['height', 20], ['opacity', 100], ['rotation', 0]]) {
        if (typeof layer[k] !== 'number') layer[k] = d;
    }
    layer.x = Math.max(0, Math.min(100 - layer.width, layer.x));
    layer.y = Math.max(0, Math.min(100 - layer.height, layer.y));
    if (raw.type === 'photo' || raw.type === 'video') {
        if (typeof raw.mediaId !== 'string' || !ambientMediaIds.has(raw.mediaId)) return null;
        layer.mediaId = raw.mediaId;
    }
    return layer;
}

// Validates one item in an ambient block's sequence - the same shape
// scheduler.html keeps in modalAmbientItems. Returns null for anything
// that doesn't hold up (unknown type, deleted/missing media, an empty
// ad or customVisual), same as a dropped rule elsewhere in this file.
function sanitizeAmbientItem(raw, ambientMediaIds) {
    if (!raw || typeof raw !== 'object' || !AMBIENT_ITEM_TYPES.includes(raw.type)) return null;
    const fallbackDur = (raw.type === 'photo' || raw.type === 'video' || raw.type === 'ad') ? 8 : 10;
    const durationSec = Number.isInteger(raw.durationSec) && raw.durationSec >= 1 && raw.durationSec <= 120 ? raw.durationSec : fallbackDur;
    const item = { id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(), type: raw.type, durationSec };

    if (raw.type === 'photo' || raw.type === 'video') {
        if (typeof raw.mediaId !== 'string' || !ambientMediaIds.has(raw.mediaId)) return null;
        item.mediaId = raw.mediaId;
    } else if (raw.type === 'ad') {
        item.adText = typeof raw.adText === 'string' ? raw.adText.trim().slice(0, 200) : '';
        const qr = typeof raw.adQrUrl === 'string' ? raw.adQrUrl.trim().slice(0, 500) : '';
        item.adQrUrl = /^https?:\/\//i.test(qr) ? qr : '';
        if (!item.adText && !item.adQrUrl) return null;
    } else if (raw.type === 'customVisual') {
        item.customLabel = typeof raw.customLabel === 'string' ? raw.customLabel.trim().slice(0, 60) : '';
        item.background = sanitizeAmbientBackground(raw.background, ambientMediaIds);
        item.layers = (Array.isArray(raw.layers) ? raw.layers : [])
            .slice(0, 40)
            .map(l => sanitizeAmbientLayer(l, ambientMediaIds))
            .filter(Boolean);
    }
    return item;
}

// Drops (or cleans up) references to a removed media library file from an
// ambient block's items - used by the ambient-media DELETE route below.
function stripMediaFromAmbientItems(items, mediaId) {
    return (Array.isArray(items) ? items : [])
        .map(it => {
            if (!it || typeof it !== 'object') return null;
            if ((it.type === 'photo' || it.type === 'video') && it.mediaId === mediaId) return null;
            if (it.type === 'customVisual') {
                const bg = it.background;
                const background = (bg && (bg.type === 'photo' || bg.type === 'video') && bg.mediaId === mediaId)
                    ? { type: 'color', color: '#000000', fit: 'cover' }
                    : bg;
                const layers = (Array.isArray(it.layers) ? it.layers : [])
                    .filter(l => !((l.type === 'photo' || l.type === 'video') && l.mediaId === mediaId));
                return { ...it, background, layers };
            }
            return it;
        })
        .filter(Boolean);
}

// Full replace of playlists+rules+enabled, validated here rather than
// trusted from the client - this is the one place a bad time string or a
// junk playlist URI would otherwise get silently saved and then break the
// tick loop later. Anything that doesn't validate is dropped rather than
// rejecting the whole save, so one bad row doesn't block the rest.
app.post('/e/:slug/api/admin/scheduler', (req, res) => {
    const event = req.event;
    const { enabled, playlists, rules, timezone } = req.body || {};

    // Validated by actually trying to construct a formatter with it rather
    // than matching against a fixed list - that list changes over time
    // (IANA zones get added/renamed), and this way anything the runtime's
    // own tz database recognizes is accepted. An invalid/missing value
    // just means the schedule keeps whatever timezone it already had
    // (falling back to server-local time in tickMusicScheduler if it never
    // had one), rather than failing the whole save over it.
    let safeTimezone = event.musicScheduler.timezone || null;
    if (typeof timezone === 'string' && timezone) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: timezone });
            safeTimezone = timezone;
        } catch (e) {
            console.error(`[SCHEDULER] (${event.slug}) Rejected invalid timezone "${timezone}":`, e.message);
        }
    }

    const safePlaylists = Array.isArray(playlists) ? playlists.map(p => {
        if (!p || typeof p !== 'object') return null;
        const label = typeof p.label === 'string' ? p.label.trim().slice(0, 60) : '';
        const uriRaw = typeof p.uri === 'string' ? p.uri.trim() : '';
        const id = extractSpotifyPlaylistId(uriRaw);
        if (!label || !id) return null;
        const type = p.type === 'karaoke' ? 'karaoke' : 'crowddj';
        return { id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(), label, uri: uriRaw, type };
    }).filter(Boolean).slice(0, 50) : event.musicScheduler.playlists;

    const validDays = new Set([0, 1, 2, 3, 4, 5, 6]);
    const playlistIds = new Set(safePlaylists.map(p => p.id));
    const ambientMediaIds = new Set((event.ambientMedia || []).map(m => m.id));
    const safeRules = Array.isArray(rules) ? rules.map(r => {
        if (!r || typeof r !== 'object') return null;
        if (parseHHMM(r.start) === null || parseHHMM(r.end) === null) return null;
        const days = Array.isArray(r.days) ? [...new Set(r.days.map(d => parseInt(d, 10)).filter(d => validDays.has(d)))] : [];
        if (days.length === 0) return null;
        const id = typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID();
        // Optional admin-chosen label shown on the block instead of the
        // auto-generated one (playlist label / first ambient filename) -
        // see blockTitleFor in scheduler.html. Blank/whitespace-only names
        // are dropped entirely rather than saved as '', so the fallback
        // title logic there keeps working for unnamed blocks.
        const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : null;

        if (r.laneType === 'ambient') {
            // Preserves the admin's chosen order (that order is exactly the
            // sequence the display side plays back), dropping any item that
            // doesn't hold up - e.g. it points at a file removed from the
            // library after this block was built. See sanitizeAmbientItem.
            const items = Array.isArray(r.items)
                ? r.items.slice(0, 60).map(it => sanitizeAmbientItem(it, ambientMediaIds)).filter(Boolean)
                : [];
            if (items.length === 0) return null; // a block with nothing to show isn't a valid block
            return { id, laneType: 'ambient', days, start: r.start, end: r.end, items, ...(name ? { name } : {}) };
        }

        if (r.laneType === 'musicvideo') {
            // videosInARow/visualsAfter describe the repeating pattern the
            // display should cycle through while this block is active:
            // show a real music video for this many songs in a row, then
            // fall back to Ambient Visuals for that many songs, then
            // repeat. Clamped to sane bounds rather than left unbounded -
            // this only controls a display loop, not anything safety
            // critical, so the bounds are generous.
            const videosInARow = Number.isInteger(r.videosInARow) && r.videosInARow >= 1 && r.videosInARow <= 20
                ? r.videosInARow : 2;
            const visualsAfter = Number.isInteger(r.visualsAfter) && r.visualsAfter >= 0 && r.visualsAfter <= 20
                ? r.visualsAfter : 1;
            return { id, laneType: 'musicvideo', days, start: r.start, end: r.end, videosInARow, visualsAfter, ...(name ? { name } : {}) };
        }

        if (!playlistIds.has(r.playlistId)) return null;
        const volume = Number.isInteger(r.volume) && r.volume >= 0 && r.volume <= 100 ? r.volume : null;
        const requestsAllowed = typeof r.requestsAllowed === 'boolean' ? r.requestsAllowed : null;
        return {
            id,
            playlistId: r.playlistId,
            days,
            start: r.start,
            end: r.end,
            volume,
            requestsAllowed,
            ...(name ? { name } : {})
        };
    }).filter(Boolean).slice(0, 200) : event.musicScheduler.rules;

    // Overlaps are rejected outright rather than silently resolved by
    // first-match-wins - two blocks fighting over the same slot almost
    // always means a dragging mistake, and resolving it silently would
    // just hide that from the admin instead of letting them fix it. Ambient
    // blocks only conflict with other ambient blocks, never with music
    // blocks - see findOverlappingRuleAcrossLanes.
    const conflict = findOverlappingRuleAcrossLanes(safeRules);
    if (conflict) {
        return res.status(400).json({
            error: 'Two scheduled blocks overlap - fix the conflict before saving.',
            conflictingRuleIds: [conflict[0].id, conflict[1].id]
        });
    }

    event.musicScheduler.enabled = !!enabled;
    event.musicScheduler.playlists = safePlaylists;
    event.musicScheduler.rules = safeRules;
    event.musicScheduler.timezone = safeTimezone;
    // Force the next tick to re-evaluate from scratch rather than trusting
    // whatever rule used to be "active" under the old timetable. Also drop
    // any switch that was already queued up under the OLD timetable - the
    // rule (or even the whole schedule) it was queued for may no longer
    // exist, so let the next tick decide fresh instead of letting a stale
    // switch fire on data that's just been replaced.
    event.schedulerRuntime.activeRuleId = null;
    cancelPendingSchedulerSwitch(event);
    events.scheduleSave(event.slug);
    res.json({ success: true, playlists: safePlaylists, rules: safeRules, timezone: safeTimezone });
});

// --- Ambient Visuals media library ---------------------------------------
// The browser uploads the actual file bytes straight to Cloudinary using an
// unsigned upload preset (never touches this server at all - keeps large
// photo/video payloads off a free-tier Node process entirely). Once that
// upload finishes, the browser calls this route with just the resulting
// metadata so it can be attached to the event and reused across blocks.
// This route deliberately never sees or handles file bytes itself.
//
// Only Cloudinary URLs are accepted (not arbitrary URLs) - this metadata
// ends up rendered as <img>/<video> src on whatever eventually displays the
// Ambient Visuals lane, so accepting any URL here would turn this into an
// open way to store/serve arbitrary attacker-hosted content under this
// event. res.cloudinary.com is Cloudinary's own delivery domain.
function isCloudinaryUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && /(^|\.)res\.cloudinary\.com$/.test(u.hostname);
    } catch (e) {
        return false;
    }
}

app.post('/e/:slug/api/admin/ambient-media', (req, res) => {
    const event = req.event;
    const { url, filename, type } = req.body || {};
    if (!isCloudinaryUrl(url)) {
        return res.status(400).json({ error: 'That upload URL is not recognized.' });
    }
    if (type !== 'photo' && type !== 'video') {
        return res.status(400).json({ error: 'Media type must be "photo" or "video".' });
    }
    if (!Array.isArray(event.ambientMedia)) event.ambientMedia = [];
    if (event.ambientMedia.length >= 300) {
        return res.status(400).json({ error: 'This event already has 300 ambient files - delete some before adding more.' });
    }
    const safeFilename = typeof filename === 'string' && filename.trim()
        ? filename.trim().slice(0, 120)
        : (type === 'video' ? 'Untitled video' : 'Untitled photo');
    const item = { id: crypto.randomUUID(), url, filename: safeFilename, type, createdAt: Date.now() };
    event.ambientMedia.push(item);
    events.scheduleSave(event.slug);
    res.json({ success: true, item });
});

// Removes a file from the library and strips it out of every block that
// referenced it, rather than leaving a dangling id sitting in a block's items -
// the next schedule save would drop it anyway (see sanitizeAmbientItem in
// POST /api/admin/scheduler), but doing it here too means a block doesn't
// silently lose a file only the next time someone happens to hit Save.
// The asset itself is left alone in Cloudinary (deleting it there requires
// the account's signed API secret, which this server never holds) - it just
// stops being referenced by this event.
app.delete('/e/:slug/api/admin/ambient-media/:mediaId', (req, res) => {
    const event = req.event;
    const { mediaId } = req.params;
    if (!Array.isArray(event.ambientMedia)) event.ambientMedia = [];
    const before = event.ambientMedia.length;
    event.ambientMedia = event.ambientMedia.filter(m => m.id !== mediaId);
    if (event.ambientMedia.length === before) {
        return res.status(404).json({ error: 'That file was not found in this event\'s library.' });
    }
    const rules = event.musicScheduler?.rules || [];
    for (const rule of rules) {
        if (rule.laneType === 'ambient') {
            rule.items = stripMediaFromAmbientItems(rule.items, mediaId);
        }
    }
    // A block that's had every one of its items removed this way is no
    // longer valid (see the "items.length === 0 -> drop the rule" check
    // in POST /api/admin/scheduler) - drop it here too instead of leaving
    // an empty, unreachable block sitting in the timetable until the next
    // save happens to clean it up.
    event.musicScheduler.rules = rules.filter(r => r.laneType !== 'ambient' || (r.items && r.items.length > 0));
    events.scheduleSave(event.slug);
    res.json({ success: true, ambientMedia: event.ambientMedia, rules: event.musicScheduler.rules });
});

// --- DJ transport controls ---
// All of these ride on the same user-modify-playback-state scope already
// granted by the existing "Connect Spotify" flow (see DJ_QUEUE_SCOPES above)
// - no new auth, no new Spotify app review, just routes that were never
// wired up to that scope's other endpoints.
app.post('/e/:slug/api/admin/playback/play', async (req, res) => {
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/play');
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/pause', async (req, res) => {
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/pause');
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/next', async (req, res) => {
    const result = await spotifyPlayerCommand(req.event, 'POST', '/next');
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/previous', async (req, res) => {
    const result = await spotifyPlayerCommand(req.event, 'POST', '/previous');
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/volume', async (req, res) => {
    const vol = parseInt(req.body.volumePercent);
    if (!Number.isInteger(vol) || vol < 0 || vol > 100) {
        return res.status(400).json({ error: 'volumePercent must be an integer 0-100.' });
    }
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/volume', `?volume_percent=${vol}`);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/shuffle', async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true/false.' });
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/shuffle', `?state=${req.body.enabled}`);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/playback/repeat', async (req, res) => {
    const mode = req.body.mode;
    if (!['track', 'context', 'off'].includes(mode)) return res.status(400).json({ error: 'mode must be track, context, or off.' });
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/repeat', `?state=${mode}`);
    res.status(result.success ? 200 : 400).json(result);
});

// Seeking needs the caller to know roughly where they clicked - client sends
// the target position, we just relay it. Spotify clamps out-of-range values
// itself rather than erroring, so no bounds-checking needed here.
app.post('/e/:slug/api/admin/playback/seek', async (req, res) => {
    const positionMs = parseInt(req.body.positionMs);
    if (!Number.isInteger(positionMs) || positionMs < 0) return res.status(400).json({ error: 'positionMs must be a non-negative integer.' });
    const result = await spotifyPlayerCommand(req.event, 'PUT', '/seek', `?position_ms=${positionMs}`);
    res.status(result.success ? 200 : 400).json(result);
});

app.post('/e/:slug/api/admin/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') req.event.systemConfigs.requestsAllowed = allow;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-explicit', (req, res) => {
    const { blockExplicit } = req.body;
    if (typeof blockExplicit === 'boolean') req.event.systemConfigs.explicitBlockActive = blockExplicit;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-radio-edits', (req, res) => {
    const { radioEditsOnly } = req.body;
    if (typeof radioEditsOnly === 'boolean') req.event.systemConfigs.radioEditsOnly = radioEditsOnly;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/toggle-location-lock', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.systemConfigs.locationLockEnabled = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

// Lets an admin loosen/tighten the check-in radius per event instead of
// every event being stuck with the hardcoded REQUEST_RADIUS_METERS default.
// Clamped to a sane range - under 10m is unusable given normal GPS drift,
// and over 5km stops meaning anything as a "you're at the venue" check.
app.post('/e/:slug/api/admin/location-radius', (req, res) => {
    const meters = parseInt(req.body.meters, 10);
    if (!Number.isInteger(meters) || meters < 10 || meters > 5000) {
        return res.status(400).json({ error: 'Distance must be between 10 and 5000 meters.' });
    }
    req.event.systemConfigs.locationRadiusMeters = meters;
    events.scheduleSave(req.event.slug);
    res.json({ success: true, locationRadiusMeters: meters });
});

app.post('/e/:slug/api/admin/kiosk/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') req.event.kioskConfigs.requestsAllowed = allow;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/kiosk/toggle-spotify', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.kioskConfigs.spotifyConnectEnabled = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/kiosk/toggle-display-only', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') req.event.kioskConfigs.displayOnlyMode = enabled;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

// ---- Admin -> Settings -> Content toggles ----
function makeVisualsToggleRoute(key) {
    return (req, res) => {
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
        ensureVisualsConfigs(req.event)[key] = enabled;
        events.scheduleSave(req.event.slug);
        res.json({ success: true });
    };
}
app.post('/e/:slug/api/admin/visuals/toggle-mute', makeVisualsToggleRoute('muteVisuals'));
app.post('/e/:slug/api/admin/visuals/toggle-show-queue', makeVisualsToggleRoute('showQueue'));
app.post('/e/:slug/api/admin/visuals/toggle-music-videos', makeVisualsToggleRoute('musicVideosEnabled'));
app.post('/e/:slug/api/admin/visuals/toggle-music-video-subtitles', makeVisualsToggleRoute('musicVideoSubtitlesEnabled'));
app.post('/e/:slug/api/admin/visuals/toggle-family-mode', makeVisualsToggleRoute('familyModeEnabled'));

// Item 8: family-mode safety lists. Deliberately global (see the comment on
// musicVideoDenylist/musicVideoAllowlist above) - reachable from any event's
// admin panel, same as the rest of /e/:slug/api/admin, but the effect isn't
// scoped to that one event. GET returns both lists so the admin UI can show
// what's already there; the POST/DELETE pairs add or remove a single track.
app.get('/e/:slug/api/admin/visuals/family-lists', (req, res) => {
    res.json({
        denylist: [...musicVideoDenylist],
        allowlist: Object.fromEntries(musicVideoAllowlist)
    });
});

app.post('/e/:slug/api/admin/visuals/family-denylist', (req, res) => {
    const { trackId } = req.body || {};
    if (!trackId || typeof trackId !== 'string') return res.status(400).json({ error: 'trackId is required.' });
    musicVideoDenylist.add(trackId);
    // A track being denylisted always wins over a stale allow entry - remove
    // it there too rather than leaving both lists disagreeing about the same
    // track, which the display route above would otherwise have to arbitrate.
    musicVideoAllowlist.delete(trackId);
    events.scheduleFamilyListsSave(familyListsSnapshot);
    res.json({ success: true, denylist: [...musicVideoDenylist] });
});

app.delete('/e/:slug/api/admin/visuals/family-denylist/:trackId', (req, res) => {
    musicVideoDenylist.delete(req.params.trackId);
    events.scheduleFamilyListsSave(familyListsSnapshot);
    res.json({ success: true, denylist: [...musicVideoDenylist] });
});

// Approving a track for family mode requires the specific {videoId,
// introOffsetMs} that's actually going to play, not just the trackId - a
// human reviewing this is expected to be looking at verifiedMusicVideoCache's
// existing entry for the track (or a candidate they've watched themselves)
// and approving THAT specific video, not just green-lighting the trackId in
// the abstract for whatever the pipeline finds later.
app.post('/e/:slug/api/admin/visuals/family-allowlist', (req, res) => {
    const { trackId, videoId, introOffsetMs } = req.body || {};
    if (!trackId || typeof trackId !== 'string') return res.status(400).json({ error: 'trackId is required.' });
    if (!videoId || typeof videoId !== 'string') return res.status(400).json({ error: 'videoId is required.' });
    if (musicVideoDenylist.has(trackId)) return res.status(400).json({ error: 'This track is denylisted; remove it from the denylist first.' });
    musicVideoAllowlist.set(trackId, {
        videoId,
        introOffsetMs: Number.isFinite(Number(introOffsetMs)) ? Number(introOffsetMs) : 0,
        approvedAt: Date.now()
    });
    events.scheduleFamilyListsSave(familyListsSnapshot);
    res.json({ success: true, allowlist: Object.fromEntries(musicVideoAllowlist) });
});

app.delete('/e/:slug/api/admin/visuals/family-allowlist/:trackId', (req, res) => {
    musicVideoAllowlist.delete(req.params.trackId);
    events.scheduleFamilyListsSave(familyListsSnapshot);
    res.json({ success: true, allowlist: Object.fromEntries(musicVideoAllowlist) });
});

// How far ahead/behind of the raw Spotify position the whole video stream
// targets - see MUSIC_VIDEO_OFFSET_MIN_MS/MAX_MS. Positive moves the video
// earlier (use when the video looks late against the audio); negative
// moves it later.
app.post('/e/:slug/api/admin/visuals/music-video-offset', (req, res) => {
    const { offsetMs } = req.body || {};
    const parsed = Number(offsetMs);
    if (!Number.isFinite(parsed)) return res.status(400).json({ error: 'offsetMs must be a number.' });
    const clamped = Math.max(MUSIC_VIDEO_OFFSET_MIN_MS, Math.min(MUSIC_VIDEO_OFFSET_MAX_MS, Math.round(parsed)));
    ensureVisualsConfigs(req.event).musicVideoOffsetMs = clamped;
    events.scheduleSave(req.event.slug);
    res.json({ success: true, offsetMs: clamped });
});

// Step-by-step diagnosis of the music-video pipeline for the song playing
// right now. Needs the admin password header, e.g.:
//   curl -H "x-admin-password: YOURPASSWORD" "https://HOST/e/SLUG/api/admin/visuals/music-video-debug?run=1"
// Without ?run=1 it only reports state (instant). With ?run=1 it actually runs
// the pipeline (YouTube lookup, ytdl probe, audio download, frame check,
// correlation) and reports exactly which step fails - can take up to a minute.
app.get('/e/:slug/api/admin/visuals/music-video-debug', async (req, res) => {
    const event = req.event;
    const vcfg = ensureVisualsConfigs(event);
    const np = event.cachedNowPlaying || {};
    const runtime = ensureMusicVideoRuntime(event);
    let nulls = 0, matches = 0;
    for (const v of verifiedMusicVideoCache.values()) { if (v === null) nulls++; else matches++; }
    const out = {
        env: { youtubeApiKeySet: !!YOUTUBE_API_KEY, ffmpegPath: ffmpegPath || null, quotaUsedToday: youtubeQuotaUsedToday, quotaBudget: YOUTUBE_DAILY_QUOTA_BUDGET },
        gates: { musicVideosEnabled: vcfg.musicVideosEnabled, muteVisuals: vcfg.muteVisuals, muteAll: vcfg.muteAll, showQueue: vcfg.showQueue, familyMode: vcfg.familyModeEnabled, schedulerEnabled: !!event.musicScheduler?.enabled },
        nowPlaying: { trackId: np.trackId || null, title: np.title || null, artist: np.artist || null, durationMs: np.durationMs || null, isPlaying: !!np.isPlaying },
        cache: {
            verifiedMatches: matches, verifiedNoMatch: nulls,
            thisTrack: np.trackId ? (verifiedMusicVideoCache.has(np.trackId) ? verifiedMusicVideoCache.get(np.trackId) : 'not verified yet') : null,
            denylisted: np.trackId ? musicVideoDenylist.has(np.trackId) : null,
            familyModeAllowlisted: np.trackId ? musicVideoAllowlist.has(np.trackId) : null,
            retryState: np.trackId ? (verificationRetryState.get(np.trackId) || null) : null,
            inFlight: np.trackId ? verificationInFlight.has(np.trackId) : null,
            eventRuntimeCache: runtime.cache
        },
        verificationQueue: { active: mvVerificationActiveCount, waiting: mvVerificationQueue.length, inFlightTotal: verificationInFlight.size }
    };
    if (req.query.run !== '1') return res.json(out);
    if (!np.trackId || !np.title || !np.artist || !np.durationMs) { out.run = [{ step: 'abort', why: 'no complete now-playing info to test with' }]; return res.json(out); }

    const steps = [];
    out.run = steps;
    try {
        const artistNames = np.artist.split(',').map(x => x.trim()).filter(Boolean);
        const failuresBefore = youtubeFailureCount;
        const candidates = await youtubeFindCandidates(artistNames, `${artistNames.join(' ')} ${np.title} official music video`, np.title);
        steps.push({ step: '1_youtube_candidates', count: candidates.length, youtubeFailuresDuringLookup: youtubeFailureCount - failuresBefore,
            sample: candidates.slice(0, 8).map(v => ({ title: v.title, channel: v.channelTitle, durationMs: v.durationMs, id: v.videoId })) });

        const core = normalizeForMatch(coreSongTitle(np.title));
        const f1 = candidates.filter(v => !titleLooksDisqualified(v.title));
        const f2 = f1.filter(v => channelMatchesAnyArtist(v.channelTitle, artistNames));
        const f3 = f2.filter(v => normalizeForMatch(v.title).includes(core));
        const f4 = f3.filter(v => typeof v.durationMs === 'number' && Math.abs(v.durationMs - np.durationMs) <= MUSIC_VIDEO_MAX_DURATION_DIFF_MS);
        steps.push({ step: '2_filters', songCore: core, songDurationMs: np.durationMs, start: candidates.length,
            afterNotLiveLyricAudioTitle: f1.length, afterChannelIsTheArtist: f2.length, afterTitleContainsSong: f3.length, afterDurationWithin60s: f4.length });

        const probeId = (f4[0] || candidates[0] || {}).videoId;
        if (!probeId) { steps.push({ step: 'stop', why: 'no candidate to test further' }); return res.json(out); }

        try {
            const t0 = Date.now();
            const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${probeId}`);
            steps.push({ step: '3_ytdl_getInfo', ok: true, ms: Date.now() - t0, formats: (info.formats || []).length });
        } catch (e) {
            steps.push({ step: '3_ytdl_getInfo', ok: false, error: e.message, hint: 'ytdl cannot read YouTube from this server (bot-check / outdated library). Every audio + frame check depends on this.' });
            return res.json(out);
        }

        const t1 = Date.now();
        const ref = await getReferenceAudioEnvelope(np.trackId, artistNames, np.title, np.durationMs);
        steps.push({ step: '4_reference_audio', ok: !!ref, points: ref ? ref.length : 0, ms: Date.now() - t1,
            hint: ref ? undefined : 'no reference upload found (artist "audio" upload within 4s of song length) or its download failed - videos cannot be verified without it' });
        if (!ref) return res.json(out);

        const perCandidate = [];
        for (const c of f4.slice(0, 3)) {
            const row = { id: c.videoId, title: c.title };
            const env = await extractAudioEnvelope(c.videoId, MUSIC_VIDEO_AUDIO_WINDOW_SEC);
            row.audioDownloaded = !!env;
            const fv = await computeFrameVerification(c.videoId, c.durationMs);
            row.frames = { failed: !!fv.failed, motionScore: fv.motionScore, minRequired: MUSIC_VIDEO_MOTION_MIN_AVG_DIFF, moderationFlagged: fv.moderationFlagged };
            if (env) {
                const { videoLeadMs, confidence } = crossCorrelateEnvelopes(ref, env, MUSIC_VIDEO_MAX_OFFSET_SEARCH_SEC);
                row.audioMatch = { confidence: Math.round(confidence * 1000) / 1000, needed: MUSIC_VIDEO_MATCH_ACCEPT_CONFIDENCE, videoLeadMs };
            }
            perCandidate.push(row);
        }
        steps.push({ step: '5_candidates_checked', results: perCandidate });
    } catch (e) {
        steps.push({ step: 'error', error: e.message });
    }
    res.json(out);
});

// Clears music-video verification state so tracks get re-verified. By default
// only cached "no match" entries are dropped (matches are kept); send
// {"all": true} to drop matches too. Also clears the in-memory caches that can
// hold a stale failure (reference audio, frame checks, artist lookups) and
// the retry backoff, and makes this event's current song re-check right away.
app.post('/e/:slug/api/admin/visuals/music-video-cache/clear', (req, res) => {
    const all = !!(req.body && req.body.all === true);
    let removed = 0;
    for (const [trackId, result] of [...verifiedMusicVideoCache.entries()]) {
        if (all || result === null) { verifiedMusicVideoCache.delete(trackId); removed++; }
    }
    referenceAudioEnvelopeCache.clear();
    frameVerificationCache.clear();
    artistUploadsListCache.clear();
    for (const [k, v] of [...artistChannelCache.entries()]) { if (v === null) artistChannelCache.delete(k); }
    verificationRetryState.clear();
    const runtime = ensureMusicVideoRuntime(req.event);
    runtime.cache = { trackId: runtime.cache && runtime.cache.trackId || null, searchedTrackId: null, matched: false, videoId: null, introOffsetMs: 0 };
    events.scheduleMusicVideoCacheSave(musicVideoCacheSnapshot);
    res.json({ success: true, removed, remaining: verifiedMusicVideoCache.size });
});

// Mute All = Mute Visuals + pause Spotify. Switching it back off resumes
// playback, but only if this toggle was the thing that paused it.
app.post('/e/:slug/api/admin/visuals/toggle-mute-all', async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
    const v = ensureVisualsConfigs(req.event);
    const wasOn = v.muteAll;
    v.muteAll = enabled;
    let playbackOk = null;
    try {
        if (enabled && !wasOn) {
            const result = await spotifyPlayerCommand(req.event, 'PUT', '/pause');
            playbackOk = !!(result && result.success);
            v.pausedByMuteAll = playbackOk;
        } else if (!enabled && wasOn) {
            if (v.pausedByMuteAll) {
                const result = await spotifyPlayerCommand(req.event, 'PUT', '/play');
                playbackOk = !!(result && result.success);
            }
            v.pausedByMuteAll = false;
        }
    } catch (err) {
        console.error('[VISUALS] Mute All playback command failed:', err.message);
        playbackOk = false;
    }
    events.scheduleSave(req.event.slug);
    res.json({ success: true, playbackOk });
});

app.post('/e/:slug/api/admin/kiosk/config', (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    const kc = req.event.kioskConfigs;
    if (maxCredits !== undefined) kc.maxCredits = parseInt(maxCredits) || kc.maxCredits;
    if (countdownLength !== undefined) kc.countdownLength = parseInt(countdownLength) || kc.countdownLength;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
});

// Blocks a specific guest (by voterId, from a row in the admin Stats
// "Recent Requests" list) from requesting or voting for the rest of this
// event. `label` is just the name they were requesting under at the time -
// stored purely so the "Blocked Guests" list in admin.html is legible,
// never used for matching.
app.post('/e/:slug/api/admin/block-voter', (req, res) => {
    const event = req.event;
    const { voterId, label } = req.body;
    if (typeof voterId !== 'string' || !voterId) return res.status(400).json({ error: 'Missing voterId.' });
    event.blockedVoters[voterId] = {
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 30) : 'Guest',
        blockedAt: Date.now()
    };
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/unblock-voter', (req, res) => {
    const event = req.event;
    const { voterId } = req.body;
    if (typeof voterId === 'string') delete event.blockedVoters[voterId];
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// --- Blocked tab: artists, tracks, genres ---
// Same shape as block-voter/unblock-voter above - store just enough (name,
// timestamp) to render the "Currently Blocked" list without a Spotify
// round-trip, and let isArtistBlocked/isTrackBlocked do the real work at
// search and request time.
app.post('/e/:slug/api/admin/block-artist', (req, res) => {
    const event = req.event;
    const { artistId, name } = req.body;
    if (typeof artistId !== 'string' || !artistId) return res.status(400).json({ error: 'Missing artistId.' });
    if (!event.blockedArtists) event.blockedArtists = {};
    event.blockedArtists[artistId] = {
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Unknown Artist',
        blockedAt: Date.now()
    };
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/unblock-artist', (req, res) => {
    const event = req.event;
    const { artistId } = req.body;
    if (typeof artistId === 'string' && event.blockedArtists) delete event.blockedArtists[artistId];
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/block-track', (req, res) => {
    const event = req.event;
    const { trackId, name, artist } = req.body;
    if (typeof trackId !== 'string' || !trackId) return res.status(400).json({ error: 'Missing trackId.' });
    if (!event.blockedTracks) event.blockedTracks = {};
    event.blockedTracks[trackId] = {
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'Unknown Track',
        artist: typeof artist === 'string' ? artist.trim().slice(0, 120) : '',
        blockedAt: Date.now()
    };
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/unblock-track', (req, res) => {
    const event = req.event;
    const { trackId } = req.body;
    if (typeof trackId === 'string' && event.blockedTracks) delete event.blockedTracks[trackId];
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// Genre blocking reuses the exact same systemConfigs.genreFilter array the
// Settings tab's filter chips already read/write (see /admin/config above) -
// these just add/remove one key at a time instead of replacing the whole
// array, so the Blocked tab and Settings tab never fight over it.
app.post('/e/:slug/api/admin/block-genre', (req, res) => {
    const event = req.event;
    const { genreKey } = req.body;
    if (typeof genreKey !== 'string' || !Object.prototype.hasOwnProperty.call(GENRE_CATEGORIES, genreKey)) {
        return res.status(400).json({ error: 'Unknown genre.' });
    }
    if (!Array.isArray(event.systemConfigs.genreFilter)) event.systemConfigs.genreFilter = [];
    if (!event.systemConfigs.genreFilter.includes(genreKey)) event.systemConfigs.genreFilter.push(genreKey);
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.post('/e/:slug/api/admin/unblock-genre', (req, res) => {
    const event = req.event;
    const { genreKey } = req.body;
    if (typeof genreKey === 'string') {
        event.systemConfigs.genreFilter = (event.systemConfigs.genreFilter || []).filter(k => k !== genreKey);
    }
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// Combined search for the Blocked tab: one query hits Spotify for both
// tracks and artists (type=track,artist in a single call) and checks the
// query against the curated genre categories locally - no separate genre
// search exists on Spotify's side, and this is a small fixed list anyway.
// Each result carries `blocked` so the UI shows the right button state
// without a second round-trip.
app.get('/e/:slug/api/admin/blocklist-search', async (req, res) => {
    const event = req.event;
    const query = req.query.q;
    if (!query) return res.json({ tracks: [], artists: [], genres: [] });
    if (!spotifyAccessToken) await getSpotifyToken();
    try {
        const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,artist&limit=8`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        if (!searchRes.ok) return res.status(502).json({ error: 'Spotify search temporarily unavailable.' });
        const data = await searchRes.json();

        const tracks = (data.tracks?.items || []).map(t => ({
            id: t.id,
            name: t.name,
            artist: (t.artists || []).map(a => a.name).join(', '),
            artwork: t.album?.images?.[0]?.url || 'https://picsum.photos/48',
            blocked: isTrackBlocked(event, t.id)
        }));

        const artists = (data.artists?.items || []).map(a => ({
            id: a.id,
            name: a.name,
            image: a.images?.[a.images.length - 1]?.url || null,
            blocked: isArtistBlocked(event, a.id)
        }));

        const q = query.trim().toLowerCase();
        const genres = Object.keys(GENRE_CATEGORIES)
            .filter(key => key.includes(q) || GENRE_LABELS[key].toLowerCase().includes(q))
            .map(key => ({
                key,
                label: GENRE_LABELS[key],
                blocked: (event.systemConfigs.genreFilter || []).includes(key)
            }));

        res.json({ tracks, artists, genres });
    } catch (err) {
        console.error('[BLOCKLIST SEARCH] Failed:', err.message);
        res.status(500).json({ error: 'Search unavailable' });
    }
});

// Admin-only search, used by the "Add a Song" panel in the Live Queue tab.
// Deliberately much simpler than the public /api/search: one page of 10
// results, no explicit/radio-edit/decade/genre/cooldown filtering - those
// rules are for guests, not for the DJ manually placing a track.
app.get('/e/:slug/api/admin/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    if (!spotifyAccessToken) await getSpotifyToken();
    try {
        const searchRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        if (!searchRes.ok) return res.status(502).json({ error: 'Spotify search temporarily unavailable.' });
        const data = await searchRes.json();
        const tracks = (data.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: (track.artists || []).map(a => a.name).join(', '),
            artwork: track.album?.images?.[0]?.url || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: formatDuration(track.duration_ms)
        }));
        res.json({ tracks });
    } catch (err) {
        console.error('[ADMIN SEARCH] Failed:', err.message);
        res.status(500).json({ error: 'Search feature unavailable' });
    }
});

// Manually drops a track straight into the live queue, bypassing every
// guest-side gate (credits, cooldown, queue cap, filters, geofence) - this
// is the DJ overriding, not a guest requesting. `label` becomes the
// "requested by" name shown on the card (defaults to "DJ Added").
app.post('/e/:slug/api/admin/add-track', async (req, res) => {
    const event = req.event;
    const { trackId, label } = req.body;
    if (!trackId || !/^[A-Za-z0-9]{22}$/.test(trackId)) {
        return res.status(400).json({ error: 'Invalid track ID.' });
    }
    if (!spotifyAccessToken) await getSpotifyToken();
    let t;
    try {
        const lookupRes = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        if (!lookupRes.ok) return res.status(400).json({ error: 'Track not found on Spotify.' });
        t = await lookupRes.json();
        if (!t || !t.id) return res.status(400).json({ error: 'Track not found on Spotify.' });
    } catch (err) {
        return res.status(500).json({ error: 'Could not verify track with Spotify.' });
    }

    const verifiedTrack = {
        id: t.id,
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', ') || 'Unknown Artist',
        artwork: t.album?.images?.[0]?.url || 'https://picsum.photos/48',
        explicit: t.explicit || false,
        duration: formatDuration(t.duration_ms || 0),
        durationMs: t.duration_ms || 0 // raw ms, for the music-video eager verification trigger below
    };
    const requesterName = (typeof label === 'string' && label.trim() !== '') ? label.trim().slice(0, 30) : 'DJ Added';

    const existingTrack = event.activeQueue.find(tr => tr.id === verifiedTrack.id);
    if (existingTrack) {
        if (!existingTrack.requesters) existingTrack.requesters = [];
        existingTrack.requesters.push(requesterName);
    } else {
        event.activeQueue.push({
            id: verifiedTrack.id,
            title: verifiedTrack.name,
            artist: verifiedTrack.artist,
            artwork: verifiedTrack.artwork,
            explicit: verifiedTrack.explicit,
            duration: verifiedTrack.duration,
            upvoters: [],
            downvoters: [],
            requesters: [requesterName],
            order: nextQueueOrder(event)
        });
        if (event.systemConfigs.spotifyAutoQueueEnabled) {
            queueTrackOnSpotify(event, verifiedTrack.id);
        }
    }

    // Item 1: same eager verification trigger as the guest-request route -
    // a DJ-added track is just as much "known to be coming up" as a guest
    // request is.
    triggerMusicVideoVerification(verifiedTrack.id, verifiedTrack.artist, verifiedTrack.name, verifiedTrack.durationMs);

    event.requestLog.push({
        trackId: verifiedTrack.id,
        title: verifiedTrack.name,
        artist: verifiedTrack.artist,
        artwork: verifiedTrack.artwork,
        explicit: verifiedTrack.explicit,
        voterId: 'admin-added',
        username: requesterName,
        status: 'queued',
        requestedAt: Date.now()
    });
    if (event.requestLog.length > 2000) event.requestLog = event.requestLog.slice(-2000);

    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// Exports this event's "rules" (credit/countdown/filter/kiosk settings) as a
// small JSON blob for the "Duplicate as Template" button on admin.html.
// Deliberately excludes eventName, venue, password, queue/history/stats,
// and anything Spotify - a template is just the settings, not a clone.
app.get('/e/:slug/api/admin/export-template', (req, res) => {
    const sc = req.event.systemConfigs;
    const kc = req.event.kioskConfigs;
    res.json({
        systemConfigs: {
            maxCredits: sc.maxCredits,
            countdownLength: sc.countdownLength,
            explicitBlockActive: sc.explicitBlockActive,
            radioEditsOnly: sc.radioEditsOnly,
            queueCapEnabled: sc.queueCapEnabled,
            maxQueueLength: sc.maxQueueLength,
            genreFilter: sc.genreFilter || [],
            decadeFilter: sc.decadeFilter || [],
            guestSpotifyConnectEnabled: sc.guestSpotifyConnectEnabled,
            spotifyAutoQueueEnabled: sc.spotifyAutoQueueEnabled
        },
        kioskConfigs: {
            maxCredits: kc.maxCredits,
            countdownLength: kc.countdownLength,
            spotifyConnectEnabled: kc.spotifyConnectEnabled,
            displayOnlyMode: kc.displayOnlyMode
        }
    });
});

app.post('/e/:slug/api/admin/action', (req, res) => {
    const event = req.event;
    const { id, action } = req.body;
    if (action === 'clearQueue') {
        event.activeQueue.forEach(t => markRequestLogStatus(event, t.id, 'removed'));
        event.activeQueue = [];
        events.scheduleSave(event.slug);
        return res.json({ success: true });
    }
    if (action === 'clearHistory') {
        event.playedHistory = [];
        events.scheduleSave(event.slug);
        return res.json({ success: true });
    }

    const trackIndex = event.activeQueue.findIndex(t => t.id === id);
    if (trackIndex !== -1) {
        if (action === 'played') {
            markTrackPlayedByIndex(event, trackIndex);
        } else if (action === 'remove') {
            const [track] = event.activeQueue.splice(trackIndex, 1);
            markRequestLogStatus(event, track.id, 'removed');
            logDepartedTrack(event, track, 'dropped');
        }
    }
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// Replaces the old "Top" button's fake-upvote trick with a real manual
// position - the DJ drags a track in the Live Queue (via the handle icon)
// and the admin UI sends the queue's new full id order here every time a
// drag settles. Re-assigning `order` (1, 2, 3...) for every id in the given
// list, in the order given, rather than trying to compute a single track's
// new index - simplest way to stay correct even if two admins are looking
// at slightly different snapshots, and it self-heals if any ids are
// missing/stale (they're just ignored).
app.post('/e/:slug/api/admin/reorder', (req, res) => {
    const event = req.event;
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array.' });
    let position = 1;
    orderedIds.forEach(id => {
        const track = event.activeQueue.find(t => t.id === id);
        if (track) track.order = position++;
    });
    events.scheduleSave(event.slug);
    res.json({ success: true });
});

// --- Auto-sync + now-playing cache (per event) ---
// Two jobs share this one poll per event so we're not hitting Spotify twice a tick:
//   1. Remove a request from the local queue the moment Spotify actually starts
//      playing it, so the DJ doesn't have to manually click "Played" for every
//      guest request.
//   2. Cache the current track/progress so the "Now Playing" bar on all three
//      pages can poll a cheap local endpoint instead of every browser hitting
//      Spotify's API directly every few seconds.
async function syncNowPlayingForEvent(event) {
    const token = await getDjAccessToken(event);
    if (!token) {
        // Spotify itself is unreachable/disconnected (token refresh failed,
        // Spotify's own API is down, etc.) - this is the same kind of
        // transient gap as the "leave the last known cache in place" case
        // below for a non-ok player response, just one step earlier in the
        // pipeline. Wiping trackId/title/artist here (as this used to do)
        // made a brief outage indistinguishable from the song genuinely
        // changing to "nothing" - which tore down the Music Video overlay
        // and, once Spotify reconnected, restarted it from scratch instead
        // of just holding the existing video paused through the gap (see
        // the isPlaying:false handling in the /api/music-video route).
        // Keep the last known track identity and position; only the
        // connectivity flags actually change.
        const prev = event.cachedNowPlaying || {};
        event.cachedNowPlaying = {
            ...prev,
            connected: false, isPlaying: false,
            trackId: prev.trackId || null, title: prev.title || null, artist: prev.artist || null,
            artwork: prev.artwork || null, progressMs: prev.progressMs || 0, durationMs: prev.durationMs || 0,
            updatedAt: Date.now(), upcoming: prev.upcoming || [],
            deviceName: prev.deviceName || null, volumePercent: prev.volumePercent ?? null,
            shuffleState: prev.shuffleState || false, repeatState: prev.repeatState || 'off'
        };
        return;
    }
    try {
        // Full player state (not just /currently-playing) - this is the one call
        // that also returns device name/volume, shuffle_state, and repeat_state,
        // which the admin playback tab needs to show accurate button/slider state.
        //
        // Fired together with the queue fetch below (Promise.all) rather than
        // one after the other - these are independent reads, and awaiting them
        // sequentially was roughly doubling the round-trip time of every sync
        // tick for no reason.
        // Progress is read at some moment DURING the player request, not when
        // the queue call (the slower of the two) finally finishes - so the
        // capture time recorded below is the midpoint of the player request
        // itself. Stamping it with the end of Promise.all made every
        // reading look fresher than it was, i.e. the video ran behind.
        const requestedAt = Date.now();
        let playerReceivedAt = requestedAt;
        const [res, queueRes] = await Promise.all([
            fetch('https://api.spotify.com/v1/me/player', {
                headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => { playerReceivedAt = Date.now(); return r; }),
            fetch('https://api.spotify.com/v1/me/player/queue', {
                headers: { 'Authorization': `Bearer ${token}` }
            }).catch(err => {
                console.error(`[SPOTIFY SYNC] (${event.slug}) Upcoming queue fetch failed:`, err.message);
                return null;
            })
        ]);
        if (res.status === 204 || res.status === 404) {
            event.cachedNowPlaying = { connected: true, isPlaying: false, trackId: null, title: null, artist: null, artwork: null, progressMs: 0, durationMs: 0, updatedAt: Date.now(), upcoming: [], deviceName: null, volumePercent: null, shuffleState: false, repeatState: 'off' };
            return;
        }
        if (!res.ok) return; // leave the last known cache in place on a transient error
        const data = await res.json();
        const item = data?.item;

        let upcoming = event.cachedNowPlaying.upcoming;
        if (queueRes && queueRes.ok) {
            const queueData = await queueRes.json();
            upcoming = (queueData.queue || []).slice(0, 40).map(t => ({
                id: t.id,
                title: t.name,
                artist: (t.artists || []).map(a => a.name).join(', '),
                artwork: t.album?.images?.[0]?.url || null,
                durationMs: t.duration_ms || 0
            }));

            // Item 1: a track can reach Spotify's own queue without ever
            // passing through this app's guest-request route (queued
            // directly in Spotify, or staged by pushNextTrackToSpotifyIfNeeded
            // itself) - diff against what the PREVIOUS poll saw so eager
            // verification fires exactly once per track as it first appears,
            // not on every single poll it happens to still be sitting there.
            const previouslySeenIds = new Set((event.cachedNowPlaying.upcoming || []).map(u => u.id));
            upcoming.forEach(u => {
                if (!previouslySeenIds.has(u.id)) {
                    triggerMusicVideoVerification(u.id, u.artist, u.title, u.durationMs);
                }
            });
        }

        event.cachedNowPlaying = {
            connected: true,
            isPlaying: !!data.is_playing,
            trackId: item?.id || null,
            title: item?.name || null,
            artist: item ? (item.artists || []).map(a => a.name).join(', ') : null,
            artwork: item?.album?.images?.[0]?.url || null,
            progressMs: data.progress_ms || 0,
            durationMs: item?.duration_ms || 0,
            updatedAt: Date.now(),
            progressCapturedAt: Math.round((requestedAt + playerReceivedAt) / 2),
            upcoming,
            deviceName: data.device?.name || null,
            volumePercent: typeof data.device?.volume_percent === 'number' ? data.device.volume_percent : null,
            shuffleState: !!data.shuffle_state,
            repeatState: data.repeat_state || 'off'
        };

        const nowPlayingId = item?.id;
        if (!nowPlayingId || nowPlayingId === event.lastSyncedNowPlayingId) return;
        event.lastSyncedNowPlayingId = nowPlayingId;

        const trackIndex = event.activeQueue.findIndex(t => t.id === nowPlayingId);
        if (trackIndex !== -1) {
            const track = markTrackPlayedByIndex(event, trackIndex);
            events.scheduleSave(event.slug);
            console.log(`[SPOTIFY SYNC] (${event.slug}) Now playing, removed from local queue:`, track.title);
        }
    } catch (err) {
        console.error(`[SPOTIFY SYNC] (${event.slug}) Poll failed:`, err.message);
    }
}

// Only polls events currently loaded in memory (i.e. touched recently this
// session), and only ones with a Spotify DJ connection actually set up -
// no point waking up every event ever created on every tick.
//
// Runs every event's sync concurrently (Promise.allSettled) instead of one
// at a time - with several events loaded (this cache never evicts, so it
// only grows over a server's lifetime) a sequential loop meant one slow or
// hung Spotify call held up the refresh for every other event too, and the
// nominal "every 4s" cadence could stretch out to many multiples of that as
// more events accumulated. isSyncing guards against a tick still running
// when the next setInterval fire comes around, which would otherwise pile
// up more and more concurrent requests over time rather than just skipping
// that tick and catching up on the next one.
// Normal cadence for the "Now Playing" cache - plenty for the UI bar and
// for the scheduler most of the time.
const NOW_PLAYING_NORMAL_POLL_MS = 4000;
// While a scheduler switch is pending AND we're waiting on a currently-
// playing track to finish (see schedulerBoundaryWatch above), the gap
// between the real track-change boundary and us noticing it is exactly
// however long we go between polls of THAT event - so it gets polled every
// tick instead, to keep the "how much of the wrong track could play before
// we catch it and switch" window as tight as the process loop allows.
const SCHEDULER_FAST_POLL_MS = 1000;

// Tracks the last time each event's now-playing was actually polled from
// Spotify, so the two cadences above can share one process tick without
// hitting Spotify 4x more often than needed for events that aren't
// mid-switch. Runtime-only, same reasoning as schedulerBoundaryWatch.
const nowPlayingLastSyncedAt = new Map();

let isSyncingAllEvents = false;
async function syncAllLoadedEvents() {
    if (isSyncingAllEvents) return;
    isSyncingAllEvents = true;
    try {
        const loaded = events.getLoadedEvents();
        const connected = loaded.filter(e => e.spotify.djRefreshToken);
        // Now-playing sync only matters (and only works) for events with
        // Spotify connected. The scheduler tick, though, runs for every
        // loaded event - even one with no Spotify connection yet still has
        // a requests-open/closed setting the timetable can drive.
        const now = Date.now();
        const dueForSync = connected.filter(event => {
            const waitingOnBoundary = !!event.schedulerRuntime?.pendingSwitchUri;
            const interval = waitingOnBoundary ? SCHEDULER_FAST_POLL_MS : NOW_PLAYING_NORMAL_POLL_MS;
            const lastSynced = nowPlayingLastSyncedAt.get(event.slug) || 0;
            return now - lastSynced >= interval;
        });
        dueForSync.forEach(event => nowPlayingLastSyncedAt.set(event.slug, now));
        await Promise.allSettled(dueForSync.map(event => syncNowPlayingForEvent(event)));
        // The scheduler tick itself is cheap (array scan + comparisons, no
        // Spotify call unless a switch/volume change is actually due), so
        // it just runs every process tick for every loaded event rather
        // than needing its own throttle.
        await Promise.allSettled(loaded.map(event => tickMusicScheduler(event).catch(err => {
            console.error(`[SCHEDULER] (${event.slug}) Tick failed:`, err.message);
        })));
    } finally {
        isSyncingAllEvents = false;
    }
}
setInterval(syncAllLoadedEvents, SCHEDULER_FAST_POLL_MS);

// Public (no admin auth) - the guest, kiosk, and admin pages all poll this for
// the live "Now Playing" bar. Only ever exposes playback state, nothing about
// the connected account itself.
app.get('/e/:slug/api/now-playing', publicReadLimiter, (req, res) => {
    res.json(req.event.cachedNowPlaying);
});

// Public (no admin auth) - whatever eventually renders the Ambient Visuals
// lane (kiosk, a standalone signage screen, etc.) polls this for "what
// should be on screen right now". Resolves each item in the active block's
// sequence (photo/video mediaIds become real urls) here so the display
// side never has to also fetch/hold the whole library just to look up a
// few ids. Returns active:false whenever the scheduler is off or no ambient
// block covers this moment - callers should hold whatever was last showing
// rather than blank the screen on a brief gap.
app.get('/e/:slug/api/ambient-visuals', publicReadLimiter, (req, res) => {
    const event = req.event;
    const vcfg = ensureVisualsConfigs(event);
    // Screen overrides from Admin -> Settings -> Content ride along on every
    // response so the display can apply them even when nothing is scheduled.
    const overrides = { muted: !!(vcfg.muteVisuals || vcfg.muteAll), showQueue: !!vcfg.showQueue };
    if (!event.musicScheduler?.enabled) {
        return res.json({ active: false, ...overrides });
    }
    const rule = getActiveAmbientRule(event);
    if (!rule) {
        return res.json({ active: false, ...overrides });
    }
    const byId = new Map((event.ambientMedia || []).map(m => [m.id, m]));
    // Resolves each stored item to what the display actually consumes (a
    // real url instead of a mediaId it can't look up itself). Note:
    // 'customVisual' items (layered compositions from the Custom Visual
    // editor) aren't rendered by the current Visuals Display build yet, so
    // they're skipped here rather than sent as something it can't draw.
    const items = (rule.items || []).map(it => {
        if (it.type === 'photo' || it.type === 'video') {
            const media = byId.get(it.mediaId);
            if (!media) return null;
            return { type: it.type, url: media.url, durationSec: it.durationSec };
        }
        if (it.type === 'queue' || it.type === 'clock' || it.type === 'ad') {
            return { ...it };
        }
        return null;
    }).filter(Boolean);
    if (items.length === 0) {
        return res.json({ active: false, ...overrides });
    }
    res.json({
        active: true,
        ruleId: rule.id,
        items,
        ...overrides
    });
});

// Public (no admin auth), polled every few seconds by the display - see
// pollMusicVideo in visual-display.html. Two independent things have to
// line up for a video to actually play: (1) a Music Videos block has to
// be active right now (the scheduler side - see the Music Videos lane),
// AND (2) this particular song has to land on a "video" slot in that
// block's videosInARow/visualsAfter repeating pattern rather than a
// "visuals" slot. Even then, a video is only ever returned once it has an
// entry in verifiedMusicVideoCache - the audio-cross-correlation-backed
// result from findAudioVerifiedMusicVideo, normally already resolved by now
// thanks to the eager, queue-time trigger (see triggerMusicVideoVerification)
// - anything unresolved or unmatched falls straight back to Ambient
// Visuals, same as if no Music Videos block were active at all.
app.get('/e/:slug/api/music-video', publicReadLimiter, async (req, res) => {
    const event = req.event;
    const vcfg = ensureVisualsConfigs(event);
    const emptyResponse = { enabled: false, matched: false, videoId: null, introOffsetMs: 0, trackId: (event.cachedNowPlaying && event.cachedNowPlaying.trackId) || null, progressMs: 0, durationMs: 0, isPlaying: false, updatedAt: Date.now(), subtitlesEnabled: !!vcfg.musicVideoSubtitlesEnabled, videoOffsetMs: vcfg.musicVideoOffsetMs };

    // Mute / Show Queue from Admin -> Settings -> Content win over videos:
    // returning nothing makes the display drop the video, after which its
    // ambient poll applies the black-out or the queue board.
    if (vcfg.muteVisuals || vcfg.muteAll || vcfg.showQueue) return res.json({ ...emptyResponse, override: true, reason: 'admin_override_mute_or_show_queue_is_on' });

    // Admin -> Settings -> Content -> Music Videos forces a video attempt for
    // every song, ignoring the scheduler. With it off, only an active Music
    // Videos block in the scheduler enables videos (and sets the pattern).
    const forceVideos = !!vcfg.musicVideosEnabled;
    const np = event.cachedNowPlaying;
    const runtime = ensureMusicVideoRuntime(event);

    // RULE: if a video is already playing, it must finish. Once a video has
    // been offered for the song that is playing right now, nothing about the
    // schedule (the Music Videos block ending, the scheduler being switched
    // off, the pattern landing on a "visuals" slot) is allowed to take it
    // away mid-song. Those checks only decide about the NEXT song. Only the
    // explicit admin Mute / Show Queue overrides above still win instantly.
    const committed = !!(np && np.trackId && runtime.cache.trackId === np.trackId &&
                         runtime.cache.matched && runtime.cache.videoId);

    let rule = null;
    if (!forceVideos && !committed) {
        if (!event.musicScheduler?.enabled) return res.json({ ...emptyResponse, reason: 'videos_toggle_off_and_scheduler_disabled' });
        rule = getActiveMusicVideoRule(event);
        if (!rule) {
            // No Music Videos block covers this moment - reset so the NEXT
            // block this event runs into always starts on a video slot, not
            // however far a previous block's pattern happened to have gotten.
            runtime.lastActiveRuleId = undefined;
            return res.json({ ...emptyResponse, reason: 'no_active_music_video_block_in_scheduler' });
        }
    }

    if (!np || !np.trackId || !np.title || !np.artist) {
        return res.json({ ...emptyResponse, enabled: true, reason: 'no_now_playing_info_from_spotify' });
    }


    // Spotify isn't currently reporting this song as playing - either it's
    // genuinely paused, or the connection itself dropped for a moment (see
    // syncNowPlayingForEvent, which now preserves the last known track
    // through that kind of gap instead of wiping it). If this exact track
    // already has a matched video from a moment ago, keep reporting it -
    // just with isPlaying:false - so the display holds the video paused in
    // place (its existing pause handling) rather than tearing the whole
    // overlay down and having to restart it from ambient the instant
    // playback resumes. A track with no prior match, or no track at all,
    // still falls back to the plain empty response - there's nothing to
    // hold onto.
    if (!np.isPlaying) {
        if (runtime.cache.trackId === np.trackId && runtime.cache.matched) {
            return res.json({
                enabled: true,
                matched: true,
                videoId: runtime.cache.videoId,
                introOffsetMs: runtime.cache.introOffsetMs || 0,
                trackId: np.trackId,
                progressMs: np.progressMs,
                durationMs: np.durationMs,
                isPlaying: false,
                updatedAt: np.progressCapturedAt || np.updatedAt,
                serverNow: Date.now(),
                subtitlesEnabled: !!vcfg.musicVideoSubtitlesEnabled,
                videoOffsetMs: vcfg.musicVideoOffsetMs
            });
        }
        return res.json({ ...emptyResponse, enabled: true, reason: 'spotify_reports_not_playing' });
    }

    // A different block became active since the last poll (or this is the
    // very first poll of a fresh one) - always start it on its first
    // video slot.
    if (forceVideos) {
        runtime.lastActiveRuleId = undefined;
    } else if (rule && runtime.lastActiveRuleId !== rule.id) {
        runtime.lastActiveRuleId = rule.id;
        runtime.cycleCount = 0;
    }

    const videosInARow = rule && Number.isInteger(rule.videosInARow) && rule.videosInARow >= 1 ? rule.videosInARow : 2;
    const visualsAfter = rule && Number.isInteger(rule.visualsAfter) && rule.visualsAfter >= 0 ? rule.visualsAfter : 1;
    const cycleLength = videosInARow + visualsAfter;

    const isNewTrack = runtime.cache.trackId !== np.trackId;
    if (isNewTrack) {
        // Only an actual track change advances the pattern position -
        // repeated polls mid-song must never move it forward.
        if (runtime.cache.trackId !== null) runtime.cycleCount++;
        runtime.cache = { trackId: np.trackId, searchedTrackId: null, matched: false, videoId: null, introOffsetMs: 0 };
    }

    if (!forceVideos && !committed && (runtime.cycleCount % cycleLength) >= videosInARow) {
        // This song lands on a "visuals" slot in the pattern - hand back
        // to Ambient Visuals without spending a YouTube search on it.
        return res.json({ ...emptyResponse, enabled: true, matched: false, reason: 'pattern_says_this_song_is_a_visuals_slot' });
    }

    // Check the verified cache fresh once per track (cached across the rest
    // of that song's polls) rather than re-checking every 3 seconds.
    if (runtime.cache.searchedTrackId !== np.trackId) {
        const excludeVideoIds = new Set(
            [...runtime.blacklist].filter(k => k.startsWith(np.trackId + '|')).map(k => k.split('|')[1])
        );

        if (verifiedMusicVideoCache.has(np.trackId) && !(verifiedMusicVideoCache.get(np.trackId) && excludeVideoIds.has(verifiedMusicVideoCache.get(np.trackId).videoId))) {
            // Some other event (or an earlier play of this song at THIS
            // event, or - per item 1 - this same play, started well before
            // the song actually began) already did the real work of
            // checking this song's audio - reuse that answer outright. No
            // placeholder, no guessing, no wait: either a confirmed match or
            // a confirmed "nothing syncs", both instant.
            // Skipped when the cached video is one THIS event just
            // blacklisted via /sync-failed - see that handler, which also
            // clears this global cache entry so it gets re-verified for
            // everyone, but the local exclude-list check here closes the
            // gap for the moment in between.
            const cached = verifiedMusicVideoCache.get(np.trackId);
            runtime.cache = {
                trackId: np.trackId, searchedTrackId: np.trackId,
                matched: !!cached, videoId: cached ? cached.videoId : null,
                introOffsetMs: cached ? cached.introOffsetMs : 0
            };
        } else {
            // No verified answer yet - either this track skipped straight to
            // playing without ever sitting in a queue we saw (an admin
            // force-play via Spotify directly, say), or item 1's eager check
            // simply hasn't finished yet. Either way, an unverified guess is
            // no longer eligible to display (see item 6's reveal-gating) -
            // fall back to ambient visuals for THIS play and (re)start
            // verification now. triggerMusicVideoVerification is a no-op if
            // an eager run for this track is already in flight; if it
            // resolves before the song ends, the next poll picks it up from
            // the cache branch above.
            // searchedTrackId stays null on purpose: this poll has no verified
            // answer yet, so every following poll must re-check the cache.
            // (It used to be set to np.trackId here, which made this branch
            // run once per song - a verification finishing a few seconds after
            // the song started was then never picked up, even though the
            // comment above says the next poll would.)
            runtime.cache = { trackId: np.trackId, searchedTrackId: null, matched: false, videoId: null, introOffsetMs: 0 };
            triggerMusicVideoVerification(np.trackId, np.artist, np.title, np.durationMs, excludeVideoIds);
        }

        // Item 8: the denylist is a hard block regardless of family mode -
        // covers a track that was verified and cached BEFORE it was added to
        // the denylist (triggerMusicVideoVerification only stops NEW checks,
        // it can't retroactively un-cache one that already resolved).
        // Family mode's allowlist only matters when the event has it on: with
        // it on, a track's video plays ONLY if a human has already approved
        // it here, regardless of what the automated pipeline concluded -
        // deliberately stricter than the normal "show unless rejected"
        // default, since automated moderation alone isn't a strong enough
        // guarantee for that audience (see the comment on musicVideoAllowlist
        // above).
        if (runtime.cache.matched) {
            if (musicVideoDenylist.has(np.trackId)) {
                runtime.cache.matched = false;
                runtime.cache.videoId = null;
                runtime.cache.blockedBy = 'denylist';
            } else if (vcfg.familyModeEnabled && !musicVideoAllowlist.has(np.trackId)) {
                runtime.cache.matched = false;
                runtime.cache.videoId = null;
                runtime.cache.blockedBy = 'family_mode_not_allowlisted';
            }
        }
    }

    // Plain-English explanation of why there's no video, so "nothing shows"
    // can be diagnosed by just opening this route in a browser mid-song.
    let mvReason = 'matched';
    if (!runtime.cache.matched) {
        const retry = verificationRetryState.get(np.trackId);
        if (runtime.cache.blockedBy) mvReason = runtime.cache.blockedBy;
        else if (verifiedMusicVideoCache.has(np.trackId) && verifiedMusicVideoCache.get(np.trackId) === null) mvReason = 'verified_no_video_passed_all_checks';
        else if (verificationInFlight.has(np.trackId)) mvReason = 'verification_running_now';
        else if (retry) mvReason = `verification_inconclusive_retrying (attempt ${retry.attempts}, next try in ${Math.max(0, Math.round((retry.notBefore - Date.now()) / 1000))}s) - check server logs for [MV-MATCH]/[MUSIC VIDEO] errors`;
        else mvReason = 'verification_waiting_to_start';
    }
    res.json({
        reason: mvReason,
        detail: runtime.cache.matched ? undefined : verificationDiagCache.get(np.trackId),
        youtube: { apiKeySet: !!YOUTUBE_API_KEY, quotaUsedToday: youtubeQuotaUsedToday, quotaBudget: YOUTUBE_DAILY_QUOTA_BUDGET },
        enabled: true,
        matched: runtime.cache.matched,
        videoId: runtime.cache.videoId,
        introOffsetMs: runtime.cache.introOffsetMs || 0,
        trackId: np.trackId,
        progressMs: np.progressMs,
        durationMs: np.durationMs,
        isPlaying: np.isPlaying,
        // updatedAt = when Spotify's progress was actually read; serverNow = the
        // server's clock at this instant. The display uses the DIFFERENCE of the
        // two (both server clock) so its own clock being off can't skew sync.
        updatedAt: np.progressCapturedAt || np.updatedAt,
        serverNow: Date.now(),
        subtitlesEnabled: !!vcfg.musicVideoSubtitlesEnabled,
        videoOffsetMs: vcfg.musicVideoOffsetMs
    });
});

// The display reports here when a video it was offered turned out not to
// actually work in practice - couldn't hold sync with the song, or errored
// at real playback time (region lock, an owner opt-out that only surfaces
// at play time, etc). Blacklisted per trackId+videoId pair so the next
// search for this SAME song excludes it and tries the next-best candidate,
// rather than silently offering the identical broken video again next time
// this track comes up.
app.post('/e/:slug/api/music-video/sync-failed', publicReadLimiter, (req, res) => {
    const event = req.event;
    const { trackId, videoId, keepCurrent } = req.body || {};
    if (typeof trackId !== 'string' || !trackId || typeof videoId !== 'string' || !videoId) {
        return res.status(400).json({ error: 'trackId and videoId are required.' });
    }
    const runtime = ensureMusicVideoRuntime(event);
    runtime.blacklist.add(`${trackId}|${videoId}`);
    // If this video was the server-wide "verified" answer for this song,
    // it's now known to be wrong in practice (whatever the audio check
    // thought) - clear it so the NEXT poll (here and at every other event
    // playing this song) re-verifies from scratch and tries a different
    // candidate, rather than everyone continuing to get handed the same
    // video straight from cache forever.
    const cachedMatch = verifiedMusicVideoCache.get(trackId);
    if (cachedMatch && cachedMatch.videoId === videoId) {
        verifiedMusicVideoCache.delete(trackId);
        events.scheduleMusicVideoCacheSave(musicVideoCacheSnapshot); // item 2: debounced Redis persist
    }
    // Force the next poll to search again instead of re-offering the
    // video that was just reported as not working.
    // keepCurrent: the video is already on screen and playing - it finishes.
    // Blacklisting it is enough; the next play of this track skips it.
    if (!keepCurrent && runtime.cache.trackId === trackId) {
        runtime.cache = { trackId, searchedTrackId: null, matched: false, videoId: null };
    }
    res.json({ success: true });
});

// ============================================================
// Fallback routes
// ============================================================

// Bare, un-slugged paths from old bookmarks/muscle memory - point people at
// the new event-creation flow instead of silently 404ing.
app.get(['/admin', '/kiosk'], (req, res) => {
    res.redirect('/new');
});

// Event creation now lives at its own explicit path - the bare root is the
// guest page (see below), not this. voterIdentityMiddleware isn't relevant
// here since there's no :slug yet to scope a cookie to.
app.get('/new', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'new-event.html'));
});

// The single guest URL. With no event chosen yet, index.html renders itself
// in a "no venue selected" state (empty queue, disabled search) and the
// guest picks a venue from the sidebar's Change Venue screen without ever
// navigating away from this path. Every other unmatched path also falls
// back here rather than to new-event.html, per the "always go to the guest
// page" requirement - only /new and /admin /kiosk (redirected above) lead to
// anything else.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Flush any debounced-but-not-yet-written event saves on shutdown.
async function shutdown() {
    await events.flushAllSaves();
    await events.flushMusicVideoCacheSave(musicVideoCacheSnapshot); // item 2
    await events.flushFamilyListsSave(familyListsSnapshot); // item 8
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.warn('==========================================================');
        console.warn('[SERVER] SPOTIFY_CLIENT_ID and/or SPOTIFY_CLIENT_SECRET are');
        console.warn('not set. Search and song requests will not work until both');
        console.warn('are set in your environment variables and the server is');
        console.warn('redeployed/restarted.');
        console.warn('==========================================================');
    }
    // Item 2: seed the in-memory verifiedMusicVideoCache from Redis before
    // anything else runs, so a restart/redeploy doesn't throw away prior
    // audio-verification work. Loaded here (not at module load time, above)
    // because it needs the network, and nothing tries to read the cache
    // before the server is actually accepting requests.
    try {
        const persisted = await events.loadMusicVideoCache();
        const needsNullPurge = persisted[MV_CACHE_SCHEMA_KEY] !== MV_CACHE_SCHEMA_VERSION;
        let purgedNulls = 0;
        for (const [trackId, result] of Object.entries(persisted)) {
            if (trackId === MV_CACHE_SCHEMA_KEY) continue;
            if (needsNullPurge && result === null) { purgedNulls++; continue; }
            verifiedMusicVideoCache.set(trackId, result);
        }
        console.log(`[SERVER] Loaded ${verifiedMusicVideoCache.size} cached music-video verification(s) from Redis.` +
            (needsNullPurge ? ` Dropped ${purgedNulls} legacy "no match" entr${purgedNulls === 1 ? 'y' : 'ies'} (may have been recorded during quota/ytdl failures) - they will be re-verified.` : ''));
        if (needsNullPurge) events.scheduleMusicVideoCacheSave(musicVideoCacheSnapshot);
    } catch (err) {
        console.error('[SERVER] Failed to load persisted music-video cache:', err.message);
    }
    // Item 8: seed the denylist/allowlist the same way, before anything else
    // runs - a track shouldn't be able to slip past a restart-cleared
    // denylist for even one request.
    try {
        const persisted = await events.loadFamilyLists();
        for (const trackId of persisted.denylist) musicVideoDenylist.add(trackId);
        for (const [trackId, entry] of Object.entries(persisted.allowlist)) musicVideoAllowlist.set(trackId, entry);
        console.log(`[SERVER] Loaded family-mode lists from Redis: ${musicVideoDenylist.size} denylisted, ${musicVideoAllowlist.size} allowlisted.`);
    } catch (err) {
        console.error('[SERVER] Failed to load persisted family-mode lists:', err.message);
    }
    await getSpotifyToken();
});
