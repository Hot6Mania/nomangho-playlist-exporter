// Shared storage helpers for tracks, room metadata, and settings

export const STORAGE_KEYS = {
    TRACKS: "tracks",
    SETTINGS: "settings",
    CURRENT_ROOM: "currentRoomId",
    AUTH_SESSION: "authSession",
    ROOM_META: "roomMetadata"
};

function normaliseTrackStore(raw) {
    if (Array.isArray(raw)) {
        return { legacy: raw.filter(Boolean) };
    }
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const store = {};
    for (const [roomId, list] of Object.entries(raw)) {
        if (!roomId) continue;
        store[roomId] = Array.isArray(list) ? list.filter(Boolean) : [];
    }
    return store;
}

async function readTrackStore() {
    const { [STORAGE_KEYS.TRACKS]: raw } = await chrome.storage.local.get(STORAGE_KEYS.TRACKS);
    return normaliseTrackStore(raw);
}

async function writeTrackStore(store) {
    await chrome.storage.local.set({ [STORAGE_KEYS.TRACKS]: store });
}

async function readRoomMetadata() {
    const { [STORAGE_KEYS.ROOM_META]: raw } = await chrome.storage.local.get(STORAGE_KEYS.ROOM_META);
    if (!raw || typeof raw !== "object") {
        return {};
    }
    return { ...raw };
}

async function writeRoomMetadata(meta) {
    await chrome.storage.local.set({ [STORAGE_KEYS.ROOM_META]: meta });
}

function cloneTracks(tracks) {
    return tracks.map(t => ({ ...t }));
}

const duplicateKey = (track) => `${track.videoId || ""}|${(track.title || "").trim().toLowerCase()}`;

export async function getRooms() {
    const [store, meta] = await Promise.all([readTrackStore(), readRoomMetadata()]);
    const ids = new Set([...Object.keys(store), ...Object.keys(meta)]);
    const rooms = [...ids]
        .filter(id => id && id !== "global" && id !== "legacy")
        .map(id => ({
            id,
            name: meta[id]?.name || id,
            trackCount: (store[id] || []).length
        }));
    rooms.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return rooms;
}

export async function getRoomInfo(roomId) {
    if (!roomId) return null;
    const meta = await readRoomMetadata();
    return meta[roomId] || null;
}

export async function upsertRoom(roomId, info = {}) {
    if (!roomId) return;
    const meta = await readRoomMetadata();
    const current = meta[roomId] || {};
    const next = { ...current };
    if (info.name && typeof info.name === "string") {
        next.name = info.name.trim();
    }
    meta[roomId] = next;
    await writeRoomMetadata(meta);
}

export async function getTracks(roomId) {
    if (!roomId) return [];
    const store = await readTrackStore();
    const list = store[roomId] || [];
    return cloneTracks(list);
}

export async function setTracks(roomId, tracks) {
    if (!roomId) return;
    const store = await readTrackStore();
    store[roomId] = Array.isArray(tracks) ? cloneTracks(tracks) : [];
    await writeTrackStore(store);
}

export async function addTrack(roomId, track, roomName) {
    if (!roomId) return { added: false, tracks: [] };
    const store = await readTrackStore();
    const tracks = store[roomId] ? [...store[roomId]] : [];
    const normaliseVideoId = (value) => String(value || "").trim().toLowerCase();
    const newVideoId = normaliseVideoId(track.videoId);

    let merged = false;
    if (newVideoId) {
        for (let i = 0; i < tracks.length; i++) {
            const existing = tracks[i];
            if (!existing) continue;
            const existingVideoId = normaliseVideoId(existing.videoId);
            if (!existingVideoId || existingVideoId !== newVideoId) continue;
            const updated = { ...existing };
            let changed = false;
            const applyField = (field) => {
                const rawIncoming = track[field];
                const incoming = typeof rawIncoming === "string" ? rawIncoming.trim() : rawIncoming;
                const current = typeof updated[field] === "string" ? updated[field].trim() : updated[field];
                if (!incoming) return;
                if (!current) {
                    updated[field] = incoming;
                    changed = true;
                }
            };
            applyField("title");
            applyField("channel");
            applyField("watchUrl");
            if (!updated.videoId && track.videoId) {
                updated.videoId = String(track.videoId).trim();
                changed = true;
            }
            if (track.ts && (!updated.ts || track.ts > updated.ts)) {
                updated.ts = track.ts;
                changed = true;
            }
            if (changed) {
                tracks[i] = updated;
                merged = true;
            }
        }
        if (merged) {
            store[roomId] = tracks;
            await writeTrackStore(store);
        }
    }
    const key = duplicateKey(track);
    const lastTrack = tracks[tracks.length - 1];
    const lastVideoId = normaliseVideoId(lastTrack?.videoId);
    const sameVideoId = Boolean(lastTrack && newVideoId && lastVideoId && newVideoId === lastVideoId);
    const isSameAsLast = Boolean(lastTrack && (sameVideoId || (!newVideoId && !lastVideoId && duplicateKey(lastTrack) === key)));
    const existingKeys = new Set(tracks.map(duplicateKey));
    let added = false;
    if (!merged && !isSameAsLast && !existingKeys.has(key)) {
        tracks.push(track);
        store[roomId] = tracks;
        await writeTrackStore(store);
        added = true;
    }
    if (roomName) {
        await upsertRoom(roomId, { name: roomName });
    }
    return { added, tracks: cloneTracks(store[roomId] || []) };
}

export async function removeTrack(roomId, index) {
    if (!roomId) return [];
    const store = await readTrackStore();
    const tracks = store[roomId] ? [...store[roomId]] : [];
    if (index >= 0 && index < tracks.length) {
        tracks.splice(index, 1);
        store[roomId] = tracks;
        await writeTrackStore(store);
    }
    return cloneTracks(store[roomId] || []);
}

export async function clearTracks(roomId) {
    if (!roomId) return;
    const store = await readTrackStore();
    if (store[roomId]) {
        store[roomId] = [];
        await writeTrackStore(store);
    }
}

export async function getSettings() {
    const { [STORAGE_KEYS.SETTINGS]: settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return Object.assign({ defaultPlaylistName: "SyncTube Export", enableYouTubeApi: false }, settings || {});
}

export async function setSettings(partial) {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
}

export async function getCurrentRoomId() {
    const { [STORAGE_KEYS.CURRENT_ROOM]: roomId } = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_ROOM);
    return roomId || null;
}

export async function setCurrentRoomId(roomId) {
    if (roomId) {
        await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_ROOM]: roomId });
        return roomId;
    }
    await chrome.storage.local.remove(STORAGE_KEYS.CURRENT_ROOM);
    return null;
}

export async function getAuthSession() {
    const { [STORAGE_KEYS.AUTH_SESSION]: auth } = await chrome.storage.local.get(STORAGE_KEYS.AUTH_SESSION);
    return auth || null;
}

export async function setAuthSession(auth) {
    await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_SESSION]: auth || null });
}