const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// MEMORY STORAGE STATE
// -------------------------------------------------------------
let activeQueue = [];
let playedHistory = [];

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

const ADMIN_PASSWORD = "ballDJ2026";

// -------------------------------------------------------------
// SPOTIFY AUTHENTICATION VARIABLE STORAGE
// -------------------------------------------------------------
let spotifyAccessToken = "";
let tokenExpirationTime = 0;

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "YOUR_CLIENT_ID";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "YOUR_CLIENT_SECRET";

async function getSpotifyToken() {
    if (Date.now() < tokenExpirationTime && spotifyAccessToken) {
        return spotifyAccessToken;
    }

    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            body: 'grant_type=client_credentials',
            headers: {
                'Authorization': `Basic ${authBuffer}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (!response.ok) {
            console.error("Failed to fetch Spotify token status:", response.status);
            return null;
        }

        const data = await response.json();
        spotifyAccessToken = data.access_token;
        tokenExpirationTime = Date.now() + (data.expires_in * 1000) - 60000; 
        return spotifyAccessToken;
    } catch (err) {
        console.error("Error fetching access token from Spotify API:", err);
        return null;
    }
}

// -------------------------------------------------------------
// USER INTERFACE ENDPOINTS
// -------------------------------------------------------------

// Search Tracks Engine
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    const token = await getSpotifyToken();
    if (!token) return res.status(500).json({ error: "Spotify API token missing or invalid." });

    try {
        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Failed to fetch tracks from Spotify." });

        const data = await response.json();
        const formattedTracks = data.tracks.items.map(track => {
            const minutes = Math.floor(track.duration_ms / 60000);
            const seconds = ((track.duration_ms % 60000) / 1000).toFixed(0);
            
            return {
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                artwork: track.album.images[2]?.url || track.album.images[0]?.url || 'https://via.placeholder.com/50',
                duration: `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`,
                explicit: track.explicit
            };
        });

        res.json({ tracks: formattedTracks });
    } catch (err) {
        res.status(500).json({ error: "Internal Search Error" });
    }
});

// Post Request Track
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.status(403).json({ error: "Submissions are currently closed by the DJ." });
    }

    const { track } = req.body;
    if (!track || !track.id) return res.status(400).json({ error: "Invalid track choice data." });

    const isDuplicate = activeQueue.some(item => item.id === track.id);
    if (isDuplicate) {
        return res.status(400).json({ error: "This track is already waiting in the active queue!" });
    }

    const newQueueItem = {
        id: track.id,
        title: track.name,
        artist: track.artist,
        artwork: track.artwork,
        votes: 1
    };

    activeQueue.push(newQueueItem);
    res.json({ success: true });
});

// Long-polling Sync Target for User View
app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed
    });
});

// -------------------------------------------------------------
// CONTROL LAYER (ADMIN - SECURED BACKEND)
// -------------------------------------------------------------

// Secure validation route
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Incorrect password. Access denied." });
    }
});

// Middleware security helper
function verifyAdminAuth(req, res, next) {
    const authPassword = req.headers['x-admin-password'];
    if (authPassword === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(403).json({ error: "Unauthorized access." });
    }
}

app.get('/api/admin/data', verifyAdminAuth, (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

app.post('/api/admin/config', verifyAdminAuth, (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits) || systemConfigs.maxCredits;
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength) || systemConfigs.countdownLength;
    res.json({ success: true });
});

app.post('/api/admin/toggle', verifyAdminAuth, (req, res) => {
    const { allow } = req.body;
    if (typeof allow === 'boolean') systemConfigs.requestsAllowed = allow;
    res.json({ success: true });
});

app.post('/api/admin/action', verifyAdminAuth, (req, res) => {
    const { id, action } = req.body;
    
    if (action === 'clearQueue') { 
        activeQueue = []; 
        return res.json({ success: true }); 
    }
    if (action === 'clearHistory') { 
        playedHistory = []; 
        return res.json({ success: true }); 
    }

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

// Fallback routing handlers to index template page
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server executing live on node port: ${PORT}`));
