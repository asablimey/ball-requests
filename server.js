const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const events = require('./eventStore');
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
    if (!token) return { success: false, error: 'DJ Spotify account is not connected yet.' };

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

// Shared by every transport-control route below (play/pause/next/previous/
// volume/shuffle/repeat) - same token lookup and same 404 (no active
// device)/403 (not Premium) handling switchDjPlaylist already uses, just
// generalized to any method/path/query on the /me/player resource instead
// of only the "start context playback" call.
async function spotifyPlayerCommand(event, method, playerPath, query = '') {
    const token = await getDjAccessToken(event);
    if (!token) return { success: false, error: 'DJ Spotify account is not connected yet.' };
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/player${playerPath}${query}`, {
            method,
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204 || res.status === 200) {
            // The admin UI re-polls /api/now-playing ~300ms after a command
            // to reflect the change quickly, but that endpoint only ever
            // serves the cache - which otherwise wouldn't update until the
            // next background sync tick (up to 4s away, worse with several
            // events loaded). Refreshing it here means that quick re-poll
            // actually shows the new state instead of the stale one.
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

// How close a guest's device has to be to the event's pinned venue location
// to be allowed to actually add a song - browsing/viewing the queue is never
// gated, only the request itself. Loose enough to allow for GPS drift and a
// venue that spans a building/parking lot, tight enough that someone across
// town can't request. Events created without a venue pin (venueLatitude/
// venueLongitude are both null - see new-event.html's optional map picker)
// have nothing to check distance against, so they're never gated by this.
const REQUEST_RADIUS_METERS = 300;

function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    event.queueHistoryLog.push({
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
        requesters: t.requesters || []
    })).sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs));
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
    return track;
}

// ============================================================
// Global (non-event) routes: creating events, and the one fixed
// Spotify OAuth callback URL every event's login flow shares.
// ============================================================

// The person picks a slug + admin password here; this is the only route that
// doesn't require an existing event to already exist.
app.post('/api/events', createEventLimiter, async (req, res) => {
    const { slug, eventName, adminPassword, latitude, longitude, venueName } = req.body || {};
    if (typeof slug !== 'string') return res.status(400).json({ error: 'Missing event URL.' });
    const venue = (typeof latitude === 'number' && typeof longitude === 'number')
        ? { latitude, longitude, venueName }
        : null;
    const result = await events.createEvent(slug.trim().toLowerCase(), eventName, adminPassword, venue);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, slug: result.event.slug });
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
                <h2>Spotify connected ✅</h2>
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
app.get('/e/:slug/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/e/:slug/kiosk', voterIdentityMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Real, server-side admin auth - gates every /e/:slug/api/admin/* route below.
async function requireAdminAuth(req, res, next) {
    const provided = req.headers['x-admin-password'];
    const ok = await events.verifyPassword(provided, req.event.adminPasswordHash);
    if (!ok) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
}
app.use('/e/:slug/api/admin', adminAuthLimiter, requireAdminAuth);

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
app.get('/e/:slug/api/search', async (req, res) => {
    const event = req.event;
    if (!event.systemConfigs.requestsAllowed || isQueueFull(event)) {
        return res.json({ tracks: [] });
    }

    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    if (!spotifyAccessToken) await getSpotifyToken();

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
            fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${PAGE_SIZE}&offset=${offset}`, {
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
                _primaryArtistId: track.artists?.[0]?.id || null
            };
        });

        if (event.systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }

        if (event.systemConfigs.radioEditsOnly) {
            tracks = tracks.filter(track => !isExtendedOrClubMix(track.name));
        }

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
            const allowedKeywords = event.systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
            tracks = tracks.filter(track => {
                const artistGenres = genresByArtist.get(track._primaryArtistId) || [];
                return artistGenres.some(g => allowedKeywords.some(keyword => g.includes(keyword)));
            });
        }

        tracks = tracks.map(({ _releaseYear, _primaryArtistId, ...publicFields }) => publicFields);

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

        // Kiosk requests skip this - a kiosk is a fixed device physically at
        // the venue by definition. Only the guest's own phone (isKiosk ===
        // false) needs to prove it's actually near the pinned venue location,
        // and only if the organizer actually pinned one at creation.
        if (!isKiosk && typeof event.venueLatitude === 'number' && typeof event.venueLongitude === 'number') {
            const lat = parseFloat(req.body.lat);
            const lng = parseFloat(req.body.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return res.status(403).json({ error: "Location needed to request a song here.", locationRequired: true });
            }
            const distanceMeters = haversineMeters(lat, lng, event.venueLatitude, event.venueLongitude);
            if (distanceMeters > REQUEST_RADIUS_METERS) {
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
                duration: formatDuration(t.duration_ms || 0)
            };
            releaseYear = parseInt((t.album?.release_date || '').slice(0, 4), 10) || null;
            primaryArtistId = t.artists?.[0]?.id || null;
        } catch (err) {
            return res.status(500).json({ error: "Could not verify track with Spotify." });
        }

        if (event.systemConfigs.explicitBlockActive && verifiedTrack.explicit) {
            return res.status(403).json({ error: "Explicit content is currently restricted by the DJ." });
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
            const allowedKeywords = event.systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
            const matches = artistGenres.some(g => allowedKeywords.some(keyword => g.includes(keyword)));
            if (!matches) {
                return res.status(403).json({ error: "That song's genre isn't part of tonight's theme." });
            }
        }

        const creditState = getOrCreateVoterCreditState(event, voterId, modeConfig.maxCredits);
        refillVoterCredits(creditState, modeConfig.maxCredits, modeConfig.countdownLength);
        if (creditState.available <= 0) {
            return res.status(429).json({ error: "You are out of credits! Wait for the regeneration cycle." });
        }
        creditState.available -= 1;

        const requesterName = (typeof username === 'string' && username.trim() !== '')
            ? username.trim().slice(0, 30)
            : 'Anonymous';

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
                requesters: [requesterName]
            });
            if (event.systemConfigs.spotifyAutoQueueEnabled) {
                queueTrackOnSpotify(event, trackId);
            }
        }

        event.requestLog.push({
            trackId,
            title: verifiedTrack.name,
            artist: verifiedTrack.artist,
            artwork: verifiedTrack.artwork,
            explicit: verifiedTrack.explicit,
            voterId,
            status: 'queued',
            requestedAt: Date.now()
        });
        if (event.requestLog.length > 2000) event.requestLog = event.requestLog.slice(-2000);

        events.scheduleSave(event.slug);
        res.json({ success: true });
    };
}

app.post('/e/:slug/api/request', voterIdentityMiddleware, buildRequestHandler(false));
app.post('/e/:slug/api/kiosk-request', voterIdentityMiddleware, buildRequestHandler(true));

app.post('/e/:slug/api/vote', voterIdentityMiddleware, (req, res) => {
    const event = req.event;
    const { id, type } = req.body;
    const voterId = req.serverVoterId;

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
    const clearDown = () => { track.downvoters = track.downvoters.filter(v => v !== voterId); };

    if (type === 'up') {
        if (track.upvoters.includes(voterId)) {
            clearUp();
        } else {
            clearDown();
            track.upvoters.push(voterId);
        }
    } else if (type === 'down') {
        if (track.downvoters.includes(voterId)) {
            clearDown();
        } else {
            clearUp();
            track.downvoters.push(voterId);
        }
    }

    events.scheduleSave(event.slug);
    res.json({ success: true });
});

app.get('/e/:slug/data', (req, res) => {
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
        spotifyConnectEnabled: event.systemConfigs.guestSpotifyConnectEnabled,
        queue: buildSortedQueue(event),
        history: event.playedHistory
    });
});

app.get('/e/:slug/kiosk-data', (req, res) => {
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
        history: event.playedHistory
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
        djSpotifyQueueConnected: !!event.spotify.djRefreshToken,
        lastSwitchedPlaylist: event.systemConfigs.lastSwitchedPlaylist || '',
        kiosk: event.kioskConfigs,
        queue: buildSortedQueueForAdmin(event),
        history: event.playedHistory
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

    res.json({ allRequests, topRequesters, totals, topLiked, topDisliked });
});

app.get('/e/:slug/api/my-requests', voterIdentityMiddleware, (req, res) => {
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

app.post('/e/:slug/api/admin/switch-playlist', async (req, res) => {
    const event = req.event;
    const { playlistUrl } = req.body;
    if (!playlistUrl) return res.status(400).json({ error: 'Missing playlistUrl.' });
    const result = await switchDjPlaylist(event, playlistUrl);
    if (result.success) event.systemConfigs.lastSwitchedPlaylist = playlistUrl.trim();
    events.scheduleSave(event.slug);
    res.status(result.success ? 200 : 400).json(result);
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

app.post('/e/:slug/api/admin/kiosk/config', (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    const kc = req.event.kioskConfigs;
    if (maxCredits !== undefined) kc.maxCredits = parseInt(maxCredits) || kc.maxCredits;
    if (countdownLength !== undefined) kc.countdownLength = parseInt(countdownLength) || kc.countdownLength;
    events.scheduleSave(req.event.slug);
    res.json({ success: true });
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
        if (action === 'top') {
            const track = event.activeQueue[trackIndex];
            const sorted = buildSortedQueue(event);
            const highestNet = sorted.length > 0 ? (sorted[0].ups - sorted[0].downs) : 0;
            track.downvoters = [];
            track.upvoters = Array(highestNet + 1).fill('forced-admin-boost');
        } else if (action === 'played') {
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
        event.cachedNowPlaying = { connected: false, isPlaying: false, trackId: null, title: null, artist: null, artwork: null, progressMs: 0, durationMs: 0, updatedAt: Date.now(), upcoming: [], deviceName: null, volumePercent: null, shuffleState: false, repeatState: 'off' };
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
        const [res, queueRes] = await Promise.all([
            fetch('https://api.spotify.com/v1/me/player', {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
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
                artwork: t.album?.images?.[0]?.url || null
            }));
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
let isSyncingAllEvents = false;
async function syncAllLoadedEvents() {
    if (isSyncingAllEvents) return;
    isSyncingAllEvents = true;
    try {
        const loaded = events.getLoadedEvents().filter(e => e.spotify.djRefreshToken);
        await Promise.allSettled(loaded.map(event => syncNowPlayingForEvent(event)));
    } finally {
        isSyncingAllEvents = false;
    }
}
setInterval(syncAllLoadedEvents, 4000);

// Public (no admin auth) - the guest, kiosk, and admin pages all poll this for
// the live "Now Playing" bar. Only ever exposes playback state, nothing about
// the connected account itself.
app.get('/e/:slug/api/now-playing', (req, res) => {
    res.json(req.event.cachedNowPlaying);
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
    await getSpotifyToken();
});
