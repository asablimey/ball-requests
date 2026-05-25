const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize tracking cookie sessions securely
app.use(session({
    secret: 'dj_station_master_key_2026',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // Valid for 1 day
}));

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
// SPOTIFY ENVIRONMENT SETTINGS
// -------------------------------------------------------------
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "YOUR_CLIENT_ID";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
const REDIRECT_URI = process.env.REDIRECT_URI || "https://song-requests-gnzd.onrender.com/api/auth/callback";

// -------------------------------------------------------------
// SPOTIFY AUTHORIZATION CODE LAYER (USER LOGIN & PLAYLISTS)
// -------------------------------------------------------------

// Redirect user straight to Spotify authorization engine portal
app.get('/api/auth/login', (req, res) => {
    const scopes = 'playlist-read-private playlist-read-collaborative';
    const spotifyAuthUrl = `https://accounts.spotify.com/authorize?` + 
        `response_type=code` +
        `&client_id=${SPOTIFY_CLIENT_ID}` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    res.redirect(spotifyAuthUrl);
});

// Authentication callback intercept engine processing tokens
app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code || null;
    if (!code) return res.redirect('/?error=auth_denied');

    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            body: new URLSearchParams({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
            }),
            headers: {
                'Authorization': `Basic ${authBuffer}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.ok) {
            const data = await response.json();
            // Bind token values exclusively inside user session cookie cache container
            req.session.userAccessToken = data.access_token;
            req.session.userRefreshToken = data.refresh_token;
            req.session.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
            
            res.redirect('/'); // Clear URL query params and bounce back to user home layout
        } else {
            res.redirect('/?error=token_exchange_failure');
        }
    } catch (err) {
        res.redirect('/?error=server_callback_exception');
    }
});

// Helper checking middleware verifying/refreshing session keys dynamically
async function ensureUserToken(req, res, next) {
    if (!req.session || !req.session.userAccessToken) {
        return res.status(401).json({ error: "User not connected to Spotify account." });
    }

    if (Date.now() < req.session.tokenExpiresAt) {
        return next();
    }

    // Refresh token routine
    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: req.session.userRefreshToken
            }),
            headers: {
                'Authorization': `Basic ${authBuffer}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.ok) {
            const data = await response.json();
            req.session.userAccessToken = data.access_token;
            req.session.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
            if (data.refresh_token) req.session.userRefreshToken = data.refresh_token;
            next();
        } else {
            res.status(401).json({ error: "Session token expired and refresh failed." });
        }
    } catch(e) {
        res.status(500).json({ error: "Token balancing failure handler fault." });
    }
}

// Check logged in user status
app.get('/api/user/me', (req, res) => {
    if (req.session && req.session.userAccessToken) {
        res.json({ authenticated: true });
    } else {
        res.json({ authenticated: false });
    }
});

// Pull all targeted playlists belonging to user profiles
app.get('/api/user/playlists', ensureUserToken, async (req, res) => {
    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists', {
            headers: { 'Authorization': `Bearer ${req.session.userAccessToken}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Failed listing playlists." });

        const data = await response.json();
        const simplifiedPlaylists = data.items.map(p => ({
            id: p.id,
            name: p.name,
            tracksCount: p.tracks.total
        }));
        res.json(simplifiedPlaylists);
    } catch (e) {
        res.status(500).json({ error: "Playlist indexing error." });
    }
});

// Extract nested inner-track arrays safely avoiding zero lengths tracks issues
app.get('/api/user/playlist-tracks', ensureUserToken, async (req, res) => {
    const playlistId = req.query.id;
    if (!playlistId) return res.status(400).json({ error: "Missing playlist identifier parameters." });

    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`, {
            headers: { 'Authorization': `Bearer ${req.session.userAccessToken}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Failed parsing playlist tracking components." });

        const data = await response.json();
        
        // Extract and map valid tracks, filtering out null entries or empty track objects
        const itemsList = data.items || [];
        const formattedTracks = itemsList
            .filter(item => item && item.track && item.track.id)
            .map(item => {
                const t = item.track;
                const minutes = Math.floor(t.duration_ms / 60000);
                const seconds = ((t.duration_ms % 60000) / 1000).toFixed(0);
                
                return {
                    id: t.id,
                    name: t.name,
                    artist: t.artists && t.artists.length ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
                    artwork: t.album && t.album.images && t.album.images[2] ? t.album.images[2].url : 'https://via.placeholder.com/50',
                    duration: `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`,
                    explicit: t.explicit || false
                };
            });

        res.json({ tracks: formattedTracks });
    } catch (e) {
        res.status(500).json({ error: "Playlist data aggregation framework exception." });
    }
});

// -------------------------------------------------------------
// PUBLIC COMMON SEARCH INFRASTRUCTURE (FALLBACK SYSTEM SEARCH)
// -------------------------------------------------------------
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    // Fall back cleanly to user tokens if available, otherwise reject unauthorized
    let token = req.session ? req.session.userAccessToken : null;
    
    if (!token) {
        return res.status(401).json({ error: "Connect your Spotify account at the bottom to perform searches." });
    }

    try {
        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) return res.status(response.status).json({ error: "Failed to fetch tracks from Spotify context engine." });

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
        res.status(500).json({ error: "Internal Context Search Error" });
    }
});

// -------------------------------------------------------------
// SYSTEM USER CORE REQUEST CONSOLE ACTIONS
// -------------------------------------------------------------
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

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed
    });
});

// -------------------------------------------------------------
// CONTROL LAYER (ADMIN CONTROL PIPELINE)
// -------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Incorrect password. Access denied." });
    }
});

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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server executing live on node port: ${PORT}`));
