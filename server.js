const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

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

// Assigns every guest a server-issued, HttpOnly identity cookie on first visit.
// This is what credits/votes/request-history are now keyed on, instead of the
// voterId the client generates and sends itself - a value the client fully
// controls can be reset just by clearing localStorage, which defeats the point
// of a "credit limit". An HttpOnly cookie can't be read or forged by page JS,
// and clearing it requires clearing site cookies specifically, not just
// localStorage - a meaningfully higher bar, though still not unbeatable by
// someone using a private window each time.
app.use((req, res, next) => {
    const cookies = parseCookies(req);
    let vid = cookies[VOTER_COOKIE];
    if (!vid) {
        vid = crypto.randomUUID();
        res.cookie(VOTER_COOKIE, vid, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
        });
    }
    req.serverVoterId = vid;
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// --- DJ Spotify Queue Relay ---
// Separate from the client-credentials token above (which only reads the public
// catalog for search) and separate from guests' own read-only PKCE login. This is
// a one-time Authorization Code login as the DJ's own Spotify account, which is
// the only kind of token Spotify accepts for POST /me/player/queue - adding to
// *your* actual playback queue requires the user-modify-playback-state scope,
// which can only be granted by that account logging in, not by an app-only token.
//
// Required env vars:
//   SPOTIFY_REDIRECT_URI - e.g. https://your-app.onrender.com/admin/spotify-callback
//                           Must be registered exactly (including https and path)
//                           in your Spotify Developer Dashboard app settings.
//   SPOTIFY_REFRESH_TOKEN - filled in after the one-time login below; without it,
//                           auto-queueing is silently skipped (guest requests still
//                           work normally, they just don't relay to Spotify).
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const DJ_QUEUE_SCOPES = 'user-modify-playback-state user-read-playback-state';

let djRefreshToken = process.env.SPOTIFY_REFRESH_TOKEN || null;
let djAccessToken = null;
let djAccessTokenExpiresAt = 0;
let pendingLoginState = null; // basic CSRF check for the single-admin login flow

// Exchanges the stored DJ refresh token for a fresh access token, caching it
// until shortly before it expires. Returns null (rather than throwing) if DJ
// queueing isn't set up yet, so callers can treat "not configured" and
// "temporarily failed" the same way: just skip queueing, never block a guest's request.
async function getDjAccessToken() {
    if (!djRefreshToken) return null;
    if (djAccessToken && Date.now() < djAccessTokenExpiresAt - 30000) return djAccessToken;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(djRefreshToken)
        });
        const data = await response.json();
        if (!data.access_token) {
            console.error('[SPOTIFY QUEUE] Refresh failed:', data.error_description || data.error);
            return null;
        }
        djAccessToken = data.access_token;
        djAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        // Spotify occasionally rotates the refresh token on use. If it does, the
        // old one stops working - swap in-memory so this session keeps running,
        // but flag it loudly since the Render env var is now stale.
        if (data.refresh_token && data.refresh_token !== djRefreshToken) {
            djRefreshToken = data.refresh_token;
            console.warn('[SPOTIFY QUEUE] Spotify issued a new refresh token. Update SPOTIFY_REFRESH_TOKEN in Render to:', djRefreshToken);
        }
        return djAccessToken;
    } catch (err) {
        console.error('[SPOTIFY QUEUE] Token refresh error:', err.message);
        return null;
    }
}

// Adds a track to the DJ's live Spotify playback queue. Fails silently (logged,
// not thrown) so a guest's request always succeeds locally even if the DJ's
// Spotify isn't open, isn't Premium, or hasn't been connected yet.
async function queueTrackOnSpotify(trackId) {
    const token = await getDjAccessToken();
    if (!token) return;
    try {
        const uri = `spotify:track:${trackId}`;
        const res = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204) {
            console.log('[SPOTIFY QUEUE] Added to live queue:', trackId);
        } else if (res.status === 404) {
            console.warn('[SPOTIFY QUEUE] No active device - open Spotify and play something first.');
        } else if (res.status === 403) {
            console.warn('[SPOTIFY QUEUE] Forbidden - this usually means the account is not Spotify Premium.');
        } else {
            const body = await res.text();
            console.error('[SPOTIFY QUEUE] Unexpected response', res.status, body);
        }
    } catch (err) {
        console.error('[SPOTIFY QUEUE] Request failed:', err.message);
    }
}

// One-time login: DJ opens this (from the admin dashboard) and authorizes with
// their own Spotify account. Gated by the same admin password as everything else
// in /api/admin, but this route can't live under that prefix since it needs to be
// a plain browser navigation (redirects can't carry a custom header).
// "Priority mode" alternative to queueTrackOnSpotify above. Spotify's API has no
// endpoint to insert into, reorder, or remove from an existing live queue - the
// only way to change what plays next is to replace the whole thing via
// PUT /me/player/play with an explicit uris list. So to put a new request at the
// FRONT of what's coming up, we: read what's currently playing (to resume it at
// the same position, not restart it) and what's already queued (so we don't lose
// it), then replay with [current, newTrack, ...restOfOldQueue].
//
// Trade-off worth knowing: this REPLACES Spotify's live queue outright, which
// means anything the DJ personally queued from their own Spotify app (outside
// this system) gets wiped in the process. Also requires an active device with
// something already playing - if nothing's playing yet, it just starts the new
// track immediately instead of "inserting" it.
async function insertTrackAtTopOfSpotifyQueue(trackId) {
    const token = await getDjAccessToken();
    if (!token) return;

    try {
        const stateRes = await fetch('https://api.spotify.com/v1/me/player', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const newUri = `spotify:track:${trackId}`;

        if (stateRes.status === 204 || !stateRes.ok) {
            // Nothing currently playing / no readable state - nothing to preserve,
            // so just start this track now rather than silently failing.
            console.warn('[SPOTIFY QUEUE] No current playback state - starting the new request directly instead of inserting.');
            await fetch('https://api.spotify.com/v1/me/player/play', {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: [newUri] })
            });
            return;
        }

        const state = await stateRes.json();
        const deviceId = state.device?.id;
        const currentUri = state.item?.uri;
        const positionMs = state.progress_ms || 0;

        if (!deviceId) {
            console.warn('[SPOTIFY QUEUE] No active device found - open Spotify and play something first.');
            return;
        }

        // Pull the rest of what's already queued so it isn't lost, just pushed back one.
        let restOfQueueUris = [];
        try {
            const queueRes = await fetch('https://api.spotify.com/v1/me/player/queue', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (queueRes.ok) {
                const queueData = await queueRes.json();
                restOfQueueUris = (queueData.queue || []).map(t => t.uri).filter(uri => uri && uri !== newUri);
            }
        } catch (e) { /* non-fatal - proceed without the rest of the old queue rather than fail the insert */ }

        const orderedUris = [currentUri, newUri, ...restOfQueueUris].filter(Boolean);

        const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: orderedUris, position_ms: positionMs })
        });

        if (playRes.status === 204 || playRes.ok) {
            console.log('[SPOTIFY QUEUE] Inserted at top of live queue:', trackId);
        } else {
            const body = await playRes.text();
            console.error('[SPOTIFY QUEUE] Insert-at-top failed', playRes.status, body);
        }
    } catch (err) {
        console.error('[SPOTIFY QUEUE] Insert-at-top request failed:', err.message);
    }
}

// Reads Spotify's actual live queue (real play order, not our vote-sorted local
// list) for display. Returns null if not configured/connected so callers can
// distinguish "feature off" from "temporarily empty."
async function fetchLiveSpotifyQueue() {
    const token = await getDjAccessToken();
    if (!token) return null;
    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const mapTrack = (t) => ({
            id: t.id,
            title: t.name,
            artist: (t.artists || []).map(a => a.name).join(', ') || 'Unknown Artist',
            artwork: t.album?.images?.[0]?.url || 'https://picsum.photos/48',
            explicit: t.explicit || false,
            duration: formatDuration(t.duration_ms || 0)
        });
        return {
            currentlyPlaying: data.currently_playing ? mapTrack(data.currently_playing) : null,
            queue: (data.queue || []).slice(0, 10).map(mapTrack)
        };
    } catch (err) {
        console.error('[SPOTIFY QUEUE] Live queue fetch failed:', err.message);
        return null;
    }
}


app.get('/admin/spotify-login', (req, res) => {
    if (req.query.password !== ADMIN_PASSWORD) {
        return res.status(401).send('Unauthorized.');
    }
    if (!SPOTIFY_REDIRECT_URI) {
        return res.status(500).send('SPOTIFY_REDIRECT_URI is not set in your environment variables. Set it to this app\'s URL + /admin/spotify-callback, add that exact URL to your Spotify Developer Dashboard app\'s Redirect URIs, then try again.');
    }
    pendingLoginState = crypto.randomUUID();
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: DJ_QUEUE_SCOPES,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        state: pendingLoginState
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/admin/spotify-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Spotify login failed: ${error}`);
    if (!state || state !== pendingLoginState) return res.status(400).send('State mismatch - please restart the login from the admin dashboard.');
    pendingLoginState = null;

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
        djRefreshToken = data.refresh_token;
        djAccessToken = data.access_token;
        djAccessTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

        res.send(`
            <html><body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height: 1.5;">
                <h2>Spotify connected ✅</h2>
                <p>Auto-queueing is now active for the rest of this server session.</p>
                <p><strong>To make this survive restarts/redeploys</strong>, copy the value below into your Render environment variables as <code>SPOTIFY_REFRESH_TOKEN</code>, then redeploy:</p>
                <textarea readonly style="width:100%; height:80px; font-family: monospace; padding:8px;">${djRefreshToken}</textarea>
                <p style="color:#666; font-size:0.9em;">This value is sensitive - treat it like a password. Don't post it anywhere public.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send('Token exchange failed: ' + err.message);
    }
});


// Real, server-side admin auth. Previously the "password" only gated the UI in
// admin.html client-side - the API routes underneath had no check at all, so
// anyone could call them directly with no password. This closes that gap.
// Set ADMIN_PASSWORD in your Render environment variables; falls back to the
// existing password only if that's not set, so this doesn't break on deploy.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ballDJ2026';

function requireAdminAuth(req, res, next) {
    const provided = req.headers['x-admin-password'];
    if (provided !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
}
app.use('/api/admin', requireAdminAuth);

// The guest page's "Connect Spotify" button needs the Client ID (not the secret) to run
// its own PKCE login. Client IDs aren't sensitive - this is safe to expose publicly.
app.get('/api/public-config', (req, res) => {
    res.json({ spotifyClientId: CLIENT_ID });
});

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true,
    explicitBlockActive: false,
    eventName: '',
    // Queue length cap: once activeQueue.length hits maxQueueLength, requests
    // auto-close. Nothing is "stuck closed" here - it's recomputed from the
    // live queue length on every request, so it reopens on its own as the
    // queue drains, with no separate flag that could get out of sync.
    queueCapEnabled: false,
    maxQueueLength: 50,
    // Genre/decade filters: DJ-configurable allow-lists for theme nights.
    // Empty array = no restriction (everything allowed) for that filter.
    genreFilter: [],   // array of GENRE_CATEGORIES keys, e.g. ['pop', 'rock']
    decadeFilter: [],  // array of decade-start years, e.g. [1980, 1990]
    // Whether regular guests (index.html) see the "Connect Spotify" button at
    // all - independent of the kiosk page's own version of the same toggle.
    guestSpotifyConnectEnabled: false,
    // Master on/off for relaying accepted requests into the DJ's live Spotify
    // queue. Independent of whether a DJ account is actually connected - this
    // just lets the DJ pause the *auto-queueing behavior* on the fly (e.g. during
    // a run of troll requests) without disconnecting Spotify or closing requests
    // entirely. Requests still land in the local site queue either way.
    spotifyAutoQueueEnabled: true,
    // "Priority mode": when on, each new unique request is inserted at the very
    // front of the DJ's live Spotify queue (see insertTrackAtTopOfSpotifyQueue),
    // and all three pages show Spotify's actual next-10 as the live queue. When
    // off, falls back to the original behavior above (appended to the end via
    // spotifyAutoQueueEnabled, vote-sorted local list shown instead).
    liveSpotifyQueueEnabled: false
};

// Separate, independently-configurable settings for kiosk.html - a DJ-attended
// device (e.g. a tablet on a stand) as opposed to guests' own phones. Requests
// on/off, the Spotify Connect button, and credit rules are all controlled
// separately here from the regular guest page. The live queue, explicit
// filter, genre/decade filters, and queue cap are still shared/global - those
// describe the event itself, not which device someone's requesting from.
let kioskConfigs = {
    requestsAllowed: true,
    spotifyConnectEnabled: false,
    maxCredits: 3,
    countdownLength: 60
};

function isQueueFull() {
    return systemConfigs.queueCapEnabled && activeQueue.length >= systemConfigs.maxQueueLength;
}

// Curated genre buckets mapped to the keywords Spotify actually uses in an
// artist's `genres` array (which is a long tail of very specific micro-genres,
// e.g. "chicago rap" - matching by substring against a curated list is far
// more usable for a DJ than trying to expose Spotify's raw genre taxonomy.
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
// a genre filter is actually active).
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

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

// --- Abuse/spam control state ---
// Server-authoritative credits per guest (voterId), mirrors the client's local display
// but can't be bypassed by clearing localStorage credits, only by generating a brand
// new voterId (a much higher bar than editing one number in devtools).
let voterCreditState = new Map(); // voterId -> { available, lastRefill }
let voterLastVoteAt = new Map(); // voterId -> timestamp of last vote action
const MIN_VOTE_INTERVAL_MS = 400;

function getOrCreateVoterCreditState(voterId, maxCredits) {
    let state = voterCreditState.get(voterId);
    if (!state) {
        state = { available: maxCredits, lastRefill: Date.now() };
        voterCreditState.set(voterId, state);
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

// --- Guest "My Requests" log ---
// Independent of activeQueue/playedHistory so a guest can still see a song's fate
// (played or dropped) even after it leaves the live queue entirely.
let requestLog = [];

// Every song that leaves the active queue (played or dropped) gets one entry
// here, with its final vote counts and requester list captured before that
// data would otherwise be lost. This is what the Stats tab reads from.
let queueHistoryLog = [];

function markRequestLogStatus(trackId, newStatus) {
    requestLog.forEach(entry => {
        if (entry.trackId === trackId && entry.status === 'queued') {
            entry.status = newStatus;
            entry.resolvedAt = Date.now();
        }
    });
}

function logDepartedTrack(track, outcome) {
    queueHistoryLog.push({
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
    // Keep this from growing forever across a long-running server.
    if (queueHistoryLog.length > 3000) queueHistoryLog = queueHistoryLog.slice(-3000);
}


function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
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

// SEARCH ROUTE - Now strictly blocked if DJ turns off requests
app.get('/api/search', async (req, res) => {
    if (!systemConfigs.requestsAllowed || isQueueFull()) {
        return res.json({ tracks: [] }); 
    }

    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    if (!spotifyAccessToken) await getSpotifyToken();

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        const data = await response.json();
        const trackItems = data.tracks?.items || [];
        
        let tracks = trackItems.map(track => {
            const releaseYear = parseInt((track.album?.release_date || '').slice(0, 4), 10) || null;
            return {
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
                explicit: track.explicit || false,
                duration: formatDuration(track.duration_ms),
                // Internal-only fields used for filtering below, stripped before response.
                _releaseYear: releaseYear,
                _primaryArtistId: track.artists?.[0]?.id || null
            };
        });
        
        // Filter out explicit tracks if explicit restriction lock is active
        if (systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }

        // Decade filter (DJ-configured, e.g. theme night restricted to the 90s/2000s)
        if (systemConfigs.decadeFilter && systemConfigs.decadeFilter.length > 0) {
            tracks = tracks.filter(track => {
                if (!track._releaseYear) return false;
                const decade = Math.floor(track._releaseYear / 10) * 10;
                return systemConfigs.decadeFilter.includes(decade);
            });
        }

        // Genre filter (DJ-configured allow-list, matched against the primary artist's genres)
        if (systemConfigs.genreFilter && systemConfigs.genreFilter.length > 0 && tracks.length > 0) {
            const artistIds = [...new Set(tracks.map(t => t._primaryArtistId).filter(Boolean))];
            const genresByArtist = await getArtistGenres(artistIds);
            const allowedKeywords = systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
            tracks = tracks.filter(track => {
                const artistGenres = genresByArtist.get(track._primaryArtistId) || [];
                return artistGenres.some(g => allowedKeywords.some(keyword => g.includes(keyword)));
            });
        }

        // Strip internal filtering-only fields before sending to the client.
        tracks = tracks.map(({ _releaseYear, _primaryArtistId, ...publicFields }) => publicFields);

        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search feature unavailable" });
    }
});

app.post('/api/request', async (req, res) => {
    const { track, username, isKiosk } = req.body;
    // Kiosk devices (kiosk.html) and regular guests (index.html) have their
    // own independent requestsAllowed toggle and credit rules, set separately
    // in the admin dashboard - everything else (explicit filter, genre/decade
    // filters, queue cap) is shared, since those describe the event itself.
    const modeConfig = isKiosk === true ? kioskConfigs : systemConfigs;

    if (!modeConfig.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    if (isQueueFull()) return res.status(403).json({ error: `Queue is full (max ${systemConfigs.maxQueueLength} songs) - wait for it to drain.` });
    if (!track || !track.id) return res.status(400).json({ error: "Missing track ID." });
    // Identity now comes from the server-issued cookie, not a client-supplied
    // value - see the cookie middleware near the top of this file.
    const voterId = req.serverVoterId;

    // Spotify track IDs are always 22-character base62 strings - reject anything
    // that isn't even shaped like one before spending an API call on it.
    if (!/^[A-Za-z0-9]{22}$/.test(track.id)) {
        return res.status(400).json({ error: "Invalid track ID." });
    }

    // Re-fetch the track from Spotify's own catalog rather than trusting whatever
    // name/artist/artwork/duration the client sent - otherwise anyone could POST
    // fabricated metadata (offensive titles, arbitrary image URLs) straight into
    // the live queue without it ever being a real, searchable track.
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

    // API block safety gate against manual requests injection of explicit songs
    if (systemConfigs.explicitBlockActive && verifiedTrack.explicit) {
        return res.status(403).json({ error: "Explicit content is currently restricted by the DJ." });
    }

    // Same idea as the explicit gate above, but for genre/decade theme-night
    // restrictions - re-checked here so a guest can't bypass the DJ's filters
    // by POSTing a track ID directly instead of going through /api/search.
    if (systemConfigs.decadeFilter && systemConfigs.decadeFilter.length > 0) {
        const decade = releaseYear ? Math.floor(releaseYear / 10) * 10 : null;
        if (decade === null || !systemConfigs.decadeFilter.includes(decade)) {
            return res.status(403).json({ error: "That song's decade isn't part of tonight's theme." });
        }
    }
    if (systemConfigs.genreFilter && systemConfigs.genreFilter.length > 0) {
        const genresByArtist = await getArtistGenres(primaryArtistId ? [primaryArtistId] : []);
        const artistGenres = genresByArtist.get(primaryArtistId) || [];
        const allowedKeywords = systemConfigs.genreFilter.flatMap(key => GENRE_CATEGORIES[key] || []);
        const matches = artistGenres.some(g => allowedKeywords.some(keyword => g.includes(keyword)));
        if (!matches) {
            return res.status(403).json({ error: "That song's genre isn't part of tonight's theme." });
        }
    }

    // Server-authoritative credit check (abuse/spam control) - separate from the
    // client's own locally-displayed credit counter, can't be bypassed client-side.
    // Kiosk and guest each use their own maxCredits/countdownLength, but the
    // per-device tracking mechanism (keyed by the voter cookie) is identical -
    // each physical kiosk device naturally gets its own independent credit
    // bank, same as any guest's phone would.
    const creditState = getOrCreateVoterCreditState(voterId, modeConfig.maxCredits);
    refillVoterCredits(creditState, modeConfig.maxCredits, modeConfig.countdownLength);
    if (creditState.available <= 0) {
        return res.status(429).json({ error: "You are out of credits! Wait for the regeneration cycle." });
    }
    creditState.available -= 1;

    // DJ-only attribution: never sent back down via /data, only via /api/admin/data
    const requesterName = (typeof username === 'string' && username.trim() !== '')
        ? username.trim().slice(0, 30)
        : 'Anonymous';

    const trackId = verifiedTrack.id;

    const existingTrack = activeQueue.find(t => t.id === trackId);
    if (existingTrack) {
        if (!existingTrack.upvoters.includes('system-generated')) {
            existingTrack.upvoters.push('system-generated');
        }
        if (!existingTrack.requesters) existingTrack.requesters = [];
        existingTrack.requesters.push(requesterName);
    } else {
        activeQueue.push({
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
        // Relay to the DJ's actual Spotify playback queue. Only on first entry -
        // a duplicate request just upvotes the existing local entry above, it
        // shouldn't queue the same song twice on Spotify. Fire-and-forget: never
        // let a slow/failed Spotify call delay or fail the guest's request.
        if (systemConfigs.liveSpotifyQueueEnabled) {
            insertTrackAtTopOfSpotifyQueue(trackId);
        } else if (systemConfigs.spotifyAutoQueueEnabled) {
            queueTrackOnSpotify(trackId);
        }
    }

    requestLog.push({
        trackId,
        title: verifiedTrack.name,
        artist: verifiedTrack.artist,
        artwork: verifiedTrack.artwork,
        explicit: verifiedTrack.explicit,
        voterId,
        status: 'queued',
        requestedAt: Date.now()
    });
    // Keep the log from growing forever on a long night
    if (requestLog.length > 2000) requestLog = requestLog.slice(-2000);

    res.json({ success: true });
});

app.post('/api/vote', (req, res) => {
    const { id, type } = req.body;
    const voterId = req.serverVoterId;

    // Abuse/spam control: block rapid-fire vote-button mashing per guest
    const lastVoteAt = voterLastVoteAt.get(voterId) || 0;
    if (Date.now() - lastVoteAt < MIN_VOTE_INTERVAL_MS) {
        return res.status(429).json({ error: "Please slow down." });
    }
    voterLastVoteAt.set(voterId, Date.now());

    const track = activeQueue.find(t => t.id === id);
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

    res.json({ success: true });
});

// Public queue shape: NEVER includes "requesters" - keeps requester identity DJ-only.
function buildSortedQueue() {
    return activeQueue.map(t => ({
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
function buildSortedQueueForAdmin() {
    return activeQueue.map(t => ({
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

// Read-only, public: Spotify's actual next-10 in real play order. Used by all
// three front-ends when the DJ has liveSpotifyQueueEnabled on. Never exposes
// tokens - just track metadata, same shape as the local queue's song objects.
app.get('/api/spotify-queue', async (req, res) => {
    if (!systemConfigs.liveSpotifyQueueEnabled) {
        return res.json({ enabled: false, currentlyPlaying: null, queue: [] });
    }
    const live = await fetchLiveSpotifyQueue();
    if (!live) return res.json({ enabled: true, connected: false, currentlyPlaying: null, queue: [] });
    res.json({ enabled: true, connected: true, ...live });
});

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        eventName: systemConfigs.eventName || '',
        queueCapEnabled: systemConfigs.queueCapEnabled,
        maxQueueLength: systemConfigs.maxQueueLength,
        queueFull: isQueueFull(),
        genreFilter: systemConfigs.genreFilter || [],
        decadeFilter: systemConfigs.decadeFilter || [],
        spotifyConnectEnabled: systemConfigs.guestSpotifyConnectEnabled,
        liveSpotifyQueueEnabled: systemConfigs.liveSpotifyQueueEnabled,
        queue: buildSortedQueue(),
        history: playedHistory
    });
});

// Same shape as /data, but sourcing requestsAllowed/spotifyConnectEnabled/
// credit rules from kioskConfigs instead - everything else (queue, explicit
// filter, genre/decade filters, queue cap) is shared with regular guests.
app.get('/kiosk-data', (req, res) => {
    res.json({
        maxCredits: kioskConfigs.maxCredits,
        countdownLength: kioskConfigs.countdownLength,
        requestsAllowed: kioskConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        eventName: systemConfigs.eventName || '',
        queueCapEnabled: systemConfigs.queueCapEnabled,
        maxQueueLength: systemConfigs.maxQueueLength,
        queueFull: isQueueFull(),
        genreFilter: systemConfigs.genreFilter || [],
        decadeFilter: systemConfigs.decadeFilter || [],
        spotifyConnectEnabled: kioskConfigs.spotifyConnectEnabled,
        liveSpotifyQueueEnabled: systemConfigs.liveSpotifyQueueEnabled,
        queue: buildSortedQueue(),
        history: playedHistory
    });
});

app.get('/api/admin/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        eventName: systemConfigs.eventName || '',
        queueCapEnabled: systemConfigs.queueCapEnabled,
        maxQueueLength: systemConfigs.maxQueueLength,
        queueFull: isQueueFull(),
        genreFilter: systemConfigs.genreFilter || [],
        decadeFilter: systemConfigs.decadeFilter || [],
        guestSpotifyConnectEnabled: systemConfigs.guestSpotifyConnectEnabled,
        spotifyAutoQueueEnabled: systemConfigs.spotifyAutoQueueEnabled,
        liveSpotifyQueueEnabled: systemConfigs.liveSpotifyQueueEnabled,
        djSpotifyQueueConnected: !!djRefreshToken,
        kiosk: kioskConfigs,
        queue: buildSortedQueueForAdmin(),
        history: playedHistory
    });
});

app.get('/api/admin/stats', (req, res) => {
    // 1. Every song ever requested, one row per requester, newest first.
    const allRequests = [];
    queueHistoryLog.forEach(entry => {
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

    // 2. Requester leaderboard - song count per username.
    const usernameCounts = new Map();
    allRequests.forEach(r => {
        usernameCounts.set(r.username, (usernameCounts.get(r.username) || 0) + 1);
    });
    const topRequesters = [...usernameCounts.entries()]
        .map(([username, count]) => ({ username, count }))
        .sort((a, b) => b.count - a.count);

    // 3. Played vs dropped totals.
    const totals = {
        played: queueHistoryLog.filter(e => e.outcome === 'played').length,
        dropped: queueHistoryLog.filter(e => e.outcome === 'dropped').length,
        stillQueued: activeQueue.length
    };

    // 4. Top liked / disliked songs by final vote count.
    const topLiked = [...queueHistoryLog]
        .filter(e => e.ups > 0)
        .sort((a, b) => b.ups - a.ups)
        .slice(0, 5)
        .map(e => ({ title: e.title, artist: e.artist, artwork: e.artwork, count: e.ups }));

    const topDisliked = [...queueHistoryLog]
        .filter(e => e.downs > 0)
        .sort((a, b) => b.downs - a.downs)
        .slice(0, 5)
        .map(e => ({ title: e.title, artist: e.artist, artwork: e.artwork, count: e.downs }));

    res.json({ allRequests, topRequesters, totals, topLiked, topDisliked });
});

// Guest-only lookup of their own request history/status, keyed by their own
// server-issued cookie identity (previously a client-supplied ?voterId= query
// param, which meant anyone could view anyone else's request history just by
// reusing their token in the URL).
app.get('/api/my-requests', (req, res) => {
    const voterId = req.serverVoterId;

    const mine = requestLog
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

app.post('/api/admin/config', (req, res) => {
    const { maxCredits, countdownLength, eventName, maxQueueLength, genreFilter, decadeFilter } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    if (typeof eventName === 'string') systemConfigs.eventName = eventName.trim().slice(0, 60);
    if (maxQueueLength !== undefined) {
        const parsed = parseInt(maxQueueLength);
        if (parsed > 0) systemConfigs.maxQueueLength = parsed;
    }
    if (Array.isArray(genreFilter)) {
        systemConfigs.genreFilter = genreFilter.filter(key => Object.prototype.hasOwnProperty.call(GENRE_CATEGORIES, key));
    }
    if (Array.isArray(decadeFilter)) {
        systemConfigs.decadeFilter = decadeFilter.map(y => parseInt(y)).filter(y => Number.isInteger(y));
    }
    res.json({ success: true });
});

app.post('/api/admin/toggle-queue-cap', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') systemConfigs.queueCapEnabled = enabled;
    res.json({ success: true });
});

app.post('/api/admin/toggle-guest-spotify', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') systemConfigs.guestSpotifyConnectEnabled = enabled;
    res.json({ success: true });
});

app.post('/api/admin/toggle-spotify-auto-queue', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') systemConfigs.spotifyAutoQueueEnabled = enabled;
    res.json({ success: true });
});

app.post('/api/admin/toggle-live-spotify-queue', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') systemConfigs.liveSpotifyQueueEnabled = enabled;
    res.json({ success: true });
});

app.post('/api/admin/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') systemConfigs.requestsAllowed = allow;
    res.json({ success: true });
});

app.post('/api/admin/toggle-explicit', (req, res) => {
    const { blockExplicit } = req.body;
    if (typeof blockExplicit === 'boolean') systemConfigs.explicitBlockActive = blockExplicit;
    res.json({ success: true });
});

// Kiosk-specific equivalents of the toggles above - independent from the
// guest page's settings.
app.post('/api/admin/kiosk/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') kioskConfigs.requestsAllowed = allow;
    res.json({ success: true });
});

app.post('/api/admin/kiosk/toggle-spotify', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') kioskConfigs.spotifyConnectEnabled = enabled;
    res.json({ success: true });
});

app.post('/api/admin/kiosk/config', (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) kioskConfigs.maxCredits = parseInt(maxCredits) || kioskConfigs.maxCredits;
    if (countdownLength !== undefined) kioskConfigs.countdownLength = parseInt(countdownLength) || kioskConfigs.countdownLength;
    res.json({ success: true });
});

// Shared by the admin "Played" button and the auto-sync poller below - moves a
// track out of the live local queue into playedHistory/stats. trackIndex must
// already be a valid index into activeQueue.
function markTrackPlayedByIndex(trackIndex) {
    const [track] = activeQueue.splice(trackIndex, 1);
    markRequestLogStatus(track.id, 'played');
    playedHistory.unshift({
        title: track.title,
        artist: track.artist,
        artwork: track.artwork,
        explicit: track.explicit,
        duration: track.duration,
        requesters: track.requesters || []
    });
    logDepartedTrack(track, 'played');
    return track;
}

app.post('/api/admin/action', (req, res) => {
    const { id, action } = req.body;
    if (action === 'clearQueue') {
        activeQueue.forEach(t => markRequestLogStatus(t.id, 'removed'));
        activeQueue = [];
        return res.json({ success: true });
    }
    if (action === 'clearHistory') { playedHistory = []; return res.json({ success: true }); }

    const trackIndex = activeQueue.findIndex(t => t.id === id);
    if (trackIndex !== -1) {
        if (action === 'top') {
            const track = activeQueue[trackIndex];
            const sorted = buildSortedQueue();
            const highestNet = sorted.length > 0 ? (sorted[0].ups - sorted[0].downs) : 0;
            track.downvoters = [];
            track.upvoters = Array(highestNet + 1).fill('forced-admin-boost');
        } else if (action === 'played') {
            markTrackPlayedByIndex(trackIndex);
        } else if (action === 'remove') {
            const [track] = activeQueue.splice(trackIndex, 1);
            markRequestLogStatus(track.id, 'removed');
            logDepartedTrack(track, 'dropped');
        }
    }
    res.json({ success: true });
});

// --- Auto-sync: remove a request from the local queue the moment Spotify
// actually starts playing it, so the DJ doesn't have to manually click
// "Played" for every guest request. Only touches tracks that are still in
// activeQueue - the DJ's regular playlist tracks never match anything here,
// so this has no effect when nothing requested is currently playing.
let lastSyncedNowPlayingId = null;
async function syncNowPlayingWithQueue() {
    const token = await getDjAccessToken();
    if (!token) return;
    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204 || res.status === 404) return; // nothing playing
        if (!res.ok) return;
        const data = await res.json();
        const nowPlayingId = data?.item?.id;
        if (!nowPlayingId || nowPlayingId === lastSyncedNowPlayingId) return;
        lastSyncedNowPlayingId = nowPlayingId;

        const trackIndex = activeQueue.findIndex(t => t.id === nowPlayingId);
        if (trackIndex !== -1) {
            const track = markTrackPlayedByIndex(trackIndex);
            console.log('[SPOTIFY SYNC] Now playing, removed from local queue:', track.title);
        }
    } catch (err) {
        console.error('[SPOTIFY SYNC] Poll failed:', err.message);
    }
}
setInterval(syncNowPlayingWithQueue, 5000);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    await getSpotifyToken();
});
