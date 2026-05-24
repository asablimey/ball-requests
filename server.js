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
    requestsAllowed: true,
    // 📂 Define your pre-selected Spotify Playlist IDs here!
    featuredPlaylists: [
        '37i9dQZF1DXcBWIGoYBM5M', // Example: Today's Top Hits
        '37i9dQZF1DX0XUsuxW93e7', // Example: Hit Rewind
        '37i9dQZF1DX10zKzsJ2jva'  // Example: Viva Latino
    ]
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

// 🌐 SPOTIFY CLIENT CREDENTIALS FLOW
async function getSpotifyToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log("[WARNING] Spotify API credentials are missing in Render environment settings.");
        return;
    }

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });

        const data = await response.json();
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
            console.log("[SPOTIFY] Successfully fetched live access token.");
        } else {
            console.log("[SPOTIFY ERROR] Authentication failed:", data);
        }
    } catch (err) {
        console.error("[SPOTIFY CRITICAL ERROR]:", err.message);
    }
}

setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// GET & POST ENDPOINTS
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

// 🔍 SEARCH ENDPOINT
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    if (!spotifyAccessToken) {
        return res.status(500).json({ error: "Token uninitialized." });
    }

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
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

// 📂 NEW ENDPOINT: FETCH ALL FEATURED PLAYLIST META-DATA
app.get('/api/playlists', async (req, res) => {
    if (!spotifyAccessToken) return res.status(500).json({ error: "Token uninitialized." });
    
    try {
        const playlistPromises = systemConfigs.featuredPlaylists.map(async (id) => {
            const response = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=id,name,images,tracks.total`, {
                headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
            });
            if (!response.ok) return null;
            return response.json();
        });

        const rawResults = await Promise.all(playlistPromises);
        const cleanPlaylists = rawResults.filter(p => p !== null).map(p => ({
            id: p.id,
            name: p.name,
            trackCount: p.tracks?.total || 0,
            artwork: p.images?.[0]?.url || 'https://picsum.photos/100'
        }));

        res.json(cleanPlaylists);
    } catch (err) {
        res.status(500).json({ error: "Failed to retrieve playlists" });
    }
});

// 🎵 NEW ENDPOINT: FETCH TRACK DETAILS INSIDE PLAYLIST (FLATTENS DATA TO MATCH SEARCH)
app.get('/api/playlists/:id/tracks', async (req, res) => {
    const playlistId = req.params.id;
    if (!spotifyAccessToken) return res.status(500).json({ error: "Token uninitialized." });

    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=30&fields=items(track(id,name,album(images),artists(name)))`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        if (!response.ok) return res.status(response.status).json({ error: "Failed to fetch playlist tracks" });

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
        res.status(500).json({ error: "Track compilation error" });
    }
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

// Admin System data endpoints
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
    console.log(`[SERVER] Request dashboard streaming live on port ${PORT}`);
    await getSpotifyToken();
});
