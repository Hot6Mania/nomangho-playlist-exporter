// Content script: observes the SyncTube player and reports reliable now-playing info.
// Uses the YouTube IFrame API (when available) to obtain the actual videoId for accuracy.

const SELECTORS = {
    mediaWrapper: ".media-wrapper",
    player: ".player-wrapper .player",
    title: ".media-info .title",
    author: ".media-info .author",
    ytIframe: ".youtube-player iframe",
    aside: "aside"
};

const ROOM_KEY = (() => {
    const match = window.location.pathname.match(/\/room\/([^/?#]+)/);
    if (match && match[1]) return match[1];
    const titleName = getRoomDisplayName();
    if (titleName) return titleName.replace(/\s+/g, "_");
    return `room-${Date.now()}`;
})();

function getRoomDisplayName() {
    const title = document.title || "";
    const parts = title.split(" - ");
    const name = parts.length > 1 ? parts[0].trim() : title.trim();
    return name || "방";
}

let lastVideoKey = null;
let lastWatchUrl = null;
let disconnectVideoChange = null;
let isSendingNowPlaying = false;
let latestFrameLink = null;
let lastFrameHydrateTs = 0;
const FRAME_HYDRATE_INTERVAL_MS = 1500;
const FORCE_FRAME_POLL_INTERVAL_MS = 2000;

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "YT_NOW_PLAYING_BROADCAST" && msg.payload) {
        latestFrameLink = {
            href: msg.payload?.href || "",
            id: msg.payload?.videoId || msg.payload?.id || "",
            videoId: msg.payload?.videoId || msg.payload?.id || "",
            title: msg.payload?.title || "",
            channel: msg.payload?.channel || "",
            frameUrl: msg.payload?.frameUrl || "",
            updatedAt: msg.payload?.updatedAt || Date.now()
        };
        lastFrameHydrateTs = Date.now();
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toWatchUrl(id) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

function extractIdFromAny(urlOrId) {
    if (!urlOrId) return null;
    const m = String(urlOrId).match(
        /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/
    );
    return m && m[1] ? m[1] : null;
}

function getYTFrame() {
    return document.querySelector(SELECTORS.ytIframe) || null;
}

async function waitForYouTubeAPI() {
    for (let i = 0; i < 40; i++) {
        if (window.YT && typeof window.YT.Player === "function") {
            return true;
        }
        await sleep(100);
    }
    return false;
}

let cachedApiPlayer = null;
let cachedPlayerIframe = null;

async function getCurrentVideoIdViaAPI() {
    const hasAPI = await waitForYouTubeAPI();
    if (!hasAPI) return null;

    const iframe = getYTFrame();
    if (!iframe) return null;

    if (!iframe.id) {
        iframe.id = `syncyt-iframe-${Math.random().toString(36).slice(2)}`;
    }

    if (cachedApiPlayer && cachedPlayerIframe !== iframe && typeof cachedApiPlayer.destroy === "function") {
        try { cachedApiPlayer.destroy(); } catch { /* ignore */ }
        cachedApiPlayer = null;
    }

    let player = null;
    if (typeof YT.get === "function") {
        player = YT.get(iframe.id) || null;
    }

    if (!player) {
        try {
            player = new YT.Player(iframe.id);
        } catch {
            try {
                player = new YT.Player(iframe);
            } catch {
                player = null;
            }
        }
    }

    if (!player) return null;

    cachedApiPlayer = player;
    cachedPlayerIframe = iframe;

    for (let i = 0; i < 40; i++) {
        try {
            if (typeof player.getVideoData === "function") {
                const data = player.getVideoData();
                if (data && data.video_id) {
                    return data.video_id;
                }
            }
        } catch { /* ignore transient errors */ }
        await sleep(100);
    }
    return null;
}

function getCurrentVideoIdFromSrc() {
    const iframe = getYTFrame();
    if (!iframe) return null;
    const src = iframe.getAttribute("src") || "";
    const direct = src.split("/embed/")[1]?.split(/[?&#]/)[0];
    return direct || extractIdFromAny(src);
}

async function getCurrentVideoId() {
    const viaAPI = await getCurrentVideoIdViaAPI();
    if (viaAPI) return viaAPI;
    return getCurrentVideoIdFromSrc();
}

function getActivePlayerElements() {
    const player = document.querySelector(SELECTORS.player);
    if (!player || player.classList.contains("no-media")) {
        return { player: null, iframe: null };
    }
    const iframe = player.querySelector("iframe");
    return { player, iframe };
}

async function readNowPlaying() {
    const { player, iframe } = getActivePlayerElements();
    if (!player || !iframe) return null;

    const wrapper = player.closest(SELECTORS.mediaWrapper) || document;
    const tEl = wrapper.querySelector(SELECTORS.title);
    const aEl = wrapper.querySelector(SELECTORS.author);

    const title = tEl?.textContent?.trim() || "";
    const author = aEl?.textContent?.trim() || "";
    const videoId = await getCurrentVideoId();

    if (!videoId && !title) {
        return null;
    }

    return {
        title,
        author,
        videoId,
        watchUrl: videoId ? toWatchUrl(videoId) : null
    };
}

async function hydrateFrameLink(force = false) {
    const now = Date.now();
    if (!force && now - lastFrameHydrateTs < FRAME_HYDRATE_INTERVAL_MS) {
        return latestFrameLink;
    }
    lastFrameHydrateTs = now;
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "get-now-playing" }, (res) => {
                const err = chrome.runtime?.lastError || null;
                if (!err) {
                    const data = res?.current ? res.current : res;
                    if (data) {
                        latestFrameLink = {
                            href: data.href || "",
                            id: data.id || data.videoId || "",
                            videoId: data.videoId || data.id || "",
                            title: data.title || "",
                            channel: data.channel || "",
                            updatedAt: data.updatedAt || data.ts || Date.now()
                        };
                    }
                }
                resolve(latestFrameLink);
            });
        } catch {
            resolve(latestFrameLink);
        }
    });
}

async function sendNowPlayingIfChanged(forceHydrate = false) {
    if (isSendingNowPlaying) return;
    isSendingNowPlaying = true;
    try {
        const now = await readNowPlaying();
        const hydratedLink = await hydrateFrameLink(forceHydrate);
        const fallbackVideoId = hydratedLink?.videoId || hydratedLink?.id || null;
        const resolvedVideoId = now?.videoId || fallbackVideoId || null;
        let watchUrl = now?.watchUrl || hydratedLink?.href || (resolvedVideoId ? toWatchUrl(resolvedVideoId) : null);

        if (!now && !resolvedVideoId) {
            lastVideoKey = null;
            lastWatchUrl = null;
            return;
        }

        if (!resolvedVideoId) {
            lastVideoKey = null;
            lastWatchUrl = null;
            return;
        }

        if (!watchUrl) {
            watchUrl = toWatchUrl(resolvedVideoId);
        }

        const title = now?.title || hydratedLink?.title || "";
        const author = now?.author || hydratedLink?.channel || "";
        const key = `${resolvedVideoId}|${title}|${author}`;
        if (key === lastVideoKey && watchUrl === lastWatchUrl) return;
        lastVideoKey = key;
        lastWatchUrl = watchUrl;

        const roomName = getRoomDisplayName();
        chrome.runtime.sendMessage({
            type: "NOW_PLAYING",
            payload: {
                title,
                channel: author,
                videoId: resolvedVideoId,
                watchUrl,
                roomId: ROOM_KEY,
                roomName,
                source: "page-now-playing",
                ts: Date.now()
            }
        });
    } finally {
        isSendingNowPlaying = false;
    }
}

function scanPlaylistLinks() {
    const aside = document.querySelector(SELECTORS.aside);
    if (!aside) return [];
    const links = [...aside.querySelectorAll('a[href*="youtube.com/watch"], a[href*="youtu.be/"]')];
    return links.map(a => ({
        href: a.href,
        text: a.textContent.trim(),
        roomId: ROOM_KEY,
        roomName: getRoomDisplayName(),
        ts: Date.now()
    }));
}

function reportPlaylistCandidates() {
    const items = scanPlaylistLinks();
    if (!items.length) return;
    chrome.runtime.sendMessage({
        type: "PLAYLIST_CANDIDATES",
        payload: {
            items,
            roomId: ROOM_KEY,
            roomName: getRoomDisplayName(),
            ts: Date.now()
        }
    });
}

function safeSendNowPlaying(forceHydrate = false) {
    sendNowPlayingIfChanged(forceHydrate).catch(() => { });
}
const safeReportCandidates = () => { try { reportPlaylistCandidates(); } catch { /* noop */ } };

const infoObserver = new MutationObserver(() => {
    safeSendNowPlaying();
    safeReportCandidates();
});

function initInfoObserver() {
    infoObserver.disconnect();
    const targets = [
        document.querySelector(SELECTORS.mediaWrapper),
        document.querySelector(".media-info"),
        document.querySelector(".youtube-player"),
        document.querySelector("aside")
    ].filter(Boolean);
    targets.forEach(t => infoObserver.observe(t, { childList: true, subtree: true, characterData: true }));
}

function onVideoChange(callback) {
    const runCallback = () => { try { callback(); } catch { /* ignore */ } };
    const iframeObserver = new MutationObserver(() => runCallback());
    const containerObserver = new MutationObserver(() => {
        iframeObserver.disconnect();
        startWatchingIframe();
        runCallback();
    });

    function startWatchingIframe() {
        const iframe = getYTFrame();
        if (!iframe) return;
        iframeObserver.observe(iframe, { attributes: true, attributeFilter: ["src"] });
    }

    const container = document.querySelector(".youtube-player") || document.body;
    containerObserver.observe(container, { childList: true, subtree: true });

    startWatchingIframe();
    runCallback();

    return () => {
        iframeObserver.disconnect();
        containerObserver.disconnect();
    };
}

function initVideoChangeWatcher() {
    if (disconnectVideoChange) {
        disconnectVideoChange();
    }
    disconnectVideoChange = onVideoChange(() => {
        safeSendNowPlaying();
        safeReportCandidates();
    });
}

async function hydrateInitialFrameLink() {
    await hydrateFrameLink(true);
}

async function init() {
    hydrateInitialFrameLink().catch(() => { });
    safeSendNowPlaying();
    safeReportCandidates();
    initInfoObserver();
    initVideoChangeWatcher();
    setInterval(() => {
        safeSendNowPlaying();
    }, 1000);
    setInterval(() => {
        safeSendNowPlaying(true);
    }, FORCE_FRAME_POLL_INTERVAL_MS);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
} else {
    window.addEventListener("DOMContentLoaded", init);
}
