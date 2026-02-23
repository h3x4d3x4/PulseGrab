# JDownloader Setup Guide for EmbyGrab

## Why Use JDownloader?

Instead of copying links and downloading manually, JDownloader:
- ✅ **One-click downloads** - No copy/paste needed
- ✅ **Auto-organizes files** - Creates proper folder structure
- ✅ **Handles hundreds of files** - Batch download easily
- ✅ **Resume downloads** - Never lose progress
- ✅ **Speed limits** - Control bandwidth
- ✅ **Queue management** - Schedule downloads

---

## Step-by-Step Setup (5 minutes)

### Step 1: Install JDownloader 2

1. **Download JDownloader 2**:
   - Go to: https://jdownloader.org/jdownloader2
   - Click **"Download Installer"**
   - Choose your OS (Windows/Mac/Linux)

2. **Install it**:
   - Run the installer
   - Follow the setup wizard
   - Launch JDownloader 2

3. **Complete initial setup**:
   - Skip the account creation (optional)
   - Let it update if needed

---

### Step 2: Enable FlashGot Extension

This is the KEY step that makes EmbyGrab work with JDownloader!

1. **In JDownloader**, click **Settings** (gear icon)

2. Go to **"Extensions"** or **"Addons"**

3. Find **"FlashGot"** in the list

4. **Enable it** (check the box or toggle switch)

5. **Configure FlashGot** (if there's a settings button):
   - Port: **9666** (default - don't change unless you know why)
   - Enable: **Yes**
   - Auto-start: **Yes** (recommended)

6. **Restart JDownloader** (important!)

---

### Step 3: Enable in EmbyGrab

1. **In Emby**, click the **Settings** button (gear icon next to "Get Links")

2. Scroll to **"JDownloader Integration"** section

3. **Check** "Enable JDownloader integration"

4. **Port**: Leave as **9666** (unless you changed it)

5. Click **"Test Connection"**
   - Should say: ✅ "Connected!"
   - If it fails, make sure:
     - JDownloader is running
     - FlashGot is enabled
     - Port is 9666

6. Click **"Save"**

---

### Step 4: Test It!

1. **Navigate** to a movie or collection in Emby

2. Click **"Get Links"**

3. After scan completes, you'll see **two buttons**:
   - 📥 **Send to JDownloader** (NEW!)
   - 📋 Copy to Clipboard

4. Click **"Send to JDownloader"**

5. **Check JDownloader** - downloads should appear!

---

## What You'll See in JDownloader

### Organized Folders

**TV Shows:**
```
📁 TV Shows/
  └─ 📁 Breaking Bad/
      └─ 📁 Season 1/
          ├─ S01E01 - Pilot.mkv
          ├─ S01E02 - Cat in the Bag.mkv
          └─ S01E03 - ...And the Bag's in the River.mkv
```

**Movies:**
```
📁 Movies/
  ├─ 📁 The Matrix (1999)/
  │   └─ The Matrix.mkv
  └─ 📁 Inception (2010)/
      └─ Inception.mkv
```

**Music:**
```
📁 Music/
  └─ 📁 Pink Floyd/
      └─ 📁 Dark Side of the Moon/
          ├─ 01 - Speak to Me.mp3
          ├─ 02 - Breathe.mp3
          └─ 03 - On the Run.mp3
```

### Package Names

EmbyGrab creates smart package names:
- **TV Show**: "Breaking Bad - Season 1"
- **Entire Show**: "Breaking Bad - Multiple Seasons"
- **Movie**: "Inception (2010)"
- **Collection**: "Marvel Collection"

---

## Advanced JDownloader Tips

### 1. Set Download Location

**In JDownloader:**
- Settings → General → Default Download Folder
- Set to your media folder (e.g., `/mnt/media` or `D:\Media`)
- EmbyGrab will create subfolders automatically!

### 2. Speed Limits

**Settings → Connection Manager:**
- Max downloads: 3-5 (for parallel downloading)
- Download limit: Set bandwidth limit
- Chunks per download: 4-8 (for faster speeds)

### 3. Auto-Extract

**If you download compressed files:**
- Settings → Extensions → Extraction
- Enable auto-extraction
- Set extraction path

### 4. Schedule Downloads

**For large batches:**
- Right-click package → Schedule
- Set start time (e.g., overnight)
- Let it run while you sleep!

---

## Troubleshooting

### "Cannot connect to JDownloader"

**Check:**
1. ✅ JDownloader is **running**
2. ✅ FlashGot extension is **enabled**
3. ✅ Port is **9666** in both JDownloader and EmbyGrab
4. ✅ No firewall blocking localhost:9666
5. ✅ Restart JDownloader after enabling FlashGot

**Test manually:**
- Open browser
- Go to: `http://localhost:9666/flashgot`
- Should see some text (not an error)

### "Connection successful but downloads don't appear"

**Try:**
1. Check JDownloader "Linkgrabber" tab (might be waiting for approval)
2. Settings → Advanced Settings → Search for "FlashGot"
3. Make sure "flashgot enabled" is true
4. Restart JDownloader

### "Folder structure not working"

**EmbyGrab tries two methods:**
1. **Advanced method**: Sends full folder paths
2. **Simple method**: Just URLs (if advanced fails)

**If you only get simple method:**
- Downloads work but no folders
- This is a JDownloader/FlashGot limitation
- You can manually organize after download
- Or check JDownloader update (newer versions better)

### Port Already in Use

**If 9666 is taken:**
1. In JDownloader: Change FlashGot port to 9667
2. In EmbyGrab Settings: Change port to 9667
3. Test connection
4. Save

---

## Comparison: JDownloader vs Manual

| Aspect | Copy to Clipboard | JDownloader |
|--------|-------------------|-------------|
| **Setup** | None needed | 5 minutes once |
| **Speed** | Manual paste | Automatic |
| **Folders** | Create manually | Auto-created |
| **Resume** | Start over | Resume anytime |
| **Batch** | Paste 100+ links | One click |
| **Queue** | Download all now | Schedule/prioritize |
| **Speed Limit** | Per-browser | Global control |

---

## Real-World Example

### Without JDownloader:
1. EmbyGrab: Scan collection (50 episodes)
2. Copy 50 URLs to clipboard
3. Open download manager
4. Paste URLs one by one (or all at once)
5. Start downloads
6. Wait for completion
7. Manually organize into folders
8. Rename files properly

**Time: 10-15 minutes of work**

### With JDownloader:
1. EmbyGrab: Scan collection (50 episodes)
2. Click "Send to JDownloader"
3. Done!

**Time: 5 seconds**

Downloads appear in JDownloader with:
- ✅ Proper folder structure
- ✅ Correct filenames
- ✅ Organized by season
- ✅ Ready to download

---

## Large Batch Tips

### For 100+ Items:

EmbyGrab automatically splits into chunks of 500 items:
```
Package: "Breaking Bad - Multiple Seasons (Part 1/3)"
Package: "Breaking Bad - Multiple Seasons (Part 2/3)"
Package: "Breaking Bad - Multiple Seasons (Part 3/3)"
```

This prevents overwhelming JDownloader.

### For Whole-Server Downloads:

If you download entire server (1000s of items):
1. EmbyGrab sends in batches
2. Each library becomes separate package
3. Can pause/resume per library
4. Total control in JDownloader

---

## Alternative: Without FlashGot

**If FlashGot doesn't work for you:**

### Method 1: Direct Link Paste
1. Copy links from EmbyGrab
2. In JDownloader: Click "Add Links" (+ button)
3. Paste links
4. They'll appear in Linkgrabber
5. Right-click → Start downloads

**Note**: Won't have folder structure, but works!

### Method 2: Use wget/aria2 Script
1. EmbyGrab Settings → Output Format → **Wget Script**
2. Copy to clipboard
3. Save as `download.sh` (or `download.bat` on Windows)
4. Run the script: `bash download.sh`

Folders are created by the script!

---

## Best Practices

### 1. Keep JDownloader Running
- Run in background while using Emby
- EmbyGrab can send downloads anytime

### 2. Use Packages
- JDownloader groups by package (TV show, movie, etc.)
- Easy to manage 100+ downloads

### 3. Set Auto-Start
- Settings → Enable auto-start for new downloads
- No manual click needed

### 4. Monitor Progress
- JDownloader shows:
  - Download speed
  - ETA
  - Progress per file
  - Total progress

### 5. Use Queue
- Prioritize important downloads
- Move to top of queue
- Pause less urgent items

---

## Summary

### Setup Checklist:
- [ ] Install JDownloader 2
- [ ] Enable FlashGot extension (port 9666)
- [ ] Restart JDownloader
- [ ] Enable in EmbyGrab Settings
- [ ] Test connection (should say "Connected!")
- [ ] Save settings
- [ ] Test with small collection first

### Expected Workflow:
1. Navigate to content in Emby
2. Click "Get Links"
3. Click "Send to JDownloader"
4. Watch downloads appear in JDownloader
5. Downloads auto-organize with folders
6. Enjoy!

---

**JDownloader + EmbyGrab = Perfect combination!** 🎉

No more manual copy/paste, no more folder organization, just one-click downloads!
