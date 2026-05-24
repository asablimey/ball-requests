const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🔐 Secret admin validation token
const ADMIN_PASSWORD = "ballDJ2026";

// Live Session Data Storage
let systemConfigs = {
    maxCredits: 3,
    countdownLength: 60,
    requestsAllowed: true
};

let activeQueue = [];
let playedHistory = [];

// Helper mock tracks to populate UI if database is fresh
const loadMockDataIfEmpty = () => {
    if (activeQueue.length === 0 && playedHistory.length === 0) {
        activeQueue = [
            { id: '1', name: 'Stay', title: 'Stay', artist: 'The Kid LAROI & Justin Bieber', artwork: 'https://picsum.photos/48', albumArt: 'https://picsum.photos/48', votes: 5 },
            { id: '2', name: 'Blinding Lights', title: 'Blinding Lights', artist: 'The Weeknd', artwork: 'https://picsum.photos/48', albumArt: 'https://picsum.photos/48', votes: 2 }
        ];
    }
};
loadMockDataIfEmpty();

// -------------------------------------------------------------
// 🌐 PUBLIC CLIENT APIS
// -------------------------------------------------------------

// Main Data payload delivery for both client stream and admin updates
app.get('/api/queue', (req, res) => {
    res.json({
        configs: systemConfigs,
        queue: activeQueue.sort((a, b) => (b.votes || 0) - (a.votes || 0)),
        history: playedHistory
    });
});

// Student request submission endpoint
app.post('/api/request', (req, res) => {
    if (!systemConfigs.requestsAllowed) {
        return res.status(403).json({ error: "Submissions are currently closed by the DJ." });
    }
    const { track } = req.body;
    if (!track || !track.name) return res.status(400).json({ error: "Invalid track context element details." });

    const existingTrack = activeQueue.find(t => t.id === track.id);
    if (existingTrack) {
        existingTrack.votes = (existingTrack.votes || 1) + 1;
    } else {
        activeQueue.push({
            id: track.id || Date.now().toString(),
            name: track.name,
            title: track.name,
            artist: track.artist || 'Unknown Artist',
            artwork: track.artwork || track.albumArt || 'https://picsum.photos/48',
            albumArt: track.artwork || track.albumArt || 'https://picsum.photos/48',
            votes: 1
        });
    }
    res.json({ success: true });
});

// -------------------------------------------------------------
// 🔐 PROTECTED DJ ADMINISTRATIVE APIS
// -------------------------------------------------------------

// Global session configs editor handler
app.post('/api/admin/update-configs', (req, res) => {
    const { password, configs } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });
    
    if (configs) {
        systemConfigs.maxCredits = parseInt(configs.maxCredits) || systemConfigs.maxCredits;
        systemConfigs.countdownLength = parseInt(configs.countdownLength) || systemConfigs.countdownLength;
        if (typeof configs.requestsAllowed === 'boolean') {
            systemConfigs.requestsAllowed = configs.requestsAllowed;
        }
    }
    res.json({ success: true, configs: systemConfigs });
});

// Track layout status manipulation (Played Next / Dropped Out)
app.post('/api/admin/remove', (req, res) => {
    const { password, trackId, played } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized access." });

    const trackIndex = activeQueue.findIndex(t => t.id === trackId);
    if (trackIndex !== -1) {
        const [removedTrack] = activeQueue.splice(trackIndex, 1);
        if (played) {
            playedHistory.unshift(removedTrack);
        }
    }
    res.json({ success: true });
});

// Reordering priority action endpoint (Bump up to top stack manually)
app.post('/api/admin/action', (req, res) => {
    const authHeader = req.headers['authorization'];
    const { id, action } = req.body;

    if (authHeader !== ADMIN_PASSWORD) return res.status(401).json({ error
