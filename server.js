const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 SPOTIFY API CREDENTIALS (Pulled securely from Render environment variables)
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Global DJ Settings (Editable from Admin Panel)
let maxCredits = 3;             // Default max credits a user can hold
let countdownLength = 60;       // Default countdown time in seconds to earn 1 credit back
let requestsAllowed = true;

// Core Memory Arrays
let queue = [];
let history = [];
let userBanks = {};             // Keeps track of individual student credit accounts
let spotifyAccessToken = '';
const ADMIN_PASSWORD = "ballDJ2026";

// INTERNAL FUNCTION: Request fresh access token from Spotify API
async function refreshSpotifyToken() {
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
            },
            body: 'grant_type=client_credentials'
        });
        const data = await response.json();
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
            console.log('[SPOTIFY] Connected to live database successfully.');
        }
    } catch (err) {
        console.error('[SPOTIFY ERROR] Failed to fetch access token:', err);
    }
}

// 🔐 PASSWORD PROTECTED ADMIN ROUTE
app.get('/admin.html', (req, res) => {
    if (req.query.password === ADMIN_PASSWORD) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else {
        res.status(403).send('<h1>Access Denied</h1><p>You need the correct admin password appended to the URL to view this page.</p>');
    }
});

// --- API ENDPOINTS FOR THE APP ---

// Search Tracks via Spotify API
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    
    if (!spotifyAccessToken) await refreshSpotifyToken();

    try {
        // ✅ FIXED: Replaced the stray '2' with '$' so template literal works and guest search results populate!
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        
        if (response.status === 401) { // Token expired
            await refreshSpotifyToken();
            return res.redirect(req.originalUrl);
        }

        const data = await response.json();
        const tracks = data.tracks?.items.map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumArt: track.album.images[0]?.url || ''
        })) || [];
        
        res.json(tracks);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// Get Current Queue & Global Configs
app.get('/api/queue', (req, res) => {
    res.json({
        queue,
        history,
        configs: { maxCredits, countdownLength, requestsAllowed }
    });
});

// Track and Manage Credits per User IP
app.get('/api/user-status', (req, res) => {
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!userBanks[userIp]) {
        userBanks[userIp] = { credits: maxCredits, lastRegen: Date.now() };
    }
    
    let user = userBanks[userIp];
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - user.lastRegen) / 1000);
    
    if (user.credits < maxCredits && elapsedSeconds >= countdownLength) {
        const earned = Math.floor(elapsedSeconds / countdownLength);
        user.credits = Math.min(maxCredits, user.credits + earned);
        user.lastRegen = now;
    }
    
    let timeRemaining = 0;
    if (user.credits < maxCredits) {
        timeRemaining = countdownLength - (Math.floor((now - user.lastRegen) / 1000) % countdownLength);
    }
    
    res.json({ credits: user.credits, timeRemaining, maxCredits, countdownLength, requestsAllowed });
});

// Submit a Request
app.post('/api/request', (req, res) => {
    if (!requestsAllowed) return res.status(400).json({ error: 'Song requests are currently locked by the DJ.' });

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const { track } = req.body;
    
    if (!userBanks[userIp] || userBanks[userIp].credits <= 0) {
        return res.status(400).json({ error: 'Out of credits! Wait for the timer to reset.' });
    }
    
    const isDuplicate = queue.some(item => item.id === track.id);
    if (isDuplicate) return res.status(400).json({ error: 'This song is already in the queue!' });

    userBanks[userIp].credits -= 1;
    if (userBanks[userIp].credits === maxCredits - 1) {
        userBanks[userIp].lastRegen = Date.now();
    }
    
    // Map properties cleanly so names map across both frontend array variances
    queue.push({ 
        ...track, 
        name: track.name || track.title,
        title: track.title || track.name,
        artwork: track.artwork || track.albumArt,
        albumArt: track.albumArt || track.artwork,
        votes: 1, 
        id: track.id, 
        timestamp: Date.now() 
    });
    res.json({ success: true });
});

// Upvote an Existing Request
app.post('/api/upvote', (req, res) => {
    const { trackId } = req.body;
    const song = queue.find(item => item.id === trackId);
    if (song) {
        song.votes += 1;
        queue.sort((a, b) => b.votes - a.votes || a.timestamp - b.timestamp);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Song not found in active queue.' });
    }
});

// --- ADMIN SPECIFIC ENDPOINTS ---

app.post('/api/admin/update-configs', (req, res) => {
    const { password, configs } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    
    maxCredits = Number(configs.maxCredits);
    countdownLength = Number(configs.countdownLength);
    requestsAllowed = configs.requestsAllowed;
    res.json({ success: true });
});

app.post('/api/admin/remove', (req, res) => {
    const { password, trackId, played } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    
    const index = queue.findIndex(item => item.id === trackId);
    if (index !== -1) {
        const removedTrack = queue.splice(index, 1)[0];
        if (played) {
            history.unshift(removedTrack);
            if (history.length > 20) history.pop();
        }
    }
    res.json({ success: true });
});

app.post('/api/admin/clear-queue', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    queue = [];
    res.json({ success: true });
});

// Start the live server hook
app.listen(PORT, () => {
    console.log(`[SERVER] Request dashboard streaming live on port ${PORT}`);
    refreshSpotifyToken();
});
