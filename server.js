app.get('/api/playlists/:id/tracks', async (req, res) => {
    const userToken = req.headers['user-token'];
    if (!userToken || userToken === "null" || userToken === "undefined") {
        return res.status(401).json({ error: "No user token provided." });
    }
    try {
        // 🛠️ FIXED: Switched to direct string addition so the actual playlist ID is injected properly
        const targetUrl = 'https://api.spotify.com/v1/search?q=$/?q=$$' + req.params.id + '/tracks?limit=50';
        
        console.log(`[DEBUG] Fetching tracks for playlist from: ${targetUrl}`);

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
                    artwork: t.album?.images && t.album.images.length > 0 ? t.album.images[0].url : 'https://picsum.photos/48'
                };
            });
        res.json(tracks);
    } catch (err) {
        console.error("Tracks fetch error:", err);
        res.status(500).json({ error: "Failed fetching tracks." });
    }
});
