# SyncTube → YouTube Playlist Exporter (Chrome MV3)


Collects currently playing tracks from a SyncTube site, stores them, and exports to CSV or a YouTube playlist.


## Install (Developer Mode)
1. Clone this folder.
2. `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → select the project folder.


## Usage
- Open your SyncTube page. Start playing videos.
- Click the extension icon → see captured tracks.
- **Export CSV**: one click, no OAuth required.
- **Create/Add to YouTube playlist**: toggle **Enable YouTube API** and authorize when prompted.


## Notes
- Content script uses MutationObserver and a 3s polling fallback.
- De-dupe uses `videoId|title` to avoid noisy repeats.
- Playlist creation inserts items sequentially with a small delay to be gentle on quotas.


## Security
- MV3 service worker background, minimal permissions (storage, scripting; host permissions for embed parsing / optional YouTube usage).


## Extending
- Persist candidate items scraped from the sidebar.
- Support non-YouTube players (SoundCloud) with separate exports.