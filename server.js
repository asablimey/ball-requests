const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// Background token generator - authenticates the app itself directly
async function getSpotifyToken() {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("[SPOTIFY] Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in environment variables.");
        return;
    }
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
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
            console.log("[SPOTIFY] Master API access token refreshed successfully.");
        } else {
            console.error("[SPOTIFY] Failed to fetch token:", data);
        }
    } catch (err) {
        console.error("[SPOTIFY] Auth error:", err.message);
    }
}
// Automatically refresh the master token every 50 minutes
setInterval(getSpotifyToken, 1000 * 60 * 50);

// -------------------------------------------------------------
// USER SEARCH API (Uses Master Token)
// -------------------------------------------------------------
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    
    if (!spotifyAccessToken) {
        await getSpotifyToken(); 
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
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: formatDuration(track.duration_ms)
        }));
        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search feature unavailable" });
    }
});

app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
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
            explicit: track.explicit || false,
            duration: track.duration || '--:--',
            votes: 1
        });
    }
    res.json({ success: true });
});

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// -------------------------------------------------------------
// CONTROL LAYER (ADMIN)
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
    console.log(`[SERVER] Running on port ${PORT}`);
    await getSpotifyToken();
});





<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Submit a Request</title>
    <style>
        :root {
            --spotify-green: #1DB954;
            --spotify-black: #121212;
            --panel-bg: #181818;
            --card-bg: #242424;
            --text-muted: #a7a7a7;
            --red-action: #e91429;
        }

        body {
            background-color: var(--spotify-black);
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            padding: 20px;
            margin: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .container { width: 100%; max-width: 480px; }
        
        h2 { 
            font-weight: 800; 
            letter-spacing: -0.5px; 
            margin-bottom: 15px; 
            border-left: 4px solid var(--spotify-green); 
            padding-left: 10px;
        }

        .status-card {
            background-color: var(--panel-bg);
            border: 1px solid #282828;
            border-top: 3px solid var(--spotify-green);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .status-info h3 { margin: 0; font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase; }
        .status-info p { margin: 4px 0 0 0; font-size: 1.4rem; font-weight: 800; color: var(--spotify-green); }

        .search-box {
            width: 100%;
            background-color: var(--panel-bg);
            border: 1px solid #282828;
            padding: 14px;
            color: white;
            border-radius: 8px;
            font-size: 1rem;
            box-sizing: border-box;
            outline: none;
            margin-bottom: 20px;
        }
        .search-box:focus { border-color: var(--spotify-green); }
        .search-box:disabled { background-color: #1a1a1a; color: #555; cursor: not-allowed; }

        .section-title {
            font-size: 1.2rem;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 15px;
        }

        .track-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: var(--panel-bg);
            margin-bottom: 8px;
            border-radius: 8px;
            border: 1px solid #222;
        }

        .track-details { display: flex; align-items: center; gap: 12px; }
        .track-details img { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; }
        .track-title { font-weight: 700; margin: 0; font-size: 1rem; }
        .track-artist { color: var(--text-muted); margin: 2px 0 0 0; font-size: 0.85rem; }

        .explicit-badge {
            background-color: var(--red-action);
            color: white;
            font-size: 0.65rem;
            font-weight: 900;
            padding: 2px 5px;
            border-radius: 3px;
            margin-left: 6px;
            display: inline-block;
            vertical-align: middle;
        }

        .action-container { display: flex; align-items: center; gap: 12px; }
        .duration-label { font-size: 0.85rem; color: var(--text-muted); font-weight: 600; font-variant-numeric: tabular-nums; }

        .req-btn {
            background-color: var(--spotify-green);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 700;
            cursor: pointer;
            font-size: 0.85rem;
        }
        .req-btn:disabled { background-color: #333; color: #666; cursor: not-allowed; }
        
        .placeholder-text { color: var(--text-muted); font-style: italic; font-size: 0.95rem; }
    </style>
</head>
<body>

    <div class="container">
        <h2>Request a Song</h2>
        
        <div class="status-card">
            <div class="status-info">
                <h3>Your Credits</h3>
                <p id="credits-display">3 / 3</p>
            </div>
            <div class="status-info" style="text-align: right;">
                <h3>Next Credit In</h3>
                <p id="timer-display">MAX</p>
            </div>
        </div>

        <input type="text" id="search-input" class="search-box" placeholder="Search tracks, artists..." oninput="searchSongs()">
        
        <h3 class="section-title">Search Results</h3>
        <div id="results-list">
            <p class="placeholder-text">Type in the box above to discover tracks.</p>
        </div>
    </div>

    <script>
        let maxCredits = 3;
        let localCredits = parseInt(localStorage.getItem('dj_user_credits'));
        let lastRegenTime = parseInt(localStorage.getItem('dj_last_regen'));
        let regenIntervalLength = 60; 
        let systemRequestsOpen = true;

        if (isNaN(localCredits) || isNaN(lastRegenTime) || localCredits === null || lastRegenTime === null) {
            localCredits = maxCredits;
            lastRegenTime = Date.now();
            localStorage.setItem('dj_user_credits', localCredits);
            localStorage.setItem('dj_last_regen', lastRegenTime);
        }

        function searchSongs() {
            const query = document.getElementById('search-input').value.trim();
            const container = document.getElementById('results-list');
            
            if (!query) { 
                container.innerHTML = `<p class="placeholder-text">Type in the box above to discover tracks.</p>`; 
                return; 
            }

            fetch(`/api/search?q=${encodeURIComponent(query)}`)
            .then(res => res.json())
            .then(data => {
                container.innerHTML = ''; 

                if(!data.tracks || data.tracks.length === 0) {
                    container.innerHTML = "<p class='placeholder-text'>No results matched your query.</p>";
                    return;
                }

                data.tracks.forEach(track => {
                    const row = document.createElement('div');
                    row.className = 'track-row';
                    row.innerHTML = `
                        <div class="track-details">
                            <img src="${track.artwork}">
                            <div>
                                <p class="track-title">
                                    ${escapeHtml(track.name)}
                                    ${track.explicit ? '<span class="explicit-badge">E</span>' : ''}
                                </p>
                                <p class="track-artist">${escapeHtml(track.artist)}</p>
                            </div>
                        </div>
                        <div class="action-container">
                            <span class="duration-label">${track.duration}</span>
                            <button class="req-btn" ${localCredits <= 0 || !systemRequestsOpen ? 'disabled' : ''}>Request</button>
                        </div>
                    `;
                    row.querySelector('.req-btn').addEventListener('click', () => submitRequest(track));
                    container.appendChild(row);
                });
            });
        }

        async function submitRequest(track) {
            if (localCredits <= 0 || !systemRequestsOpen) return;
            const res = await fetch('/api/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track })
            });

            if (res.ok) {
                localCredits--;
                if (localCredits === maxCredits - 1) {
                    lastRegenTime = Date.now();
                    localStorage.setItem('dj_last_regen', lastRegenTime);
                }
                localStorage.setItem('dj_user_credits', localCredits);
                alert(`"${track.name}" submitted successfully!`);
                document.getElementById('search-input').value = "";
                searchSongs();
            } else {
                const errData = await res.json();
                alert(errData.error || "Submission failed.");
            }
        }

        function escapeHtml(str) { return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
        
        async function syncWithServer() {
            try {
                const res = await fetch('/data');
                const data = await res.json();
                maxCredits = data.maxCredits;
                regenIntervalLength = data.countdownLength;
                systemRequestsOpen = data.requestsAllowed;
                if (localCredits > maxCredits) {
                    localCredits = maxCredits;
                    localStorage.setItem('dj_user_credits', localCredits);
                }
                document.getElementById('credits-display').innerText = `${localCredits} / ${maxCredits}`;
                updateUI();
            } catch (e) {}
        }

        function handleCreditCalculations() {
            if (localCredits >= maxCredits) {
                document.getElementById('timer-display').innerText = "MAX";
                return;
            }
            const elapsedSeconds = Math.floor((Date.now() - lastRegenTime) / 1000);
            if (elapsedSeconds >= regenIntervalLength) {
                const gained = Math.floor(elapsedSeconds / regenIntervalLength);
                localCredits = Math.min(maxCredits, localCredits + gained);
                lastRegenTime += gained * regenIntervalLength * 1000;
                localStorage.setItem('dj_user_credits', localCredits);
                localStorage.setItem('dj_last_regen', lastRegenTime);
            }
            const remaining = regenIntervalLength - (Math.floor((Date.now() - lastRegenTime) / 1000) % regenIntervalLength);
            document.getElementById('timer-display').innerText = `${Math.floor(remaining / 60)}:${(remaining % 60) < 10 ? '0' : ''}${remaining % 60}`;
        }

        function updateUI() {
            const inputs = document.getElementById('search-input');
            const btns = document.querySelectorAll('.req-btn');
            if (!systemRequestsOpen) {
                inputs.placeholder = "Submissions are currently CLOSED by the DJ";
                btns.forEach(b => b.disabled = true);
            } else if (localCredits <= 0) {
                btns.forEach(b => b.disabled = true);
            } else {
                inputs.placeholder = "Search tracks, artists...";
                btns.forEach(b => b.disabled = false);
            }
        }

        setInterval(handleCreditCalculations, 1000);
        setInterval(syncWithServer, 4000);
        syncWithServer();
    </script>
</body>
</html>


