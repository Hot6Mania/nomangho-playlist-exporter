function send(type, payload) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, resolve);
    });
}

function fmtTime(ts) {
    try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

function extractIdFromAny(value) {
    if (!value) return "";
    const match = String(value).trim().match(
        /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/
    );
    if (match && match[1]) return match[1];
    return String(value).trim();
}

function toWatchUrl(videoId) {
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

const state = {
    roomId: null,
    roomName: "",
    rooms: [],
    playlistLink: null
};

function qs(selector) {
    return document.querySelector(selector);
}

function getRoomIdFromUrl(url) {
    if (!url) return "";
    const match = String(url).match(/\/room\/([^/?#]+)/i);
    return match && match[1] ? match[1] : "";
}

function getRoomNameFromTitle(title) {
    if (!title) return "";
    const parts = title.split(" - ");
    const name = parts.length > 1 ? parts[0].trim() : title.trim();
    return name;
}

function queryActiveTab() {
    return new Promise((resolve) => {
        if (!chrome.tabs?.query) {
            resolve([]);
            return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                resolve([]);
                return;
            }
            resolve(tabs || []);
        });
    });
}

async function detectActiveRoom() {
    const tabs = await queryActiveTab();
    const tab = tabs[0];
    if (!tab) return null;
    const roomId = getRoomIdFromUrl(tab.url || "");
    if (!roomId) return null;
    const roomName = getRoomNameFromTitle(tab.title || "");
    return { roomId, roomName };
}

function setMessage(kind, text) {
    const box = qs("#message");
    if (!box) return;
    if (!text) {
        box.textContent = "";
        box.dataset.kind = "";
        box.classList.add("hidden");
        return;
    }
    box.textContent = text;
    box.dataset.kind = kind;
    box.classList.remove("hidden");
}

function renderRooms() {
    const select = qs("#roomSelect");
    if (!select) return;
    const wrapper = select.closest(".field-group");
    select.innerHTML = "";

    if (!state.rooms.length) {
        select.disabled = true;
        if (wrapper) wrapper.classList.add("room-select-hidden");
        return;
    }

    state.rooms.forEach(room => {
        const opt = document.createElement("option");
        opt.value = room.id;
        opt.textContent = room.name || room.id;
        select.appendChild(opt);
    });

    if (state.roomId) {
        select.value = state.roomId;
    }
    select.disabled = true;
    if (wrapper) wrapper.classList.add("room-select-hidden");
}

function renderTracks(tracks) {
    const tbody = qs("#tracks tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!tracks.length) {
        const emptyRow = document.createElement("tr");
        const emptyCell = document.createElement("td");
        emptyCell.colSpan = 6;
        emptyCell.className = "empty";
        emptyCell.textContent = "현재 수집된 곡이 없습니다.";
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
    }

    tracks.forEach((track, index) => {
        const tr = document.createElement("tr");

        const indexCell = document.createElement("td");
        indexCell.textContent = String(index + 1);
        tr.appendChild(indexCell);

        const titleCell = document.createElement("td");
        titleCell.className = "ellipsize";
        titleCell.textContent = track.title || "";
        titleCell.title = track.title || "";
        tr.appendChild(titleCell);

        const channelCell = document.createElement("td");
        channelCell.className = "ellipsize";
        channelCell.textContent = track.channel || "";
        channelCell.title = track.channel || "";
        tr.appendChild(channelCell);

        const videoCell = document.createElement("td");
        const videoId = track.videoId || "";
        if (videoId) {
            const link = document.createElement("a");
            link.href = track.watchUrl || toWatchUrl(videoId);
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = videoId;
            link.title = link.href;
            videoCell.appendChild(link);
        }
        tr.appendChild(videoCell);

        const timeCell = document.createElement("td");
        timeCell.textContent = fmtTime(track.ts);
        tr.appendChild(timeCell);

        const actionCell = document.createElement("td");
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-remove";
        removeBtn.dataset.index = String(index);
        removeBtn.textContent = "삭제";
        actionCell.appendChild(removeBtn);
        tr.appendChild(actionCell);

        tbody.appendChild(tr);
    });
}

async function refreshTracks() {
    if (!state.roomId) {
        renderTracks([]);
        renderRooms();
        return;
    }
    const res = await send("GET_TRACKS", { roomId: state.roomId });
    if (!res?.ok) {
        setMessage("error", res?.error || "트랙을 불러오지 못했습니다.");
        return;
    }
    if (res.roomId) {
        state.roomId = res.roomId;
    }
    if (res.roomName) {
        state.roomName = res.roomName;
    }
    renderTracks(res.tracks || []);
    renderRooms();
}

async function loadRooms() {
    const res = await send("GET_ROOMS");
    if (!res?.ok) return;
    state.rooms = res.rooms || [];
    if (state.roomId && !state.rooms.some(r => r.id === state.roomId)) {
        state.rooms.unshift({ id: state.roomId, name: state.roomName || state.roomId, trackCount: 0 });
    }
    if (!state.roomId && state.rooms.length) {
        state.roomId = state.rooms[0].id;
        state.roomName = state.rooms[0].name || state.roomId;
    } else if (state.roomId) {
        const active = state.rooms.find(r => r.id === state.roomId);
        if (active && active.name) {
            state.roomName = active.name;
        }
    }
    renderRooms();
}

async function applyActiveRoom(roomId, roomName) {
    if (!roomId) return;
    state.roomId = roomId;
    if (roomName) {
        state.roomName = roomName;
    }
    await send("SET_ACTIVE_ROOM", { roomId: state.roomId, roomName: state.roomName });
}

async function clearTracks() {
    if (!state.roomId) return;
    const res = await send("CLEAR_TRACKS", { roomId: state.roomId });
    if (!res?.ok) {
        setMessage("error", res?.error || "리스트를 비우지 못했습니다.");
        return;
    }
    setMessage("info", "리스트를 비웠습니다.");
    await refreshTracks();
}

async function addTrackManually(e) {
    e?.preventDefault?.();
    const title = qs("#manualTitle").value.trim();
    const channel = qs("#manualChannel").value.trim();
    const input = qs("#manualVideoId").value.trim();
    const videoId = extractIdFromAny(input);
    if (!videoId) {
        setMessage("error", "유효한 YouTube ID 또는 링크를 입력하세요.");
        return;
    }
    const res = await send("MANUAL_ADD_TRACK", {
        roomId: state.roomId,
        roomName: state.roomName,
        track: { title, channel, videoId }
    });
    if (!res?.ok) {
        setMessage("error", res?.error || "곡을 추가하지 못했습니다.");
        return;
    }
    qs("#manualTitle").value = "";
    qs("#manualChannel").value = "";
    qs("#manualVideoId").value = "";
    setMessage("success", "곡을 추가했습니다.");
    renderTracks(res.tracks || []);
    renderRooms();
}

async function removeTrack(index) {
    const res = await send("REMOVE_TRACK", { roomId: state.roomId, index });
    if (!res?.ok) {
        setMessage("error", res?.error || "곡을 삭제하지 못했습니다.");
        return;
    }
    setMessage("info", "곡을 삭제했습니다.");
    renderTracks(res.tracks || []);
    renderRooms();
}

function exportCSV() {
    send("GET_TRACKS", { roomId: state.roomId }).then(res => {
        if (!res?.ok) {
            setMessage("error", "트랙을 내보내지 못했습니다.");
            return;
        }
        const rows = [["title", "channel", "videoId", "timestamp"]];
        (res.tracks || []).forEach(t => {
            rows.push([t.title || "", t.channel || "", t.videoId || "", new Date(t.ts || Date.now()).toISOString()]);
        });
        const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `synctube_export_${state.roomId || "room"}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

function handleTableClick(e) {
    const btn = e.target.closest(".btn-remove");
    if (!btn) return;
    const index = Number(btn.dataset.index);
    if (!Number.isInteger(index)) return;
    removeTrack(index);
}

async function loadSettings() {
    const r = await send("GET_SETTINGS");
    if (!r?.ok) return;
    qs("#playlistName").value = r.settings?.defaultPlaylistName || "";
    const keepLinked = typeof r.settings?.keepYouTubeLinked === "boolean"
        ? r.settings.keepYouTubeLinked
        : !!r.settings?.enableYouTubeApi;
    qs("#keepYouTubeLinked").checked = keepLinked;
}

async function saveSettings() {
    const name = qs("#playlistName").value.trim();
    const keepYouTubeLinked = qs("#keepYouTubeLinked").checked;
    await send("SET_SETTINGS", { defaultPlaylistName: name || "SyncTube Export", keepYouTubeLinked });
}

async function createPlaylistAndRemember() {
    await saveSettings();
    const name = qs("#playlistName").value.trim() || "SyncTube Export";
    const r = await send("CREATE_YT_PLAYLIST", { name });
    if (!r?.ok) {
        setMessage("error", r?.error || "플레이리스트 생성 실패");
        return null;
    }
    const id = r.playlistId;
    if (!id) {
        setMessage("error", "playlistId가 없습니다.");
        return null;
    }
    state.playlistLink = `https://www.youtube.com/playlist?list=${id}`;
    setMessage("success", "플레이리스트를 생성했습니다.");
    renderPlaylistLink();
    return id;
}

async function onCreatePlaylist() {
    await createPlaylistAndRemember();
}

async function addAllToPlaylistById(playlistId, { notify = true } = {}) {
    const r = await send("ADD_ALL_TO_PLAYLIST", { playlistId, roomId: state.roomId });
    if (!r?.ok) {
        setMessage("error", r?.error || "플레이리스트에 추가하지 못했습니다.");
        return null;
    }
    state.playlistLink = `https://www.youtube.com/playlist?list=${playlistId}`;
    if (notify) {
        setMessage("success", `${r.count || 0}곡을 추가했습니다.`);
    }
    renderPlaylistLink();
    return r.count || 0;
}

async function onAddAllToPlaylist() {
    await saveSettings();
    let playlistId = extractIdFromAny(qs("#playlistIdInput").value.trim());
    if (!playlistId && state.playlistLink) {
        const match = state.playlistLink.match(/list=([a-zA-Z0-9_-]+)/);
        playlistId = match ? match[1] : "";
    }
    if (!playlistId) {
        setMessage("error", "플레이리스트 ID를 입력하세요.");
        return;
    }
    await addAllToPlaylistById(playlistId);
}

async function onCreateAndFill() {
    const playlistId = await createPlaylistAndRemember();
    if (!playlistId) return;
    const count = await addAllToPlaylistById(playlistId, { notify: false });
    if (count !== null) {
        setMessage("success", `새로 만든 플레이리스트에 ${count}곡을 추가했습니다.`);
        renderPlaylistLink();
    }
}

function renderPlaylistLink() {
    const linkEl = qs("#playlistLink");
    if (!linkEl) return;
    if (!state.playlistLink) {
        linkEl.classList.add("hidden");
        linkEl.setAttribute("href", "#");
        linkEl.textContent = "YouTube에서 플레이리스트 열기";
        return;
    }
    linkEl.classList.remove("hidden");
    linkEl.setAttribute("href", state.playlistLink);
    linkEl.textContent = state.playlistLink;
}

window.addEventListener("DOMContentLoaded", async () => {
    const detected = await detectActiveRoom();
    if (detected?.roomId) {
        await applyActiveRoom(detected.roomId, detected.roomName);
    }

    await loadRooms();

    if (!state.roomId && state.rooms.length) {
        await applyActiveRoom(state.rooms[0].id, state.rooms[0].name);
    }

    await refreshTracks();
    renderPlaylistLink();

    qs("#btnClear").addEventListener("click", clearTracks);
    qs("#btnCsv").addEventListener("click", exportCSV);
    qs("#btnCreate").addEventListener("click", onCreatePlaylist);
    qs("#btnCreateFill").addEventListener("click", onCreateAndFill);
    qs("#btnAddAll").addEventListener("click", onAddAllToPlaylist);
    qs("#manualForm").addEventListener("submit", addTrackManually);
    qs("#tracks").addEventListener("click", handleTableClick);
    qs("#keepYouTubeLinked").addEventListener("change", saveSettings);
    qs("#playlistName").addEventListener("change", saveSettings);

    setInterval(refreshTracks, 2000);
});

