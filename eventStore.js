const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Every event's state lives in one JSON file under here. Kept outside the
// app's own source tree conceptually (still inside the project for simplicity
// on a single-server deploy like Render), so it's easy to volume-mount later
// if you move to a host with persistent disks.
const DATA_DIR = process.env.EVENTS_DIR || path.join(__dirname, 'data', 'events');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // e.g. "prom-2026", 2-40 chars, lowercase/digits/hyphens

function isValidSlug(slug) {
    return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

function filePath(slug) {
    return path.join(DATA_DIR, `${slug}.json`);
}

function existsOnDisk(slug) {
    return fs.existsSync(filePath(slug));
}

// In-memory cache of loaded events: slug -> event object. This is the live
// working copy every route reads/mutates directly; writes to disk are just a
// backup so a restart doesn't lose everything.
const cache = new Map();

// Fresh state for a brand new event - mirrors what used to be hardcoded
// module-level globals in the single-tenant version of server.js.
function blankEventState(slug, eventName, adminPasswordHash) {
    return {
        slug,
        adminPasswordHash,
        createdAt: Date.now(),

        systemConfigs: {
            maxCredits: 3,
            countdownLength: 60,
            requestsAllowed: true,
            explicitBlockActive: false,
            radioEditsOnly: false,
            eventName: eventName || slug,
            queueCapEnabled: false,
            maxQueueLength: 50,
            genreFilter: [],
            decadeFilter: [],
            guestSpotifyConnectEnabled: false,
            spotifyAutoQueueEnabled: true,
            lastSwitchedPlaylist: ''
        },
        kioskConfigs: {
            requestsAllowed: true,
            spotifyConnectEnabled: false,
            maxCredits: 3,
            countdownLength: 60,
            displayOnlyMode: false
        },

        activeQueue: [],
        playedHistory: [],
        requestLog: [],
        queueHistoryLog: [],

        // Plain objects instead of Maps so this round-trips through
        // JSON.stringify/parse with no extra conversion step.
        voterCreditState: {},   // voterId -> { available, lastRefill }
        voterLastVoteAt: {},    // voterId -> timestamp
        voterLastRequestAt: {}, // voterId -> timestamp

        spotify: {
            djRefreshToken: null,
            djAccessToken: null,
            djAccessTokenExpiresAt: 0,
            pendingLoginState: null
        },

        lastSyncedNowPlayingId: null,
        cachedNowPlaying: {
            connected: false, isPlaying: false, trackId: null, title: null,
            artist: null, artwork: null, progressMs: 0, durationMs: 0,
            updatedAt: Date.now(), upcoming: []
        }
    };
}

function loadFromDisk(slug) {
    try {
        const raw = fs.readFileSync(filePath(slug), 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[EVENTS] Failed to load "${slug}":`, err.message);
        return null;
    }
}

// Debounced per-slug writes so a burst of votes/requests doesn't hit disk on
// every single mutation - callers just call scheduleSave(slug) after any
// change and this coalesces writes that land within the same window.
const pendingSaves = new Map(); // slug -> Timeout
const SAVE_DEBOUNCE_MS = 1500;

function writeToDiskNow(slug) {
    const event = cache.get(slug);
    if (!event) return;
    const tmpPath = filePath(slug) + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(event));
        fs.renameSync(tmpPath, filePath(slug)); // atomic on the same filesystem
    } catch (err) {
        console.error(`[EVENTS] Failed to save "${slug}":`, err.message);
    }
}

function scheduleSave(slug) {
    if (pendingSaves.has(slug)) return;
    const timeout = setTimeout(() => {
        pendingSaves.delete(slug);
        writeToDiskNow(slug);
    }, SAVE_DEBOUNCE_MS);
    pendingSaves.set(slug, timeout);
}

// Flushes every pending write immediately - used on shutdown so a debounce
// window in flight doesn't silently drop the last few minutes of a night.
function flushAllSaves() {
    for (const [slug, timeout] of pendingSaves.entries()) {
        clearTimeout(timeout);
        writeToDiskNow(slug);
    }
    pendingSaves.clear();
}

function getEvent(slug) {
    if (cache.has(slug)) return cache.get(slug);
    if (!existsOnDisk(slug)) return null;
    const loaded = loadFromDisk(slug);
    if (!loaded) return null;
    cache.set(slug, loaded);
    return loaded;
}

function createEvent(slug, eventName, adminPassword) {
    if (!isValidSlug(slug)) {
        return { error: 'Event URL can only use lowercase letters, numbers, and hyphens (2-40 characters).' };
    }
    if (existsOnDisk(slug) || cache.has(slug)) {
        return { error: 'That event URL is already taken.' };
    }
    if (!adminPassword || adminPassword.length < 4) {
        return { error: 'Admin password must be at least 4 characters.' };
    }
    const adminPasswordHash = hashPassword(adminPassword);
    const event = blankEventState(slug, eventName, adminPasswordHash);
    cache.set(slug, event);
    writeToDiskNow(slug); // write immediately on creation, don't wait for debounce
    return { event };
}

// Salted scrypt hash, stored as "salt:hash" hex - avoids pulling in bcrypt
// for what's a single low-stakes password per event.
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || typeof password !== 'string') return false;
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    // Constant-time compare to avoid leaking timing info about the hash.
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Only iterates events currently held in memory - used by the Spotify polling
// loop so it doesn't wake up every event ever created, just ones with recent
// activity in this server session.
function getLoadedEvents() {
    return [...cache.values()];
}

module.exports = {
    isValidSlug,
    getEvent,
    createEvent,
    scheduleSave,
    flushAllSaves,
    verifyPassword,
    getLoadedEvents
};
