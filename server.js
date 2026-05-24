const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// System State Variables (Syncs with Frontend)
let maxCredits = 3;
let countdownLength = 60;
let requestsAllowed = true;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🎛️ ADMIN DATA ENDPOINT
app.get('/data', (req, res) => {
    res.json({ maxCredits, countdownLength, requestsAllowed });
});

// 📂 ENDPOINT 1: FETCH ALL PLAYLISTS
app.get('/api/playlists', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken) return res.status(401).json({ error: "Missing user token" });

    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("[SPOTIFY API ERROR]", errText);
            return res.status(response.status).json({ error: "Spotify fetch failed" });
        }

        const data = await response.json();
        
        // Clean up the playlist items for the frontend grid
        const formattedPlaylists = (data.items || []).map(p => ({
            id: p.id,
            name: p.name,
            trackCount: p.tracks?.total || 0,
            artwork: p.images?.[0]?.url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop'
        }));

        res.json(formattedPlaylists);
    } catch (err) {
        console.error("Playlists system error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 🎵 ENDPOINT 2: FETCH SONGS INSIDE A PLAYLIST (The Critical Fix)
app.get('/api/playlists/:id/tracks', async (req, res) => {
    const userToken = req.headers['user-token'];
    const playlistId = req.params.id;
    if (!userToken) return res.status(401).json({ error: "Missing user token" });

    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=items(track(id,name,album(images),artists(name)))&limit=50`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: "Spotify tracks fetch failed" });
        }

        const data = await response.json();

        // 🔥 TRANSFORMATION LOGIC: Flattens Spotify's nested structure 
        // to match the exact format returned by global search!
        const cleanTracks = (data.items || [])
            .filter(item => item.track !== null) // Skip empty or unplayable tracks
            .map(item => {
                const t = item.track;
                return {
                    id: t.id,
                    name: t.name,
                    artist: t.artists?.[0]?.name || 'Unknown Artist',
                    artwork: t.album?.images?.[0]?.url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop'
                };
            });

        res.json(cleanTracks);
    } catch (err) {
        console.error("Tracks endpoint broken:", err);
        res.status(500).json({ error: "Internal server track failure" });
    }
});

// 🔍 ENDPOINT 3: GLOBAL SEARCH (Uses identical data mapping format)
app.get('/api/search', async (req, res) => {
    const userToken = req.headers['user-token'];
    const query = req.query.q;
    if (!userToken) return res.status(401).json({ error: "Unauthorized" });
    if (!query) return res.json({ tracks: [] });

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=20`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Search failed" });

        const data = await response.json();
        const cleanTracks = (data.tracks?.items || []).map(t => ({
            id: t.id,
            name: t.name,
            artist: t.artists?.[0]?.name || 'Unknown Artist',
            artwork: t.album?.images?.[0]?.url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=100&auto=format&fit=crop'
        }));

        res.json({ tracks: cleanTracks });
    } catch (err) {
        res.status(500).json({ error: "Search logic crashed" });
    }
});

// 📥 ENDPOINT 4: TRANSMIT REQUEST TO QUEUE
app.post('/api/request', (req, { json }) => {
    if (!requestsAllowed) return json({ success: false, error: "Submissions closed by DJ" });
    const { track } = req.body;
    if (!track) return json({ success: false, error: "No track specified" });

    console.log(`[QUEUE] Song requested: ${track.name} by ${track.artist} (ID: ${track.id})`);
    json({ success: true });
});

// Auth Passthrough routes for setup
app.get('/api/login', (req, res) => {
    res.redirect(`https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=token&redirect_uri=${encodeURIComponent(req.protocol + '://' + req.get('host') + '/')}&scope=playlist-read-private%20playlist-read-collaborative`);
});

app.listen(PORT, () => console.log(`Server blasting off on port ${PORT}`));
