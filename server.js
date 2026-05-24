const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // Double check "node-fetch": "^2.6.7" is in package.json
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Live System Configurations
let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

// Spotify API Access Token Handshake
async function getSpotifyToken() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log("[WARNING] Spotify API environmental variables are missing.");
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
            console.log("[SPOTIFY] Authentication successful.");
        } else {
            console.log("[SPOTIFY ERROR] Authentication rejected:", data);
        }
    } catch (err) {
        console.error("[SPOTIFY CRITICAL SYSTEM ERROR]:", err.message);
    }
}

// Refresh credentials token loop every 50 minutes
setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// 🌐 PUBLIC APIS (CLIENT / GUEST VISUAL SCREEN MAPS)
// -------------------------------------------------------------

// Live Client Synchronization Poll Link
app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// Spotify Catalogue Query Proxy Bridge
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    if (!spotifyAccessToken) {
        return res.status(500).json({ error: "Spotify credentials loading. Retrying..." });
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
        res.status(500).json({ error: "Search query error." });
    }
});

// Push Request Link
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.status(403).json({ error: "Song submissions are currently locked." });
    }
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Invalid song request context." });

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
// 🎛 OPEN ADMINISTRATIVE DATA ROUTERS (NO PASSCODES REQUIRED)
// -------------------------------------------------------------

// Open Admin Content Data Feed
app.get('/api/admin/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// Set Operating Variable Limits
app.post('/api/admin/config', (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    res.json({ success: true });
});

// Change Room Submissions Toggles
app.post('/api/admin/toggle', (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') {
        systemConfigs.requestsAllowed = allow;
    }
    res.json({ success: true });
});

// Modification Stack Actions & Master Deletions
app.post('/api/admin/action', (req, res) => {
    const { id, action } = req.body;

    // Direct Group Clearing Routines
    if (action === 'clearQueue') {
        activeQueue = [];
        return res.json({ success: true });
    }
    if (action === 'clearHistory') {
        playedHistory = [];
        return res.json({ success: true });
    }

    // Individual Item Evaluation Routing
    const trackIndex = activeQueue.findIndex(t => t.id === id);
    if (trackIndex !== -1) {
        if (action === 'top') {
            const track = activeQueue[trackIndex];
            const highestVotes = activeQueue.length > 0 ? Math.max(...activeQueue.map(t => t.votes || 0)) : 0;
            track.votes = highestVotes + 1;
        } 
        else if (action === 'played') {
            const [track] = activeQueue.splice(trackIndex, 1);
            playedHistory.unshift(track);
        } 
        else if (action === 'remove') {
            activeQueue.splice(trackIndex, 1);
        }
    }
    res.json({ success: true });
});

// Main Route Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// App Startup Instantiation Loop
app.listen(PORT, async () => {
    console.log(`[SERVER] System up on port ${PORT}`);
    await getSpotifyToken();
});
