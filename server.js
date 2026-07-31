const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Client IDs are not secret (the client_secret is what stays server-side) - this lets
// the public guest page run its own Spotify login (PKCE) to browse their playlists.
app.get('/api/public-config', (req, res) => {
    res.json({ spotifyClientId: CLIENT_ID || null });
});

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true,
    explicitBlockActive: false,
    fallbackPlaylistUri: "" // e.g. "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M" - filler music when the queue is empty
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

// --- DJ's personal Spotify login (separate from the app-only search token above) ---
// This is what lets the server actually control playback, not just search.
let djSpotifyAuth = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0 // epoch ms
};
let playbackState = {
    connected: false,
    autoAdvance: true, // default on so the room is never silent once the DJ connects
    deviceId: null,
    mode: 'idle' // 'idle' | 'queue' | 'fallback'
};
const SPOTIFY_SCOPES = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
    'user-read-playback-state'
].join(' ');

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

// --- DJ Spotify login (Authorization Code flow) ---
// Step 1: DJ clicks "Connect Spotify" in the admin dashboard, which hits this route.
app.get('/api/admin/spotify-login', (req, res) => {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/admin/spotify-callback`;
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: SPOTIFY_SCOPES,
        redirect_uri: redirectUri
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Step 2: Spotify redirects back here with a code we exchange for real tokens.
app.get('/api/admin/spotify-callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Spotify login failed: no code returned.');

    const redirectUri = `${req.protocol}://${req.get('host')}/api/admin/spotify-callback`;

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
                redirect_uri: redirectUri
            })
        });
        const data = await response.json();
        if (!data.access_token) {
            console.error('[SPOTIFY AUTH] Token exchange failed:', data);
            return res.status(500).send('Spotify login failed during token exchange.');
        }

        djSpotifyAuth.accessToken = data.access_token;
        djSpotifyAuth.refreshToken = data.refresh_token;
        djSpotifyAuth.expiresAt = Date.now() + (data.expires_in * 1000);
        playbackState.connected = true;

        console.log('[SPOTIFY AUTH] DJ account connected.');
        res.redirect('/admin.html'); // back to the dashboard
    } catch (err) {
        console.error('[SPOTIFY AUTH] Callback error:', err.message);
        res.status(500).send('Spotify login failed.');
    }
});

// Keeps the DJ's playback token valid. Called before any playback action.
async function ensureDjTokenFresh() {
    if (!djSpotifyAuth.refreshToken) return false;
    if (djSpotifyAuth.accessToken && Date.now() < djSpotifyAuth.expiresAt - 30000) {
        return true; // still valid for at least 30 more seconds
    }
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: djSpotifyAuth.refreshToken
            })
        });
        const data = await response.json();
        if (!data.access_token) return false;
        djSpotifyAuth.accessToken = data.access_token;
        djSpotifyAuth.expiresAt = Date.now() + (data.expires_in * 1000);
        // Spotify sometimes rotates the refresh token too
        if (data.refresh_token) djSpotifyAuth.refreshToken = data.refresh_token;
        return true;
    } catch (err) {
        console.error('[SPOTIFY AUTH] Refresh failed:', err.message);
        return false;
    }
}

// The admin page's Web Playback SDK needs a live token to initialize the player.
app.get('/api/admin/spotify-token', async (req, res) => {
    const ok = await ensureDjTokenFresh();
    if (!ok) return res.status(401).json({ error: 'DJ not connected to Spotify.' });
    res.json({ accessToken: djSpotifyAuth.accessToken });
});

app.get('/api/admin/spotify-status', (req, res) => {
    res.json({
        connected: playbackState.connected,
        autoAdvance: playbackState.autoAdvance,
        mode: playbackState.mode
    });
});

app.post('/api/admin/spotify-disconnect', (req, res) => {
    djSpotifyAuth = { accessToken: null, refreshToken: null, expiresAt: 0 };
    playbackState = { connected: false, autoAdvance: true, deviceId: null, mode: 'idle' };
    res.json({ success: true });
});

app.post('/api/admin/spotify-autoadvance', (req, res) => {
    const { enabled } = req.body;
    playbackState.autoAdvance = !!enabled;
    res.json({ success: true });
});

// Registers which Spotify Connect device (the browser tab running the SDK) to control.
app.post('/api/admin/spotify-device', (req, res) => {
    const { deviceId } = req.body;
    playbackState.deviceId = deviceId || null;
    res.json({ success: true });
});

// Plays a specific track (used for both manual play and auto-advance).
async function playTrackOnDevice(spotifyTrackId) {
    const ok = await ensureDjTokenFresh();
    if (!ok || !playbackState.deviceId) return { success: false, error: 'Not connected or no active device.' };

    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${playbackState.deviceId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${djSpotifyAuth.accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uris: [`spotify:track:${spotifyTrackId}`] })
    });

    if (response.status === 204 || response.ok) return { success: true };
    const errData = await response.json().catch(() => ({}));
    return { success: false, error: errData.error?.message || 'Playback failed.' };
}

// Starts (or continues) the fallback playlist as Spotify's own playback context, so
// Spotify itself handles track-to-track advancing without us polling anything.
async function playFallback() {
    const ok = await ensureDjTokenFresh();
    if (!ok || !playbackState.deviceId) return { success: false, error: 'Not connected or no active device.' };
    if (!systemConfigs.fallbackPlaylistUri) return { success: false, error: 'No fallback playlist configured.' };

    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${playbackState.deviceId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${djSpotifyAuth.accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            context_uri: systemConfigs.fallbackPlaylistUri,
            offset: { position: Math.floor(Math.random() * 20) }
        })
    });

    if (response.status === 204 || response.ok) {
        playbackState.mode = 'fallback';
        return { success: true };
    }
    const errData = await response.json().catch(() => ({}));
    return { success: false, error: errData.error?.message || 'Fallback playback failed.' };
}

app.post('/api/admin/spotify/play', async (req, res) => {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'Missing trackId.' });
    const result = await playTrackOnDevice(trackId);
    res.json(result);
});

app.post('/api/admin/spotify/pause', async (req, res) => {
    const ok = await ensureDjTokenFresh();
    if (!ok || !playbackState.deviceId) return res.status(400).json({ error: 'Not connected.' });
    await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${playbackState.deviceId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${djSpotifyAuth.accessToken}` }
    });
    res.json({ success: true });
});

// Pulls the top track off the active queue, plays it, and moves it to history.
// Used both for the manual "Play Next" button and auto-advance.
app.post('/api/admin/spotify/play-next', async (req, res) => {
    const sorted = buildSortedQueue();

    if (sorted.length === 0) {
        // Nothing requested right now - keep the room filled with the fallback playlist
        // instead of going silent. Spotify handles advancing within that playlist itself.
        if (!systemConfigs.fallbackPlaylistUri) {
            playbackState.mode = 'idle';
            return res.json({ success: false, error: 'Queue is empty and no fallback playlist is set (add one in Settings).' });
        }
        const fallbackResult = await playFallback();
        return res.json({ ...fallbackResult, fallback: true });
    }

    const next = sorted[0];
    const result = await playTrackOnDevice(next.id);
    if (!result.success) return res.json(result);
    playbackState.mode = 'queue';

    const trackIndex = activeQueue.findIndex(t => t.id === next.id);
    if (trackIndex !== -1) {
        const [track] = activeQueue.splice(trackIndex, 1);
        playedHistory.unshift({
            title: track.title,
            artist: track.artist,
            artwork: track.artwork,
            explicit: track.explicit,
            duration: track.duration
        });
    }
    res.json({ success: true, nowPlaying: next });
});

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
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Missing metadata." });

    // API block safety gate against manual requests injection of explicit songs
    if (systemConfigs.explicitBlockActive && track.explicit) {
        return res.status(403).json({ error: "Explicit content is currently restricted by the DJ." });
    }

    const existingTrack = activeQueue.find(t => t.id === track.id);
    if (existingTrack) {
        if (!existingTrack.upvoters.includes('system-generated')) {
            existingTrack.upvoters.push('system-generated');
        }
    } else {
        activeQueue.push({
            id: track.id || Date.now().toString(),
            title: track.name,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: track.duration || '--:--',
            upvoters: [],
            downvoters: []
        });
    }
    res.json({ success: true });
});

app.post('/api/vote', (req, res) => {
    const { id, type, voterId } = req.body;
    if (!voterId) return res.status(400).json({ error: "Missing voter validation token." });

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

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
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
        fallbackPlaylistUri: systemConfigs.fallbackPlaylistUri,
        queue: buildSortedQueue(),
        history: playedHistory
    });
});

app.post('/api/admin/config', (req, res) => {
    const { maxCredits, countdownLength, fallbackPlaylist } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;

    if (fallbackPlaylist !== undefined) {
        const raw = String(fallbackPlaylist).trim();
        if (raw === '') {
            systemConfigs.fallbackPlaylistUri = '';
        } else {
            // Accepts a pasted share link, a spotify: URI, or a bare playlist ID
            const linkMatch = raw.match(/playlist\/([a-zA-Z0-9]+)/);
            const uriMatch = raw.match(/spotify:playlist:([a-zA-Z0-9]+)/);
            const id = uriMatch ? uriMatch[1] : (linkMatch ? linkMatch[1] : raw);
            systemConfigs.fallbackPlaylistUri = `spotify:playlist:${id}`;
        }
    }
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
    if (action === 'clearQueue') { activeQueue = []; return res.json({ success: true }); }
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
            playedHistory.unshift({
                title: track.title,
                artist: track.artist,
                artwork: track.artwork,
                explicit: track.explicit,
                duration: track.duration
            });
        } else if (action === 'remove') {
            activeQueue.splice(trackIndex, 1);
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
