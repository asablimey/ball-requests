const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'dj_station_master_key_2026',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// -------------------------------------------------------------
// CREDENTIALS & SYSTEM CONFIGS
// -------------------------------------------------------------
let activeQueue = [];
let playedHistory = [];
let systemConfigs = { maxCredits: 3, countdownLength: 60, requestsAllowed: true };
const ADMIN_PASSWORD = "ballDJ2026";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "YOUR_CLIENT_ID";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "YOUR_CLIENT_SECRET";
const REDIRECT_URI = process.env.REDIRECT_URI || "https://song-requests-gnzd.onrender.com/api/auth/callback";

let anonymousAccessToken = null;
let anonymousTokenExpiresAt = 0;

// Helper to generate a background token for open searches
async function getAnonymousServerToken() {
    if (anonymousAccessToken && Date.now() < anonymousTokenExpiresAt) {
        return anonymousAccessToken;
    }
    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
            headers: {
                'Authorization': `Basic ${authBuffer}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        if (response.ok) {
            const data = await response.json();
            anonymousAccessToken = data.access_token;
            anonymousTokenExpiresAt = Date.now() + (data.expires_in * 1000);
            return anonymousAccessToken;
        }
    } catch (e) {
        console.error("Failed fetching background anonymous token:", e);
    }
    return null;
}

// -------------------------------------------------------------
// SPOTIFY USER AUTH FLOW
// -------------------------------------------------------------
app.get('/api/auth/login', (req, res) => {
    const scopes = 'playlist-read-private playlist-read-collaborative';
    const spotifyAuthUrl = `https://accounts.spotify.com/authorize?` + 
        `response_type=code` +
        `&client_id=${SPOTIFY_CLIENT_ID}` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    res.redirect(spotifyAuthUrl);
});

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
            req.session.userAccessToken = data.access_token;
            req.session.userRefreshToken = data.refresh_token;
            req.session.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
            res.redirect('/');
        } else {
            res.redirect('/?error=token_exchange_failure');
        }
    } catch (err) {
        res.redirect('/?error=server_callback_exception');
    }
});

async function ensureUserToken(req, res, next) {
    if (!req.session || !req.session.userAccessToken) {
        return res.status(401).json({ error: "User not connected to Spotify." });
    }
    if (Date.now() < req.session.tokenExpiresAt) {
        return next();
    }
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
            res.status(401).json({ error: "Session expired." });
        }
    } catch(e) {
        res.status(500).json({ error: "Token refresh failure." });
    }
}

app.get('/api/user/me', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.userAccessToken) });
});

app.get('/api/user/playlists', ensureUserToken, async (req, res) => {
    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists', {
            headers: { 'Authorization': `Bearer ${req.session.userAccessToken}` }
        });
        if (!response.ok) return res.status(response.status).json({ error: "Failed listing playlists." });
        const data = await response.json();
        res.json((data.items || []).map(p => ({ id: p.id, name: p.name, tracksCount: p.tracks.total })));
    } catch (e) {
        res.status(500).json({ error: "Playlist indexing error." });
    }
});

app.get('/api/user/playlist-tracks', ensureUserToken, async (req, res) => {
    const playlistId = req.query.id;
    if (!playlistId) return res.status(400).json({ error: "Missing playlist identifier." });
    try {
        const response = await fetch(`https://api.spotify.com/v1/playlists/$${playlistId}/tracks?limit=50`, {
            headers: { 'Authorization': `Bearer ${req.session.userAccessToken}` }
        });
        if (!response.ok) return res.status(response.status).json({ error: "Failed parsing playlist tracks." });
        const data = await response.json();
        const formattedTracks = (data.items || [])
            .filter(item => item && item.track && item.track.id)
            .map(item => {
                const t = item.track;
                const minutes = Math.floor(t.duration_ms / 60000);
                const seconds = ((t.duration_ms % 60000) / 1000).toFixed(0);
                return {
                    id: t.id,
                    name: t.name,
                    artist: t.artists?.length ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
                    artwork: t.album?.images?.[2]?.url || 'https://via.placeholder.com/50',
                    duration: `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`,
                    explicit: t.explicit || false
                };
            });
        res.json({ tracks: formattedTracks });
    } catch (e) {
        res.status(500).json({ error: "Playlist data collection error." });
    }
});

// -------------------------------------------------------------
// PUBLIC SEARCH
// -------------------------------------------------------------
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    let token = req.session ? req.session.userAccessToken : null;
    if (!token) token = await getAnonymousServerToken();
    if (!token) return res.status(500).json({ error: "Spotify connectivity offline." });

    try {
        const url = `https://api.spotify.com/v1/search?q=$${encodeURIComponent(query)}&type=track&limit=8`;
        const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) return res.status(response.status).json({ error: "Search request failed." });
        const data = await response.json();
        const formattedTracks = (data.tracks?.items || []).map(track => {
            const minutes = Math.floor(track.duration_ms / 60000);
            const seconds = ((track.duration_ms % 60000) / 1000).toFixed(0);
            return {
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                artwork: track.album.images[2]?.url || 'https://via.placeholder.com/50',
                duration: `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`,
                explicit: track.explicit
            };
        });
        res.json({ tracks: formattedTracks });
    } catch (err) {
        res.status(500).json({ error: "Search Error Exception" });
    }
});

// -------------------------------------------------------------
// CORE QUEUE ENGINE
// -------------------------------------------------------------
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track } = req.body;
    if (!track || !track.id) return res.status(400).json({ error: "Invalid track." });
    if (activeQueue.some(item => item.id === track.id)) return res.status(400).json({ error: "Already waiting!" });
    activeQueue.push({ id: track.id, title: track.name, artist: track.artist, artwork: track.artwork, votes: 1 });
    res.json({ success: true });
});

app.get('/data', (req, res) => {
    res.json({ maxCredits: systemConfigs.maxCredits, countdownLength: systemConfigs.countdownLength, requestsAllowed: systemConfigs.requestsAllowed });
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true });
    res.status(401).json({ error: "Incorrect password." });
});

function verifyAdminAuth(req, res, next) {
    if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
    res.status(403).json({ error: "Unauthorized." });
}

app.get('/api/admin/data', verifyAdminAuth, (req, res) => {
    res.json({ maxCredits: systemConfigs.maxCredits, countdownLength: systemConfigs.countdownLength, requestsAllowed: systemConfigs.requestsAllowed, queue: activeQueue.sort((a, b) => b.votes - a.votes), history: playedHistory });
});

app.post('/api/admin/config', verifyAdminAuth, (req, res) => {
    const { maxCredits, countdownLength } = req.body;
    if (maxCredits !== undefined) systemConfigs.maxCredits = parseInt(maxCredits);
    if (countdownLength !== undefined) systemConfigs.countdownLength = parseInt(countdownLength);
    res.json({ success: true });
});

app.post('/api/admin/toggle', verifyAdminAuth, (req, res) => {
    if (typeof req.body.allow === 'boolean') systemConfigs.requestsAllowed = req.body.allow;
    res.json({ success: true });
});

app.post('/api/admin/action', verifyAdminAuth, (req, res) => {
    const { id, action } = req.body;
    if (action === 'clearQueue') { activeQueue = []; return res.json({ success: true }); }
    if (action === 'clearHistory') { playedHistory = []; return res.json({ success: true }); }
    const index = activeQueue.findIndex(t => t.id === id);
    if (index !== -1) {
        if (action === 'top') activeQueue[index].votes = (activeQueue.length > 0 ? Math.max(...activeQueue.map(t => t.votes)) : 0) + 1;
        else if (action === 'played') playedHistory.unshift(activeQueue.splice(index, 1)[0]);
        else if (action === 'remove') activeQueue.splice(index, 1);
    }
    res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Live on port: ${PORT}`));
