// YouTube Data API helpers
// Handles OAuth via launchWebAuthFlow with simple token persistence.

import { getSettings, getAuthSession, setAuthSession } from "./storage.js";

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const CLIENT_ID = "167372131380-ononri3opot09qdgl3s47hiq62u0dg6q.apps.googleusercontent.com";
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl"
];

let cachedToken = null;
let tokenExpiresAt = 0;
let hydratedFromStorage = false;
async function hydrateTokenFromStorage() {
    if (hydratedFromStorage) return;
    hydratedFromStorage = true;
    try {
        const stored = await getAuthSession();
        if (stored?.token && stored?.expiresAt && stored.expiresAt > Date.now()) {
            cachedToken = stored.token;
            tokenExpiresAt = stored.expiresAt;
        }
    } catch {
        // ignore storage errors and fall back to interactive flow
    }
}

function isTokenValid() {
    return cachedToken && Date.now() < tokenExpiresAt - 5000;
}

async function persistToken(token, expiresInSeconds) {
    cachedToken = token;
    tokenExpiresAt = Date.now() + Math.max(0, expiresInSeconds) * 1000;
    await setAuthSession({ token: cachedToken, expiresAt: tokenExpiresAt });
}

async function clearPersistedToken() {
    cachedToken = null;
    tokenExpiresAt = 0;
    await setAuthSession(null);
}
async function getTokenViaLaunchWebAuthFlow() {
    const { enableYouTubeApi } = await getSettings();
    if (!enableYouTubeApi) throw new Error("YouTube API disabled in settings");

    const authUrl =
        "https://accounts.google.com/o/oauth2/auth" +
        `?client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=token` +
        `&scope=${encodeURIComponent(SCOPES.join(" "))}` +
        `&prompt=consent`;

    const responseUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (url) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!url) return reject(new Error("OAuth redirect missing"));
            resolve(url);
        });
    });

    const hash = new URL(responseUrl).hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    const expiresIn = parseInt(params.get("expires_in") || "0", 10);

    if (!token) throw new Error("No access_token in redirect");

    await persistToken(token, expiresIn || 3600);
    return token;
}

async function ensureAuthToken() {
    if (!hydratedFromStorage) await hydrateTokenFromStorage();
    if (isTokenValid()) return cachedToken;
    try {
        return await getTokenViaLaunchWebAuthFlow();
    } catch (err) {
        await clearPersistedToken();
        throw err;
    }
}
async function ytFetch(path, method, body) {
    let token = await ensureAuthToken();
    let res = await fetch(`${YT_BASE}${path}`, {
        method,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
        await clearPersistedToken();
        token = await ensureAuthToken();
        res = await fetch(`${YT_BASE}${path}`, {
            method,
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined
        });
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`YouTube API ${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
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
