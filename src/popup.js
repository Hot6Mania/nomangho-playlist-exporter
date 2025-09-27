const state = {
  track: null,
  addedTracks: [],
  playlistUrl: null,
  note: null,
};

const els = {
  trackLabel: document.getElementById("trackLabel"),
  trackTitle: document.getElementById("trackTitle"),
  trackArtist: document.getElementById("trackArtist"),
  addedList: document.getElementById("addedList"),
  playlistStatus: document.getElementById("playlistStatus"),
  playlistLink: document.getElementById("playlistLink"),
  message: document.getElementById("message"),
  refresh: document.getElementById("refresh"),
};

function setMessage(kind, text) {
  if (!els.message) return;
  if (!text) {
    els.message.textContent = "";
    els.message.dataset.kind = "";
    els.message.classList.add("hidden");
    return;
  }
  els.message.textContent = text;
  els.message.dataset.kind = kind;
  els.message.classList.remove("hidden");
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}.${mm}.${dd}`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${min}`;
}

function renderTrack() {
  const track = state.track;
  if (!track) {
    els.trackLabel.textContent = "곡 정보를 불러오는 중입니다.";
    els.trackLabel.classList.add("muted");
    els.trackTitle.textContent = "";
    els.trackArtist.textContent = "";
    return;
  }

  const labelDate = formatDate(track.updatedAt);
  const roomLabel = track.roomTitle || track.roomId || "";
  if (labelDate || roomLabel) {
    const label = [labelDate, roomLabel].filter(Boolean).join(" - ");
    els.trackLabel.textContent = label || "최근 감지된 곡";
  } else {
    els.trackLabel.textContent = "최근 감지된 곡";
  }
  els.trackLabel.classList.remove("muted");

  els.trackTitle.textContent = track.title || "제목 정보를 찾지 못했어요.";
  els.trackArtist.textContent = track.author ? `아티스트: ${track.author}` : "아티스트 정보를 찾지 못했어요.";
}

function renderAddedTracks() {
  const container = els.addedList;
  if (!container) return;

  if (!state.addedTracks.length) {
    container.className = "added-empty";
    container.textContent = "아직 추가된 곡이 없어요.";
    return;
  }

  container.className = "added-list";
  container.innerHTML = "";

  state.addedTracks.forEach((item) => {
    const row = document.createElement("div");
    row.className = "added-item";

    if (item.thumbnail) {
      const img = document.createElement("img");
      img.className = "added-thumb";
      img.src = item.thumbnail;
      img.alt = "";
      row.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "added-thumb";
      row.appendChild(placeholder);
    }

    const info = document.createElement("div");
    info.className = "added-info";

    const title = document.createElement("p");
    title.className = "added-title";
    title.textContent = item.title || "제목 없음";
    info.appendChild(title);

    if (item.channel) {
      const channel = document.createElement("p");
      channel.className = "added-channel";
      channel.textContent = item.channel;
      info.appendChild(channel);
    }

    const meta = document.createElement("p");
    meta.className = "added-meta";
    meta.textContent = `추가: ${formatDate(item.addedAt)} ${formatTime(item.addedAt)}`;
    info.appendChild(meta);

    row.appendChild(info);
    container.appendChild(row);
  });
}

function renderPlaylistLink(url) {
  if (url) {
    els.playlistStatus.textContent = "Nomangho 서버가 최신 곡을 YouTube 플레이리스트에 추가했습니다.";
    els.playlistLink.href = url;
    els.playlistLink.classList.add("active");
    els.playlistLink.setAttribute("aria-disabled", "false");
  } else {
    els.playlistStatus.textContent = "YouTube 플레이리스트 링크가 준비되면 여기에 표시됩니다.";
    els.playlistLink.href = "#";
    els.playlistLink.classList.remove("active");
    els.playlistLink.setAttribute("aria-disabled", "true");
  }
}

function applyNote(note) {
  if (!note) {
    setMessage("", "");
    return;
  }

  const title = note.title || "";
  if (note.type === "added") {
    setMessage("success", `${title || "새 곡"}을(를) 플레이리스트에 추가했어요.`);
  } else if (note.type === "skipped-duplicate") {
    setMessage("info", `${title || "해당 곡"}은 이미 추가되어 건너뛰었어요.`);
  } else if (note.type === "no-results") {
    setMessage("info", "검색 결과를 찾지 못했어요. 제목/아티스트 정보를 확인해주세요.");
  } else if (note.type === "skip-empty-query") {
    setMessage("info", "곡 정보가 부족해서 자동 추가를 건너뛰었어요.");
  } else if (note.type === "invalid-result") {
    setMessage("error", "검색 결과가 올바르지 않아 추가하지 못했어요.");
  } else if (note.type === "error") {
    setMessage("error", note.message || "자동 추가 중 오류가 발생했어요.");
  } else {
    setMessage("info", "자동 추가 상태가 업데이트되었어요.");
  }
}

function requestStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setMessage("error", err.message);
        resolve(null);
        return;
      }
      if (!response?.ok) {
        setMessage("error", response?.error || "상태 정보를 불러오지 못했어요.");
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function applyStatus(status) {
  if (!status) {
    return;
  }
  state.track = status.track || null;
  state.addedTracks = Array.isArray(status.addedTracks) ? status.addedTracks : [];
  state.playlistUrl = status.playlistUrl || null;
  state.note = status.note || null;

  renderTrack();
  renderAddedTracks();
  renderPlaylistLink(state.playlistUrl);
  applyNote(state.note);
}

async function refreshState() {
  const status = await requestStatus();
  applyStatus(status);
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, "lastTrack")) {
    state.track = changes.lastTrack?.newValue || null;
    renderTrack();
  }
  if (Object.prototype.hasOwnProperty.call(changes, "addedTracks")) {
    state.addedTracks = changes.addedTracks?.newValue || [];
    renderAddedTracks();
  }
  if (Object.prototype.hasOwnProperty.call(changes, "lastPlaylistUrl")) {
    state.playlistUrl = changes.lastPlaylistUrl?.newValue || null;
    renderPlaylistLink(state.playlistUrl);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "lastAutoAddNote")) {
    state.note = changes.lastAutoAddNote?.newValue || null;
    applyNote(state.note);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  els.refresh.addEventListener("click", refreshState);
  refreshState();
});
