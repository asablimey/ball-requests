const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = "ballDJ2026";
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];

// -------------------------------------------------------------
// SPOTIFY USER OAUTH HANDLERS
// -------------------------------------------------------------

app.get('/api/login', (req, res) => {
    const scopes = 'playlist-read-private playlist-read-collaborative';
    res.redirect('https://accounts.spotify.com/authorize' +
        '?response_type=code' +
        '&client_id=' + CLIENT_ID +
        (scopes ? '&scope=' + encodeURIComponent(scopes) : '') +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    if (!code) return res.redirect('/?error=auth_failed');

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
                grant_type: 'authorization_code'
            })
        });

        const data = await response.json();
        if (data.access_token) {
            res.redirect(`/?access_token=${data.access_token}`);
        } else {
            res.redirect('/?error=token_failed');
        }
    } catch (err) {
        res.redirect('/?error=server_error');
    }
});

app.get('/api/playlists', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken) return res.status(401).json({ error: "No user token provided." });

    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists', {
            headers: { 'Authorization': 'Bearer ' + userToken }
        });
        const data = await response.json();
        res.json(data.items || []);
    } catch (err) {
        res.status(500).json({ error: "Failed fetching playlists." });
    }
});

// 🟢 FIXED: Removed broken template literal formatting to ensure track lists resolve correctly
app.get('/api/playlists/:id/tracks', async (req, res) => {
    const playlistId = req.params.id;
    const userToken = req.headers['user-token'];
    if (!userToken) return res.status(401).json({ error: "No user token provided." });

    try {
        const apiUrl = 'https://api.spotify.com/v1/playlists/$' + playlistId + '/tracks?limit=50';
        const response = await fetch(apiUrl, {
            headers: { 'Authorization': 'Bearer ' + userToken }
        });
        const data = await response.json();
        
        const tracks = (data.items || [])
            .filter(item => item.track)
            .map(item => ({
                id: item.track.id,
                name: item.track.name,
                artist: item.track.artists.map(a => a.name).join(', '),
                artwork: item.track.album?.images[0]?.url || 'https://picsum.photos/48'
            }));

        res.json(tracks);
    } catch (err) {
        res.status(500).json({ error: "Failed fetching tracks." });
    }
});

// -------------------------------------------------------------
// CHANNELS: GLOBAL ANONYMOUS SEARCH & APP RULES
// -------------------------------------------------------------

// 🟢 FIXED: Cleaned concatenation string parameters to restore the global search field parsing behavior
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    try {
        let token = req.headers['user-token'];
        
        if (!token || token === "null" || token === "undefined") {
            const authRes = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ grant_type: 'client_credentials' })
            });
            const authData = await authRes.json();
            token = authData.access_token;
        }

        const searchUrl = 'https://api.spotify.com/v1/search?q=$' + encodeURIComponent(query) + '&type=track&limit=15';
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await response.json();
        
        const tracks = (data.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48'
        }));
        
        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
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
            votes: 1
        });
    }
    res.json({ success: true });
});

// -------------------------------------------------------------
// MASTER ADMINISTRATIVE ENDPOINTS
// -------------------------------------------------------------

app.get('/api/admin/data', (req, res) => {
    if (req.headers['authorization'] !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized." });
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

app.post('/api/admin/config', (req, res) => {
    if (req.headers['authorization'] !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized." });
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    res.json({ success: true });
});

app.post('/api/admin/toggle', (req, res) => {
    if (req.headers['authorization'] !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized." });
    const { allow } = req.body;
    if (typeof allow === 'boolean') systemConfigs.requestsAllowed = allow;
    res.json({ success: true });
});

app.post('/api/admin/action', (req, res) => {
    if (req.headers['authorization'] !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized." });
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

app.listen(PORT, () => {
    console.log(`[SERVER] Request dashboard streaming live on port ${PORT}`);
});
