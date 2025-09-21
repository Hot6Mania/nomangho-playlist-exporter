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
let disconnectVideoChange = null;
let isSendingNowPlaying = false;
let latestFrameLink = null;
let lastFrameHydrateTs = 0;
const FRAME_HYDRATE_INTERVAL_MS = 1500;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "YTLINK_UPDATE") {
        const payload = msg.payload || {};
        latestFrameLink = {
            href: payload.href || "",
            id: payload.id || "",
            reason: payload.reason || "iframe",
            ts: payload.ts || Date.now()
        };
        sendResponse?.({ ok: true });
        return true;
    }
    return false;
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
        chrome.runtime.sendMessage({ type: "GET_YTLINK" }, (res) => {
            if (res?.current) {
                latestFrameLink = res.current;
            }
            resolve(latestFrameLink);
        });
    });
}

async function sendNowPlayingIfChanged() {
    if (isSendingNowPlaying) return;
    isSendingNowPlaying = true;
    try {
        const now = await readNowPlaying();
        if (!now || !now.videoId) {
            lastVideoKey = null;
            return;
        }

        let watchUrl = now.watchUrl;
        if (latestFrameLink?.href) {
            if (!now.videoId || !latestFrameLink.id || latestFrameLink.id === now.videoId) {
                watchUrl = latestFrameLink.href;
            }
        }

        if (!watchUrl) {
            const hydrated = await hydrateFrameLink();
            if (hydrated?.href && (!now.videoId || !hydrated.id || hydrated.id === now.videoId)) {
                watchUrl = hydrated.href;
            }
        }

        const key = `${now.videoId}|${now.title}|${now.author}`;
        if (key === lastVideoKey && watchUrl === now.watchUrl) return;
        lastVideoKey = key;

        const roomName = getRoomDisplayName();
        chrome.runtime.sendMessage({
            type: "NOW_PLAYING",
            payload: {
                title: now.title,
                channel: now.author,
                videoId: now.videoId,
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

    const safeSendNowPlaying = () => { sendNowPlayingIfChanged().catch(() => { }); };
    const safeReportCandidates = () => { try { reportPlaylistCandidates(); } catch { /* noop */ } };

    const infoObserver = new MutationObserver(() => {
        safeSendNowPlaying();
        safeReportCandidates();
    });

    function initInfoObserver() {
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
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        window.addEventListener("DOMContentLoaded", init);
    }
}