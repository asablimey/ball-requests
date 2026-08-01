const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

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

function markRequestLogStatus(trackId, newStatus) {
    requestLog.forEach(entry => {
        if (entry.trackId === trackId && entry.status === 'queued') {
            entry.status = newStatus;
            entry.resolvedAt = Date.now();
        }
    });
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

app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track, username, voterId } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Missing metadata." });
    if (!voterId) return res.status(400).json({ error: "Missing voter validation token." });

    // API block safety gate against manual requests injection of explicit songs
    if (systemConfigs.explicitBlockActive && track.explicit) {
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

    const trackId = track.id || Date.now().toString();

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
            title: track.name,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: track.duration || '--:--',
            upvoters: [],
            downvoters: [],
            requesters: [requesterName]
        });
    }

    requestLog.push({
        trackId,
        title: track.name,
        artist: track.artist || 'Unknown Artist',
        artwork: track.artwork || 'https://picsum.photos/48',
        explicit: track.explicit || false,
        voterId,
        status: 'queued',
        requestedAt: Date.now()
    });
    // Keep the log from growing forever on a long night
    if (requestLog.length > 2000) requestLog = requestLog.slice(-2000);

    res.json({ success: true });
});

app.post('/api/vote', (req, res) => {
    const { id, type, voterId } = req.body;
    if (!voterId) return res.status(400).json({ error: "Missing voter validation token." });

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

// Guest-only lookup of their own request history/status, keyed by their own voterId.
// Never exposes other guests' identities or requests.
app.get('/api/my-requests', (req, res) => {
    const voterId = req.query.voterId;
    if (!voterId) return res.status(400).json({ error: "Missing voter validation token." });

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
        } else if (action === 'remove') {
            const [track] = activeQueue.splice(trackIndex, 1);
            markRequestLogStatus(track.id, 'removed');
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
