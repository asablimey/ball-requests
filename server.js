const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configuration
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve all general assets from the public folder automatically
app.use(express.static(path.join(__dirname, 'public')));

// Local state storage variables
let activeQueue = [];
let playedHistory = [];
let maxCredits = 3;
let countdownLength = 60;
let spotifyToken = "";

// Mock/Placeholder functions for structural safety
async function getSpotifyToken() {
    console.log("[SPOTIFY] Initializing authorization token generation sequence...");
    spotifyToken = "sample_token_data_stream";
    return spotifyToken;
}

// --- API ENDPOINTS ---

// Fetch current state data channel
app.get('/data', (req, res) => {
    res.json({
        queue: activeQueue,
        history: playedHistory,
        maxCredits: maxCredits,
        countdownLength: countdownLength
    });
});

// Search API processing node
app.get('/api/search', async (req, res) => {
    const query = req.query.q || "";
    console.log(`[SEARCH] Query received: "${query}"`);
    
    // Fallback static array matching the 5 tracks structure from your dashboard view
    const mockTracks = [
        { name: "Stay", artist: "Rihanna, Mikky Ekko", artwork: "https://via.placeholder.com/48", explicit: false },
        { name: "STAY HERE 4 LIFE (feat. Brent Faiyaz)", artist: "A$AP Rocky, Brent Faiyaz", artwork: "https://via.placeholder.com/48", explicit: true },
        { name: "Staying Still", artist: "Noah Kahan", artwork: "https://via.placeholder.com/48", explicit: false },
        { name: "STAY (with Justin Bieber)", artist: "The Kid LAROI, Justin Bieber", artwork: "https://via.placeholder.com/48", explicit: true },
        { name: "Stayin' Alive - From \"Saturday Night Fever\" Soundtrack", artist: "Bee Gees", artwork: "https://via.placeholder.com/48", explicit: false }
    ];

    res.json({ tracks: mockTracks });
});

// Request submission processing node
app.post('/api/request', (req, res) => {
    const { track } = req.body;
    if (!track) return res.status(400).json({ error: "Missing track context framework." });

    const newRequest = {
        id: 'track_' + Math.random().toString(36).substr(2, 9),
        title: track.name || track.title,
        artist: track.artist,
        artwork: track.artwork || "https://via.placeholder.com/48",
        explicit: track.explicit || false,
        ups: 0,
        downs: 0,
        upvoters: [],
        downvoters: []
    };

    activeQueue.push(newRequest);
    res.json({ success: true, track: newRequest });
});

// Vote balancing array parser
app.post('/api/vote', (req, res) => {
    const { id, type, voterId } = req.body;
    const track = activeQueue.find(s => s.id === id);
    
    if (!track) return res.status(404).json({ error: "Target track reference missing." });

    if (!track.upvoters) track.upvoters = [];
    if (!track.downvoters) track.downvoters = [];

    if (type === 'up') {
        if (track.upvoters.includes(voterId)) {
            track.upvoters = track.upvoters.filter(v => v !== voterId);
            track.ups--;
        } else {
            track.upvoters.push(voterId);
            track.ups++;
            if (track.downvoters.includes(voterId)) {
                track.downvoters = track.downvoters.filter(v => v !== voterId);
                track.downs--;
            }
        }
    } else if (type === 'down') {
        if (track.downvoters.includes(voterId)) {
            track.downvoters = track.downvoters.filter(v => v !== voterId);
            track.downs--;
        } else {
            track.downvoters.push(voterId);
            track.downs++;
            if (track.upvoters.includes(voterId)) {
                track.upvoters = track.upvoters.filter(v => v !== voterId);
                track.ups--;
            }
        }
    }

    res.json({ success: true });
});

// Dedicated DJ text messaging interface endpoint
app.post('/api/message', (req, res) => {
    const { message, voterId } = req.body;
    console.log(`[DJ MESSAGE] Incoming message from [${voterId}]: ${message}`);
    res.json({ success: true });
});

// Admin Queue Modification endpoint
app.post('/api/admin/action', (req, res) => {
    const { id, action } = req.body;
    const trackIndex = activeQueue.findIndex(s => s.id === id);

    if (trackIndex !== -1) {
        const track = activeQueue[trackIndex];
        
        if (action === 'boost') {
            const highestNet = activeQueue.reduce((max, t) => Math.max(max, (t.ups || 0) - (t.downs || 0)), 0);
            track.ups = highestNet + 1;
            track.downs = 0;
            track.downvoters = [];
            track.upvoters = Array(highestNet + 1).fill('forced-admin-boost');
        } else if (action === 'played') {
            const [removedTrack] = activeQueue.splice(trackIndex, 1);
            playedHistory.unshift({
                title: removedTrack.title,
                artist: removedTrack.artist,
                artwork: removedTrack.artwork,
                explicit: removedTrack.explicit
            });
        } else if (action === 'remove') {
            activeQueue.splice(trackIndex, 1);
        }
    }
    res.json({ success: true });
});

// --- ROUTING LOGIC BLOCK ---

// 1. Explicitly serve the admin file when its specific URL is called
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 2. Wildcard fallback: Redirect all unmapped regular paths to the guest home page
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SERVER EXECUTION LINK ---
app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    await getSpotifyToken();
});
