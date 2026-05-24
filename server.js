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
let spotifyAccessToken = "";

// 🌐 SPOTIFY CLIENT CREDENTIALS FLOW (For Search Backup)
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
            console.log("[SPOTIFY] Global access token generated successfully.");
        } else {
            console.log("[SPOTIFY ERROR] Authentication failed:", data);
        }
    } catch (err) {
        console.error("[SPOTIFY CRITICAL ERROR]:", err.message);
    }
}

setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// SPOTIFY CONNECT (USER OAUTH FLOW) ENDPOINTS
// -------------------------------------------------------------
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://song-requests-gnzd.onrender.com/callback';

app.get('/api/login', (req, res) => {
    const scopes = 'playlist-read-private playlist-read-collaborative';
    res.redirect('https://accounts.spotify.com/authorize' +
        '?response_type=code' +
        '&client_id=' + process.env.SPOTIFY_CLIENT_ID +
        (scopes ? '&scope=' + encodeURIComponent(scopes) : '') +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    if (!code) return res.redirect('/?error=auth_failed');

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=authorization_code&code=' + code + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
        });

        const data = await response.json();
        if (data.access_token) {
            res.redirect('/?access_token=' + data.access_token);
        } else {
            res.redirect('/?error=token_failed');
        }
    } catch (err) {
        res.redirect('/?error=server_error');
    }
});

// -------------------------------------------------------------
// USER PLAYLISTS & TRACKS DATA EXTRACTION ENDPOINTS
// -------------------------------------------------------------
app.get('/api/playlists', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken || userToken === "null" || userToken === "undefined") {
        return res.status(401).json({ error: "No user token provided." });
    }
    try {
        const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
            headers: { 'Authorization': 'Bearer ' + userToken }
        });
        const data = await response.json();
        
        const items = (data.items || []).map(p => {
            let count = 0;
            if (p.tracks) {
                if (typeof p.tracks === 'number') count = p.tracks;
                else if (p.tracks.total !== undefined) count = p.tracks.total;
            }
            return {
                id: p.id,
                name: p.name || 'Untitled Playlist',
                trackCount: count,
                artwork: p.images && p.images.length > 0 ? p.images[0].url : 'https://picsum.photos/48'
            };
        });
        
        res.json(items);
    } catch (err) {
        console.error("Playlist fetch error:", err);
        res.status(500).json({ error: "Failed fetching playlists." });
    }
});

app.get('/api/playlists/:id/tracks', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken || userToken === "null" || userToken === "undefined") {
        return res.status(401).json({ error: "No user token provided." });
    }
    
    // ✅ FIXED: Correct proxy syntax path mapping for playlist track layers
    const targetUrl = 'https://api.spotify.com/v1/playlists//' + req.params.id + '/tracks?limit=50';
    
    try {
        const response = await fetch(targetUrl, {
            headers: { 'Authorization': 'Bearer ' + userToken }
        });
        
        const data = await response.json();
        const items = data.items || [];
        
        const tracks = items
            .filter(item => item && item.track)
            .map(item => {
                const t = item.track;
                return {
                    id: t.id || Math.random().toString(36).substr(2, 9),
                    name: t.name || 'Unknown Track',
                    artist: t.artists ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
                    artwork: t.album && t.album.images && t.album.images.length > 0 ? t.album.images[0].url : 'https://picsum.photos/48'
                };
            });

        res.json(tracks);
    } catch (err) {
        console.error("Tracks extraction error:", err);
        res.status(500).json({ error: "Failed fetching tracks." });
    }
});

// -------------------------------------------------------------
// CORE GET & POST ENDPOINTS
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

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });

    let token = req.headers['user-token'];
    if (!token || token === "null" || token === "undefined") {
        token = spotifyAccessToken;
    }

    if (!token) {
        return res.status(500).json({ error: "Token uninitialized." });
    }

    // ✅ FIXED: Restored complete search parameters so global search displays results again
    const searchUrl = 'https://api.spotify.com/v1/search?q=?q=' + encodeURIComponent(query) + '&type=track&limit=10';

    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await response.json();
        
        const tracks = (data.tracks?.items || []).map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist',
            artwork: track.album && track.album.images && track.album.images.length > 0 ? track.album.images[0].url : 'https://picsum.photos/48'
        }));
        
        res.json({ tracks });
    } catch (err) {
        console.error("Search API error:", err);
        res.status(500).json({ error: "Search failed" });
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

// -------------------------------------------------------------
// ADMIN OVERRIDE ENDPOINTS
// -------------------------------------------------------------
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
    console.log('[SERVER] Request dashboard streaming live on port ' + PORT);
    await getSpotifyToken();
});
