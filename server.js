const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `https://song-requests-gnzd.onrender.com/api/callback`;

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true,
    minSongsBetweenRepeats: 5 // Default: must wait 5 tracks before repeating a song
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

async function getSpotifyToken() {
    if (!CLIENT_ID || !CLIENT_SECRET) return;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        const data = await response.json();
        if (data.access_token) spotifyAccessToken = data.access_token;
    } catch (err) {
        console.error("Token error:", err.message);
    }
}
setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// SPOTIFY OAUTH ENDPOINTS
// -------------------------------------------------------------
app.get('/api/login', (req, res) => {
    const scope = 'playlist-read-private playlist-read-collaborative';
    res.redirect('https://accounts.spotify.com/authorize?' +
        new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: scope,
            redirect_uri: REDIRECT_URI
        }).toString());
});

app.get('/api/callback', async (req, res) => {
    const code = req.query.code || null;
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                code: code,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization-code'
            }).toString()
        });
        const data = await response.json();
        
        if (data.access_token) {
            res.redirect(`/#access_token=${data.access_token}`);
        } else {
            res.redirect('/?error=auth_failed');
        }
    } catch (err) {
        res.redirect('/?error=server_error');
    }
});

// -------------------------------------------------------------
// CORE DATA & REQUEST ENDPOINTS
// -------------------------------------------------------------
app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        minSongsBetweenRepeats: systemConfigs.minSongsBetweenRepeats,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history
