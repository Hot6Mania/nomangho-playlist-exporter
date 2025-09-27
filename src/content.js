const TITLE_SELECTOR = ".media-info .title";
const AUTHOR_SELECTOR = ".media-info .author";
const ROOT_SELECTOR = ".media-info";
const POLL_INTERVAL_MS = 1000;
const FORCE_DISPATCH_INTERVAL_MS = 10_000;
const ROOM_TITLE_SUFFIX_RE = /\s*-\s*SyncTube\s*$/i;

let lastSentKey = null;
let lastSentAt = 0;
let pollTimerId = null;
let titleObserver = null;
let authorObserver = null;
let rootObserver = null;

function getRoomId() {
  const parts = location.pathname.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function getRoomTitle() {
  const raw = (document.title || "").trim();
  const cleaned = raw.replace(ROOM_TITLE_SUFFIX_RE, "").trim();
  return cleaned || "방";
}

function getCurrentTrack() {
  const titleEl = document.querySelector(TITLE_SELECTOR);
  const authorEl = document.querySelector(AUTHOR_SELECTOR);
  const title = titleEl?.textContent?.trim() || "";
  const artist = authorEl?.textContent?.trim() || "";
  if (!title && !artist) {
    return null;
  }
  return {
    title,
    artist,
    roomId: getRoomId(),
    roomTitle: getRoomTitle(),
  };
}

function buildTrackKey(track) {
  return `${track.title}|||${track.artist}`.toLowerCase();
}

function sendTrack(track) {
  const payload = {
    title: track.title,
    author: track.artist,
    artist: track.artist,
    roomId: track.roomId,
    roomTitle: track.roomTitle,
    query: [track.artist, track.title].filter(Boolean).join(" ").trim(),
    updatedAt: Date.now(),
  };

  chrome.runtime.sendMessage(
    {
      type: "TRACK_METADATA",
      payload,
    },
    () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("[Nomangho][content] sendMessage error", err.message);
      }
    }
  );

  console.log("[Nomangho][content] detected", {
    title: track.title,
    artist: track.artist,
    roomId: track.roomId,
    roomTitle: track.roomTitle,
    timestamp: new Date().toISOString(),
  });
}

function evaluateTrack({ force = false } = {}) {
  const track = getCurrentTrack();
  if (!track) {
    if (force) {
      lastSentKey = null;
      lastSentAt = 0;
    }
    return;
  }

  const key = buildTrackKey(track);
  const now = Date.now();
  const timeSinceLast = now - lastSentAt;

  if (!force && key === lastSentKey && timeSinceLast < FORCE_DISPATCH_INTERVAL_MS) {
    return;
  }

  lastSentKey = key;
  lastSentAt = now;
  sendTrack(track);
}

function ensureObserver(selector, existingObserver) {
  const el = document.querySelector(selector);
  if (existingObserver) {
    existingObserver.disconnect();
  }
  if (!el) {
    return null;
  }
  const observer = new MutationObserver(() => evaluateTrack({ force: false }));
  observer.observe(el, { childList: true, subtree: true, characterData: true });
  return observer;
}

function refreshObservers() {
  titleObserver = ensureObserver(TITLE_SELECTOR, titleObserver);
  authorObserver = ensureObserver(AUTHOR_SELECTOR, authorObserver);
}

function startRootObserver() {
  const root = document.querySelector(ROOT_SELECTOR) || document.body;
  if (rootObserver) {
    rootObserver.disconnect();
  }
  rootObserver = new MutationObserver(() => {
    refreshObservers();
    evaluateTrack({ force: false });
  });
  rootObserver.observe(root, { childList: true, subtree: true });
}

function startPolling() {
  if (pollTimerId) {
    clearInterval(pollTimerId);
  }
  pollTimerId = setInterval(() => {
    refreshObservers();
    evaluateTrack({ force: false });
  }, POLL_INTERVAL_MS);
}

function init() {
  refreshObservers();
  startRootObserver();
  evaluateTrack({ force: true });
  startPolling();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshObservers();
      evaluateTrack({ force: true });
    }
  });
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
