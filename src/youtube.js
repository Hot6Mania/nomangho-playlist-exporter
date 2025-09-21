(() => {
    let lastHref = null;
    let lastTitle = null;
    let lastVideoId = null;

    const getAnchor = () =>
        document.querySelector('a.ytp-title-link[href^="https://www.youtube.com/watch"]');

    const pick = () => {
        const a = getAnchor();
        if (!a) return null;

        const href = a.getAttribute('href') || "";
        const title = (a.textContent || "").trim();
        let videoId = null;
        try {
            const url = new URL(href);
            videoId = url.searchParams.get('v') || null;
        } catch (err) {
            videoId = null;
        }

        return { href, title, videoId };
    };

    const sendIfChanged = () => {
        const cur = pick();
        if (!cur || !cur.videoId) return;

        if (cur.href !== lastHref || cur.title !== lastTitle || cur.videoId !== lastVideoId) {
            lastHref = cur.href;
            lastTitle = cur.title;
            lastVideoId = cur.videoId;

            try {
                const maybePromise = chrome.runtime.sendMessage({
                    type: "yt-now-playing",
                    payload: {
                        href: cur.href,
                        title: cur.title,
                        videoId: cur.videoId
                    }
                });
                if (maybePromise && typeof maybePromise.catch === "function") {
                    maybePromise.catch(() => { /* ignore */ });
                }
            } catch {
                // ignore messaging errors
            }
        }
    };

    const interval = setInterval(sendIfChanged, 1000);

    const mo = new MutationObserver(() => sendIfChanged());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('unload', () => {
        clearInterval(interval);
        mo.disconnect();
    });
})();