const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true,
    explicitBlockActive: false,
    catalogueModeActive: false // <-- NEW: Config to track if searching global or catalogue
};

let activeQueue = [];
let playedHistory = [];
let spotifyAccessToken = "";
let djCatalogue = []; 

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

async function getSpotifyToken() {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error("[SPOTIFY] Missing credentials in environment.");
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
            console.log("[SPOTIFY] Master token refreshed.");
        }
    } catch (err) {
        console.error("[SPOTIFY] Auth error:", err.message);
    }
}
setInterval(getSpotifyToken, 1000 * 60 * 50);

// SMART SEARCH ROUTE - Searches Spotify OR Catalogue based on Admin setting
app.get('/api/search', async (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.json({ tracks: [] }); 
    }

    const query = req.query.q?.toLowerCase();
    if (!query) return res.json({ tracks: [] });

    // MODE A: Catalogue Search Only
    if (systemConfigs.catalogueModeActive) {
        let tracks = djCatalogue.filter(track => 
            track.name.toLowerCase().includes(query) || 
            track.artist.toLowerCase().includes(query)
        );
        
        if (systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }
        return res.json({ tracks });
    }

    // MODE B: Global Spotify Search (Default)
    if (!spotifyAccessToken) await getSpotifyToken();
    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=$?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        const data = await response.json();
        const trackItems = data.tracks?.items || [];
        
        let tracks = trackItems.map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: formatDuration(track.duration_ms)
        }));
        
        if (systemConfigs.explicitBlockActive) {
            tracks = tracks.filter(track => !track.explicit);
        }

        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search feature unavailable" });
    }
});

// REQUEST ROUTE
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Missing metadata." });

    if (systemConfigs.explicitBlockActive && track.explicit) {
        return res.status(403).json({ error: "Explicit content is currently restricted by the DJ." });
    }

    const existingTrack = activeQueue.find(t => t.id === track.id);
    if (existingTrack) {
        if (!existingTrack.upvoters.includes('system-generated')) {
            existingTrack.upvoters.push('system-generated');
        }
    } else {
        activeQueue.push({
            id: track.id || Date.now().toString(),
            title: track.name,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: track.duration || '--:--',
            upvoters: [],
            downvoters: []
        });
    }
    res.json({ success: true });
});

// VOTE ROUTE
app.post('/api/vote', (req, res) => {
    const { id, type, voterId } = req.body;
    if (!voterId) return res.status(400).json({ error: "Missing voter validation token." });

    const track = activeQueue.find(t => t.id === id);
    if (!track) return res.status(404).json({ error: "Track missing from live pool." });

    if (!track.upvoters) track.upvoters = [];
    if (!track.downvoters) track.downvoters = [];

    const clearUp = () => { track.upvoters = track.upvoters.filter(v => v !== voterId); };
    const clearDown = () => { track.downvoters = track.downvoters.filter(v => v !== voterId); };

    if (type === 'up') {
        if (track.upvoters.includes(voterId)) {
            clearUp();
        } else {
            clearDown();
            track.upvoters.push(voterId);
        }
    } else if (type === 'down') {
        if (track.downvoters.includes(voterId)) {
            clearDown();
        } else {
            clearUp();
            track.downvoters.push(voterId);
        }
    }

    res.json({ success: true });
});

function buildSortedQueue() {
    return activeQueue.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        artwork: t.artwork,
        explicit: t.explicit,
        duration: t.duration,
        ups: t.upvoters?.length || 0,
        downs: t.downvoters?.length || 0,
        upvoters: t.upvoters || [],
        downvoters: t.downvoters || []
    })).sort((a, b) => (b.ups - b.downs) - (a.ups - a.downs));
}

app.get('/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        catalogueModeActive: systemConfigs.catalogueModeActive, // <-- Pass state down
        queue: buildSortedQueue(),
        history: playedHistory
    });
});

app.get('/api/admin/data', (req, res) => {
    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        explicitBlockActive: systemConfigs.explicitBlockActive,
        catalogueModeActive: systemConfigs.catalogueModeActive,
        queue: buildSortedQueue(),
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

app.post('/api/admin/toggle-explicit', (req, res) => {
    const { blockExplicit } = req.body;
    if (typeof blockExplicit === 'boolean') systemConfigs.explicitBlockActive = blockExplicit;
    res.json({ success: true });
});

// NEW ADMIN TOGGLE: Switches between Spotify search and Catalogue search
app.post('/api/admin/toggle-catalogue-mode', (req, res) => {
    const { useCatalogueOnly } = req.body;
    if (typeof useCatalogueOnly === 'boolean') systemConfigs.catalogueModeActive = useCatalogueOnly;
    res.json({ success: true, catalogueModeActive: systemConfigs.catalogueModeActive });
});

// ADMIN CATALOGUE ADD TRACK
app.post('/api/admin/catalogue/add', (req, res) => {
    const { track } = req.body;
    if (!track || !track.id) return res.status(400).json({ error: "Invalid track data." });
    
    const exists = djCatalogue.some(t => t.id === track.id);
    if (!exists) {
        djCatalogue.push({
            id: track.id,
            name: track.name || track.title,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: track.duration || '--:--'
        });
    }
    res.json({ success: true });
});

// BULK SYNC ENDPOINT: Inbound pipeline processing local Serato Mac files
app.post('/api/admin/bulk-sync', async (req, res) => {
    const { tracks } = req.body;
    
    if (!tracks || !Array.isArray(tracks)) {
        return res.status(400).json({ error: "Invalid tracks payload structure." });
    }

    console.log(`Received ${tracks.length} tracks from local Serato folder. Syncing...`);
    let addedCount = 0;

    for (const track of tracks) {
        try {
            // Match structures by checking both Name and Artist inside your live system layout array
            const alreadyExists = djCatalogue.some(existingTrack => 
                existingTrack.name.toLowerCase() === track.title.toLowerCase() && 
                existingTrack.artist.toLowerCase() === track.artist.toLowerCase()
            );

            if (alreadyExists) continue;

            // Pack track definitions to directly correlate with your /api/search filter loop outputs
            const trackData = {
                id: `serato_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                name: track.title,
                artist: track.artist,
                artwork: "https://picsum.photos/48", // Standard clean layout fallback thumbnail
                explicit: false,
                duration: track.duration ? `${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}` : "3:30"
            };

            djCatalogue.push(trackData);
            addedCount++;
        } catch (err) {
            console.error(`Skipped song sync processing line exception: ${track.title}`, err.message);
        }
    }

    res.json({ success: true, message: `Successfully loaded ${addedCount} brand new tracks straight into your DJ Catalogue loop.` });
});

app.post('/api/admin/action', (req, res) => {
    const { id, action } = req.body;
    if (action === 'clearQueue') { activeQueue = []; return res.json({ success: true }); }
    if (action === 'clearHistory') { playedHistory = []; return res.json({ success: true }); }

    const trackIndex = activeQueue.findIndex(t => t.id === id);
    if (trackIndex !== -1) {
        if (action === 'top') {
            const track = activeQueue[trackIndex];
            const sorted = buildSortedQueue();
            const highestNet = sorted.length > 0 ? (sorted[0].ups - sorted[0].downs) : 0;
            track.downvoters = [];
            track.upvoters = Array(highestNet + 1).fill('forced-admin-boost');
        } else if (action === 'played') {
            const [track] = activeQueue.splice(trackIndex, 1);
            playedHistory.unshift({
                title: track.title,
                artist: track.artist,
                artwork: track.artwork,
                explicit: track.explicit,
                duration: track.duration
            });
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
    console.log("[SERVER] Running on port " + PORT);
    await getSpotifyToken();
});
