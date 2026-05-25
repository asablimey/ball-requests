const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const mongoose = require('mongoose'); // Official Database Driver

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

// Connect directly to your MongoDB Atlas Cloud Cluster
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log("[DATABASE] MongoDB Atlas connected seamlessly."))
        .catch(err => console.error("[DATABASE] Connection error:", err.message));
} else {
    console.warn("[DATABASE] Missing MONGODB_URI environment variable. Running in local memory fallback mode.");
}

// Create a structural schema template for your historical data logs
const AnalyticsLogSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    eventType: String, // 'request', 'vote_up', 'vote_down', 'track_played'
    title: String,
    artist: String,
    explicit: Boolean,
    voterId: String
});
const AnalyticsLog = mongoose.model('AnalyticsLog', AnalyticsLogSchema);

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
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
        }
    } catch (err) {
        console.error("[SPOTIFY] Auth token failure:", err.message);
    }
}
setInterval(getSpotifyToken, 1000 * 60 * 50);

// Search query route handler
app.get('/api/search', async (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.json({ tracks: [] });

    const query = req.query.q;
    if (!query) return res.json({ tracks: [] });
    if (!spotifyAccessToken) await getSpotifyToken();

    try {
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`, {
            headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
        });
        const data = await response.json();
        const trackItems = data.tracks?.items || [];
        
        const tracks = trackItems.map(track => ({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            artwork: track.album?.images[0]?.url || 'https://picsum.photos/48',
            explicit: track.explicit || false,
            duration: formatDuration(track.duration_ms)
        }));
        
        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: "Search feature offline." });
    }
});

// Request handling system with integrated background database logger
app.post('/api/request', async (req, res) => {
    if (!systemConfigs.requestsAllowed) return res.status(403).json({ error: "Submissions closed." });
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Missing metadata." });

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

    // Quietly stream this metric to your MongoDB cluster
    try {
        await AnalyticsLog.create({
            eventType: 'request',
            title: track.name,
            artist: track.artist,
            explicit: track.explicit
        });
    } catch (e) { console.log("Analytics stream dropped."); }

    res.json({ success: true });
});

// Realtime interactive ballot router
app.post('/api/vote', async (req, res) => {
    const { id, type, voterId } = req.body;
    if (!voterId) return res.status(400).json({ error: "Missing credential token." });

    const track = activeQueue.find(t => t.id === id);
    if (!track) return res.status(404).json({ error: "Track missing." });

    if (!track.upvoters) track.upvoters = [];
    if (!track.downvoters) track.downvoters = [];

    const clearUp = () => { track.upvoters = track.upvoters.filter(v => v !== voterId); };
    const clearDown = () => { track.downvoters = track.downvoters.filter(v => v !== voterId); };

    let eventRecorded = '';
    if (type === 'up') {
        if (track.upvoters.includes(voterId)) {
            clearUp();
        } else {
            clearDown();
            track.upvoters.push(voterId);
            eventRecorded = 'vote_up';
        }
    } else if (type === 'down') {
        if (track.downvoters.includes(voterId)) {
            clearDown();
        } else {
            clearUp();
            track.downvoters.push(voterId);
            eventRecorded = 'vote_down';
        }
    }

    // Save interactive engagement spikes to MongoDB
    if (eventRecorded) {
        try {
            await AnalyticsLog.create({
                eventType: eventRecorded,
                title: track.title,
                artist: track.artist,
                voterId: voterId
            });
        } catch (e) {}
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
        queue: buildSortedQueue(),
        history: playedHistory
    });
});

// Gather state and calculate aggregated analytics on the fly
app.get('/api/admin/data', async (req, res) => {
    let rawLogs = [];
    try {
        rawLogs = await AnalyticsLog.find({}).lean();
    } catch(err) { console.log("Db read error."); }

    // Aggregate key parameters out of raw document metrics
    const totalRequestsCount = rawLogs.filter(l => l.eventType === 'request').length;
    const totalVotesCount = rawLogs.filter(l => l.eventType.startsWith('vote')).length;
    
    const explicitCount = rawLogs.filter(l => l.eventType === 'request' && l.explicit).length;
    const totalTrackRequests = rawLogs.filter(l => l.eventType === 'request').length;
    const explicitRatio = totalTrackRequests > 0 ? Math.round((explicitCount / totalTrackRequests) * 100) : 0;

    // Discover the crowd favorites
    const artistCounter = {};
    rawLogs.filter(l => l.eventType === 'request').forEach(l => {
        if(l.artist) artistCounter[l.artist] = (artistCounter[l.artist] || 0) + 1;
    });
    let topArtist = "None";
    let maxArtistCount = 0;
    Object.entries(artistCounter).forEach(([artist, count]) => {
        if(count > maxArtistCount) { maxArtistCount = count; topArtist = artist; }
    });
    if(maxArtistCount > 0) topArtist = `${topArtist} (${maxArtistCount} requests)`;

    res.json({
        maxCredits: systemConfigs.maxCredits,
        countdownLength: systemConfigs.countdownLength,
        requestsAllowed: systemConfigs.requestsAllowed,
        queue: buildSortedQueue(),
        history: playedHistory,
        analytics: {
            totalRequests: totalRequestsCount,
            totalVotes: totalVotesCount,
            explicitPercentage: explicitRatio,
            topArtistName: topArtist
        }
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

app.post('/api/admin/action', async (req, res) => {
    const { id, action } = req.body;
    
    if (action === 'clearQueue') { activeQueue = []; return res.json({ success: true }); }
    if (action === 'clearHistory') { playedHistory = []; return res.json({ success: true }); }
    
    // HARD RESET FLUSH BUTTON: Safely clear out MongoDB clusters
    if (action === 'wipeDatabaseAnalytics') {
        try {
            await AnalyticsLog.deleteMany({});
            console.log("[DATABASE] Hard wipe successfully processed.");
        } catch (e) {}
        return res.json({ success: true });
    }

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

            try {
                await AnalyticsLog.create({
                    eventType: 'track_played',
                    title: track.title,
                    artist: track.artist
                });
            } catch(e) {}
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
    console.log(`[SERVER] Multi-threaded processing listening on port ${PORT}`);
    await getSpotifyToken();
});
