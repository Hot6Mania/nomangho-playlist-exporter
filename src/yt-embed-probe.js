(function () {
    const LINK_SELECTOR = 'a.ytp-title-link[href^="https://www.youtube.com/watch"]';
    let lastHref = null;

    function readLink() {
        const anchor = document.querySelector(LINK_SELECTOR);
        if (!anchor) return null;
        const href = anchor.href;
        let id = null;
        try {
            id = new URL(href).searchParams.get("v");
        } catch {
            id = null;
        }
        return { href, id };
    }

    function publish(reason) {
        const data = readLink();
        if (!data || !data.href) return;
        if (data.href === lastHref && reason !== "api") return;
        lastHref = data.href;
        chrome.runtime.sendMessage({
            type: "YTLINK_FROM_IFRAME",
            payload: { ...data, reason }
        });
    }

    publish("init");

    const observer = new MutationObserver(() => publish("mutation"));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => publish("interval"), 1000);

    function hookPlayerAPI() {
        if (!(window.YT && typeof window.YT.Player === "function")) {
            return;
        }
        let player = null;
        try {
            const frame = document.querySelector("#movie_player") || document.querySelector("iframe#player") || null;
            if (frame) {
                player = new YT.Player(frame);
            }
        } catch {
            player = null;
        }
        if (!player) return;

        function emitFromPlayer(tag) {
            try {
                const url = typeof player.getVideoUrl === "function" ? player.getVideoUrl() : null;
                const data = typeof player.getVideoData === "function" ? player.getVideoData() : null;
                const id = data?.video_id || null;
                const href = url || (id ? https://www.youtube.com/watch?v= : null);
                if (href) {
                    lastHref = href;
                    chrome.runtime.sendMessage({
                        type: "YTLINK_FROM_IFRAME",
                        payload: { href, id, reason: tag }
                    });
                }
            } catch {
                // ignore API glitches
            }
        }

        try {
            player.addEventListener("onStateChange", () => emitFromPlayer("api"));
            emitFromPlayer("api-init");
        } catch {
            // ignore
        }
    }

    let apiTries = 0;
    const apiTimer = setInterval(() => {
        if (window.YT && typeof window.YT.Player === "function") {
            clearInterval(apiTimer);
            hookPlayerAPI();
            return;
        }
        apiTries += 1;
        if (apiTries > 30) {
            clearInterval(apiTimer);
        }
    }, 200);
})();
