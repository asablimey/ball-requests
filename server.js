const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];

// -------------------------------------------------------------
// SPOTIFY AUTHENTICATION & PLAYLIST ENDPOINTS
// -------------------------------------------------------------

// Redirects user to Spotify's login page
app.get('/api/login', (req, res) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
        return res.status(500).send("Server missing SPOTIFY_CLIENT_ID environment variable.");
    }
    
    const redirectUri = encodeURIComponent(`${req.protocol}://${req.get('host')}/`);
    // Requests access to read private and collaborative playlists
    res.redirect(`https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=token&redirect_uri=${redirectUri}&scope=playlist-read-private%20playlist-read-collaborative`);
});

// Fetch all playlists belonging to the logged-in user
app.get('/api/playlists', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken) return res.status(401).json({ error: "Missing access token" });

    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Spotify API error" });
        const data = await response.json();
        
        const formatted = (data.items || []).map(p => ({
            id: p.id,
            name: p.name,
            trackCount: p.tracks?.total || 0,
            artwork: p.images?.[0]?.url || 'https://picsum.photos/100'
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: "Server failed to fetch playlists" });
    }
});

// Fetch songs inside a chosen playlist
app.get('/api/playlists/:id/tracks', async (req, res) => {
    const userToken = req.headers['user-token'];
    const playlistId = req.params.id;
    if (!userToken) return res.status(401).json({ error: "Missing access token" });

    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Spotify API error" });
        const data = await response.json();

        const cleanTracks = (data.items || [])
            .filter(item => item.track !== null)
            .map(item => {
                const t = item.track;
                return {
                    id: t.id,
                    name: t.name,
                    artist: t.artists.map(a => a.name).join(', '),
                    artwork: t.album?.images?.[0]?.url || 'https://picsum.photos/48'
                };
            });

        res.json(cleanTracks);
    } catch (err) {
        res.status(500).json({ error: "Server failed to compile tracks" });
    }
});

// Global Search Endpoint using the user's login token
app.get('/api/search', async (req, res) => {
    const userToken = req.headers['user-token'];
    const query = req.query.q;
    if (!userToken) return res.status(401).json({ error: "Missing access token" });
    if (!query) return res.json({ tracks: [] });

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=15`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        
        if (!response.ok) return res.status(response.status).json({ error: "Search failed" });
        const data = await response.json();
        
        const tracks = (data.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48'
        }));
        
        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search crashed" });
    }
});

// -------------------------------------------------------------
// USER REQUESTS & ADMIN OVERRIDES (100% UNTOUCHED)
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

app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.status(403).json({ error: "Submissions closed." });
    }
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

app.listen(PORT, () => console.log(`[SERVER] Running request interface on port ${PORT}`));
