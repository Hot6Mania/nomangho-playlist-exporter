// YouTube Data API helpers
// Handles OAuth tokens via chrome.identity with optional interactive consent.

import { getSettings } from "./storage.js";

const YT_BASE = "https://www.googleapis.com/youtube/v3";

const identityGetAuthToken = (interactive) => new Promise((resolve, reject) => {
    try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime?.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!token) {
                reject(new Error("토큰을 가져오지 못했습니다."));
                return;
            }
            resolve(token);
        });
    } catch (err) {
        reject(err);
    }
});

const identityRemoveCachedToken = (token) => new Promise((resolve) => {
    if (!token) {
        resolve();
        return;
    }
    try {
        chrome.identity.removeCachedAuthToken({ token }, () => {
            // ignore errors, resolve regardless
            resolve();
        });
    } catch {
        resolve();
    }
});

async function isLinkingEnabled() {
    const settings = await getSettings();
    if (typeof settings.keepYouTubeLinked === "boolean") {
        return settings.keepYouTubeLinked;
    }
    return !!settings.enableYouTubeApi;
}

async function acquireAuthToken({ allowInteractive = true } = {}) {
    if (!(await isLinkingEnabled())) {
        throw new Error("YouTube 연동이 비활성화되어 있습니다.");
    }

    try {
        const silentToken = await identityGetAuthToken(false);
        if (silentToken) {
            return silentToken;
        }
    } catch (err) {
        if (!allowInteractive) {
            throw err;
        }
    }

    if (!allowInteractive) {
        throw new Error("토큰을 가져오지 못했습니다.");
    }

    return identityGetAuthToken(true);
}

async function ytFetch(path, method, body) {
    let token = await acquireAuthToken({ allowInteractive: true });

    const doFetch = async (authToken) => {
        const res = await fetch(`${YT_BASE}${path}`, {
            method,
            headers: {
                "Authorization": `Bearer ${authToken}`,
                "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined
        });
        return res;
    };

    let response = await doFetch(token);
    if (response.status === 401) {
        await identityRemoveCachedToken(token);
        token = await acquireAuthToken({ allowInteractive: true });
        response = await doFetch(token);
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`YouTube API ${method} ${path} failed: ${response.status} ${text}`);
    }

    return response.json();
}

export async function createPlaylist(title) {
    const body = {
        snippet: { title: title || "SyncTube Export" },
        status: { privacyStatus: "private" }
    };
    const json = await ytFetch("/playlists?part=snippet,status", "POST", body);
    return json?.id;
}

export async function addVideoToPlaylist(playlistId, videoId) {
    const body = {
        snippet: {
            playlistId,
            resourceId: { kind: "youtube#video", videoId }
        }
    };
    const json = await ytFetch("/playlistItems?part=snippet", "POST", body);
    return json?.id;
}

export async function searchVideos(query, { maxResults = 5 } = {}) {
    if (!query || !query.trim()) {
        return [];
    }
    const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        order: "relevance",
        maxResults: String(Math.max(1, Math.min(maxResults, 10))),
        q: query.trim(),
        videoEmbeddable: "true"
    });
    const json = await ytFetch(`/search?${params.toString()}`, "GET");
    return Array.isArray(json?.items) ? json.items : [];
}
