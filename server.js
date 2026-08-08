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
    if (!vid || typeof vid !== 'string' || vid.length < 16) {
        vid = crypto.randomBytes(16).toString('hex');
        const isProd = process.env.NODE_ENV === 'production';
        const parts = [
            `${VOTER_COOKIE}=${encodeURIComponent(vid)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${60 * 60 * 24 * 365}`
        ];
        if (isProd) parts.push('Secure');
        res.setHeader('Set-Cookie', parts.join('; '));
    }
    req.voterId = vid;
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

let djTokens = null;
let activeQueue = [];
let pendingFallbackSwitch = null; // { playlistUri, requestedAt }
let lastSyncedNowPlayingId = null;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const DJ_REFRESH_TOKEN = process.env.DJ_REFRESH_TOKEN;
const DJ_ADMIN_PASSWORD = process.env.DJ_ADMIN_PASSWORD || 'secret123';

const MAX_ACTIVE_QUEUE_SIZE = 50;
const INITIAL_CREDITS = 3;
const CREDIT_REGEN_TIME_MS = 3 * 60 * 1000; // 3 minutes

const voterCreditsMap = {};
const voterRequestHistoryMap = {};
const sessionUsernames = {};

function getVoterCredits(voterId) {
    if (!voterCreditsMap[voterId]) {
        voterCreditsMap[voterId] = {
            credits: INITIAL_CREDITS,
            lastRegenTime: Date.now()
        };
    } else {
        const data = voterCreditsMap[voterId];
        const now = Date.now();
        const timePassed = now - data.lastRegenTime;
        if (data.credits < INITIAL_CREDITS && timePassed >= CREDIT_REGEN_TIME_MS) {
            const creditsToAdd = Math.floor(timePassed / CREDIT_REGEN_TIME_MS);
            data.credits = Math.min(INITIAL_CREDITS, data.credits + creditsToAdd);
            data.lastRegenTime = now;
        }
    }
    return voterCreditsMap[voterId];
}

function consumeCredit(voterId) {
    const creditData = getVoterCredits(voterId);
    if (creditData.credits > 0) {
        creditData.credits -= 1;
        creditData.lastRegenTime = Date.now();
        return true;
    }
    return false;
}

function addTrackToHistory(voterId, track) {
    if (!voterRequestHistoryMap[voterId]) {
        voterRequestHistoryMap[voterId] = [];
    }
    voterRequestHistoryMap[voterId].unshift({
        id: track.id,
        title: track.title,
        artist: track.artist,
        albumArt: track.albumArt,
        requestedAt: Date.now()
    });
}

function markTrackPlayedByIndex(index) {
    if (index >= 0 && index < activeQueue.length) {
        const [playedTrack] = activeQueue.splice(index, 1);
        playedTrack.played = true;
        playedTrack.playedAt = Date.now();

        if (playedTrack.username && playedTrack.username !== 'System Backup') {
            const history = voterRequestHistoryMap[playedTrack.requestedBy] || [];
            const historyItem = history.find(t => t.id === playedTrack.id);
            if (historyItem) {
                historyItem.played = true;
                historyItem.playedAt = playedTrack.playedAt;
            }
        }
        return playedTrack;
    }
    return null;
}

async function getDjAccessToken() {
    if (djTokens && djTokens.access_token && Date.now() < djTokens.expires_at) {
        return djTokens.access_token;
    }
    if (!DJ_REFRESH_TOKEN || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        console.error('Missing Spotify Credentials in Environment Variables!');
        return null;
    }
    try {
        const basicAuth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: DJ_REFRESH_TOKEN
            })
        });
        const data = await res.json();
        if (data.access_token) {
            djTokens = {
                access_token: data.access_token,
                expires_at: Date.now() + (data.expires_in - 60) * 1000
            };
            return djTokens.access_token;
        } else {
            console.error('Failed to refresh token:', data);
            return null;
        }
    } catch (err) {
        console.error('Token refresh error:', err);
        return null;
    }
}

async function queueTrackOnSpotify(trackId) {
    const token = await getDjAccessToken();
    if (!token) throw new Error('No Spotify DJ Access Token');

    const uri = `spotify:track:${trackId}`;
    const res = await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Spotify Queue API returned ${res.status}: ${errText}`);
    }
}

async function startPlaylistPlaybackOnSpotify(playlistUri) {
    const token = await getDjAccessToken();
    if (!token) throw new Error('No Spotify DJ Access Token');

    const res = await fetch('https://api.spotify.com/v1/me/player/play', {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ context_uri: playlistUri })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Spotify Play API returned ${res.status}: ${errText}`);
    }
}

async function maybeFireFallbackSwitch(currentNowPlayingId) {
    if (!pendingFallbackSwitch) return;

    // Check if any unplayed guest requests remain in activeQueue
    const activeUnplayedRequests = activeQueue.filter(t => !t.played);

    // Context switch only fires when guest requests are empty AND whatever track
    // was playing when the switch was requested has finished playing.
    if (activeUnplayedRequests.length === 0) {
        const targetUri = pendingFallbackSwitch.playlistUri;
        pendingFallbackSwitch = null;
        try {
            await startPlaylistPlaybackOnSpotify(targetUri);
            console.log('[FALLBACK SWITCH] Fired fallback context switch to:', targetUri);
        } catch (err) {
            console.error('[FALLBACK SWITCH] Failed to switch playback context:', err.message);
        }
    }
}

function requireAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        if (token === DJ_ADMIN_PASSWORD) {
            return next();
        }
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid DJ Admin Password' });
}

app.get('/api/spotify-config', (req, res) => {
    res.json({
        clientId: SPOTIFY_CLIENT_ID || ''
    });
});

app.post('/api/username', (req, res) => {
    const { username } = req.body;
    if (!username || typeof username !== 'string' || !username.trim()) {
        return res.status(400).json({ error: 'Username is required.' });
    }
    const cleanName = username.trim().slice(0, 30);
    sessionUsernames[req.voterId] = cleanName;
    res.json({ success: true, username: cleanName });
});

app.get('/api/username', (req, res) => {
    res.json({ username: sessionUsernames[req.voterId] || null });
});

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query parameter q is required' });

    const token = await getDjAccessToken();
    if (!token) return res.status(500).json({ error: 'Spotify integration not configured on server.' });

    try {
        const spotifyRes = await fetch(`https://api.spotify.com/v1/search?type=track&limit=15&q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await spotifyRes.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to search Spotify' });
    }
});

app.get('/api/user-playlists', async (req, res) => {
    const token = await getDjAccessToken();
    if (!token) return res.status(500).json({ error: 'Spotify DJ access token not available' });

    try {
        const playlists = [];
        let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
        while (url && playlists.length < 100) {
            const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!resp.ok) break;
            const data = await resp.json();
            if (data.items) {
                for (const item of data.items) {
                    if (item && item.id) {
                        playlists.push({
                            id: item.id,
                            name: item.name,
                            uri: item.uri,
                            images: item.images,
                            tracksCount: item.tracks ? item.tracks.total : 0
                        });
                    }
                }
            }
            url = data.next;
        }
        res.json({ playlists });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch user playlists.' });
    }
});

app.get('/api/playlist-tracks', async (req, res) => {
    const playlistId = req.query.id;
    if (!playlistId) return res.status(400).json({ error: 'Missing playlist id.' });

    const token = await getDjAccessToken();
    if (!token) return res.status(500).json({ error: 'Spotify access token not available.' });

    try {
        const resp = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch playlist tracks from Spotify.' });
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch playlist tracks.' });
    }
});

app.get('/api/credits', (req, res) => {
    const creditData = getVoterCredits(req.voterId);
    res.json({
        credits: creditData.credits,
        maxCredits: INITIAL_CREDITS,
        regenTimeMs: CREDIT_REGEN_TIME_MS,
        lastRegenTime: creditData.lastRegenTime
    });
});

app.get('/api/queue', (req, res) => {
    res.json({
        queue: activeQueue,
        pendingFallbackSwitch: pendingFallbackSwitch ? {
            playlistUri: pendingFallbackSwitch.playlistUri,
            requestedAt: pendingFallbackSwitch.requestedAt
        } : null
    });
});

app.get('/api/my-history', (req, res) => {
    const history = voterRequestHistoryMap[req.voterId] || [];
    res.json({ history });
});

app.post('/api/request', async (req, res) => {
    const { track } = req.body;
    const voterId = req.voterId;

    if (!track || !track.id || !track.title) {
        return res.status(400).json({ error: 'Invalid track payload.' });
    }

    if (activeQueue.length >= MAX_ACTIVE_QUEUE_SIZE) {
        return res.status(400).json({ error: 'Queue is full! Wait for songs to play.' });
    }

    const existingInActive = activeQueue.find(t => t.id === track.id && !t.played);
    if (existingInActive) {
        return res.status(400).json({ error: 'This track is already waiting in the queue!' });
    }

    const creditData = getVoterCredits(voterId);
    if (creditData.credits <= 0) {
        return res.status(400).json({ error: 'You are out of request credits! Wait for credits to regenerate.' });
    }

    try {
        await queueTrackOnSpotify(track.id);
        consumeCredit(voterId);

        const username = sessionUsernames[voterId] || 'Guest';

        const queueItem = {
            queueId: crypto.randomBytes(8).toString('hex'),
            id: track.id,
            uri: track.uri || `spotify:track:${track.id}`,
            title: track.title,
            artist: track.artist,
            albumArt: track.albumArt,
            requestedBy: voterId,
            username: username,
            votes: 0,
            votedBy: [],
            requestedAt: Date.now(),
            played: false
        };

        activeQueue.push(queueItem);
        addTrackToHistory(voterId, track);

        res.json({
            success: true,
            queueItem,
            remainingCredits: creditData.credits
        });
    } catch (err) {
        console.error('Request error:', err);
        res.status(500).json({ error: err.message || 'Failed to queue song on Spotify.' });
    }
});

app.post('/api/vote', (req, res) => {
    const { queueId } = req.body;
    const voterId = req.voterId;

    const item = activeQueue.find(t => t.queueId === queueId && !t.played);
    if (!item) {
        return res.status(404).json({ error: 'Track not found in queue.' });
    }

    if (item.votedBy.includes(voterId)) {
        return res.status(400).json({ error: 'You already upvoted this song!' });
    }

    item.votes += 1;
    item.votedBy.push(voterId);

    activeQueue.sort((a, b) => b.votes - a.votes || a.requestedAt - b.requestedAt);

    res.json({ success: true, item });
});

app.use('/api/admin', requireAdminAuth);

app.post('/api/admin/switch-playlist', async (req, res) => {
    const { playlistUri } = req.body;
    if (!playlistUri) {
        return res.status(400).json({ error: 'Missing playlistUri' });
    }

    const token = await getDjAccessToken();
    if (!token) {
        return res.status(500).json({ error: 'Spotify access token not available.' });
    }

    try {
        // 1. Get all active unplayed guest requests
        const unplayedGuestTracks = activeQueue.filter(track => !track.played);

        // 2. Re-queue each active guest track sequentially to preserve order
        //    and force Spotify's queue to prioritize them over old context auto-play
        for (const track of unplayedGuestTracks) {
            await queueTrackOnSpotify(track.id);
        }

        // 3. Set pending fallback switch state
        pendingFallbackSwitch = {
            playlistUri,
            requestedAt: Date.now()
        };

        // 4. Trigger immediate evaluation if queue is already empty
        await maybeFireFallbackSwitch(lastSyncedNowPlayingId);

        res.json({
            success: true,
            message: 'Playlist switch scheduled and guest queue re-buffered.',
            pending: !!pendingFallbackSwitch
        });
    } catch (err) {
        console.error('[SWITCH PLAYLIST] Error:', err.message);
        res.status(500).json({ error: 'Failed to schedule playlist switch.' });
    }
});

app.post('/api/admin/remove', (req, res) => {
    const { queueId } = req.body;
    const idx = activeQueue.findIndex(t => t.queueId === queueId);
    if (idx !== -1) {
        activeQueue.splice(idx, 1);
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'Item not found in active queue.' });
});

app.post('/api/admin/cancel-switch', (req, res) => {
    pendingFallbackSwitch = null;
    res.json({ success: true, message: 'Pending fallback switch cancelled.' });
});

app.get('/api/admin/stats', (req, res) => {
    const activeVotersCount = Object.keys(voterCreditsMap).length;
    const totalRequestsCount = Object.values(voterRequestHistoryMap).reduce((acc, curr) => acc + curr.length, 0);

    const userStatsMap = {};
    for (const [voterId, history] of Object.entries(voterRequestHistoryMap)) {
        const name = sessionUsernames[voterId] || 'Guest';
        userStatsMap[voterId] = {
            username: name,
            totalRequests: history.length,
            playedRequests: history.filter(h => h.played).length
        };
    }

    const leaderboard = Object.values(userStatsMap).sort((a, b) => b.totalRequests - a.totalRequests);

    res.json({
        activeVotersCount,
        totalRequestsCount,
        activeQueueLength: activeQueue.filter(t => !t.played).length,
        leaderboard
    });
});

async function syncNowPlayingWithQueue() {
    const token = await getDjAccessToken();
    if (!token) return;
    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 204 || res.status === 404) {
            // Nothing playing right now still counts as "the watched track
            // is no longer playing" for a pending fallback switch.
            await maybeFireFallbackSwitch(null);
            return;
        }
        if (!res.ok) return;
        const data = await res.json();
        const nowPlayingId = data?.item?.id;

        await maybeFireFallbackSwitch(nowPlayingId || null);

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

app.listen(PORT, () => {
    console.log(`CrowdDJ server running on port ${PORT}`);
});
