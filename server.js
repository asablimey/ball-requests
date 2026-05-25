const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Global state variables
let activeQueue = [];
let playedHistory = [];
let djMessages = []; // Global array for live DJ messages

// --- Existing Spotify / Queue Endpoints (Placeholders for your existing logic) ---

async function getSpotifyToken() {
    // Your existing Spotify token retrieval logic runs here
    console.log('[SPOTIFY] Token fetched successfully.');
}

app.get('/api/search', async (req, res) => {
    // Your existing search logic
    res.json({ tracks: [] });
});

app.post('/api/request', (req, res) => {
    // Your existing song request logic
    res.json({ success: true });
});

// Your existing queue mutation logic (upvote, downvote, played, remove)
app.post('/api/queue/action', (req, res) => {
    const { trackIndex, action } = req.body;
    
    // Example mirroring your screenshot's logic:
    if (action === 'played') {
        const [track] = activeQueue.splice(trackIndex, 1);
        if (track) {
            playedHistory.unshift({
                title: track.title,
                artist: track.artist,
                artwork: track.artwork,
                explicit: track.explicit,
                duration: track.duration
            });
        }
    } else if (action === 'remove') {
        activeQueue.splice(trackIndex, 1);
    }
    
    res.json({ success: true });
});


// --- New Messaging & Updated Admin Endpoints ---

// Endpoint for guests to send a message to the DJ
app.post('/api/messages', (req, res) => {
    const { text } = req.body;
    if (!text || text.trim() === "") {
        return res.status(400).json({ success: false, error: "Message cannot be empty" });
    }

    const newMessage = {
        id: Date.now().toString(),
        text: text.trim(),
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    djMessages.push(newMessage);
    res.json({ success: true, message: "Message sent to DJ!" });
});

// Sync data endpoint for the Admin Dashboard
app.get('/api/admin/data', (req, res) => {
    res.json({
        activeQueue: activeQueue,
        playedHistory: playedHistory,
        messages: djMessages // Passes the live messages to the admin dashboard
    });
});

// Utility endpoint for DJ to clear the message board
app.post('/api/admin/messages/clear', (req, res) => {
    djMessages = [];
    res.json({ success: true });
});


// --- Catch-All Routing ---

// Fallback to serve index.html for any unmatched routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, async () => {
    console.log(`[SERVER] Running on port ${PORT}`);
    await getSpotifyToken();
});
