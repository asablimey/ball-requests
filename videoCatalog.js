/* videoCatalog.js - the curated music-video catalog.
 *
 * One global Redis hash (CATALOG_KEY) holds every row, field = row id, value =
 * JSON. The server keeps a derived in-memory copy with lookup indexes (Spotify
 * ID, ISRC, normalised artist+title) so /api/music-video never hits Redis per
 * poll. Every write goes to Redis first, then drops the in-memory copy; the
 * next lookup reloads it with a single HGETALL. That is what makes an edit in
 * the master grid show up on the very next poll, even for the song playing now.
 *
 * Row shape:
 *   { id, song, artist, spotifyId, youtubeId, startMs, enabled, nsfw,
 *     isrc, notes, updatedAt }
 *   enabled = the sheet's "Video ON/OFF" column.
 *   nsfw    = the sheet's "NSFW YES/NO" column: 'yes' | 'no' | '' (not set).
 *             Family mode only plays rows marked 'no'; a blank is NOT treated as safe.
 *   startMs = how far into the YouTube video the song actually begins
 *             (what the player calls introOffsetMs).
 */
'use strict';

const CATALOG_KEY = 'video-catalog:rows';
const CACHE_TTL_MS = 120 * 1000;      // safety net only; writes invalidate immediately
const MAX_START_MS = 10 * 60 * 1000;  // an intro longer than 10 minutes is a typo
const MAX_ROWS = 20000;

// ---------- parsing / normalising -------------------------------------------

function parseYouTubeId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return '';
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    let m = s.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/i);
    if (m) return m[1];
    m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/i);
    if (m) return m[1];
    return null; // non-empty but not recognisable
}

function parseSpotifyId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return '';
    if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
    let m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/i);
    if (m) return m[1];
    m = s.match(/^spotify:track:([A-Za-z0-9]{22})$/i);
    if (m) return m[1];
    return null;
}

function parseIsrc(input) {
    const s = String(input == null ? '' : input).trim().toUpperCase().replace(/[\s-]/g, '');
    if (!s) return '';
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : null;
}

// Accepts a number of ms, or text: "12", "12.5", "0:12", "1:02.5", "1:02:03".
function parseStartMs(input) {
    if (input === null || input === undefined || input === '') return 0;
    if (typeof input === 'number') {
        return Number.isFinite(input) && input >= 0 && input <= MAX_START_MS ? Math.round(input) : null;
    }
    const s = String(input).trim();
    if (!s) return 0;
    if (!/^\d+(\.\d+)?(:\d+(\.\d+)?){0,2}$/.test(s)) return null;
    const parts = s.split(':').map(Number);
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    const ms = Math.round(seconds * 1000);
    return ms >= 0 && ms <= MAX_START_MS ? ms : null;
}

// "Video ON/OFF" column. Returns true/false, `fallback` for blank, null if unrecognised.
function parseOnOff(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined) return fallback;
    const s = String(input).trim().toLowerCase();
    if (s === '') return fallback;
    if (['on', 'true', 'yes', 'y', '1', 'x', '✓'].includes(s)) return true;
    if (['off', 'false', 'no', 'n', '0'].includes(s)) return false;
    return null;
}

// "NSFW YES/NO" column. Returns 'yes' | 'no' | '' (blank), or null if unrecognised.
function parseNsfw(input) {
    if (typeof input === 'boolean') return input ? 'yes' : 'no';
    const s = String(input == null ? '' : input).trim().toLowerCase();
    if (s === '') return '';
    if (['yes', 'y', 'true', '1', 'nsfw'].includes(s)) return 'yes';
    if (['no', 'n', 'false', '0', 'safe'].includes(s)) return 'no';
    return null;
}

function parseBool(input, fallback) {
    if (typeof input === 'boolean') return input;
    if (input === null || input === undefined || input === '') return fallback;
    const s = String(input).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'x', '✓'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(s)) return false;
    return fallback;
}

function stripDiacritics(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Primary artist + core title, lower-cased, no punctuation. Spotify decorates
// titles ("- Remastered 2011", "(feat. X)") and joins artists with ", ".
function titleKey(artist, song) {
    const primaryArtist = String(artist || '').split(/,|;|&|\bfeat\.?\b|\bft\.?\b|\bx\b/i)[0];
    const coreSong = String(song || '').split(/[(\[]/)[0].split(/\s-\s/)[0];
    const clean = (v) => stripDiacritics(v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const a = clean(primaryArtist), t = clean(coreSong);
    return a && t ? `${a}|${t}` : '';
}

function clampStr(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

// Validates one incoming row against an optional existing row. Returns
// { row, errors } - errors is { field: message } and means "do not save".
function normalizeInput(input, existing) {
    const src = input || {};
    const errors = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const base = existing || { enabled: true, nsfw: '', startMs: 0 };
    const row = {
        id: existing ? existing.id : undefined,
        song: has('song') ? clampStr(src.song, 200) : (base.song || ''),
        artist: has('artist') ? clampStr(src.artist, 200) : (base.artist || ''),
        spotifyId: base.spotifyId || '',
        youtubeId: base.youtubeId || '',
        startMs: base.startMs || 0,
        enabled: base.enabled !== false,
        nsfw: base.nsfw === 'yes' || base.nsfw === 'no' ? base.nsfw : '',
        isrc: base.isrc || '',
        notes: has('notes') ? clampStr(src.notes, 500) : (base.notes || '')
    };
    if (has('spotifyId')) {
        const v = parseSpotifyId(src.spotifyId);
        if (v === null) errors.spotifyId = 'Not a Spotify track link or 22-character ID.';
        else row.spotifyId = v;
    }
    if (has('youtubeId')) {
        const v = parseYouTubeId(src.youtubeId);
        if (v === null) errors.youtubeId = 'Not a YouTube link or 11-character video ID.';
        else row.youtubeId = v;
    }
    if (has('startMs')) {
        const v = parseStartMs(src.startMs);
        if (v === null) errors.startMs = 'Use seconds (12.5) or m:ss (1:02.5), 0 to 10:00.';
        else row.startMs = v;
    }
    if (has('isrc')) {
        const v = parseIsrc(src.isrc);
        if (v === null) errors.isrc = 'ISRC is 12 characters, e.g. USRC17607839.';
        else row.isrc = v;
    }
    if (has('enabled')) {
        const v = parseOnOff(src.enabled, true);
        if (v === null) errors.enabled = 'Use ON or OFF.';
        else row.enabled = v;
    }
    if (has('nsfw')) {
        const v = parseNsfw(src.nsfw);
        if (v === null) errors.nsfw = 'Use YES or NO (or leave blank).';
        else row.nsfw = v;
    }
    return { row, errors };
}

// ---------- factory ---------------------------------------------------------

module.exports = function createVideoCatalog({ redis }) {
    let state = null;          // { loadedAt, rows: Map, bySpotify, byIsrc, byTitle }
    let loading = null;

    function build(rowsObj) {
        const rows = new Map();
        const bySpotify = new Map(), byIsrc = new Map(), byTitle = new Map();
        const push = (map, key, row) => {
            if (!key) return;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(row);
        };
        for (const row of Object.values(rowsObj)) {
            rows.set(row.id, row);
            push(bySpotify, row.spotifyId, row);
            push(byIsrc, row.isrc, row);
            push(byTitle, titleKey(row.artist, row.song), row);
        }
        return { loadedAt: Date.now(), rows, bySpotify, byIsrc, byTitle };
    }

    async function fetchAll() {
        const flat = await redis(['HGETALL', CATALOG_KEY]);
        const out = {};
        if (Array.isArray(flat)) {
            for (let i = 0; i + 1 < flat.length; i += 2) {
                try {
                    const row = JSON.parse(flat[i + 1]);
                    if (row && row.id) out[row.id] = row;
                } catch (e) { /* skip a corrupt row rather than lose the catalog */ }
            }
        } else if (flat && typeof flat === 'object') {
            for (const [id, v] of Object.entries(flat)) {
                try { const row = JSON.parse(v); if (row && row.id) out[id] = row; } catch (e) { /* skip */ }
            }
        }
        return out;
    }

    // Reloads when invalidated or stale. If Redis is unreachable, keeps serving
    // the last good copy instead of failing the live display.
    async function ensureLoaded() {
        if (state && Date.now() - state.loadedAt < CACHE_TTL_MS) return state;
        if (!loading) {
            loading = fetchAll()
                .then((obj) => { state = build(obj); return state; })
                .catch((err) => {
                    console.error('[CATALOG] Reload from Redis failed:', err.message);
                    if (state) { state.loadedAt = Date.now() - CACHE_TTL_MS + 15000; return state; } // retry in ~15s
                    throw err;
                })
                .finally(() => { loading = null; });
        }
        return loading;
    }

    function invalidate() { state = null; }

    function newId() {
        return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function pickBest(list) {
        // Prefer a row that is enabled and has a video, then the newest edit.
        return [...list].sort((a, b) => {
            const sa = (a.enabled && a.youtubeId) ? 1 : 0, sb = (b.enabled && b.youtubeId) ? 1 : 0;
            if (sa !== sb) return sb - sa;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        })[0];
    }

    // np: { trackId, isrc, title, artist }. The first tier (Spotify ID, then
    // ISRC, then artist+title) that finds ANY row decides the outcome, so a row
    // a human disabled by Spotify ID is not overridden by a looser match.
    async function lookup(np) {
        const st = await ensureLoaded();
        const tiers = [
            ['spotify', st.bySpotify.get(np && np.trackId)],
            ['isrc', st.byIsrc.get(parseIsrc(np && np.isrc) || '')],
            ['title', st.byTitle.get(titleKey(np && np.artist, np && np.title))]
        ];
        for (const [via, list] of tiers) {
            if (!list || !list.length) continue;
            const row = pickBest(list);
            if (!row.enabled) return { status: 'disabled', via, row };
            if (!row.youtubeId) return { status: 'no_video', via, row };
            return { status: 'hit', via, row };
        }
        return { status: 'miss', rowCount: st.rows.size };
    }

    async function list() {
        const st = await ensureLoaded();
        return [...st.rows.values()].sort((a, b) =>
            (a.artist || '').localeCompare(b.artist || '') || (a.song || '').localeCompare(b.song || ''));
    }

    async function stats() {
        const st = await ensureLoaded();
        let withVideo = 0;
        for (const r of st.rows.values()) if (r.youtubeId && r.enabled) withVideo++;
        return { rows: st.rows.size, playable: withVideo };
    }

    function warningsFor(st, row) {
        const warnings = [];
        if (row.spotifyId) {
            const dupes = (st.bySpotify.get(row.spotifyId) || []).filter(r => r.id !== row.id);
            if (dupes.length) warnings.push({ field: 'spotifyId', message: `Another row already uses this Spotify ID (${dupes[0].artist || '?'} - ${dupes[0].song || '?'}).` });
        }
        if (!row.spotifyId && !row.isrc && !(row.song && row.artist)) {
            warnings.push({ field: 'song', message: 'Needs a Spotify ID, an ISRC, or both Song and Artist before it can match anything.' });
        }
        return warnings;
    }

    // Creates or updates one row. `input.id` updates that row (or recreates it
    // for undo when `input.restore` is set). With no id, a row with the same
    // Spotify ID is updated instead of duplicated.
    async function upsert(input) {
        const st = await ensureLoaded();
        let existing = input && input.id ? st.rows.get(input.id) : null;
        if (!existing && input && !input.id && input.spotifyId) {
            const sid = parseSpotifyId(input.spotifyId);
            if (sid) existing = pickBest(st.bySpotify.get(sid) || []) || null;
        }
        if (!existing && st.rows.size >= MAX_ROWS) return { errors: { _row: `Catalog is full (${MAX_ROWS} rows).` } };
        const { row, errors } = normalizeInput(input, existing);
        if (Object.keys(errors).length) return { errors };
        row.id = existing ? existing.id : (input && input.id && /^[A-Za-z0-9_-]{4,40}$/.test(input.id) ? input.id : newId());
        row.updatedAt = Date.now();
        await redis(['HSET', CATALOG_KEY, row.id, JSON.stringify(row)]);
        invalidate();
        const fresh = await ensureLoaded().catch(() => st);
        return { row, warnings: warningsFor(fresh, row), created: !existing };
    }

    // Bulk upsert (paste / CSV). One HSET for the whole batch. Rows that fail
    // validation are reported by index and skipped; the rest are saved.
    async function upsertMany(inputs) {
        const st = await ensureLoaded();
        const results = [];
        const pairs = [];
        const seenSpotify = new Map(); // spotifyId -> id, to merge duplicates inside one batch
        let capacityLeft = MAX_ROWS - st.rows.size;
        inputs.forEach((input, index) => {
            let existing = input && input.id ? st.rows.get(input.id) : null;
            if (!existing && input && input.spotifyId) {
                const sid = parseSpotifyId(input.spotifyId);
                if (sid) {
                    if (seenSpotify.has(sid)) existing = { ...(pairs.find(p => p.row.id === seenSpotify.get(sid)) || {}).row };
                    if (!existing || !existing.id) existing = pickBest(st.bySpotify.get(sid) || []) || null;
                }
            }
            if (!existing && capacityLeft <= 0) { results.push({ index, errors: { _row: 'Catalog is full.' } }); return; }
            const { row, errors } = normalizeInput(input, existing);
            if (Object.keys(errors).length) { results.push({ index, errors }); return; }
            if (!existing) capacityLeft--;
            row.id = existing && existing.id ? existing.id : newId();
            row.updatedAt = Date.now();
            if (row.spotifyId) seenSpotify.set(row.spotifyId, row.id);
            const prior = pairs.findIndex(p => p.row.id === row.id);
            if (prior >= 0) pairs[prior] = { row }; else pairs.push({ row });
            results.push({ index, row, created: !existing });
        });
        if (pairs.length) {
            const cmd = ['HSET', CATALOG_KEY];
            for (const p of pairs) cmd.push(p.row.id, JSON.stringify(p.row));
            await redis(cmd);
            invalidate();
        }
        return { results, saved: pairs.length };
    }

    async function remove(id) {
        const n = await redis(['HDEL', CATALOG_KEY, String(id)]);
        invalidate();
        return { removed: Number(n) > 0 };
    }

    return { lookup, list, stats, upsert, upsertMany, remove, invalidate,
             parse: { parseYouTubeId, parseSpotifyId, parseIsrc, parseStartMs, titleKey } };
};
