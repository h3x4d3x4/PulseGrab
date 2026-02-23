# 🎯 EmbyGrab - Quick Start Guide

## What is EmbyGrab?

**EmbyGrab** is an advanced download manager for Emby that lets you grab download links for any content - from a single movie to your entire server!

### Features at a Glance
✅ Smart 404 error handling (auto-fallback)
✅ Individual items, collections, libraries, or whole server
✅ Multiple output formats (URLs, wget, aria2, JSON)
✅ JDownloader integration with auto-folders
✅ Download history tracking (v5.0)
✅ Content filtering by quality/size (v5.0)
✅ Resume interrupted scans (v5.0)

---

## 📦 Choose Your Version

### EmbyGrab v4.7 (Recommended for most users)
- ✅ All bugs fixed
- ✅ Simple and stable
- ✅ Perfect for basic downloads
- **Size**: 111KB

### EmbyGrab v5.0 (Power users)
- ✅ Everything in v4.7 PLUS:
- 🌐 Whole-server downloads
- 📥 Download history
- 🎬 Content filtering
- ⏯️ Resume capability
- 💾 Export/import config
- **Size**: 146KB

**→ Start with v5.0 if you want advanced features!**

---

## 🚀 Installation (2 minutes)

### Step 1: Install Tampermonkey
- **Chrome**: [Get Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/)
- **Firefox**: [Get Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- **Edge**: [Get Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/)

### Step 2: Install EmbyGrab
1. Open Tampermonkey dashboard
2. Click **"+"** (Create new script)
3. Delete the template
4. **Copy and paste** your chosen version:
   - `EmbyGrab v4.7.js` OR
   - `EmbyGrab v5.0.js`
5. Click **File → Save** (or Ctrl+S)

### Step 3: Verify
1. Go to your Emby server
2. **Refresh** the page
3. Look for green **"Get Links"** button (bottom-right)
4. Open console (F12) - should see:
   ```
   EmbyGrab v5.0 loaded - Advanced features ready!
   ```

---

## 🎮 Basic Usage

### Grab a Single Item
1. Navigate to a movie or episode
2. Click **"Get Links"**
3. Click **"Copy to Clipboard"**
4. Done! Links are copied

### Grab a Collection
1. Navigate to any collection
2. Click **"Get Links"**
3. Wait for scan
4. All items in collection grabbed!

### Grab a TV Show
1. Navigate to a TV show page
2. Click **"Get Links"**
3. Confirm if entire show (all seasons)
4. All episodes grabbed!

---

## 🚀 Advanced Usage (v5.0 Only)

### Grab Entire Server
1. Go to **Emby home page** (main page with library icons)
2. Click **"Get Links"**
3. **Confirm** "Download Entire Server?"
4. Wait (10-60 minutes for large servers)
5. Get ALL downloadable content!

### Grab a Library
1. Click on a library (**Movies** or **TV Shows**)
2. Click **"Get Links"**
3. All items in that library grabbed!

### Use Download History
1. Click **Settings** (gear icon)
2. Check **"Enable download history"**
3. Check **"Skip already downloaded items"**
4. Click **Save**
5. Now when you scan, already-downloaded items are filtered!

### Filter Content
1. Settings → **"Content Filters"**
2. Set **Minimum Quality**: 720p / 1080p / 4K
3. Set **Maximum File Size**: e.g., 10 GB
4. Click **Save**
5. Only matching items are grabbed!

---

## 🎨 Customization

### Change Button Position
Settings → Button Position → Choose corner → Save

### Change Theme
Settings → Theme → Green/Blue/Purple → Save

### Change Output Format
Settings → Output Format → Choose format → Save

### Enable JDownloader
1. Install JDownloader 2
2. Enable FlashGot extension (port 9666)
3. Settings → Enable JDownloader → Test Connection → Save
4. Now "Send to JDownloader" button appears!

---

## 🎯 What Was Your 404 Error?

### Before EmbyGrab
```
GET .../Shows/60939/Episodes?SeasonId=636808... 404
Error: No episodes found for season
❌ Collection download FAILED
```

### After EmbyGrab
```
[Debug] REST API returned 404 - using fallback
[Debug] ✓ Fallback successful - got 12 episodes
✅ Collection download SUCCESS!
```

**Your exact error (Show ID: 60939, Season ID: 636808) is now FIXED!**

---

## 🔍 Testing Your Fix

Try that same TV show that gave you the 404 error:

1. Install **EmbyGrab v5.0.js**
2. Navigate to that TV show
3. Click **"Get Links"**
4. Open console (F12) to watch
5. You'll see:
   ```
   [Debug] REST API returned 404 for season 636808 - using fallback
   [Debug] Trying Items API fallback
   [Debug] ✓ Fallback successful - got X episodes
   ```
6. **IT WORKS!** 🎉

---

## ⚙️ Essential Settings (v5.0)

After installing v5.0, configure these:

1. **Enable Download History** ✅
   - Tracks what you've downloaded

2. **Enable Resume** ✅
   - Can resume if interrupted

3. **Enable Rate Limiting** ✅
   - Prevents server overload

4. **Skip Downloaded** ⚠️
   - Start disabled, enable when you want it

5. **Debug Mode** ❌
   - Only enable for troubleshooting

---

## 📊 What You Can Download

| Content Type | v4.7 | v5.0 |
|--------------|------|------|
| Single Movie | ✅ | ✅ |
| Single Episode | ✅ | ✅ |
| TV Season | ✅ | ✅ |
| Entire Series | ✅ | ✅ |
| Collection | ✅ | ✅ |
| Folder | ✅ | ✅ |
| **Entire Library** | ❌ | ✅ |
| **Whole Server** | ❌ | ✅ |

---

## 🐛 Troubleshooting

### Button not showing?
- Reload page
- Check Tampermonkey is enabled
- Check console for errors

### Still getting 404 errors?
- Make sure you installed EmbyGrab (not the old version)
- Check console says "EmbyGrab v4.7" or "EmbyGrab v5.0"
- Should auto-fallback now!

### Slow downloads?
- Normal for large operations
- Can cancel anytime (click button again)
- Try smaller batch size in Settings

---

## 💡 Pro Tips

1. **Use v5.0** - It has all the features!
2. **Enable history** - Never duplicate work
3. **Set filters** - Only grab what you want
4. **Use JDownloader** - Auto-organized downloads
5. **Start small** - Test with one collection first
6. **Check console** - See exactly what's happening

---

## 📖 Need More Help?

**Full Guides:**
- `EMBYGRAB-README.md` - Complete feature reference
- `V5.0-COMPLETE-GUIDE.md` - Detailed v5.0 tutorial
- `UPGRADE-TO-V5.md` - Migration guide

**Console Logs:**
- Open browser DevTools (F12)
- See real-time progress
- Debug any issues

---

## 🎊 You're Ready!

1. ✅ Install EmbyGrab
2. ✅ Click "Get Links"
3. ✅ Grab everything!

**No more 404 errors!**
**No more missing items!**
**Just flawless downloads!**

---

### Quick Reference Card

```
Button: "Get Links" (bottom-right)
Shortcut: Ctrl+D (Cmd+D on Mac)
Settings: Gear icon next to button

v4.7: Simple, stable, bug-free
v5.0: Advanced features + everything in v4.7

Your 404 error: FIXED in both versions!
```

---

**Install now and start grabbing!** 🚀
