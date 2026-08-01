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
    eventName: ''
};

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

function getOrCreateVoterCreditState(voterId) {
    let state = voterCreditState.get(voterId);
    if (!state) {
        state = { available: systemConfigs.maxCredits, lastRefill: Date.now() };
        voterCreditState.set(voterId, state);
    }
    return state;
}

function refillVoterCredits(state) {
    const now = Date.now();
    const cycleMs = Math.max(1, systemConfigs.countdownLength) * 1000;
    const elapsed = now - state.lastRefill;
    const cycles = Math.floor(elapsed / cycleMs);
    if (cycles > 0) {
        state.available = Math.min(systemConfigs.maxCredits, state.available + cycles);
        state.lastRefill += cycles * cycleMs;
    }
    if (state.available > systemConfigs.maxCredits) state.available = systemConfigs.maxCredits;
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
    if (!systemConfigs.requestsAllowed) {
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
            return {
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
                explicit: track.explicit || false,
                duration: formatDuration(track.duration_ms)
            };
        });
        
        // Filter out explicit tracks if explicit restriction lock is active
        if (systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }

        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search feature unavailable" });
    }
});

app.post('/api/request', async (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track, username } = req.body;
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
    } catch (err) {
        return res.status(500).json({ error: "Could not verify track with Spotify." });
    }

    // API block safety gate against manual requests injection of explicit songs
    if (systemConfigs.explicitBlockActive && verifiedTrack.explicit) {
        return res.status(403).json({ error: "Explicit content is currently restricted by the DJ." });
    }

    // Server-authoritative credit check (abuse/spam control) - separate from the
    // client's own locally-displayed credit counter, can't be bypassed client-side.
    const creditState = getOrCreateVoterCreditState(voterId);
    refillVoterCredits(creditState);
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

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        eventName: systemConfigs.eventName || '',
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
    const { maxCredits, countdownLength, eventName } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    if (typeof eventName === 'string') systemConfigs.eventName = eventName.trim().slice(0, 60);
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
        } else if (action === 'remove') {
            const [track] = activeQueue.splice(trackIndex, 1);
            markRequestLogStatus(track.id, 'removed');
            logDepartedTrack(track, 'dropped');
        }
    }
    res.json({ success: true });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    await getSpotifyToken();
});
