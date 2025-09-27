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

  const bodyText = await resp.text().catch(() => "");
  const type = resp.headers.get("content-type") || "";
  let data = bodyText;

  if (type.includes("application/json")) {
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      data = bodyText;
    }
  }

  if (!resp.ok) {
    const errMessage = typeof data === "string" ? data : JSON.stringify(data);
    const error = new Error(errMessage || ("Request failed: " + resp.status));
    error.status = resp.status;
    throw error;
  }

  return data;
}

async function addToPlaylist(body) {
  return callServer("/add", body);
}

function makeTrackKey(title, channel) {
  const name = (title || "").trim().toLowerCase();
  const artist = (channel || "").trim().toLowerCase();
  return `${name}|||${artist}`;
}

function formatProcessKey(track) {
  return makeTrackKey(track.title, track.author);
}

function scheduleAutoAdd(track) {
  processingQueue = processingQueue
    .catch(() => {})
    .then(() => processTrack(track));
}

async function updateAddedState({
  videoId,
  title,
  channel,
  thumbnail,
  roomId,
  roomTitle,
  playlistUrl,
  noteType,
  status = "added",
  existingState,
}) {
  const store = existingState ?? await storageGet(["addedVideoIds", "addedTracks"]);
  const existingIds = new Set(store.addedVideoIds || []);
  if (videoId) {
    existingIds.add(videoId);
  }

  const updates = {
    addedVideoIds: Array.from(existingIds),
    lastAutoAddNote: {
      ts: Date.now(),
      type: noteType || "auto-added",
      videoId: videoId || "",
      title: title || "",
      channel: channel || "",
      status,
    },
  };

  if (status !== "skipped") {
    const existingTracks = Array.isArray(store.addedTracks) ? store.addedTracks : [];
    const addedEntry = {
      videoId: videoId || "",
      title: title || "",
      channel: channel || "",
      thumbnail: thumbnail || null,
      addedAt: Date.now(),
      roomId: roomId || "",
      roomTitle: roomTitle || "",
      status,
    };
    updates.addedTracks = [addedEntry, ...existingTracks].slice(0, MAX_TRACK_HISTORY);
  }

  if (playlistUrl) {
    updates.lastPlaylistUrl = playlistUrl;
  }

  await storageSet(updates);
  return updates.addedTracks ? updates.addedTracks[0] : null;
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

  const trackName = (track.title || "").trim();
  const artist = (track.author || "").trim();

  if (!trackName && !artist) {
    await storageSet({
      lastAutoAddNote: {
        ts: Date.now(),
        type: "skip-no-metadata",
      },
    });
    return;
  }

  const payload = {
    roomId: track.roomId || "",
    roomTitle: track.roomTitle || "",
    trackName,
    artist,
  };

  if (track.videoUrl) {
    payload.url = track.videoUrl;
  }

  try {
    const addResponse = await addToPlaylist(payload);
    const status = String(addResponse?.status || "added").toLowerCase();
    const videoId = addResponse?.videoId || "";
    const playlistUrl = addResponse?.playlistUrl || null;

    await updateAddedState({
      videoId,
      title: addResponse?.title || trackName,
      channel: addResponse?.channel || artist,
      thumbnail: addResponse?.thumbnail || null,
      roomId: track.roomId || "",
      roomTitle: track.roomTitle || "",
      playlistUrl,
      noteType: status === "queued" ? "auto-queued" : status === "skipped" ? "skipped-duplicate" : "auto-added",
      status,
    });
  } catch (error) {
    console.error("[Nomangho][background] auto-add failed", error);
    const noteType = error?.status === 404 ? "skip-no-match" : error?.status === 400 ? "skip-no-metadata" : "error-add";
    await storageSet({
      lastAutoAddNote: {
        ts: Date.now(),
        type: noteType,
        message: error?.message || String(error),
        title: track.title || "",
        channel: track.author || "",
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
  const videoUrl = (payload.videoUrl || payload.watchUrl || "").trim();

  const normalized = {
    title,
    author,
    roomId,
    roomTitle,
    query,
    videoUrl,
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

async function handleManualAdd(payload) {
  try {
    const rawUrl = (payload?.url || payload?.videoId || payload?.input || "").trim();
    const store = await storageGet(["lastTrack", "addedTracks", "addedVideoIds"]);
    const lastTrack = store.lastTrack || {};

    const roomId = (payload?.roomId || lastTrack.roomId || "").trim();
    const roomTitle = (payload?.roomTitle || lastTrack.roomTitle || "").trim();
    const trackName = (payload?.title || payload?.trackName || lastTrack.title || "").trim();
    const artist = (payload?.channel || payload?.artist || lastTrack.author || "").trim();

    if (!roomId || (!trackName && !artist)) {
      await storageSet({
        lastAutoAddNote: {
          ts: Date.now(),
          type: "manual-error",
          message: "곡 정보를 확인할 수 없습니다.",
        },
      });
      return { ok: false, error: "missing_metadata" };
    }

    const requestBody = {
      roomId,
      roomTitle,
      trackName,
      artist,
    };

    if (rawUrl) {
      requestBody.url = rawUrl;
    }

    const addResponse = await addToPlaylist(requestBody);
    const status = String(addResponse?.status || "added").toLowerCase();
    const videoId = addResponse?.videoId || "";
    const playlistUrl = addResponse?.playlistUrl || null;

    await updateAddedState({
      videoId,
      title: addResponse?.title || trackName,
      channel: addResponse?.channel || artist,
      thumbnail: addResponse?.thumbnail || null,
      roomId,
      roomTitle,
      playlistUrl,
      noteType: status === "queued" ? "manual-queued" : status === "skipped" ? "manual-skipped" : "manual-added",
      status,
      existingState: store,
    });

    return {
      ok: true,
      status,
      playlistUrl,
      videoId,
      title: addResponse?.title || trackName,
      channel: addResponse?.channel || artist,
      thumbnail: addResponse?.thumbnail || null,
    };
  } catch (error) {
    console.error("[Nomangho][background] manual add failed", error);
    await storageSet({
      lastAutoAddNote: {
        ts: Date.now(),
        type: "manual-error",
        message: error?.message || String(error),
      },
    });
    return { ok: false, error: error?.message || String(error) };
  }
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

  if (type === "ADD_MANUAL_TRACK") {
    handleManualAdd(message?.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[Nomangho][background] ADD_MANUAL_TRACK failed", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled?.addListener(() => {
  storageRemove(["lastTrack", "lastPlaylistUrl", "addedTracks", "addedVideoIds", "lastAutoAddNote"]);
});