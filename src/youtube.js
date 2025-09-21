
(() => {
    const host = location.hostname || "";
    const isYouTubeHost = /(^|\.)youtube(?:-nocookie)?\.com$/i.test(host);
    if (!isYouTubeHost) return;

    const TITLE_SELECTOR = "a.ytp-title-link";
    const CHANNEL_SELECTOR = ".ytp-title-channel-name, .ytp-title-channel-name a, .ytp-title-channel-logo + span";
    const BRIDGE_MESSAGE = "nomangho:yt-now-playing";
    const BRIDGE_ATTR = "data-nomangho-yt-bridge-injected";

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

    const pageBridgeScript = `(() => {
        const BRIDGE_MESSAGE = "nomangho:yt-now-playing";
        const BRIDGE_FLAG = "__nomanghoYTBridgeInjected__";
        if (window[BRIDGE_FLAG]) return;
        window[BRIDGE_FLAG] = true;

        const safeTrim = (value) => {
            if (typeof value === "string") return value.trim();
            if (value === null || value === undefined) return "";
            return String(value).trim();
        };

        const collapseWhitespace = (value) => safeTrim(value).replace(/\s+/g, " ").trim();
        const buildWatchUrl = (videoId) => (videoId ? "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) : "");

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
            } catch {}
            const fallbackMatch = str.match(/(?:v=|\/embed\/|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{6,})/);
            return fallbackMatch && fallbackMatch[1] ? fallbackMatch[1] : "";
        };

        const shouldTriggerForUrl = (url) => {
            if (!url) return false;
            try {
                const str = String(url);
                return str.includes("/player?") || str.includes("/next?") || str.includes("/watchtime?");
            } catch {
                return false;
            }
        };

        const readDetails = () => {
            let videoId = "";
            let title = "";
            let channel = "";
            let href = "";

            const applyDetails = (details) => {
                if (!details) return;
                if (!videoId && details.videoId) videoId = safeTrim(details.videoId);
                if (!title && details.title) title = collapseWhitespace(details.title);
                const author = details.author || details.channel || details.ownerChannelName;
                if (!channel && author) channel = collapseWhitespace(author);
            };

            try { applyDetails(window.ytInitialPlayerResponse?.videoDetails); } catch {}
            try { applyDetails(window.ytInitialData?.playerResponse?.videoDetails); } catch {}
            try { applyDetails(window.ytInitialData?.playerResponse?.microformat?.playerMicroformatRenderer); } catch {}

            try {
                const args = window.ytplayer?.config?.args || {};
                applyDetails({
                    videoId: args.video_id || args.videoId,
                    title: args.title,
                    channel: args.author || args.channel
                });
                const pr = args.player_response;
                if (pr) {
                    if (typeof pr === "string") {
                        try {
                            const parsed = JSON.parse(pr);
                            applyDetails(parsed?.videoDetails);
                            if (!channel && parsed?.videoDetails?.author) {
                                channel = collapseWhitespace(parsed.videoDetails.author);
                            }
                        } catch {}
                    } else if (typeof pr === "object") {
                        applyDetails(pr?.videoDetails);
                        if (!channel && pr?.videoDetails?.author) {
                            channel = collapseWhitespace(pr.videoDetails.author);
                        }
                    }
                }
            } catch {}

            if (!href) {
                href = pickFirstString([
                    document.querySelector('link[rel="canonical"]')?.href,
                    document.querySelector('meta[itemprop="url"]')?.content,
                    document.querySelector('meta[property="og:video:url"]')?.content,
                    document.querySelector('meta[property="og:url"]')?.content,
                    document.querySelector('link[rel="shortlinkUrl"]')?.href,
                    document.querySelector('meta[itemprop="embedURL"]')?.content
                ], safeTrim);
            }

            if (!videoId) {
                videoId = pickFirstString([
                    videoId,
                    document.querySelector('meta[itemprop="videoId"]')?.content,
                    document.querySelector('meta[itemprop="videoIdString"]')?.content,
                    document.querySelector('meta[property="og:video:url"]')?.content,
                    document.querySelector('meta[property="og:url"]')?.content,
                    href
                ], safeTrim);
                if (videoId) {
                    const extracted = extractVideoId(videoId);
                    if (extracted) videoId = extracted;
                }
            }

            if (videoId && !href) {
                href = buildWatchUrl(videoId);
            }

            if (!title) {
                title = pickFirstString([
                    document.querySelector('meta[property="og:title"]')?.content,
                    document.querySelector('meta[name="title"]')?.content,
                    document.querySelector('meta[itemprop="name"]')?.content,
                    document.title ? document.title.replace(/ - YouTube$/i, "") : ""
                ], collapseWhitespace);
            }

            if (!channel) {
                channel = pickFirstString([
                    document.querySelector('.ytp-title-channel-name')?.textContent,
                    document.querySelector('.ytp-title-channel-name a')?.textContent,
                    document.querySelector('.ytp-title-channel-logo + span')?.textContent,
                    document.querySelector('meta[itemprop="author"]')?.content,
                    document.querySelector('meta[name="author"]')?.content
                ], collapseWhitespace);
            }

            return { videoId, title, channel, href };
        };

        let lastSent = { videoId: "", title: "", channel: "", href: "" };

        const hasMeaningfulData = (payload) => Boolean(payload && (payload.videoId || payload.href || payload.title));
        const hasChanged = (payload) => (
            payload.videoId !== lastSent.videoId ||
            payload.title !== lastSent.title ||
            payload.channel !== lastSent.channel ||
            payload.href !== lastSent.href
        );

        const emit = (reason) => {
            try {
                const payload = readDetails();
                if (!hasMeaningfulData(payload)) return;
                if (payload.videoId && !payload.href) {
                    payload.href = buildWatchUrl(payload.videoId);
                }
                if (!payload.title && document.title) {
                    payload.title = collapseWhitespace(document.title.replace(/ - YouTube$/i, ""));
                }
                if (!payload.channel) {
                    const domChannel = pickFirstString([
                        document.querySelector('.ytp-title-channel-name')?.textContent,
                        document.querySelector('.ytp-title-channel-name a')?.textContent,
                        document.querySelector('.ytp-title-channel-logo + span')?.textContent
                    ], collapseWhitespace);
                    if (domChannel) payload.channel = domChannel;
                }
                if (!hasChanged(payload)) return;
                lastSent = { ...payload };
                window.postMessage({
                    __nomYT: true,
                    type: BRIDGE_MESSAGE,
                    payload: { ...payload, source: "bridge", reason }
                }, "*");
            } catch {}
        };

        let timer = null;
        const schedule = (reason) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => emit(reason), 0);
        };

        const navEvents = [
            "yt-navigate-start",
            "yt-navigate-finish",
            "yt-navigate-cache",
            "yt-page-data-updated",
            "yt-player-updated",
            "spfdone"
        ];
        navEvents.forEach((eventName) => {
            window.addEventListener(eventName, () => schedule(eventName), true);
            document.addEventListener(eventName, () => schedule(eventName), true);
        });

        document.addEventListener("visibilitychange", () => schedule("visibilitychange"), true);

        try {
            const origPush = history.pushState;
            history.pushState = function () {
                const result = origPush.apply(this, arguments);
                schedule("pushState");
                return result;
            };
        } catch {}

        try {
            const origReplace = history.replaceState;
            history.replaceState = function () {
                const result = origReplace.apply(this, arguments);
                schedule("replaceState");
                return result;
            };
        } catch {}

        if (typeof window.fetch === "function") {
            const origFetch = window.fetch;
            window.fetch = function () {
                const response = origFetch.apply(this, arguments);
                Promise.resolve(response).then(() => {
                    try {
                        const req = arguments[0];
                        const url = typeof req === "string"
                            ? req
                            : (req && (req.url || (typeof req.toString === "function" ? req.toString() : ""))) || "";
                        if (shouldTriggerForUrl(url)) {
                            schedule("fetch");
                        }
                    } catch {}
                });
                return response;
            };
        }

        if (typeof XMLHttpRequest !== "undefined") {
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
                if (typeof url === "string") {
                    this.addEventListener("load", () => {
                        if (shouldTriggerForUrl(url)) {
                            schedule("xhr");
                        }
                    });
                }
                return origOpen.apply(this, arguments);
            };
        }

        try {
            const descriptor = Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse");
            let currentValue = window.ytInitialPlayerResponse;
            if (!descriptor || descriptor.configurable !== false) {
                Object.defineProperty(window, "ytInitialPlayerResponse", {
                    configurable: true,
                    enumerable: true,
                    get() { return currentValue; },
                    set(value) {
                        currentValue = value;
                        schedule("ytInitialPlayerResponse");
                    }
                });
            }
        } catch {}

        try {
            const descriptor = Object.getOwnPropertyDescriptor(window, "ytplayer");
            let currentValue = window.ytplayer;
            if (!descriptor || descriptor.configurable !== false) {
                Object.defineProperty(window, "ytplayer", {
                    configurable: true,
                    enumerable: true,
                    get() { return currentValue; },
                    set(value) {
                        currentValue = value;
                        schedule("ytplayer");
                    }
                });
            }
        } catch {}

        setInterval(() => emit("interval"), 1000);
        schedule("init");
        emit("init");
    })();`;

    const injectBridge = () => {
        if (!document || !document.documentElement) return false;
        if (document.documentElement.getAttribute(BRIDGE_ATTR) === "1") {
            return true;
        }
        try {
            const script = document.createElement("script");
            script.type = "text/javascript";
            script.textContent = pageBridgeScript;
            (document.documentElement || document.head || document.body).appendChild(script);
            if (script.parentNode) {
                script.parentNode.removeChild(script);
            }
            document.documentElement.setAttribute(BRIDGE_ATTR, "1");
            return true;
        } catch {
            return false;
        }
    };

    let reinjectIntervalId = null;
    const ensureBridge = () => {
        if (injectBridge()) {
            if (reinjectIntervalId) {
                clearInterval(reinjectIntervalId);
                reinjectIntervalId = null;
            }
            return;
        }
        if (reinjectIntervalId) return;
        reinjectIntervalId = setInterval(() => {
            if (injectBridge()) {
                clearInterval(reinjectIntervalId);
                reinjectIntervalId = null;
            }
        }, 500);
    };

    ensureBridge();

    handleDomUpdate();

    let cleanedUp = false;
    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { observer.disconnect(); } catch {}
        try { clearInterval(intervalId); } catch {}
        if (reinjectIntervalId) {
            try { clearInterval(reinjectIntervalId); } catch {}
            reinjectIntervalId = null;
        }
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
