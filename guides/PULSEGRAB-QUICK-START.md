# PulseGrab - Quick Start Guide

## What is PulseGrab?

**PulseGrab** is a universal download manager for Emby, Plex, and Jellyfin media servers. It runs as a browser userscript and lets you grab download links for any content — from a single movie to your entire server.

### Features at a Glance
- Universal server support (Emby, Plex, Jellyfin)
- Built-in concurrent download manager with pause/resume
- 10+ export formats (URLs, wget, aria2, curl, JDownloader, M3U8, JSON, and more)
- Music library expansion (artist to album to track)
- Download history tracking with skip-downloaded option
- Content filtering by quality and file size
- In-app update checking via GitHub Releases
- Dark mode with server-adaptive accent themes

---

## Installation (2 minutes)

### Step 1: Install a Userscript Manager
- **Chrome**: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/) or [Violentmonkey](https://chrome.google.com/webstore/detail/violentmonkey/)
- **Firefox**: [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) or [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/)
- **Edge**: [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/)
- **Safari**: [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)

### Step 2: Install PulseGrab
1. Open your userscript manager dashboard
2. Click **"+"** (Create new script)
3. Delete the template code
4. Copy and paste the contents of `PulseGrab v1.0.2.js`
5. Click **File -> Save** (or Ctrl+S)

### Step 3: Verify
1. Navigate to your Emby, Plex, or Jellyfin server in the browser
2. **Refresh** the page
3. Look for the **"Get Links"** button (bottom-right corner by default)
4. Open the browser console (F12) — you should see:
   ```
   PulseGrab v1.0.2 loaded!
   ```

---

## Basic Usage

### Download a Single Item
1. Navigate to a movie, episode, or track page
2. Click **"Get Links"**
3. Choose your preferred action: Copy to Clipboard, Download Manager, Send to JDownloader, etc.

### Download a TV Show
1. Navigate to any TV show page
2. Click **"Get Links"** — all seasons and episodes are expanded automatically
3. Open the **Download Manager** for concurrent downloads, or copy links in your preferred format

### Download a Music Library
1. Navigate to your Music library
2. Click **"Get Links"** — PulseGrab expands all artists, albums, and tracks
3. Choose your download method

### Download an Entire Server
1. Go to the server home page (Emby dashboard, Plex home, or Jellyfin home)
2. Click **"Get Links"**
3. Confirm the large-batch dialog
4. All libraries are scanned and expanded into downloadable items

---

## Configuration

### Essential Settings
Open **Settings** via the gear icon next to the "Get Links" button:

1. **Download History** — enable to track downloaded files and optionally skip them on re-scan
2. **Rate Limiting** — keep enabled to avoid overloading your server
3. **Concurrent Downloads** — set between 1-5 parallel streams (default: 3)
4. **Dark Mode** — matches your system preference by default, or toggle manually
5. **Debug Logging** — enable only when troubleshooting issues

### Updates
PulseGrab automatically checks for updates on each load. You can configure this in **Settings → Updates** (toggle auto-check, change interval, or manually check).

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+D` | Open Download Manager |
| `Ctrl+H` | Toggle download history |
| `Ctrl+S` | Open Settings |
| `Esc` | Close current panel |

---

## Troubleshooting

### Button not showing?
- Refresh the page
- Check your userscript manager is enabled for this site
- Check the browser console (F12) for error messages

### Plex authentication issues?
- Make sure you're logged in to Plex
- Navigate to a library or media item first (not just the home page)
- PulseGrab captures the Plex token from network requests — it needs at least one API call to have occurred

### Downloads failing?
- Try enabling **Debug Logging** in Settings to see detailed console output
- Check that your server allows direct file access
- For restricted servers, PulseGrab's bypass mode auto-activates when needed

---

## Need More Help?

- [JDownloader Setup Guide](JDOWNLOADER-SETUP-GUIDE.md) — configure JDownloader 2 integration
- [wget/curl Download Guide](WGET-CURL-DOWNLOAD-GUIDE.md) — use terminal scripts for batch downloads
- [Collection 404 Fix](COLLECTION-404-FIX.md) — troubleshooting collection expansion errors

---

**Install PulseGrab and start downloading!**
