const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // Ensure 'node-fetch' is in your package.json dependencies
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = "ballDJ2026";

// Live System Data State
let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

// 🔑 Fetch access token using Spotify credentials from Render environment variables
async function getSpotifyToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log("[WARNING] Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Search features will be limited.");
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
            console.log("[SPOTIFY] Access token refreshed successfully.");
        } else {
            console.log("[SPOTIFY ERROR] Failed response payload:", data);
        }
    } catch (err) {
        console.error("[SPOTIFY FETCH SYSTEM ERROR]:", err.message);
    }
}

// Automatically refresh token every 50 minutes
setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// 🌐 PUBLIC CLIENT APIS (GUEST PAGE)
// -------------------------------------------------------------

// Guest Page Data Polling
app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// Spotify Search Proxy
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    if (!spotifyAccessToken) {
        return res.status(500).json({ error: "Spotify authentication in progress. Try again." });
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

// Student request submission endpoint
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.status(403).json({ error: "Submissions are currently closed." });
    }
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Invalid track context details." });

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
// 🔐 PROTECTED DJ ADMINISTRATIVE APIS (MATCHES BLUEPRINT)
// -------------------------------------------------------------

// Core Admin Dashboard Feed
app.get('/api/admin/data', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });

    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// Edit Parameters Handler
app.post('/api/admin/config', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });

    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;

    res.json({ success: true });
});

// Toggle Submissions State
app.post('/api/admin/toggle', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });

    const { allow } = req.body;
    if (typeof allow === 'boolean') {
        systemConfigs.requestsAllowed = allow;
    }
    res.json({ success: true });
});

// Row Status Manipulation & Master Clears Endpoint
app.post('/api/admin/action', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });

    const {
