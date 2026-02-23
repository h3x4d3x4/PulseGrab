<p align="center">
  <img src="assets/embygrab_logo.png" alt="EmbyGrab Logo" width="150" />
</p>

# EmbyGrab — Browser Download Manager for Emby

> **A browser userscript to download anything from your Emby server — directly through the browser, with zero extra software.** Supports built-in downloads, JDownloader, wget/curl scripts, QR codes, clipboard, and 10+ export formats. 

## Current Version: **v1.0**

**Latest Release**: [EmbyGrab v1.0.js](releases/EmbyGrab%20v1.0.js)

---

## Quick Start

1. **Install a Userscript Manager** like Tampermonkey, Violentmonkey, or Greasemonkey in your browser (Chrome / Edge / Firefox / Safari).
2. **Add the script**: Paste the `EmbyGrab v1.0.js` code into a new script in your manager.
3. **Navigate** to your Emby server
4. **Click** the floating **"Get Links"** button that appears on any page

**Detailed Setup**: [Quick Start Guide](guides/EMBYGRAB-QUICK-START.md)

---

## Overview

### Download Manager
The built-in browser downloader features:

- **Stats View** — Big at-a-glance stat cards (Total / Done / Active / Queued / Failed), segmented colour progress bar with legend, per-folder breakdown table, and a live "Currently Downloading" panel with per-item speed + ETA
- **Per-item Controls** — each row has context-aware buttons:
  - `>` **Start / Resume** (green) — pending or paused items
  - `||` **Pause** (amber) — stop the stream, keep progress
  - `[]` **Stop** (red square) — abort and reset to pending
  - `O` **Retry** (amber) — restart a failed item and auto-queue it
  - `X` **Dismiss** (grey) — remove a failed item from the list
  - `O` **Re-download** (faded green) — re-fetch a completed item
  - `[v]` badge — completed items show a green checkmark indicator
- **Keyboard shortcuts** — `Esc` closes the manager, `Space` toggles pause/resume globally
- **Overall ETA** — shown live in the status bar while downloading
- **Scrollable list** — flex-column layout correctly constrains the list area

---

## Key Features

### Download Methods
| Method | Description |
|---|---|
| **Built-in Manager** | Download files directly in the browser — no extra app needed |
| **JDownloader** | One-click send to a running JD2 instance via local socket |
| **wget / curl Scripts** | Generate `.bat` / `.command` / `.sh` terminal scripts with correct filenames |
| **Clipboard** | Copy all URLs in your chosen format |
| **QR Code** | Scan links on mobile |
| **Email** | Send a batch of links via `mailto:` |

### Export Formats
Plain text · M3U8 · JSON · HTML · CSV · XML · wget · curl · aria2 · JDownloader package

### Content Support
- [x] Movies
- [x] TV Shows — entire series, individual seasons, or single episodes
- [x] Collections & BoxSets
- [x] Music — artists, albums, tracks
- [x] Generic folders & libraries
- [x] Server root (with large-batch confirmation)

### Smart Features
- **Bypass Mode** — Strict DirectPlay bypass for servers that restrict downloads
- **Download History** — local tracking; skip already-downloaded files
- **Selective Download** — checkbox any item or group, then "Download Selected"
- **Concurrent Downloads** — configurable (1–5 parallel streams)
- **Smart Grouping** — TV Shows by Season, Music by Artist/Album, Movies together
- **Dark Mode** — full dark/light theme across all panels
- **Accent Themes** — Emerald Green, Ocean Blue, Royal Purple

---

## Settings Reference

| Section | Key Options |
|---|---|
| **General Basics** | Button position, default output format, batch size |
| **Advanced Controls** | Concurrent downloads (1–5), skip large-batch prompt, fetch progress dialog, auto-show results, rate limiting, server emulation, Strict Bypass on/off, debug logging |
| **Appearance** | Accent theme, dark mode, compact view |
| **Filters & History** | History tracking, skip-downloaded, exclude extras, quality preset floor, file-size min/max |
| **JDownloader** | Enable/disable local socket, auto-detect, port (default 9666) |
| **Naming Templates** | TV episode and movie filename macros |
| **Subtitles** | Subtitle download preferences |

---

## Project Structure

```
EmbyGrab/
├── README.md                      # This file
│
├── releases/                      # Current releases
│   └── EmbyGrab v1.0.js          # Latest version
│
├── guides/                        # User guides
│   ├── EMBYGRAB-QUICK-START.md
│   ├── JDOWNLOADER-SETUP-GUIDE.md
│   ├── COLLECTION-404-FIX.md
│   ├── DOWNLOAD-MANAGER-V2-IMPROVEMENTS.md
│   └── WGET-CURL-DOWNLOAD-GUIDE.md
│
└── docs/                          # Technical documentation
    └── EMBYGRAB-README.md
```

---

## Common Use Cases

### Download an Entire TV Series
1. Navigate to the TV show page on your Emby server
2. Click **Get Links**
3. In the Results dialog click **Download Manager**
4. Press **Start** — all seasons and episodes download concurrently

### Selective Episode Download
1. Open the Download Manager
2. Check the items you want
3. Click **Selected** in the toolbar — only checked items download

### Send to JDownloader
1. Enable JDownloader in **Settings -> JDownloader**
2. Ensure JDownloader 2 is running with RemoteAPI on port 9666
3. Click **Send to JDownloader** in the Results dialog — files appear with correct folder structure

### Bypass Restricted Downloads
1. If you get an "Access Denied" error, a bypass warning dialog will appear
2. Click **Enable Strict Bypass** to activate DirectPlay URL generation
3. Downloads automatically resume with rebuilt URLs

---

## Contributing

Found a bug or want a feature?

1. Test with the latest version
2. Reproduce with Verbose Debug Logging enabled (Settings -> Advanced)
3. Open an issue with console logs

---

## License

Personal-use userscript for Emby servers. Use responsibly and in accordance with your server's terms of service.

---

**Enjoy seamless Emby downloads!**
