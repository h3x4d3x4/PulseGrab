# wget/curl Download Script Guide

## What is wget/curl Script?

The **wget/curl Script** feature generates platform-specific download scripts that use native command-line tools to download your Emby media with correct filenames automatically.

### Why Use wget/curl Scripts?

**Benefits:**
- Correct filenames from the start (no renaming needed)
- Uses native system tools (wget/curl)
- No external apps required (unlike JDownloader)
- Fast, reliable downloads
- Works in background/Terminal
- No browser limitations (CORS, memory, etc.)

**Comparison with other methods:**

| Feature | Built-in Manager | wget/curl Script | JDownloader |
|---------|------------------|------------------|-------------|
| Correct Filenames | ✅ Yes | ✅ Yes | ❌ No (needs rename script) |
| Setup Required | None | Minimal | App install + config |
| Browser Required | Yes | No | No |
| Progress Tracking | In browser | In Terminal | In JDownloader |
| Background Downloads | Limited | ✅ Yes | ✅ Yes |
| Pause/Resume | ✅ Yes | Manual | ✅ Yes |

---

## How It Works

### The Process

1. Click **"wget/curl Script"** button in EmbyGrab
2. Script file downloads automatically (.bat, .command, or .sh)
3. Double-click the script file
4. All files download with correct names to current folder

**That's it! Two clicks total.**

---

## System Requirements

### Windows (10 or later)

**Built-in Tool:** `curl` (pre-installed)

- Windows 10 (1803+) and Windows 11 have curl built-in
- No installation needed
- Script generates `.bat` file

**Check if you have curl:**
```cmd
curl --version
```

### macOS (All versions)

**Built-in Tools:** `curl` and `wget` (curl is always available)

- macOS comes with curl pre-installed
- Most Macs also have wget via Homebrew
- Script generates `.command` file (double-clickable)

**Check if you have curl:**
```bash
curl --version
```

**Install wget (optional, for faster downloads):**
```bash
brew install wget
```

### Linux (All distributions)

**Built-in Tools:** `wget` and/or `curl`

- Most Linux distros have both pre-installed
- Script auto-detects which one you have
- Script generates `.sh` file

**Check what you have:**
```bash
wget --version
curl --version
```

**Install if needed:**
```bash
# Debian/Ubuntu
sudo apt install wget curl

# Fedora/RHEL
sudo dnf install wget curl

# Arch
sudo pacman -S wget curl
```

---

## Usage Instructions

### Windows

1. **Generate Script:**
   - Click "wget/curl Script" in EmbyGrab
   - File downloads: `embygrab_[package-name].bat`

2. **Run Script:**
   - Find the downloaded `.bat` file
   - Double-click it
   - Command window opens
   - Press Enter to start downloads

3. **Downloads Location:**
   - Files save to same folder as `.bat` file
   - Usually your Downloads folder

**If Windows blocks the script:**
- Right-click the `.bat` file
- Select "Properties"
- Click "Unblock" checkbox
- Click "OK"
- Now double-click to run

### macOS

1. **Generate Script:**
   - Click "wget/curl Script" in EmbyGrab
   - File downloads: `embygrab_[package-name].command`

2. **Run Script:**
   - Find the downloaded `.command` file
   - Double-click it
   - Terminal opens automatically
   - Press Enter to start downloads

3. **Downloads Location:**
   - Files save to same folder as `.command` file
   - Usually your Downloads folder

**If macOS blocks the script:**

Option A (Easy):
- Right-click the `.command` file
- Select "Open"
- Click "Open" in warning dialog

Option B (Terminal):
```bash
cd ~/Downloads
chmod +x embygrab_*.command
./embygrab_*.command
```

### Linux

1. **Generate Script:**
   - Click "wget/curl Script" in EmbyGrab
   - File downloads: `embygrab_[package-name].sh`

2. **Make Executable:**
   ```bash
   cd ~/Downloads
   chmod +x embygrab_*.sh
   ```

3. **Run Script:**
   ```bash
   ./embygrab_*.sh
   ```

4. **Downloads Location:**
   - Files save to current directory
   - Same folder as `.sh` file

**Tip:** Move the `.sh` file to your desired download folder before running it.

---

## Script Features

### What the Script Does

**On Windows (.bat):**
```batch
- Shows package name and file count
- Uses curl to download each file
- Shows progress for each download
- Reports success/failure for each file
- Pauses at end so you can see results
```

**On macOS/Linux (.command/.sh):**
```bash
- Shows package name and file count
- Auto-detects wget or curl
- Uses whichever tool is available
- Shows progress for each download
- Counts successes and failures
- Shows final statistics
```

### Progress Monitoring

While script runs, you'll see:
```
[1/25] Movie Title (2024) S01E01.mkv
SUCCESS: Movie Title (2024) S01E01.mkv

[2/25] Movie Title (2024) S01E02.mkv
SUCCESS: Movie Title (2024) S01E02.mkv
```

### Error Handling

If a download fails:
```
[3/25] Movie Title (2024) S01E03.mkv
ERROR: Failed to download Movie Title (2024) S01E03.mkv
```

Script continues with remaining files.

---

## Advanced Usage

### Customize Download Location

**Windows:**
```cmd
1. Create your target folder (e.g., D:\Media\MyShow)
2. Move the .bat file there
3. Double-click to run
4. Files download to that folder
```

**macOS/Linux:**
```bash
mkdir -p ~/Media/MyShow
mv ~/Downloads/embygrab_*.sh ~/Media/MyShow/
cd ~/Media/MyShow
./embygrab_*.sh
```

### Run Multiple Scripts

You can generate and run multiple scripts simultaneously:

1. Generate script for Movies library
2. Generate script for TV Shows library
3. Run both scripts at once
4. Each downloads to its own folder

### Pause/Resume

**Manual Pause:**
- Press `Ctrl+C` to stop script
- Script saves progress
- Re-run script later to continue

**Note:** wget supports better resume capabilities. Use `wget -c` flag for automatic resume.

### Monitor in Background

**Windows:**
- Script runs in Command Prompt window
- Minimize window to run in background
- Check window periodically for progress

**macOS/Linux:**
```bash
# Run in background with output log
./embygrab_*.sh > download.log 2>&1 &

# Monitor progress
tail -f download.log
```

---

## Troubleshooting

### "curl: command not found" (Windows)

**Cause:** Old Windows version (< Windows 10 1803)

**Solution:**
1. Download curl: https://curl.se/windows/
2. Or upgrade to Windows 10 1803+
3. Or use Built-in Download Manager instead

### "wget: command not found" (macOS/Linux)

**Cause:** wget not installed

**Solution:** Script will automatically use curl instead. Or install wget:
```bash
# macOS
brew install wget

# Linux (Debian/Ubuntu)
sudo apt install wget
```

### Downloads Are Slow

**Cause:** Server bandwidth or network speed

**Solutions:**
- Use wget for better performance (faster than curl)
- Check your internet connection
- Try downloading during off-peak hours
- Consider using JDownloader for multi-threaded downloads

### "Permission Denied" Error

**Cause:** Script not executable

**Solution:**
```bash
chmod +x embygrab_*.sh
# or on macOS
chmod +x embygrab_*.command
```

### Files Download to Wrong Location

**Cause:** Script downloads to its current folder

**Solution:**
1. Move script file to desired folder BEFORE running
2. Or move files after download completes

### Script Closes Immediately

**Windows Cause:** Script finished (check if files downloaded)

**Solution:** Open Command Prompt first, then run:
```cmd
cd Downloads
embygrab_*.bat
```

### Some Downloads Failed

**Causes:**
- Network interruption
- Server timeout
- File no longer available
- Insufficient disk space

**Solution:**
1. Check error messages in Terminal/Command Prompt
2. Check disk space
3. Re-run script (will skip existing files)
4. Or use Built-in Download Manager for better error handling

---

## Best Practices

### 1. Organize by Content Type

Create folders for different content:
```
Downloads/
├── Movies/
│   └── embygrab_action_movies.sh
├── TV_Shows/
│   └── embygrab_breaking_bad.sh
└── Collections/
    └── embygrab_mcu.sh
```

### 2. Test Small Batches First

Before downloading entire libraries:
1. Test with single movie/episode
2. Test with small collection (5-10 items)
3. Then proceed with larger batches

### 3. Use Descriptive Package Names

In EmbyGrab settings, set meaningful package names:
- ❌ Bad: `Package`, `Download`, `Items`
- ✅ Good: `MCU_Movies_4K`, `Breaking_Bad_Season_1`, `Action_Movies_2023`

### 4. Check Available Disk Space

Before large downloads:
```bash
# macOS/Linux
df -h .

# Windows
dir
```

Ensure you have enough space for all files.

### 5. Keep Scripts for Re-downloads

Don't delete scripts immediately:
- Keep for re-downloading if needed
- Useful if some downloads failed
- Easy to resume interrupted downloads

---

## Comparison: When to Use What?

### Use wget/curl Script When:
- ✅ You want correct filenames automatically
- ✅ You're downloading many files (10+)
- ✅ You want downloads to run in background
- ✅ You're comfortable with Terminal/Command Prompt
- ✅ You don't want to install extra software

### Use Built-in Download Manager When:
- ✅ You want visual progress tracking
- ✅ You want pause/resume in browser
- ✅ You're downloading small batches (1-10 files)
- ✅ You prefer GUI over command-line
- ✅ You want everything in-browser

### Use JDownloader When:
- ✅ You need multi-threaded downloads
- ✅ You want GUI with advanced features
- ✅ You're okay with renaming files afterward
- ✅ You download frequently from multiple sources
- ✅ You want captcha solving, reconnection, etc.

---

## FAQ

### Q: Do I need to install wget or curl?

**A:** Probably not! They're usually already installed:
- Windows 10+: curl built-in
- macOS: curl built-in
- Linux: usually both built-in

### Q: Can I edit the script before running?

**A:** Yes! Open the script in a text editor:
- Customize download locations
- Add flags (e.g., `curl -C -` for resume)
- Remove files you don't want
- Change download order

### Q: Will the script work offline?

**A:** No. The script downloads from your Emby server, which requires:
- Internet connection (if server is remote)
- Or local network connection (if server is on LAN)

### Q: Can I schedule script to run automatically?

**A:** Yes!

**Windows Task Scheduler:**
```
1. Open Task Scheduler
2. Create Basic Task
3. Select script file
4. Set schedule
```

**macOS/Linux cron:**
```bash
crontab -e
# Add line (runs daily at 2 AM):
0 2 * * * /path/to/embygrab_script.sh
```

### Q: Are my Emby credentials secure?

**A:** Yes. The script uses your existing API token, which is:
- Encoded in the download URLs
- Only valid for your server
- Can be revoked in Emby settings

### Q: Can I use this with Jellyfin?

**A:** The script works with any direct download URLs, but EmbyGrab is designed for Emby. For Jellyfin, you'd need a Jellyfin-compatible userscript.

---

## Examples

### Example 1: Download Single Movie

**Script generates:**
```bash
#!/bin/bash
# Package: Inception_2010
# Files: 1

curl -L -o "Inception (2010) [1080p].mkv" "https://emby.server/Items/12345/Download?api_key=..."
```

**Result:**
- `Inception (2010) [1080p].mkv` downloads to current folder

### Example 2: Download TV Season

**Script generates:**
```batch
@echo off
REM Package: Breaking_Bad_S01
REM Files: 7

curl -L -o "Breaking Bad S01E01 - Pilot.mkv" "https://..."
curl -L -o "Breaking Bad S01E02 - Cat's in the Bag.mkv" "https://..."
...
```

**Result:**
- All 7 episodes download with correct names

### Example 3: Download Movie Collection

**Script generates:**
```bash
#!/bin/bash
# Package: MCU_Phase_1
# Files: 6

wget -O "Iron Man (2008).mkv" "https://..."
wget -O "The Incredible Hulk (2008).mkv" "https://..."
wget -O "Iron Man 2 (2010).mkv" "https://..."
...
```

**Result:**
- Entire collection downloads automatically

---

## Tips & Tricks

### Speed Up Downloads with wget

If you have wget, it's faster than curl:
```bash
# Edit script, replace curl with wget:
wget --progress=bar:force -O "filename" "url"
```

### Add Resume Capability

For curl:
```bash
curl -C - -o "filename" "url"
```

For wget:
```bash
wget -c -O "filename" "url"
```

### Limit Bandwidth

Prevent script from saturating connection:

**wget:**
```bash
wget --limit-rate=5m -O "filename" "url"  # Max 5 MB/s
```

**curl:**
```bash
curl --limit-rate 5M -o "filename" "url"  # Max 5 MB/s
```

### Add Retries

Make downloads more resilient:

**wget:**
```bash
wget --tries=5 -O "filename" "url"
```

**curl:**
```bash
curl --retry 5 -o "filename" "url"
```

### Silent Mode

Hide progress output:

**wget:**
```bash
wget -q -O "filename" "url"
```

**curl:**
```bash
curl -s -o "filename" "url"
```

---

## Summary

**wget/curl Script is ideal for:**
- Users who want correct filenames without extra steps
- Large batch downloads (entire seasons, collections, libraries)
- Background downloads without keeping browser open
- Users comfortable with Terminal/Command Prompt
- Systems where JDownloader can't be installed

**Quick Start:**
1. Click "wget/curl Script" in EmbyGrab
2. Double-click downloaded script
3. Files download with correct names
4. Done!

**Zero installation, minimal setup, maximum convenience.**

---

For more help:
- Main README: `/docs/EMBYGRAB-README.md`
- Quick Start: `/guides/EMBYGRAB-QUICK-START.md`
- JDownloader Guide: `/guides/JDOWNLOADER-SETUP-GUIDE.md`
