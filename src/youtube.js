(() => {
    const host = location.hostname || "";
    const isYouTubeHost = /(^|\.)youtube(?:-nocookie)?\.com$/i.test(host);
    if (!isYouTubeHost) return;

    const TITLE_SELECTOR = "a.ytp-title-link";
    let lastHref = "";
    let lastTitle = "";
    let lastVideoId = "";
    let lastChannel = "";

    const extractVideoId = (value) => {
        if (!value) return "";
        try {
            const url = new URL(value, location.href);
            const searchId = url.searchParams.get("v");
            if (searchId) return searchId;
            const pathMatch = url.pathname.match(/\/([^/]+)$/);
            if (pathMatch && pathMatch[1]) {
                return pathMatch[1];
            }
        } catch {
            /* ignore parsing errors */
        }
        const match = String(value).match(/(?:v=|\/embed\/|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{6,})/);
        return match && match[1] ? match[1] : "";
    };

    const resolveVideoId = (href) => {
        const fromHref = extractVideoId(href);
        if (fromHref) return fromHref;
        const candidates = [
            window.ytInitialPlayerResponse?.currentVideoEndpoint?.watchEndpoint?.videoId,
            window.ytInitialPlayerResponse?.videoDetails?.videoId,
            window.ytplayer?.config?.args?.video_id,
            window.ytplayer?.config?.args?.videoId,
            window.ytplayer?.config?.args?.player_response && (() => {
                try {
                    const json = JSON.parse(window.ytplayer.config.args.player_response);
                    return json?.videoDetails?.videoId || "";
                } catch {
                    return "";
                }
            })()
        ];
        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim()) {
                return candidate.trim();
            }
        }
        return "";
    };

    const buildWatchUrl = (href, videoId) => {
        if (href) return href;
        if (videoId) {
            return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        }
        return "";
    };

    const pick = () => {
        const link = document.querySelector(TITLE_SELECTOR);
        const href = link?.getAttribute("href") || link?.href || "";
        const fallbackTitle = window.ytInitialPlayerResponse?.videoDetails?.title
            || window.ytplayer?.config?.args?.title
            || "";
        const fallbackAuthor = window.ytInitialPlayerResponse?.videoDetails?.author
            || window.ytplayer?.config?.args?.author
            || window.ytplayer?.config?.args?.channel
            || "";
        const title = (link?.textContent?.trim() || fallbackTitle || "").trim();
        const channel = String(fallbackAuthor || "").trim();
        const videoId = resolveVideoId(href);
        const watchUrl = buildWatchUrl(href, videoId);
        if (!videoId && !watchUrl) return null;
        return { href: watchUrl, title, videoId, channel };
    };

    const sendUpdate = (payload) => {
        try {
            const maybePromise = chrome.runtime.sendMessage({
                type: "yt-now-playing",
                payload: {
                    href: payload.href || "",
                    title: payload.title || "",
                    videoId: payload.videoId || "",
                    channel: payload.channel || "",
                    frameUrl: location.href
                }
            });
            if (maybePromise && typeof maybePromise.catch === "function") {
                maybePromise.catch(() => { /* ignore */ });
            }
        } catch {
            /* ignore messaging failures */
        }
    };

    const publishIfChanged = () => {
        const current = pick();
        if (!current) return;
        if (
            current.href === lastHref &&
            current.title === lastTitle &&
            current.videoId === lastVideoId &&
            current.channel === lastChannel
        ) {
            return;
        }
        lastHref = current.href;
        lastTitle = current.title;
        lastVideoId = current.videoId;
        lastChannel = current.channel || "";
        sendUpdate(current);
    };

    const observer = new MutationObserver(publishIfChanged);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });

    const intervalId = setInterval(publishIfChanged, 1000);
    publishIfChanged();

    const cleanup = () => {
        try { observer.disconnect(); } catch { /* noop */ }
        try { clearInterval(intervalId); } catch { /* noop */ }
    };

    window.addEventListener("pagehide", cleanup);
    window.addEventListener("unload", cleanup);
})();
