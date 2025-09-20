// Background service worker (MV3)
// Handles room-scoped track storage, settings, playlist actions, and cross-frame link updates.

import {
    addTrack,
    getTracks,
    clearTracks,
    setSettings,
    getSettings,
    getRooms,
    removeTrack,
    getCurrentRoomId,
    setCurrentRoomId,
    upsertRoom,
    getRoomInfo
} from "./common/storage.js";
import { createPlaylist, addVideoToPlaylist } from "./common/youtube.js";

let activeRoomIdCache = null;
const ytLinkByTab = new Map();

chrome.tabs?.onRemoved?.addListener((tabId) => {
    ytLinkByTab.delete(tabId);
});

async function ensureActiveRoomId() {
    if (!activeRoomIdCache) {
        activeRoomIdCache = await getCurrentRoomId();
    }
    return activeRoomIdCache;
}

async function updateActiveRoom(roomId, roomName) {
    if (!roomId) return null;
    activeRoomIdCache = roomId;
    if (roomName) {
        await upsertRoom(roomId, { name: roomName });
    } else {
        await upsertRoom(roomId, {});
    }
    await setCurrentRoomId(roomId);
    return roomId;
}

function extractVideoId(value) {
    if (!value) return "";
    const match = String(value).match(
        /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/
    );
    if (match && match[1]) return match[1];
    return String(value).trim();
}

function toWatchUrl(videoId) {
    return videoId ? `"https://www.youtube.com/watch?v=${videoId}`" : null;
}

chrome.runtime.onInstalled.addListener(async () => {
    await setSettings({ defaultPlaylistName: "SyncTube Export", enableYouTubeApi: false });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg?.type === "YTLINK_FROM_IFRAME") {
                const tabId = sender?.tab?.id;
                if (typeof tabId === "number") {
                    const payload = {
                        href: msg.payload?.href || "",
                        id: msg.payload?.id || "",
                        reason: msg.payload?.reason || "iframe",
                        ts: Date.now()
                    };
                    ytLinkByTab.set(tabId, payload);
                    try {
                        chrome.tabs.sendMessage(tabId, { type: "YTLINK_UPDATE", payload });
                    } catch {
                        // no listener on page; ignore
                    }
                }
                sendResponse?.({ ok: true });
                return;
            }

            if (msg?.type === "GET_YTLINK") {
                const tabId = sender?.tab?.id;
                const current = typeof tabId === "number" ? ytLinkByTab.get(tabId) : null;
                sendResponse?.({ ok: true, current: current || null });
                return;
            }

            if (msg?.type === "NOW_PLAYING") {
                const roomId = msg.payload?.roomId;
                if (!roomId) {
                    sendResponse({ ok: false, error: "Missing roomId" });
                    return;
                }
                const roomName = msg.payload?.roomName;
                await updateActiveRoom(roomId, roomName);

                const track = {
                    title: msg.payload?.title || "",
                    channel: msg.payload?.channel || "",
                    videoId: msg.payload?.videoId || "",
                    watchUrl: msg.payload?.watchUrl || toWatchUrl(msg.payload?.videoId || ""),
                    source: msg.payload?.source || "page-now-playing",
                    ts: msg.payload?.ts || Date.now(),
                    roomId
                };

                if (!track.videoId) {
                    sendResponse({ ok: false, error: "Missing videoId" });
                    return;
                }

                const result = await addTrack(roomId, track, roomName);
                const info = await getRoomInfo(roomId);
                sendResponse({ ok: true, added: result.added, roomId, roomName: info?.name || roomName || roomId });
                return;
            }

            if (msg?.type === "PLAYLIST_CANDIDATES") {
                const roomId = msg.payload?.roomId;
                const roomName = msg.payload?.roomName;
                if (roomId && roomName) {
                    await upsertRoom(roomId, { name: roomName });
                }
                sendResponse({ ok: true });
                return;
            }

            if (msg?.type === "GET_TRACKS") {
                const requestedRoom = msg.payload?.roomId;
                const roomId = requestedRoom || (await ensureActiveRoomId());
                const tracks = roomId ? await getTracks(roomId) : [];
                const info = roomId ? await getRoomInfo(roomId) : null;
                sendResponse({ ok: true, tracks, roomId, roomName: info?.name || roomId || "" });
                return;
            }

            if (msg?.type === "CLEAR_TRACKS") {
                const roomId = msg.payload?.roomId || (await ensureActiveRoomId());
                if (roomId) {
                    await clearTracks(roomId);
                }
                const info = roomId ? await getRoomInfo(roomId) : null;
                sendResponse({ ok: true, roomId, roomName: info?.name || roomId || "" });
                return;
            }

            if (msg?.type === "MANUAL_ADD_TRACK") {
                const roomId = msg.payload?.roomId || (await ensureActiveRoomId());
                if (!roomId) {
                    sendResponse({ ok: false, error: "No active room" });
                    return;
                }
                const roomName = msg.payload?.roomName;
                await updateActiveRoom(roomId, roomName);
                const rawVideoId = msg.payload?.track?.videoId || msg.payload?.track?.input || msg.payload?.track?.url;
                const videoId = extractVideoId(rawVideoId);
                if (!videoId) {
                    sendResponse({ ok: false, error: "유효한 YouTube ID를 입력하세요." });
                    return;
                }
                const title = msg.payload?.track?.title?.trim() || "";
                const channel = msg.payload?.track?.channel?.trim() || "";
                const track = {
                    title,
                    channel,
                    videoId,
                    watchUrl: toWatchUrl(videoId),
                    source: "manual",
                    ts: msg.payload?.track?.ts || Date.now(),
                    roomId
                };
                const result = await addTrack(roomId, track, roomName);
                const info = await getRoomInfo(roomId);
                sendResponse({ ok: true, added: result.added, roomId, roomName: info?.name || roomName || roomId, tracks: result.tracks });
                return;
            }

            if (msg?.type === "REMOVE_TRACK") {
                const roomId = msg.payload?.roomId || (await ensureActiveRoomId());
                const index = Number(msg.payload?.index);
                const tracks = roomId ? await removeTrack(roomId, Number.isInteger(index) ? index : -1) : [];
                const info = roomId ? await getRoomInfo(roomId) : null;
                sendResponse({ ok: true, roomId, roomName: info?.name || roomId || "", tracks });
                return;
            }

            if (msg?.type === "GET_ROOMS") {
                const rooms = await getRooms();
                const activeRoomId = await ensureActiveRoomId();
                const activeInfo = rooms.find(r => r.id === activeRoomId);
                sendResponse({ ok: true, rooms, activeRoomId, activeRoomName: activeInfo?.name || "" });
                return;
            }

            if (msg?.type === "SET_ACTIVE_ROOM") {
                const roomId = msg.payload?.roomId || null;
                const roomName = msg.payload?.roomName;
                if (!roomId) {
                    activeRoomIdCache = null;
                    await setCurrentRoomId(null);
                    sendResponse({ ok: true, roomId: null });
                    return;
                }
                await updateActiveRoom(roomId, roomName);
                const info = await getRoomInfo(roomId);
                sendResponse({ ok: true, roomId, roomName: info?.name || roomName || roomId });
                return;
            }

            if (msg?.type === "CREATE_YT_PLAYLIST") {
                const { name } = msg.payload || {};
                const playlistId = await createPlaylist(name);
                sendResponse({ ok: true, playlistId });
                return;
            }

            if (msg?.type === "ADD_ALL_TO_PLAYLIST") {
                const { playlistId, roomId: requestedRoom } = msg.payload || {};
                if (!playlistId) {
                    sendResponse({ ok: false, error: "Missing playlistId" });
                    return;
                }
                const roomId = requestedRoom || (await ensureActiveRoomId());
                const tracks = roomId ? await getTracks(roomId) : [];
                const videoIds = tracks.map(t => t.videoId).filter(Boolean);
                for (const vid of videoIds) {
                    await addVideoToPlaylist(playlistId, vid);
                    await new Promise(r => setTimeout(r, 150));
                }
                const info = roomId ? await getRoomInfo(roomId) : null;
                sendResponse({ ok: true, count: videoIds.length, roomId, roomName: info?.name || roomId || "", playlistId });
                return;
            }

            if (msg?.type === "GET_SETTINGS") {
                const settings = await getSettings();
                sendResponse({ ok: true, settings });
                return;
            }

            if (msg?.type === "SET_SETTINGS") {
                const next = await setSettings(msg.payload || {});
                sendResponse({ ok: true, settings: next });
                return;
            }
        } catch (e) {
            sendResponse({ ok: false, error: e?.message || String(e) });
        }
    })();
    return true;
});

