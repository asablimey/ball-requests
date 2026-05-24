const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 SPOTIFY API CREDENTIALS
const SPOTIFY_CLIENT_ID = '406febd8d4e34c7b9e85849f380210ce'; 
const SPOTIFY_CLIENT_SECRET = '7527e2daea834658934e06a4cea1422a';

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
        } else {
            console.log('[SPOTIFY ERROR] Authentication failed.');
        }
    } catch (err) {
        console.error('[SPOTIFY ERROR] Connection failed:', err.message);
    }
}

// MIDDLEWARE: Identifies users or creates a credit bank profile if they are new
function trackUserCredits(req, res, next) {
    const userId = req.headers['user-token'] || 'default-guest';
    const now = Date.now();

    if (!userBanks[userId]) {
        userBanks[userId] = {
            credits: maxCredits,
            lastRegenTime: now
        };
    }

    const user = userBanks[userId];

    // Passively calculate structural credit regeneration over elapsed time
    if (user.credits < maxCredits) {
        const msPerCredit = countdownLength * 1000;
        const timePassed = now - user.lastRegenTime;
        const creditsToEarn = Math.floor(timePassed / msPerCredit);

        if (creditsToEarn > 0) {
            user.credits = Math.min(maxCredits, user.credits + creditsToEarn);
            user.lastRegenTime = user.lastRegenTime + (creditsToEarn * msPerCredit);
        }
    } else {
        user.lastRegenTime = now; // Constantly forward-align timer if already maxed out
    }

    req.userData = user;
    req.userId = userId;
    next();
}

// GUEST ENDPOINT: Live Spotify Search Connection
app.get('/api/search', async (req, res) => {
    const query = req.query.q ? req.query.q.trim() : '';
    if (!query || !spotifyAccessToken) return res.json([]);

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        if (response.status === 401) await refreshSpotifyToken();
        const data = await response.json();
        const tracks = data.tracks?.items.map(item => ({
            id: item.id,
            title: item.name,
            artist: item.artists.map(a => a.name).join(', '),
            artwork: item.album.images[2]?.url || item.album.images[0]?.url || 'https://picsum.photos/50/50'
        })) || [];
        res.json(tracks);
    } catch (error) {
        res.json([]);
    }
});

// GUEST ENDPOINT: Get system status along with the individual's credit balance
app.get('/api/status', trackUserCredits, (req, res) => {
    const nextRegenIn = req.userData.credits < maxCredits 
        ? Math.max(0, Math.ceil((countdownLength * 1000 - (Date.now() - req.userData.lastRegenTime)) / 1000))
        : 0;

    res.json({
        requestsAllowed,
        maxCredits,
        countdownLength,
        userCredits: req.userData.credits,
        nextRegenIn
    });
});

// GUEST ENDPOINT: Submit request (Deducting 1 credit)
app.post('/api/request', trackUserCredits, (req, res) => {
    if (!requestsAllowed) return res.status(403).json({ error: "Requests closed." });
    if (req.userData.credits < 1) return res.status(400).json({ error: "Out of credits!" });

    const { title, artist, artwork } = req.body;
    
    // Deduct credit points
    req.userData.credits -= 1;
    if (req.userData.credits === maxCredits - 1) {
        req.userData.lastRegenTime = Date.now(); // Start countdown sequence
    }

    const newRequest = { id: Date.now().toString(), title, artist, artwork };
    queue.push(newRequest);
    
    console.log(`[REQUESTED] "${title}" | Credits remaining for user: ${req.userData.credits}`);
    res.json({ success: true, userCredits: req.userData.credits });
});

// ADMIN PROTECTION MIDDLEWARE
const checkAuth = (req, res, next) => {
    if (req.headers.authorization === ADMIN_PASSWORD) return next();
    res.status(401).json({ error: "Unauthorized" });
};

// ADMIN ENDPOINT: Fetch complete dashboard data
app.get('/api/admin/data', checkAuth, (req, res) => {
    res.json({ queue, history, requestsAllowed, maxCredits, countdownLength });
});

// ADMIN ENDPOINT: Modify rule restrictions (Max bank limit & Countdown duration)
app.post('/api/admin/config', checkAuth, (req, res) => {
    if (req.body.maxCredits !== undefined) maxCredits = parseInt(req.body.maxCredits) || 1;
    if (req.body.countdownLength !== undefined) countdownLength = parseInt(req.body.countdownLength) || 10;
    
    // Flush active user bank timers to align immediately to new changes
    Object.keys(userBanks).forEach(id => {
        userBanks[id].credits = Math.min(maxCredits, userBanks[id].credits);
        userBanks[id].lastRegenTime = Date.now();
    });

    console.log(`[CONFIG UPDATE] Max Credits: ${maxCredits}, Cooldown Loop: ${countdownLength}s`);
    res.json({ success: true, maxCredits, countdownLength });
});

// ADMIN ENDPOINT: Toggle open status
app.post('/api/admin/toggle', checkAuth, (req, res) => {
    requestsAllowed = req.body.allow;
    res.json({ success: true, requestsAllowed });
});

// ADMIN ENDPOINT: Queue modifications
app.post('/api/admin/action', checkAuth, (req, res) => {
    const { id, action } = req.body;

    if (action === 'clearQueue') queue = [];
    else if (action === 'clearHistory') history = [];
    else {
        const songIndex = queue.findIndex(s => s.id === id);
        if (songIndex !== -1) {
            const song = queue[songIndex];
            if (action === 'played') {
                history.unshift(song);
                queue.splice(songIndex, 1);
            } else if (action === 'remove') {
                queue.splice(songIndex, 1);
            } else if (action === 'top') {
                queue.splice(songIndex, 1);
                queue.unshift(song);
            }
        }
    }
    res.json({ success: true, queue, history });
});

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await refreshSpotifyToken();
});