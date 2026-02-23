# Collection Download 404 Error - Fixed

## The Problem

When trying to download a collection from the collections tab, users were getting this error:

```
GET https://emby2.tugaekids.pt/emby/Items/215727?api_key=... 404 (Not Found)
Failed to fetch item info: Error: HTTP 404
Error: Could not detect show/season IDs. Please ensure you're on a show or season page.
```

**Root Cause**: The script was incorrectly trying to process the collection as a TV show instead of a collection.

---

## The Bug Flow

1. User clicks download button on a collection page
2. `detectPageType()` returns `'item'` (because URL is just `/item?id=215727`)
3. Script tries to fetch item info with `getItemInfo(server, token, itemId)`
4. Item 215727 returns **404 Not Found** (item doesn't exist or no permission)
5. Error is caught, script tries to detect type from URL context
6. Detection fails to identify as collection
7. `isCollection` remains `false`, `itemInfo` is `null`
8. Code falls through to else block: "Processing as TV show/series"
9. Calls `processShow()` which expects show/season IDs
10. **ERROR**: "Could not detect show/season IDs"

---

## The Fix

### Part 1: Better Collection Detection ([Lines 4869-4900](EmbyGrab v5.1.js:4869-4900))

**Added explicit check for collections context:**

```javascript
// Check for collections context
if (hash.includes('context=collections') || hash.includes('/collections') ||
    url.includes('collections') || hash.includes('collectionType=boxsets')) {
  console.log('[Debug] Detected as collection from URL context (collections)');
  isCollection = true;
}
```

This catches collections pages that would otherwise be missed.

---

### Part 2: Smarter Type Detection ([Lines 4891-4913](EmbyGrab v5.1.js:4891-4913))

**Before** (Bug):
```javascript
if (isCollection) {
  return await processCollection(server, token, itemId);
} else if (itemInfo?.Type === "Movie") {
  return await processMovie(server, token, itemInfo);
} else {
  // BUG: Assumes everything else is a TV show!
  return await processShow(server, token, api);
}
```

**After** (Fixed):
```javascript
if (isCollection) {
  console.log(`[Debug] Processing as collection`);
  return await processCollection(server, token, itemId);
} else if (itemInfo?.Type === "Movie") {
  console.log(`[Debug] Processing as single movie`);
  return await processMovie(server, token, itemInfo);
} else if (itemInfo?.Type === "Series" || itemInfo?.Type === "Season" || itemInfo?.Type === "Episode") {
  // Only process as show if we KNOW it's a show
  console.log(`[Debug] Processing as TV show/series`);
  updateProgress(0, 0, "Finding Episodes...");
  return await processShow(server, token, api);
} else if (!itemInfo) {
  // If we couldn't get item info and couldn't determine type, provide helpful error
  throw new Error(
    `Could not fetch information for item ID ${itemId}. ` +
    `The item may not exist, you may not have permission to access it, ` +
    `or it may be a special item type. ` +
    `Try navigating directly to the content page and trying again.`
  );
} else {
  // Unknown item type - try to handle gracefully
  console.warn(`[Debug] Unknown item type: ${itemInfo.Type}, attempting collection processing`);
  return await processCollection(server, token, itemId);
}
```

**Key Changes**:

1. **Explicit TV check**: Only processes as TV show if `itemInfo.Type` is "Series", "Season", or "Episode"
2. **Null check**: If `itemInfo` is null (like from 404), throws a helpful error instead of assuming it's a TV show
3. **Graceful fallback**: Unknown types default to collection processing instead of TV show

---

## What This Fixes

✅ **Collection downloads** - Collections are now properly detected and processed
✅ **Better error messages** - Users get helpful guidance instead of confusing "show/season" errors
✅ **No false assumptions** - Script doesn't assume unidentified items are TV shows
✅ **Graceful handling** - Unknown item types are attempted as collections instead of failing

---

## Detection Priority

The script now detects content in this order:

1. **URL Pattern** - Checks hash for `/collection?id=`, `/collections`, etc.
2. **Collections Context** - NEW! Checks for `context=collections`, `collectionType=boxsets`
3. **TV Shows Context** - Checks for `context=tvshows`, `/tv/`
4. **Page Content** - Looks for Movies tab, item counts
5. **Item Type** - Uses actual `itemInfo.Type` value
6. **Helpful Error** - If all fails and no info available

---

## Testing Scenarios

| Scenario | Before | After |
|----------|--------|-------|
| Collection from tab | ❌ 404 → TV show error | ✅ Detected as collection |
| Non-existent item | ❌ Confusing TV error | ✅ Clear "item not found" error |
| Unknown item type | ❌ TV show assumption | ✅ Graceful collection attempt |
| Actual TV show | ✅ Works | ✅ Still works (explicit type check) |
| Movie | ✅ Works | ✅ Still works |

---

## Error Messages

### Before
```
Error: Could not detect show/season IDs. Please ensure you're on a show or season page.
```
❌ Confusing - user IS on a collection page, not a show page!

### After (for 404s)
```
Error: Could not fetch information for item ID 215727.
The item may not exist, you may not have permission to access it,
or it may be a special item type.
Try navigating directly to the content page and trying again.
```
✅ Clear, helpful, actionable

---

## Code Locations

- **Collection detection**: [Lines 4869-4900](EmbyGrab v5.1.js:4869-4900)
- **Type-based processing**: [Lines 4891-4913](EmbyGrab v5.1.js:4891-4913)
- **Error handling**: [Lines 4901-4908](EmbyGrab v5.1.js:4901-4908)

---

## Summary

The 404 collection error is **fixed**! The script now:

1. ✅ Properly detects collections from the collections tab
2. ✅ Doesn't assume everything is a TV show
3. ✅ Provides helpful error messages when items can't be fetched
4. ✅ Handles unknown item types gracefully

Your friend should no longer see the "Could not detect show/season IDs" error when downloading collections!
