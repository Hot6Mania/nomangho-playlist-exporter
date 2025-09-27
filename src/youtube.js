
(() => {
    const host = location.hostname || "";
    const isYouTubeHost = /(^|\.)youtube(?:-nocookie)?\.com$/i.test(host);
    if (!isYouTubeHost) return;

    const TITLE_SELECTOR = "a.ytp-title-link";
    const CHANNEL_SELECTOR = ".ytp-title-channel-name, .ytp-title-channel-name a, .ytp-title-channel-logo + span";
    const BRIDGE_MESSAGE = "nomangho:yt-now-playing";
    const PARENT_MESSAGE_TYPE = "SYNCTUBE_IFRAME_NOWPLAYING";

    const safeTrim = (value) => {
        if (typeof value === "string") return value.trim();
        if (value === null || value === undefined) return "";
        return String(value).trim();
    };

    const collapseWhitespace = (value) => {
        const trimmed = safeTrim(value);
        return trimmed.replace(/\s+/g, " ").trim();
    };

    const normalizeHref = (value) => {
        const trimmed = safeTrim(value);
        if (!trimmed || trimmed === "about:blank") {
            return "";
        }
        try {
            const url = new URL(trimmed, location.href);
            if (url.protocol === "about:" || url.protocol === "javascript:" || url.protocol === "data:") {
                return "";
            }
            return url.href;
        } catch {
            return trimmed;
        }
    };

    const getDocumentTitle = () => {
        if (!document || !document.title) return "";
        return collapseWhitespace(document.title.replace(/ - YouTube$/i, ""));
    };

    const pickFirstString = (candidates, transform) => {
        if (!Array.isArray(candidates)) return "";
        for (const candidate of candidates) {
            if (candidate === null || candidate === undefined) continue;
            const value = typeof transform === "function" ? transform(candidate) : candidate;
            if (!value) continue;
            if (typeof value === "string") {
                const trimmed = value.trim();
                if (trimmed) return trimmed;
                continue;
            }
            return value;
        }
        return "";
    };

    const extractVideoId = (value) => {
        if (!value) return "";
        const str = String(value);
        try {
            const url = new URL(str, location.href);
            const searchKeys = ["v", "vi", "video_id", "videoId"];
            for (const key of searchKeys) {
                const candidate = url.searchParams.get(key);
                if (candidate) return candidate;
            }
            const pathMatch = url.pathname.match(/\/(?:embed|v|vi|shorts)\/([^/?#]+)/);
            if (pathMatch && pathMatch[1]) return pathMatch[1];
            const tailMatch = url.pathname.match(/\/([a-zA-Z0-9_-]{6,})$/);
            if (tailMatch && tailMatch[1]) return tailMatch[1];
        } catch {
            /* ignore URL parsing issues */
        }
        const fallbackMatch = str.match(/(?:v=|\/embed\/|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{6,})/);
        return fallbackMatch && fallbackMatch[1] ? fallbackMatch[1] : "";
    };

    const resolveVideoId = (href, fallback) => {
        const fromHref = extractVideoId(href);
        if (fromHref) return fromHref;
        if (fallback) {
            const list = Array.isArray(fallback) ? fallback : [fallback];
            for (const candidate of list) {
                if (typeof candidate === "string" && candidate.trim()) {
                    return candidate.trim();
                }
            }
        }
        return "";
    };

    const buildWatchUrl = (hrefCandidate, videoId) => {
        const normalized = normalizeHref(hrefCandidate);
        if (normalized) return normalized;
        if (videoId) {
            return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        }
        return "";
    };

    const hasMeaningfulData = (data) => Boolean(data && (data.href || data.videoId || data.title));

    let currentState = { href: "", title: "", videoId: "", channel: "" };

    const sendUpdate = (payload) => {
        if (!payload) return;
        try {
            const maybePromise = chrome.runtime?.sendMessage?.({
                type: "yt-now-playing",
                payload: {
                    href: payload.href || "",
                    title: payload.title || "",
                    videoId: payload.videoId || "",
                    channel: payload.channel || "",
                    frameUrl: location.href,
                    source: payload.source || ""
                }
            });
            if (maybePromise && typeof maybePromise.catch === "function") {
                maybePromise.catch(() => { /* ignore delivery errors */ });
            }
        } catch {
            /* ignore messaging failures */
        }
    };

    const applyCandidate = (candidate, source) => {
        if (!candidate) return;
        const hrefCandidate =
            candidate.href ??
            candidate.url ??
            candidate.watchUrl ??
            candidate.link ??
            "";
        const videoIdCandidate =
            candidate.videoId ??
            candidate.id ??
            candidate.video ??
            candidate.video_id ??
            candidate.watchId ??
            "";
        const titleCandidate =
            candidate.title ??
            candidate.name ??
            candidate.text ??
            candidate.textContent ??
            candidate.fallbackTitle ??
            "";
        const channelCandidate =
            candidate.channel ??
            candidate.author ??
            candidate.owner ??
            candidate.uploader ??
            candidate.channelName ??
            "";

        const normalizedHref = normalizeHref(hrefCandidate);
        const normalizedVideoId = safeTrim(videoIdCandidate);
        const normalizedTitle = collapseWhitespace(titleCandidate);
        const normalizedChannel = collapseWhitespace(channelCandidate);

        let videoId = normalizedVideoId;
        if (!videoId) {
            videoId = resolveVideoId(normalizedHref, [
                candidate.videoId,
                candidate.id,
                candidate.video,
                candidate.video_id,
                candidate.watchId,
                candidate.href,
                candidate.url,
                candidate.watchUrl
            ]);
        }

        let href = buildWatchUrl(normalizedHref, videoId);

        const titleFallback = pickFirstString([
            normalizedTitle,
            collapseWhitespace(candidate.subtitle),
            collapseWhitespace(candidate.description),
            collapseWhitespace(candidate.heading),
            collapseWhitespace(candidate.text)
        ]);
        let title = titleFallback || "";

        if (!title) {
            title = pickFirstString([
                document.querySelector('meta[property="og:title"]')?.content,
                document.querySelector('meta[name="title"]')?.content,
                document.querySelector('meta[itemprop="name"]')?.content,
                getDocumentTitle()
            ], collapseWhitespace);
        }

        let channel = normalizedChannel;
        if (!channel) {
            channel = collapseWhitespace(
                candidate.ownerText ||
                candidate.ownerChannelName ||
                candidate.uploaderName ||
                ""
            );
        }
        if (!channel) {
            channel = pickFirstString([
                document.querySelector(CHANNEL_SELECTOR)?.textContent,
                document.querySelector('.ytp-title-channel-logo + span')?.textContent,
                document.querySelector('meta[itemprop="author"]')?.content,
                document.querySelector('meta[name="author"]')?.content
            ], collapseWhitespace);
        }

        const merged = {
            href: href || currentState.href,
            videoId: videoId || currentState.videoId,
            title: title || currentState.title,
            channel: channel || currentState.channel
        };

        if (!merged.videoId && merged.href) {
            merged.videoId = resolveVideoId(merged.href, candidate.videoId);
        }
        if (!merged.href && merged.videoId) {
            merged.href = buildWatchUrl("", merged.videoId);
        }
        if (!merged.title) {
            const docTitle = getDocumentTitle();
            if (docTitle) merged.title = docTitle;
        }
        if (!merged.channel) {
            const channelFromDom = pickFirstString([
                document.querySelector(CHANNEL_SELECTOR)?.textContent,
                document.querySelector('.ytp-title-channel-logo + span')?.textContent
            ], collapseWhitespace);
            if (channelFromDom) {
                merged.channel = channelFromDom;
            }
        }

        if (!hasMeaningfulData(merged)) {
            return;
        }

        if (
            merged.href === currentState.href &&
            merged.title === currentState.title &&
            merged.videoId === currentState.videoId &&
            merged.channel === currentState.channel
        ) {
            return;
        }

        currentState = merged;
        sendUpdate({
            ...merged,
            source: source ? String(source) : safeTrim(candidate.source || "")
        });
    };

    const pickFromDom = () => {
        const link = document.querySelector(TITLE_SELECTOR);
        const href = pickFirstString([
            link?.getAttribute('href'),
            link?.href,
            document.querySelector('link[rel="canonical"]')?.href,
            document.querySelector('meta[itemprop="url"]')?.content,
            document.querySelector('meta[property="og:video:url"]')?.content,
            document.querySelector('meta[property="og:url"]')?.content,
            document.querySelector('link[rel="shortlinkUrl"]')?.href,
            document.querySelector('meta[itemprop="embedURL"]')?.content
        ], normalizeHref);

        let videoId = "";
        const videoIdCandidates = [
            link?.getAttribute('href'),
            link?.href,
            document.querySelector('meta[itemprop="videoId"]')?.content,
            document.querySelector('meta[itemprop="videoIdString"]')?.content,
            document.querySelector('meta[property="og:video:url"]')?.content,
            document.querySelector('meta[property="og:url"]')?.content,
            document.querySelector('link[rel="shortlinkUrl"]')?.href,
            href
        ];
        for (const candidate of videoIdCandidates) {
            videoId = resolveVideoId(candidate);
            if (videoId) break;
        }

        const title = pickFirstString([
            link?.textContent,
            document.querySelector('meta[property="og:title"]')?.content,
            document.querySelector('meta[name="title"]')?.content,
            document.querySelector('meta[itemprop="name"]')?.content,
            getDocumentTitle()
        ], collapseWhitespace);

        const channel = pickFirstString([
            document.querySelector(CHANNEL_SELECTOR)?.textContent,
            document.querySelector('.ytp-title-channel-logo + span')?.textContent,
            document.querySelector('meta[itemprop="author"]')?.content,
            document.querySelector('meta[name="author"]')?.content
        ], collapseWhitespace);

        const result = { href, videoId, title, channel };
        if (!hasMeaningfulData(result)) {
            return null;
        }
        return result;
    };

    const handleDomUpdate = () => {
        const candidate = pickFromDom();
        if (candidate) {
            applyCandidate(candidate, "dom");
        }
    };

    const observer = new MutationObserver(handleDomUpdate);
    const rootNode = document.documentElement || document.body;
    if (rootNode) {
        observer.observe(rootNode, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    const intervalId = setInterval(handleDomUpdate, 1000);

    const navigationHandler = () => { handleDomUpdate(); };
    const navEvents = [
        "yt-navigate-start",
        "yt-navigate-finish",
        "yt-navigate-cache",
        "yt-page-data-updated",
        "yt-player-updated",
        "spfdone",
        "transitionend"
    ];
    navEvents.forEach((eventName) => {
        window.addEventListener(eventName, navigationHandler, true);
        document.addEventListener(eventName, navigationHandler, true);
    });

    const visibilityHandler = () => handleDomUpdate();
    document.addEventListener("visibilitychange", visibilityHandler, true);

    const messageHandler = (event) => {
        if (!event || event.source !== window) return;
        const data = event.data;
        if (!data || typeof data !== "object") return;
        if (!data.__nomYT || data.type !== BRIDGE_MESSAGE) return;
        const payload = data.payload;
        if (!payload || typeof payload !== "object") return;
        applyCandidate(payload, payload.source || "bridge");
    };
    window.addEventListener("message", messageHandler, false);

    let mainWorldBridgeLastRequestTs = 0;

    const requestMainWorldBridge = (reason) => {
        if (!chrome?.runtime?.sendMessage) return;
        const now = Date.now();
        if (now - mainWorldBridgeLastRequestTs < 1500) {
            return;
        }
        mainWorldBridgeLastRequestTs = now;
        try {
            chrome.runtime.sendMessage({
                type: "YT_REQUEST_MAIN_WORLD_BRIDGE",
                payload: {
                    reason: reason || "unspecified",
                    href: location.href,
                    ts: now
                }
            }, () => {
                const err = chrome.runtime?.lastError;
                void err;
            });
        } catch { /* ignore messaging errors */ }
    };

    handleDomUpdate();
    requestMainWorldBridge("initial");

    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { observer.disconnect(); } catch {}
        try { clearInterval(intervalId); } catch {}
        navEvents.forEach((eventName) => {
            window.removeEventListener(eventName, navigationHandler, true);
            document.removeEventListener(eventName, navigationHandler, true);
        });
        document.removeEventListener("visibilitychange", visibilityHandler, true);
        window.removeEventListener("message", messageHandler, false);
    };

    window.addEventListener("pagehide", cleanup);
    window.addEventListener("unload", cleanup);
})();
