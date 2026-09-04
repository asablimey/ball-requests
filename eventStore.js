const crypto = require('crypto');
const fetch = require('node-fetch');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

// --- Upstash Redis (free tier) as the persistence layer -------------------
// Render's free plan spins the whole instance down after idle time and wipes
// its local disk on every redeploy, so anything written to `data/events` on
// disk was lost constantly. Upstash's free tier (10k commands/day, 256MB) is
// a hosted Redis reachable over plain HTTPS/REST - no TCP driver, no
// connection pool to reconnect after a cold start, just fetch() calls. Each
// event is stored as one JSON string under key `event:<slug>`, which mirrors
// the old "one JSON file per event" model almost exactly.
//
// Setup (one-time, both free):
//   1. Create a database at https://console.upstash.com (Redis, free tier)
//   2. Copy the "UPSTASH_REDIS_REST_URL" and "UPSTASH_REDIS_REST_TOKEN"
//   3. Add them as environment variables in Render's dashboard
// .trim() guards against leading/trailing whitespace; replacing any
// embedded whitespace/newline characters guards against a token that got
// split across lines by a dashboard's paste handling - either case produces
// the same "is not a legal HTTP header value" crash from node-fetch since
// HTTP header values can't contain raw whitespace/control characters.
function sanitizeEnvValue(v) {
    return (v || '').replace(/\s+/g, '').trim();
}
const UPSTASH_URL = sanitizeEnvValue(process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = sanitizeEnvValue(process.env.UPSTASH_REDIS_REST_TOKEN);

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[EVENTS] Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars.');
    console.error('[EVENTS] Events will not persist across restarts. See eventStore.js header for setup.');
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/; // e.g. "prom-2026", 2-40 chars, lowercase/digits/hyphens

function isValidSlug(slug) {
    return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

function eventKey(slug) {
    return `event:${slug}`;
}

// Upstash's REST API takes commands as a path-segment array, e.g.
// GET /GET/mykey  or  POST /SET  with body ["SET","mykey","value"].
// Using the pipeline-free single-command form here since event payloads can
// be large (SET body as JSON) and this keeps each call self-contained.
async function redis(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        throw new Error('Upstash not configured (missing/invalid env vars)');
    }
    const res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upstash error ${res.status}: ${text}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`Upstash error: ${data.error}`);
    return data.result;
}

async function redisGet(key) {
    return redis(['GET', key]);
}

async function redisSet(key, value) {
    return redis(['SET', key, value]);
}

async function redisDel(key) {
    return redis(['DEL', key]);
}

// SADD/SREM/SMEMBERS on a single "event-index" set let us list every slug
// without doing a KEYS scan (which Upstash discourages / rate-limits harder).
const INDEX_KEY = 'event-index';

async function redisIndexAdd(slug) {
    return redis(['SADD', INDEX_KEY, slug]);
}

async function redisIndexRemove(slug) {
    return redis(['SREM', INDEX_KEY, slug]);
}

async function redisIndexMembers() {
    const members = await redis(['SMEMBERS', INDEX_KEY]);
    return Array.isArray(members) ? members : [];
}

// Fresh state for a brand new event - mirrors what used to be hardcoded
// module-level globals in the single-tenant version of server.js.
function blankEventState(slug, eventName, adminPasswordHash, venue) {
    return {
        slug,
        adminPasswordHash,
        createdAt: Date.now(),

        // Optional venue pin, set at creation time from the map picker on
        // new-event.html. All three are null together when the organizer
        // skipped the location step - never partially set.
        venueLatitude: venue && typeof venue.latitude === 'number' ? venue.latitude : null,
        venueLongitude: venue && typeof venue.longitude === 'number' ? venue.longitude : null,
        venueName: venue && typeof venue.venueName === 'string' ? venue.venueName.trim().slice(0, 120) : null,

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
            updatedAt: Date.now(), upcoming: [],
            deviceName: null, volumePercent: null, shuffleState: false, repeatState: 'off'
        }
    };
}

// In-memory cache of loaded events: slug -> event object. This is the live
// working copy every route reads/mutates directly; writes to Redis are what
// make that copy durable across restarts/deploys/idle-sleeps.
const cache = new Map();

// slug -> true once we've confirmed (via Redis) that it exists, so repeated
// getEvent() calls for a live event don't need a network round-trip just to
// check existence - the cache being populated already implies existence.
async function existsRemotely(slug) {
    try {
        const raw = await redisGet(eventKey(slug));
        return raw != null;
    } catch (err) {
        console.error(`[EVENTS] existsRemotely("${slug}") failed:`, err.message);
        return false;
    }
}

async function loadFromRedis(slug) {
    try {
        const raw = await redisGet(eventKey(slug));
        if (raw == null) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[EVENTS] Failed to load "${slug}" from Redis:`, err.message);
        return null;
    }
}

// Debounced per-slug writes so a burst of votes/requests doesn't hit Redis on
// every single mutation - callers just call scheduleSave(slug) after any
// change and this coalesces writes that land within the same window. This
// also matters for staying comfortably inside Upstash's free daily command
// quota, since a naive "write on every mutation" approach burns through it
// fast on a busy event.
const pendingSaves = new Map(); // slug -> Timeout
const SAVE_DEBOUNCE_MS = 1500;

async function writeToRedisNow(slug) {
    const event = cache.get(slug);
    if (!event) return;
    try {
        await redisSet(eventKey(slug), JSON.stringify(event));
    } catch (err) {
        console.error(`[EVENTS] Failed to save "${slug}" to Redis:`, err.message);
    }
}

function scheduleSave(slug) {
    if (pendingSaves.has(slug)) return;
    const timeout = setTimeout(() => {
        pendingSaves.delete(slug);
        writeToRedisNow(slug).catch(err => console.error(`[EVENTS] Debounced save failed for "${slug}":`, err.message));
    }, SAVE_DEBOUNCE_MS);
    pendingSaves.set(slug, timeout);
}

// Flushes every pending write immediately - used on shutdown so a debounce
// window in flight doesn't silently drop the last few minutes of a night.
async function flushAllSaves() {
    const slugs = [];
    for (const [slug, timeout] of pendingSaves.entries()) {
        clearTimeout(timeout);
        slugs.push(slug);
    }
    pendingSaves.clear();
    await Promise.all(slugs.map(slug => writeToRedisNow(slug)));
}

// slug -> last time it was touched via getEvent. Used only to decide what's
// safe to drop from the in-memory cache below; has no effect on the data
// itself, which always lives in Redis regardless of cache state.
const lastAccess = new Map();

// NOTE: this becomes async (unlike the old disk version) since a cache miss
// now means a network call to Redis instead of a local fs read. Every
// call site in server.js already does `await events.getEvent(...)` or
// receives the resolved value via async route handlers, so this is safe.
async function getEvent(slug) {
    lastAccess.set(slug, Date.now());
    if (cache.has(slug)) return cache.get(slug);
    const loaded = await loadFromRedis(slug);
    if (!loaded) return null;
    cache.set(slug, loaded);
    return loaded;
}

// Without this, every event ever created stays in memory for the life of
// the process - anyone can create events with no auth (see POST /api/events),
// so unbounded cache growth is an easy, unauthenticated memory-exhaustion
// path. Evicting an idle event just means the next request for it pays one
// Redis read to reload it; nothing is lost since a save always happens
// before eviction is even considered.
const CACHE_IDLE_EVICT_MS = 1000 * 60 * 60 * 2; // 2 hours untouched
const CACHE_SWEEP_INTERVAL_MS = 1000 * 60 * 15;
function evictIdleEvents() {
    const now = Date.now();
    for (const slug of cache.keys()) {
        if (pendingSaves.has(slug)) continue; // never evict something with an unsaved write pending
        const touched = lastAccess.get(slug) || 0;
        if (now - touched > CACHE_IDLE_EVICT_MS) {
            cache.delete(slug);
            lastAccess.delete(slug);
        }
    }
}
setInterval(evictIdleEvents, CACHE_SWEEP_INTERVAL_MS);

async function createEvent(slug, eventName, adminPassword, venue) {
    if (!isValidSlug(slug)) {
        return { error: 'Event URL can only use lowercase letters, numbers, and hyphens (2-40 characters).' };
    }
    if (cache.has(slug) || await existsRemotely(slug)) {
        return { error: 'That event URL is already taken.' };
    }
    if (!adminPassword || adminPassword.length < 4) {
        return { error: 'Admin password must be at least 4 characters.' };
    }
    // Trim/cap here too, not just on later admin updates - this was previously
    // unbounded and unsanitized at creation time, letting an arbitrarily long
    // or markup-laden name get stored from the very first request.
    const safeEventName = typeof eventName === 'string' ? eventName.trim().slice(0, 60) : '';

    // Venue location is entirely optional (new-event.html only sends it if the
    // organizer actually dropped a pin). Validate shape here rather than trust
    // the client - malformed/partial values are just dropped, not errored,
    // since a bad location shouldn't block event creation.
    let safeVenue = null;
    if (venue && typeof venue.latitude === 'number' && typeof venue.longitude === 'number' &&
        isFinite(venue.latitude) && isFinite(venue.longitude) &&
        venue.latitude >= -90 && venue.latitude <= 90 && venue.longitude >= -180 && venue.longitude <= 180) {
        safeVenue = {
            latitude: venue.latitude,
            longitude: venue.longitude,
            venueName: typeof venue.venueName === 'string' ? venue.venueName.trim().slice(0, 120) : ''
        };
    }

    const adminPasswordHash = await hashPassword(adminPassword);
    // Re-check for a race: two creates for the same never-before-seen slug
    // could both pass the check above while their scrypt hash was pending.
    if (cache.has(slug) || await existsRemotely(slug)) {
        return { error: 'That event URL is already taken.' };
    }
    const event = blankEventState(slug, safeEventName, adminPasswordHash, safeVenue);
    cache.set(slug, event);
    lastAccess.set(slug, Date.now());
    await writeToRedisNow(slug); // write immediately on creation, don't wait for debounce
    await redisIndexAdd(slug);   // register in the slug index for listing/summaries
    return { event };
}

// Salted scrypt hash, stored as "salt:hash" hex - avoids pulling in bcrypt
// for what's a single low-stakes password per event.
//
// Uses the async scrypt (backed by libuv's threadpool) instead of scryptSync.
// scryptSync runs on the main thread and BLOCKS the entire Node event loop
// for the duration of the hash - since this used to run on every single
// admin-authenticated request, a burst of concurrent requests (wrong
// passwords or not) would serialize and stall every event on the server,
// not just the one being hit. The async version still costs real CPU, but
// it no longer blocks other requests from being handled while it runs.
async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 64)).toString('hex');
    return `${salt}:${hash}`;
}

async function verifyPassword(password, storedHash) {
    if (!storedHash || typeof password !== 'string') return false;
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const candidate = (await scryptAsync(password, salt, 64)).toString('hex');
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

// Lightweight summary of every event that exists - "active" here just means
// "exists" (there's no separate archive/expiry step yet, an event only goes
// away via deleteEvent). Used by the guest-facing Change Venue screen
// (Venue List + Map tabs), so this deliberately returns only what a guest is
// allowed to see - no adminPasswordHash, no Spotify tokens, no queue/request
// data. Reads the slug index then fetches each event fresh from Redis rather
// than routing through the in-memory cache, so listing every venue doesn't
// require every event to already be loaded.
async function getActiveEventsSummary() {
    let slugs;
    try {
        slugs = await redisIndexMembers();
    } catch (err) {
        console.error('[EVENTS] Failed to read event index:', err.message);
        return [];
    }
    const summaries = [];
    await Promise.all(slugs.map(async (slug) => {
        try {
            const raw = await redisGet(eventKey(slug));
            if (raw == null) return; // index entry pointing at a deleted event; skip
            const data = JSON.parse(raw);
            summaries.push({
                slug: data.slug || slug,
                eventName: (data.systemConfigs && data.systemConfigs.eventName) || data.slug || slug,
                venueName: data.venueName || null,
                latitude: typeof data.venueLatitude === 'number' ? data.venueLatitude : null,
                longitude: typeof data.venueLongitude === 'number' ? data.venueLongitude : null
            });
        } catch (err) {
            console.error(`[EVENTS] Skipping unreadable event "${slug}":`, err.message);
        }
    }));
    return summaries;
}

// Master-admin-only listing: same event set as getActiveEventsSummary above,
// but this one is never exposed to guests (see the /api/master/events route
// in server.js, gated on the master password only), so it's fine to include
// a bit more operational context - createdAt, whether requests are open -
// to help a DJ recognize which of several stale/forgotten events is which.
// Still never includes adminPasswordHash or Spotify tokens: the master
// password already grants full control over any single event via the
// existing per-slug admin routes, so there's no reason for this list itself
// to carry secrets over the wire too.
async function getAllEventsForMaster() {
    let slugs;
    try {
        slugs = await redisIndexMembers();
    } catch (err) {
        console.error('[EVENTS] Failed to read event index:', err.message);
        return [];
    }
    const summaries = [];
    await Promise.all(slugs.map(async (slug) => {
        try {
            const raw = await redisGet(eventKey(slug));
            if (raw == null) return; // index entry pointing at a deleted event; skip
            const data = JSON.parse(raw);
            summaries.push({
                slug: data.slug || slug,
                eventName: (data.systemConfigs && data.systemConfigs.eventName) || data.slug || slug,
                venueName: data.venueName || null,
                createdAt: typeof data.createdAt === 'number' ? data.createdAt : null,
                requestsAllowed: !!(data.systemConfigs && data.systemConfigs.requestsAllowed)
            });
        } catch (err) {
            console.error(`[EVENTS] Skipping unreadable event "${slug}" in master list:`, err.message);
        }
    }));
    summaries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // newest first
    return summaries;
}

// Permanently removes an event: cancels any pending debounced write (so it
// can't resurrect the entry a moment later), deletes it from Redis, removes
// it from the slug index, and drops it from the in-memory cache. The slug
// becomes available again immediately afterward.
async function deleteEvent(slug) {
    const pending = pendingSaves.get(slug);
    if (pending) {
        clearTimeout(pending);
        pendingSaves.delete(slug);
    }
    cache.delete(slug);
    lastAccess.delete(slug);
    try {
        await redisDel(eventKey(slug));
        await redisIndexRemove(slug);
    } catch (err) {
        console.error(`[EVENTS] Failed to delete "${slug}":`, err.message);
        throw err;
    }
}

module.exports = {
    isValidSlug,
    getEvent,
    createEvent,
    deleteEvent,
    scheduleSave,
    flushAllSaves,
    verifyPassword,
    getLoadedEvents,
    getActiveEventsSummary,
    getAllEventsForMaster
};
