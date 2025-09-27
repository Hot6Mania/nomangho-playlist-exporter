const TITLE_SELECTOR = ".media-info .title";
const AUTHOR_SELECTOR = ".media-info .author";
const ROOT_SELECTOR = ".media-info";
const POLL_INTERVAL_MS = 1000;
const FORCE_DISPATCH_INTERVAL_MS = 10_000;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 3;

let swPort = null;

const ROOM_TITLE_SUFFIX_RE = /\s*-\s*SyncTube\s*$/i;
const DEFAULT_ROOM_NAME = "\uBC29";

function runtimeAlive() {
  try {
    return !!(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function ensurePort() {
  if (!runtimeAlive()) return null;
  if (swPort) return swPort;
  try {
    swPort = chrome.runtime.connect({ name: "nomangho-content" });
    swPort.onDisconnect.addListener(() => {
      swPort = null;
    });
    return swPort;
  } catch {
    swPort = null;
    return null;
  }
}

function sendMessageSafe(message, onResponse, attempt = 0) {
  if (!runtimeAlive()) {
    if (attempt < MAX_RETRIES) {
      setTimeout(() => sendMessageSafe(message, onResponse, attempt + 1), RETRY_DELAY_MS);
    }
    return;
  }

  ensurePort();
  try {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = String(err.message || "");
        if (/Extension context invalidated|Receiving end does not exist|message port closed before a response was received/i.test(msg)) {
          if (attempt < MAX_RETRIES) {
            setTimeout(() => sendMessageSafe(message, onResponse, attempt + 1), RETRY_DELAY_MS);
            return;
          }
        } else if (msg) {
          console.warn('[Nomangho][content] sendMessage lastError:', msg);
        }
      }
      if (typeof onResponse === 'function') onResponse(resp);
    });
  } catch (error) {
    const msg = String(error?.message || error || '');
    if (/Extension context invalidated|message port closed before a response was received/i.test(msg) && attempt < MAX_RETRIES) {
      setTimeout(() => sendMessageSafe(message, onResponse, attempt + 1), RETRY_DELAY_MS);
      return;
    }
    console.warn('[Nomangho][content] sendMessage threw:', msg);
  }
}

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
  return cleaned || DEFAULT_ROOM_NAME;
}

function extractVideoId(urlOrId) {
  if (!urlOrId) return "";
  const str = String(urlOrId).trim();
  const urlMatch = str.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/|vi\/))([A-Za-z0-9_-]{11})/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  const paramMatch = str.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (paramMatch && paramMatch[1]) {
    return paramMatch[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(str)) {
    return str;
  }
  return "";
}

function toWatchUrl(id) {
  return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : "";
}

function getVideoContext() {
  const ctx = { videoId: "", videoUrl: "" };
  const iframe = document.querySelector(".youtube-player iframe");
  if (iframe) {
    const src = iframe.getAttribute("src") || iframe.src || "";
    if (src) {
      ctx.videoUrl = src;
      ctx.videoId = extractVideoId(src);
    }
  }
  if (!ctx.videoId) {
    const link = document.querySelector(".ytp-title-link");
    if (link && link.href) {
      ctx.videoId = extractVideoId(link.href);
      if (!ctx.videoUrl) {
        ctx.videoUrl = link.href;
      }
    }
  }
  if (ctx.videoId && (!ctx.videoUrl || ctx.videoUrl.startsWith("about:"))) {
    ctx.videoUrl = toWatchUrl(ctx.videoId);
  }
  return ctx;
}

function getCurrentTrack() {
  const titleEl = document.querySelector(TITLE_SELECTOR);
  const authorEl = document.querySelector(AUTHOR_SELECTOR);
  const title = titleEl?.textContent?.trim() || "";
  const artist = authorEl?.textContent?.trim() || "";
  if (!title && !artist) {
    return null;
  }
  const videoCtx = getVideoContext();
  return {
    title,
    artist,
    roomId: getRoomId(),
    roomTitle: getRoomTitle(),
    videoId: videoCtx.videoId,
    videoUrl: videoCtx.videoUrl,
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
    videoId: track.videoId || "",
    videoUrl: track.videoUrl || "",
    updatedAt: Date.now(),
  };

  sendMessageSafe({ type: "TRACK_METADATA", payload });

  console.log("[Nomangho][content] detected", {
    title: track.title,
    artist: track.artist,
    videoId: track.videoId,
    videoUrl: track.videoUrl,
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
  ensurePort();
  refreshObservers();
  startRootObserver();
  evaluateTrack({ force: true });
  startPolling();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      ensurePort();
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
