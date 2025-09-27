const API_BASE = "https://nomangho.duckdns.org";
const RECENT_KEY_TTL_MS = 8_000;
const MAX_TRACK_HISTORY = 20;

let lastProcessedKey = "";
let lastProcessedTs = 0;
let processingQueue = Promise.resolve();

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => resolve());
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => {
      resolve(items || {});
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

async function callServer(endpoint, payload) {
  const resp = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Request failed: ${resp.status}`);
  }
  const type = resp.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    return resp.json();
  }
  return resp.text();
}

async function searchVideos(query) {
  return callServer("/search", { query, maxResults: 5 });
}

async function addToPlaylist(roomId, roomTitle, videoId) {
  return callServer("/add", { roomId, roomTitle, videoId });
}

function formatProcessKey(track) {
  return `${track.title || ""}|||${track.author || ""}`.trim().toLowerCase();
}

function scheduleAutoAdd(track) {
  processingQueue = processingQueue
    .catch(() => {})
    .then(() => processTrack(track));
}

async function processTrack(track) {
  const key = formatProcessKey(track);
  if (!key) {
    return;
  }

  const now = Date.now();
  if (key === lastProcessedKey && now - lastProcessedTs < RECENT_KEY_TTL_MS) {
    return;
  }
  lastProcessedKey = key;
  lastProcessedTs = now;

  const query = (track.query || "").trim();
  if (!query) {
    await storageSet({
      lastAutoAddNote: {
        ts: Date.now(),
        type: "skip-empty-query",
      },
    });
    return;
  }

  try {
    const searchResponse = await searchVideos(query);
    const results = Array.isArray(searchResponse?.results) ? searchResponse.results : [];
    if (!results.length) {
      await storageSet({
        lastAutoAddNote: {
          ts: Date.now(),
          type: "no-results",
          query,
        },
      });
      return;
    }

    const first = results[0];
    if (!first?.videoId) {
      await storageSet({
        lastAutoAddNote: {
          ts: Date.now(),
          type: "invalid-result",
          query,
        },
      });
      return;
    }

    const store = await storageGet(["addedVideoIds", "addedTracks"]);
    const existingIds = new Set(store.addedVideoIds || []);
    if (existingIds.has(first.videoId)) {
      await storageSet({
        lastAutoAddNote: {
          ts: Date.now(),
          type: "skipped-duplicate",
          videoId: first.videoId,
          title: first.title || track.title || "",
        },
      });
      return;
    }

    const addResponse = await addToPlaylist(track.roomId || "", track.roomTitle || "", first.videoId);
    const playlistUrl = addResponse?.playlistUrl || null;

    existingIds.add(first.videoId);
    const addedEntry = {
      videoId: first.videoId,
      title: first.title || track.title || "",
      channel: first.channel || track.author || "",
      thumbnail: first.thumbnail || null,
      addedAt: Date.now(),
      roomId: track.roomId || "",
      roomTitle: track.roomTitle || "",
    };

    const existingTracks = Array.isArray(store.addedTracks) ? store.addedTracks : [];
    const updatedTracks = [addedEntry, ...existingTracks].slice(0, MAX_TRACK_HISTORY);

    const updates = {
      lastAutoAddNote: {
        ts: Date.now(),
        type: "added",
        videoId: first.videoId,
        title: addedEntry.title,
        channel: addedEntry.channel,
      },
      addedVideoIds: Array.from(existingIds),
      addedTracks: updatedTracks,
    };
    if (playlistUrl) {
      updates.lastPlaylistUrl = playlistUrl;
    }
    await storageSet(updates);
  } catch (error) {
    console.error("[Nomangho][background] auto-add failed", error);
    await storageSet({
      lastAutoAddNote: {
        ts: Date.now(),
        type: "error",
        message: error?.message || String(error),
      },
    });
  }
}

async function handleTrackMetadata(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "invalid_payload" };
  }

  const title = (payload.title || "").trim();
  const author = (payload.author || payload.artist || "").trim();
  const roomId = (payload.roomId || "").trim();
  const roomTitle = (payload.roomTitle || "").trim();
  const query = (payload.query || `${author} ${title}`).trim();
  const normalized = {
    title,
    author,
    roomId,
    roomTitle,
    query,
    updatedAt: payload.updatedAt || Date.now(),
  };

  await storageSet({ lastTrack: normalized });
  scheduleAutoAdd(normalized);
  return { ok: true, track: normalized };
}

async function handleGetStatus() {
  const data = await storageGet(["lastTrack", "addedTracks", "lastPlaylistUrl", "lastAutoAddNote"]);
  return {
    ok: true,
    track: data.lastTrack || null,
    addedTracks: Array.isArray(data.addedTracks) ? data.addedTracks : [],
    playlistUrl: data.lastPlaylistUrl || null,
    note: data.lastAutoAddNote || null,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (!type) {
    return undefined;
  }

  if (type === "TRACK_METADATA") {
    handleTrackMetadata(message?.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[Nomangho][background] TRACK_METADATA failed", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (type === "GET_STATUS") {
    handleGetStatus()
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[Nomangho][background] GET_STATUS failed", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled?.addListener(() => {
  storageRemove(["lastTrack", "lastPlaylistUrl", "addedTracks", "addedVideoIds", "lastAutoAddNote"]);
});
