const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Dynamically sets the redirect path to avoid any mismatch config errors
const REDIRECT_URI = `https://song-requests-gnzd.onrender.com/api/callback`;

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

async function getSpotifyToken() {
    if (!CLIENT_ID || !CLIENT_SECRET) return;
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
        if (data.access_token) spotifyAccessToken = data.access_token;
    } catch (err) {
        console.error("Token error:", err.message);
    }
}
setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// SPOTIFY AUTHENTICATION
// -------------------------------------------------------------
app.get('/api/login', (req, res) => {
    const scope = 'playlist-read-private playlist-read-collaborative';
    res.redirect('https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI
        }).toString());
});

app.get('/api/callback', async (req, res) => {
    const code = req.query.code || null;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization-code'
            }).toString()
        });
        const data = await response.json();
        
        if (data.access_token) {
            res.redirect(`/#access_token=${data.access_token}`);
        } else {
            res.redirect('/?error=auth_failed');
        }
    } catch (err) {
        res.redirect('/?error=server_error');
    }
});

// -------------------------------------------------------------
// CORE DATA API
// -------------------------------------------------------------
app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const userToken = req.headers['user-token'] || spotifyAccessToken;
    if (!query || !userToken) return res.json({ tracks: [] });

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        const data = await response.json();
        const tracks = (data.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: formatDuration(track.duration_ms)
        }));
        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Missing metadata." });

    const existingTrack = activeQueue.find(t => t.id === track.id);
    if (existingTrack) {
        existingTrack.votes = (existingTrack.votes || 1) + 1;
    } else {
        activeQueue.push({
            id: track.id || Date.now().toString(),
            title: track.name,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: track.duration || '--:--',
            votes: 1
        });
    }
    res.json({ success: true });
});

// -------------------------------------------------------------
// CONTROL LAYER (ADMIN)
// -------------------------------------------------------------
app.get('/api/admin/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

app.post('/api/admin/config', (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    res.json({ success: true });
});

app.post('/api/admin/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') systemConfigs.requestsAllowed = allow;
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
            const highestVotes = activeQueue.length > 0 ? Math.max(...activeQueue.map(t => t.votes || 0)) : 0;
            track.votes = highestVotes + 1;
        } else if (action === 'played') {
            const [track] = activeQueue.splice(trackIndex, 1);
            playedHistory.unshift(track);
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
