import { getSettings, setSettings } from "./common/storage.js";

function showMessage(kind, text) {
    const box = document.querySelector("#optionsMessage");
    if (!box) return;
    if (!text) {
        box.classList.remove("show");
        box.textContent = "";
        return;
    }
    box.dataset.kind = kind;
    box.textContent = text;
    box.classList.add("show");
}

window.addEventListener("DOMContentLoaded", async () => {
    try {
        const settings = await getSettings();
        document.querySelector("#defaultPlaylistName").value = settings.defaultPlaylistName || "SyncTube Export";
        const keepLinked = typeof settings.keepYouTubeLinked === "boolean"
            ? settings.keepYouTubeLinked
            : !!settings.enableYouTubeApi;
        document.querySelector("#keepYouTubeLinked").checked = keepLinked;
    } catch (err) {
        showMessage("error", `설정을 불러오지 못했습니다: ${err?.message || err}`);
    }

    document.querySelector("#save").addEventListener("click", async () => {
        try {
            const name = document.querySelector("#defaultPlaylistName").value.trim() || "SyncTube Export";
            const keepLinked = document.querySelector("#keepYouTubeLinked").checked;
            await setSettings({ defaultPlaylistName: name, keepYouTubeLinked: keepLinked });
            showMessage("success", "저장되었습니다.");
        } catch (err) {
            showMessage("error", `저장 중 문제가 발생했습니다: ${err?.message || err}`);
        }
    });
});
