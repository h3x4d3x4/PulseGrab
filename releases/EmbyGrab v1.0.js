// ==UserScript==
// @name         EmbyGrab - Complete Download Manager
// @namespace    embygrab.manager
// @version      1.0
// @description  Ultimate Emby download tool: 10 output formats, QR codes, email, built-in manager, wget/curl scripts, JDownloader integration & more!
// @match        https://*/emby/*
// @match        https://app.emby.media/*
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Version Check & Cache Buster ----------
  // Moved below Settings definition to avoid TDZ errors

  // ---------- Polyfills ----------
  if (!AbortSignal.timeout) {
    AbortSignal.timeout = function (ms) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("TimeoutError")), ms);
      return controller.signal;
    };
  }

  // ---------- Configuration ----------
  const CONFIG = {
    buttonId: "getDownloadLinksButton",
    settingsId: "embyDlSettings",
    progressId: "embyDlProgress",
    buttonText: "Get Links",
    retryAttempts: 3,
    retryDelay: 1000,
    requestTimeout: 30000,
    batchSize: 50,
    maxFolderItems: 5000,
    maxServerItems: 50000,  // Maximum items for whole-server downloads
    wholeShowConfirmThreshold: 50,
    seasonDelayMs: 200,
    keyboardShortcut: 'KeyD', // Ctrl+D
    // NEW v6.50: Performance improvements
    parallelSeasonFetches: 5,  // Number of concurrent season fetches
    cacheTTL: 300000,  // Cache TTL: 5 minutes (300000ms)
    enableRequestCache: true,
    concurrentDownloads: 2,  // Number of simultaneous downloads in Download Manager
    enableBackgroundPrefetch: true,
    outputFormats: {
      'links': 'Plain URLs',
      'wget': 'Wget Script',
      'aria2': 'Aria2 Input File',
      'json': 'JSON Export',
      'powershell': 'PowerShell Script',
      'python': 'Python Script',
      'curl': 'cURL Script',
      'idm': 'IDM Script',
      'qrcode': 'QR Code',
      'email': 'Email Links'
    },
    jdownloader: {
      defaultPort: 9666,
      timeout: 10000, // 10 seconds for more reliable detection
      batchSize: 500  // Send in chunks to avoid overwhelming JD
    },
    rateLimit: {
      maxRequestsPerSecond: 10,
      enabled: true
    },
    styles: {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      padding: "12px 16px",
      backgroundColor: "#10b981",
      color: "white",
      border: "none",
      borderRadius: "12px",
      cursor: "pointer",
      font: "600 14px system-ui, sans-serif",
      boxShadow: "0 8px 25px rgba(16, 185, 129, 0.3)",
      transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
      userSelect: "none",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      minWidth: "140px",
      justifyContent: "center"
    }
  };

  // ---------- Settings Management ----------
  const Settings = {
    defaults: {
      buttonPosition: 'bottom-right',
      outputFormat: 'links',
      autoConfirm: false,
      showProgress: true,
      batchSize: 50,
      theme: 'green',
      darkMode: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
      compactMode: false,
      showResultsDialog: true,
      jdownloaderEnabled: false,
      jdownloaderPort: 9666,
      enableJDownloaderAutoDetect: false,
      skipDownloaded: false,
      enableHistory: true,
      debugMode: false,
      enableRateLimit: true,
      enableResume: true,
      // NEW v6.50: Performance settings
      enableRequestCache: true,
      enableParallelFetching: true,
      parallelSeasonFetches: 5,
      concurrentDownloads: 3,  // NEW v6.54: Changed default from 2 to 3
      enableBackgroundPrefetch: true,
      filterOptions: {
        minQuality: null,  // '720p', '1080p', '4K'
        maxFileSize: null, // in GB
        excludeSubtitles: false,
        includeTypes: ['Movie', 'Episode', 'Video', 'Audio'],
        // NEW v6.55: Exclude extras
        excludeExtras: false
      },
      // NEW v6.58: Custom Filename Templates
      filenameTemplateEpisode: '{Series} - S{season}E{episode} - {Title}',
      filenameTemplateMovie: '{Title} ({Year})',
      // NEW v6.59: Subtitle Settings
      dlExternalSubtitles: true,
      subtitleLanguages: '', // Empty = all, or comma separated 'eng,spa'
      // NEW v6.59: Bypass Download Restrictions
      // bypassMode: 'disabled', // 'disabled', 'directplay' (static=true), 'remux' (static=false, copy)
      emulateClient: true     // Mimic 'Emby Web' client
    },

    get(key) {
      try {
        let stored = GM_getValue('emby_dl_settings', '{}');
        let settings = JSON.parse(stored);

        // Legacy migrations (kept for structure, but bypassMode is always on now)
        if (key === 'bypassMode') {
          return 'directplay'; // Always enforce directplay
        }

        // Migration: forceDirectPlay -> bypassMode (only if bypassMode isn't explicitly set)
        if (key === 'bypassMode' && settings.forceDirectPlay === true && settings.bypassMode === undefined) {
          return 'directplay';
        }

        return settings[key] !== undefined ? settings[key] : this.defaults[key];
      } catch {
        return this.defaults[key];
      }
    },

    set(key, value) {
      try {
        const stored = GM_getValue('emby_dl_settings', '{}');
        const settings = JSON.parse(stored);
        settings[key] = value;
        GM_setValue('emby_dl_settings', JSON.stringify(settings));
      } catch (e) {
        console.warn('Failed to save setting:', e);
      }
    },

    getAll() {
      try {
        const stored = GM_getValue('emby_dl_settings', '{}');
        const settings = JSON.parse(stored);
        const allSettings = { ...this.defaults, ...settings };

        // Enforce bypassMode to always be 'directplay'
        allSettings.bypassMode = 'directplay';

        // Migration: forceDirectPlay -> bypassMode (if old setting exists and new one isn't explicitly set)
        if (settings.forceDirectPlay === true && settings.bypassMode === undefined) {
          allSettings.bypassMode = 'directplay';
        }

        return allSettings;
      } catch {
        return { ...this.defaults, bypassMode: 'directplay' }; // Ensure bypassMode is 'directplay' even on error
      }
    }
  };

  // ---------- Version Check & Cache Buster ----------
  // Moved here to ensure Settings object is initialized before logDebug is called
  const SCRIPT_VERSION = '1.0';
  const STORED_VERSION = GM_getValue('scriptVersion', null);

  if (STORED_VERSION !== SCRIPT_VERSION) {
    if (Settings.get('debugMode')) {
      console.log(`[EmbyGrab] Version change detected: ${STORED_VERSION || 'none'} -> ${SCRIPT_VERSION}`);
      console.log('[EmbyGrab] Clearing cached download manager state...');
    }

    // Clear download manager state (but keep user settings)
    GM_setValue('downloadManagerState', undefined);

    // Set new version
    GM_setValue('scriptVersion', SCRIPT_VERSION);
  }

  // ---------- Download History ----------
  const DownloadHistory = {
    mark(items) {
      if (!Settings.get('enableHistory')) return;

      const history = JSON.parse(GM_getValue('emby_dl_history', '{}'));
      const today = new Date().toISOString().split('T')[0];

      items.forEach(item => {
        if (item && item.Id) {
          history[item.Id] = {
            name: item.Name,
            type: item.Type,
            date: today,
            size: item.Size || item.FileSize
          };
        }
      });

      GM_setValue('emby_dl_history', JSON.stringify(history));
      logDebug(`Marked ${items.length} items as downloaded`);
    },

    isDownloaded(itemId) {
      if (!Settings.get('enableHistory')) return false;
      const history = JSON.parse(GM_getValue('emby_dl_history', '{}'));
      return history[itemId] !== undefined;
    },

    getDownloadDate(itemId) {
      const history = JSON.parse(GM_getValue('emby_dl_history', '{}'));
      return history[itemId]?.date;
    },

    clear() {
      GM_setValue('emby_dl_history', '{}');
      logDebug('Download history cleared');
      showNotification('Download history cleared', 'info', 2000);
    },

    getAll() {
      return JSON.parse(GM_getValue('emby_dl_history', '{}'));
    },

    getStats() {
      const history = this.getAll();
      const entries = Object.values(history);

      return {
        total: entries.length,
        movies: entries.filter(e => e.type === 'Movie').length,
        episodes: entries.filter(e => e.type === 'Episode').length,
        other: entries.filter(e => !['Movie', 'Episode'].includes(e.type)).length,
        totalSize: entries.reduce((sum, e) => sum + (e.size || 0), 0)
      };
    },

    export() {
      const history = this.getAll();
      const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `emby-download-history-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('History exported', 'success', 2000);
    },

    import(jsonString) {
      try {
        const imported = JSON.parse(jsonString);
        const current = this.getAll();
        const merged = { ...current, ...imported };
        GM_setValue('emby_dl_history', JSON.stringify(merged));
        showNotification(`Imported ${Object.keys(imported).length} history entries`, 'success', 3000);
      } catch (error) {
        console.error('[History] Import failed:', error);
        showNotification('Failed to import history', 'error', 3000);
      }
    }
  };

  // ---------- NEW v6.50: Request Cache System ----------
  const RequestCache = {
    get(key) {
      if (!Settings.get('enableRequestCache')) return null;

      try {
        const cacheData = GM_getValue('emby_request_cache', '{}');
        const cache = JSON.parse(cacheData);
        const entry = cache[key];

        if (!entry) return null;

        // Check if cache entry is still valid (TTL check)
        const now = Date.now();
        const age = now - entry.timestamp;

        if (age > CONFIG.cacheTTL) {
          // Cache expired
          logDebug(`Cache Expired: ${key} (age: ${Math.round(age / 1000)}s)`);
          this.remove(key);
          return null;
        }

        logDebug(`Cache HIT: ${key} (age: ${Math.round(age / 1000)}s)`);
        return entry.data;
      } catch (error) {
        console.warn('[Cache] Get failed:', error);
        return null;
      }
    },

    set(key, data) {
      if (!Settings.get('enableRequestCache')) return;

      try {
        const cacheData = GM_getValue('emby_request_cache', '{}');
        const cache = JSON.parse(cacheData);

        cache[key] = {
          data: data,
          timestamp: Date.now()
        };

        // Prune old entries to prevent cache from growing too large
        const keys = Object.keys(cache);
        if (keys.length > 100) {
          // Remove oldest 20 entries
          const sorted = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
          sorted.slice(0, 20).forEach(k => delete cache[k]);
          logDebug('Pruned 20 oldest cache entries');
        }

        GM_setValue('emby_request_cache', JSON.stringify(cache));
        logDebug(`Cache SET: ${key}`);
      } catch (error) {
        console.warn('[Cache] Set failed:', error);
      }
    },

    remove(key) {
      try {
        const cacheData = GM_getValue('emby_request_cache', '{}');
        const cache = JSON.parse(cacheData);
        delete cache[key];
        GM_setValue('emby_request_cache', JSON.stringify(cache));
      } catch (error) {
        console.warn('[Cache] Remove failed:', error);
      }
    },

    clear() {
      GM_setValue('emby_request_cache', '{}');
      logDebug('All cache cleared');
      showNotification('Request cache cleared', 'info', 2000);
    },

    getStats() {
      try {
        const cacheData = GM_getValue('emby_request_cache', '{}');
        const cache = JSON.parse(cacheData);
        const now = Date.now();
        const entries = Object.entries(cache);

        return {
          total: entries.length,
          valid: entries.filter(([_, v]) => (now - v.timestamp) < CONFIG.cacheTTL).length,
          expired: entries.filter(([_, v]) => (now - v.timestamp) >= CONFIG.cacheTTL).length,
          sizeKB: Math.round(cacheData.length / 1024)
        };
      } catch {
        return { total: 0, valid: 0, expired: 0, sizeKB: 0 };
      }
    },

    // Generate cache key from URL and params
    makeKey(url, params = {}) {
      const paramStr = Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      return `${url}${paramStr ? '?' + paramStr : ''}`;
    }
  };

  // ---------- Progress Persistence for Resume ----------
  const ProgressManager = {
    save(operationType, itemId, state) {
      if (!Settings.get('enableResume')) return;

      const key = `emby_dl_progress_${operationType}_${itemId}`;
      GM_setValue(key, {
        timestamp: Date.now(),
        state: state,
        itemsProcessed: state.itemsProcessed || [],
        total: state.total || 0
      });
    },

    load(operationType, itemId) {
      if (!Settings.get('enableResume')) return null;

      const key = `emby_dl_progress_${operationType}_${itemId}`;
      const data = GM_getValue(key);

      // Clear if older than 1 hour
      if (data && Date.now() - data.timestamp > 3600000) {
        this.clear(operationType, itemId);
        return null;
      }

      return data;
    },

    clear(operationType, itemId) {
      const key = `emby_dl_progress_${operationType}_${itemId}`;
      GM_deleteValue(key);
    },

    clearAll() {
      // Clear all progress keys
      const keys = GM_listValues?.() || [];
      keys.filter(k => k.startsWith('emby_dl_progress_')).forEach(k => GM_deleteValue(k));
    }
  };

  // ---------- Content Filter ----------
  const ContentFilter = {
    apply(items) {
      const filters = Settings.get('filterOptions');
      if (!filters) return items;

      return items.filter(item => {
        // Type filter
        if (filters.includeTypes && !filters.includeTypes.includes(item.Type)) {
          logDebug(`[Filter] Excluding ${item.Name} - type ${item.Type} not in whitelist`);
          return false;
        }

        // NEW v6.55: Minimum file size filter
        if (filters.minFileSize && item.Size) {
          const minBytes = filters.minFileSize * 1024 * 1024 * 1024;
          if (item.Size < minBytes) {
            logDebug(`[Filter] Excluding ${item.Name} - size ${formatFileSize(item.Size)} < ${filters.minFileSize}GB`);
            return false;
          }
        }

        // Maximum file size filter
        if (filters.maxFileSize && item.Size) {
          const maxBytes = filters.maxFileSize * 1024 * 1024 * 1024;
          if (item.Size > maxBytes) {
            logDebug(`[Filter] Excluding ${item.Name} - size ${formatFileSize(item.Size)} > ${filters.maxFileSize}GB`);
            return false;
          }
        }

        // Quality filter (resolution)
        if (filters.minQuality && item.Width) {
          const minWidths = { '720p': 1280, '1080p': 1920, '4K': 3840 };
          const minWidth = minWidths[filters.minQuality];
          if (minWidth && item.Width < minWidth) {
            logDebug(`[Filter] Excluding ${item.Name} - resolution ${item.Width}x${item.Height} < ${filters.minQuality}`);
            return false;
          }
        }

        // NEW v6.55: Exclude extras (trailers, behind-the-scenes, etc.)
        if (filters.excludeExtras && item.ExtraType) {
          logDebug(`[Filter] Excluding ${item.Name} - extra type: ${item.ExtraType}`);
          return false;
        }

        // Subtitle exclusion
        if (filters.excludeSubtitles && item.Type === 'Subtitle') {
          return false;
        }

        return true;
      });
    },

    getStats(items) {
      const filtered = this.apply(items);
      return {
        original: items.length,
        filtered: filtered.length,
        removed: items.length - filtered.length
      };
    }
  };

  // ---------- State Management ----------
  let isProcessing = false;
  let button = null;
  let settingsPanel = null;
  let progressModal = null;
  let abortController = null;
  let currentOperation = null;
  let currentCollectionName = null;  // Store collection name for JDownloader package naming
  let processingStats = {
    current: 0,
    total: 0,
    errors: [],
    startTime: null
  };

  // ---------- Theme System ----------
  const Themes = {
    green: {
      primary: '#10b981',
      primaryHover: '#059669',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(16, 185, 129, 0.3)'
    },
    blue: {
      primary: '#3b82f6',
      primaryHover: '#2563eb',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(59, 130, 246, 0.3)'
    },
    purple: {
      primary: '#8b5cf6',
      primaryHover: '#7c3aed',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(139, 92, 246, 0.3)'
    }
  };

  function getTheme() {
    const themeName = Settings.get('theme');
    return Themes[themeName] || Themes.green;
  }

  // ---------- Icons ----------
  const Icons = {
    download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7,10 12,15 17,10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`,

    settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`,

    close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`,

    check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20,6 9,17 4,12"/>
    </svg>`,

    alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 9v2m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
    </svg>`,

    pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>`,

    play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="5,3 19,12 5,21"/>
    </svg>`,

    jdownloader: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="8,10 12,15 16,10"/>
      <path d="M12 15V3"/>
      <circle cx="12" cy="21" r="1"/>
    </svg>`,

    clipboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
    </svg>`,

    terminal: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" y1="19" x2="20" y2="19"/>
    </svg>`,

    // Download Manager Icons
    manager: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7,10 12,15 17,10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
      <circle cx="18" cy="6" r="3" fill="currentColor"/>
    </svg>`,

    pending: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12,6 12,12 16,14"/>
    </svg>`,

    downloading: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7,10 12,15 17,10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`,

    completed: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="8,12 11,15 16,10"/>
    </svg>`,

    error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>`,

    trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>
    </svg>`,

    retry: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-2.39-6.1"/><polyline points="21 3 21 9 15 9"/>
    </svg>`,

    cancel: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`,

    qr: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="8" height="8"/>
      <rect x="13" y="3" width="8" height="8"/>
      <rect x="3" y="13" width="8" height="8"/>
      <rect x="17" y="17" width="4" height="4"/>
    </svg>`,

    info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12" y2="8"/>
    </svg>`,

    email: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>`,

    search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>`
  };

  // ---------- Helper Functions ----------
  // NEW v6.58: GM_xmlhttpRequest wrapper for Mixed Content support
  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: url,
        headers: options.headers || {},
        data: options.body,
        timeout: (options.signal && options.signal.timeout) || 2000, // Handle AbortSignal timeout roughly
        onload: (response) => {
          resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            text: () => Promise.resolve(response.responseText),
            json: () => Promise.resolve(JSON.parse(response.responseText))
          });
        },
        onerror: (error) => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  function logDebug(...args) {
    if (Settings.get('debugMode')) {
      console.log('[EmbyGrab]', ...args);
    }
  }

  function sanitizeFilename(name) {
    if (!name) return 'Unknown';

    // Replace invalid characters for file systems and shell safety
    return name
      .replace(/[<>:"/\\|?*`$&;]/g, '_')  // Replace invalid/safe chars with underscore
      .replace(/[\x00-\x1f\x80-\x9f]/g, '') // Remove control characters
      .replace(/^\.+/, '') // Remove leading dots
      .replace(/\.+$/, '') // Remove trailing dots
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim()
      .substring(0, 200); // Limit length to prevent issues
  }

  function deduplicateItems(items) {
    const seen = new Set();
    const deduplicated = [];
    let duplicateCount = 0;

    for (const item of items) {
      if (seen.has(item.Id)) {
        duplicateCount++;
        logDebug(`Removing duplicate item: ${item.Name} (ID: ${item.Id})`);
      } else {
        seen.add(item.Id);
        deduplicated.push(item);
      }
    }

    if (duplicateCount > 0) {
      logDebug(`Removed ${duplicateCount} duplicates from ${items.length} items`);
    }

    return deduplicated;
  }

  // NEW v6.50: Parallel request helper with concurrency control
  async function parallelFetch(tasks, concurrency = 5, onProgress = null) {
    const results = [];
    const executing = [];
    let completed = 0;

    for (const task of tasks) {
      const p = Promise.resolve().then(() => task());
      results.push(p);

      if (concurrency <= tasks.length) {
        const e = p.then(() => {
          completed++;
          if (onProgress) onProgress(completed, tasks.length);
          executing.splice(executing.indexOf(e), 1);
        });
        executing.push(e);

        if (executing.length >= concurrency) {
          await Promise.race(executing);
        }
      }
    }

    return Promise.all(results);
  }

  // Ensure item has a valid name field - universal failsafe
  function ensureItemName(item) {
    if (item.Name && item.Name.trim()) {
      return item; // Already has valid name
    }

    console.warn(`[EmbyGrab] Item missing name field. Type: ${item.Type}, ID: ${item.Id}`);

    // Try multiple fallback sources
    item.Name =
      item.OriginalTitle?.trim() ||
      item.FileName?.split('.')[0]?.trim() ||
      item.Path?.split('/').pop()?.split('.')[0]?.trim() ||
      (item.Type ? `${item.Type}_${item.Id}` : `Item_${item.Id}`);

    logDebug(`Assigned fallback name: ${item.Name}`);
    return item;
  }
  function constructDownloadUrl(item, server, token) {
    const bypassMode = 'directplay'; // Always enforce Strict Bypass
    const emulateClient = Settings.get('emulateClient');

    if (item.MediaSources && item.MediaSources.length > 0) {
      const source = item.MediaSources[0];
      const container = (source.Container || item.Container || 'mkv').toLowerCase();

      // Get ETag if available (crucial for some servers)
      const tagParam = source.ETag ? `&Tag=${source.ETag}` : '';

      // Client emulation params
      let clientParams = '';
      if (emulateClient) {
        clientParams = '&DeviceId=EmbyGrab_Bypass&DeviceName=EmbyGrab&Client=Emby Web';
      }

      // Base params for stream copy
      let streamParams = `&MediaSourceId=${source.Id}${tagParam}${clientParams}&PlayMethod=DirectPlay&Copy=true&AudioCodec=copy&VideoCodec=copy`;

      if (bypassMode === 'directplay') {
        return `${server}/emby/Videos/${item.Id}/stream.${container}?api_key=${token}&Static=true${streamParams}`;
      } else if (bypassMode === 'remux') {
        return `${server}/emby/Videos/${item.Id}/stream.${container}?api_key=${token}&Static=false${streamParams}`;
      }
    }

    // Default /Download endpoint
    return `${server}/emby/Items/${item.Id}/Download?api_key=${token}`;
  }

  function buildDownloadInfo(item, server = null, token = null) {
    // Enhanced filename extraction with multiple fallbacks
    let filename = null;
    let displayName = null;

    // --- Helper to get Resolution/Codec ---
    const getMediaInfo = (item) => {
      if (!item.MediaSources || !item.MediaSources.length) return { resolution: '', codec: '' };
      const source = item.MediaSources[0];
      const stream = source.MediaStreams ? source.MediaStreams.find(s => s.Type === 'Video') : null;

      let res = '';
      if (stream) {
        if (stream.Height >= 2160) res = '4K';
        else if (stream.Height >= 1080) res = '1080p';
        else if (stream.Height >= 720) res = '720p';
        else if (stream.Height >= 480) res = '480p';
        else res = 'SD';
      } else if (source.Name && source.Name.includes('p')) {
        res = source.Name.match(/\d+p/)?.[0] || '';
      }

      return {
        resolution: res,
        codec: stream ? (stream.Codec || '').toUpperCase() : (source.Container || '').toUpperCase()
      };
    };

    // --- Template Engine ---
    const applyTemplate = (template, data) => {
      return template.replace(/{(\w+)}/g, (match, key) => {
        const lowerKey = key.toLowerCase();
        // Handle special padding logic
        if (lowerKey === 'season' || lowerKey === 'episode') {
          const val = data[lowerKey];
          return val !== undefined ? String(val).padStart(2, '0') : '';
        }
        return data[lowerKey] !== undefined ? data[lowerKey] : match;
      });
    };

    // Gather Metadata
    const mediaInfo = getMediaInfo(item);
    const metadata = {
      series: item.SeriesName || item.SeriesStudioName || '',
      showname: item.SeriesName || item.SeriesStudioName || '',
      season: item.ParentIndexNumber || 1,
      episode: item.IndexNumber,
      title: item.Name || item.OriginalTitle || 'Unknown',
      name: item.Name || item.OriginalTitle || 'Unknown',
      year: item.ProductionYear || '',
      resolution: mediaInfo.resolution,
      quality: mediaInfo.resolution,
      codec: mediaInfo.codec,
      audiocodec: mediaInfo.audioCodec || '',
      id: item.Id
    };

    // Generate Filename from Template
    if (item.Type === 'Episode') {
      const template = Settings.get('filenameTemplateEpisode');
      filename = applyTemplate(template, metadata);
    } else if (item.Type === 'Movie') {
      const template = Settings.get('filenameTemplateMovie');
      filename = applyTemplate(template, metadata);
    }

    // Fallback if template resulted in empty string or generic name, 
    // OR if it's not a type we have a template for (Audio, etc.)
    if (!filename || filename.replace(/[^a-z0-9]/gi, '').length < 3) {
      if (item.Name && item.Name.trim()) {
        filename = item.Name.trim();
      } else if (item.FileName && item.FileName.trim()) {
        filename = item.FileName.trim();
      } else if (item.Path) {
        const pathParts = item.Path.split('/');
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart) filename = lastPart.split('.')[0].trim();
      }

      if (!filename) {
        filename = `${item.Type || 'Item'}_${item.Id || Date.now()}`;
      }
    }

    // Sanitize
    filename = sanitizeFilename(filename);
    displayName = filename; // Store clean name for display

    // Add file extension
    if (item.Container && !filename.toLowerCase().endsWith(`.${item.Container.toLowerCase()}`)) {
      filename += `.${item.Container}`;
    } else if (!filename.includes('.')) {
      if (item.MediaType === 'Video') filename += '.mkv';
      else if (item.MediaType === 'Audio') filename += '.mp3';
      else filename += '.mp4';
    }

    // Build folder structure
    let folderPath = '';
    if (item.Type === 'Episode') {
      const seriesName = sanitizeFilename(metadata.series || 'Unknown Series');
      const seasonName = sanitizeFilename(item.SeasonName || `Season ${metadata.season}`);
      folderPath = `TV Shows/${seriesName}/${seasonName}`;
    } else if (item.Type === 'Movie') {
      const movieName = sanitizeFilename(metadata.title);
      const year = metadata.year ? ` (${metadata.year})` : '';
      folderPath = `Movies/${movieName}${year}`;
    } else if (item.Type === 'Audio') {
      const artist = sanitizeFilename(item.AlbumArtist || item.Artists?.[0] || 'Unknown Artist');
      const album = sanitizeFilename(item.Album || 'Unknown Album');
      folderPath = `Music/${artist}/${album}`;
      if (item.IndexNumber) {
        filename = `${String(item.IndexNumber).padStart(2, '0')} - ${filename}`;
      }
    } else {
      folderPath = item.Type ? `${item.Type}s` : 'Other Media';
    }

    // Safe subtitle extraction
    let subtitles = [];
    try {
      subtitles = EXTRACT_SUBTITLES(item, filename, server, token);
    } catch (e) {
      console.warn('Failed to extract subtitles for item:', item.Name, e);
    }

    return {
      filename,
      folderPath,
      fullPath: folderPath ? `${folderPath}/${filename}` : filename,
      displayName: displayName,
      // NEW v6.59: Pass subtitle info if enabled
      subtitles: subtitles
    };
  }

  // NEW v6.59: Subtitle Extraction Helper
  function EXTRACT_SUBTITLES(item, videoFilename, server = null, token = null) {
    if (!Settings.get('dlExternalSubtitles')) return [];
    if (!item.MediaSources || !item.MediaSources.length) return [];

    const source = item.MediaSources[0];
    if (!source.MediaStreams) return [];

    const preferredLangs = (Settings.get('subtitleLanguages') || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s);

    const subtitles = source.MediaStreams.filter(s => s.Type === 'Subtitle' && s.IsExternal);

    return subtitles
      .filter(sub => {
        if (preferredLangs.length === 0) return true; // Download all if no preference
        const lang = (sub.Language || '').toLowerCase();
        // Match 3-letter code or entire language name
        return preferredLangs.some(p => lang === p || lang.includes(p));
      })
      .map(sub => {
        let codec = (sub.Codec || 'srt').toLowerCase();
        if (codec === 'subrip') codec = 'srt';
        const lang = sub.Language || 'und';
        const baseName = videoFilename.substring(0, videoFilename.lastIndexOf('.'));
        // Format: Movie Name (2023).eng.srt
        const subFilename = `${baseName}.${lang}.${codec}`;

        let apiUrl = server;
        let apiToken = token;

        // Fallback to global getApiClient if server/token not provided
        if (typeof getApiClient === 'function') {
          const client = getApiClient();
          if (client) {
            apiUrl = apiUrl || normalizeServerAddress(client._serverAddress);
            apiToken = apiToken || (client._userAuthInfo?.AccessToken) || client.accessToken;
          }
        }

        // Enforce Strict Bypass for subtitles
        const bypassMode = 'directplay';
        const emulateClient = Settings.get('emulateClient');
        let bypassParams = '';

        // Apply Bypass params to subtitles
        // Get ETag if available
        const tagParam = source.ETag ? `&Tag=${source.ETag}` : '';

        // Add fake device params
        let clientParams = '';
        if (emulateClient) {
          clientParams = '&DeviceId=EmbyGrab_Bypass&DeviceName=EmbyGrab&Client=Emby Web';
        }

        bypassParams = `${tagParam}${clientParams}&Static=${bypassMode === 'directplay'}&PlayMethod=DirectPlay`;

        return {
          url: `${apiUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${codec}?api_key=${apiToken}${bypassParams}`,
          filename: subFilename,
          language: lang,
          isDefault: sub.IsDefault,
          isForced: sub.IsForced
        };
      })
      .filter(sub => sub !== null);
  }


  // ---------- JDownloader Integration ----------
  async function testJDownloaderConnection(port = null) {
    const testPort = port || Settings.get('jdownloaderPort');
    try {
      const response = await gmFetch(`http://localhost:${testPort}/flashgot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'urls=test&package=ConnectionTest&autostart=0',
        signal: { timeout: CONFIG.jdownloader.timeout } // Adapted for gmFetch
      });
      return response.ok;
    } catch (error) {
      // Only log connection failures if they're unexpected (not timeout/network errors)
      if (!error.name?.includes('Abort') && !error.message?.includes('Failed to fetch')) {
        console.log(`[JDownloader] Connection test failed on port ${testPort}:`, error.message);
      }
      return false;
    }
  }

  // Auto-detection for JDownloader
  let jdownloaderDetectionInterval = null;
  let lastJDownloaderStatus = false;

  async function checkJDownloaderStatus() {
    const isConnected = await testJDownloaderConnection();

    if (isConnected !== lastJDownloaderStatus) {
      lastJDownloaderStatus = isConnected;

      if (isConnected) {
        // JDownloader just became available
        logDebug('[JDownloader] Detected! Auto-enabling integration...');
        Settings.set('enableJDownloader', true);
        showNotification('JDownloader detected and enabled!', 'success', 3000);

        // Update UI if settings panel is open
        const jdCheckbox = document.getElementById('enable-jdownloader');
        if (jdCheckbox) {
          jdCheckbox.checked = true;
        }
      } else {
        // JDownloader disconnected
        logDebug('[JDownloader] Connection lost');
        Settings.set('enableJDownloader', false);

        // Update UI if settings panel is open
        const jdCheckbox = document.getElementById('enable-jdownloader');
        if (jdCheckbox) {
          jdCheckbox.checked = false;
        }
      }
    }

    return isConnected;
  }

  function startJDownloaderDetection() {
    // Don't check immediately to avoid permission prompts on page load
    // Only check when actually needed (when user tries to use JDownloader)
    if (jdownloaderDetectionInterval) {
      clearInterval(jdownloaderDetectionInterval);
    }

    // Disabled automatic polling to prevent browser permission popups
    // JDownloader status will be checked only when user attempts to send downloads
    logDebug('[JDownloader] Auto-detection disabled to prevent permission popups. Will check on-demand when needed.');
  }

  function stopJDownloaderDetection() {
    if (jdownloaderDetectionInterval) {
      clearInterval(jdownloaderDetectionInterval);
      jdownloaderDetectionInterval = null;
      logDebug('[JDownloader] Auto-detection stopped');
    }
  }

  async function sendToJDownloader(items, server, token, packageName = 'Emby Downloads') {
    const port = Settings.get('jdownloaderPort');

    // Deduplicate items by ID to prevent duplicates
    const uniqueItems = deduplicateItems(items);

    logDebug(`[JDownloader] Sending ${uniqueItems.length} unique items (filtered from ${items.length} total)`);

    // Build download entries with proper folder structure and filenames
    const downloadEntries = uniqueItems.map(item => {
      const downloadInfo = buildDownloadInfo(item, server, token);

      // Log items with potentially missing metadata
      if (!item.Name && !item.FileName && !item.Path) {
        console.warn(`[JDownloader] ⚠️ Item ${item.Id} has NO metadata fields (Name, FileName, Path). Emby will likely send generic filename.`, {
          Id: item.Id,
          Type: item.Type,
          Name: item.Name,
          FileName: item.FileName,
          Path: item.Path,
          OriginalTitle: item.OriginalTitle
        });
      }

      // Create a mapping of item ID to filename for JDownloader
      // We'll pass this in the comment field which JDownloader can use
      const url = getFullBypassUrl(item, server, token);

      return {
        url: url,
        filename: downloadInfo.filename,
        itemId: item.Id,
        folderPath: downloadInfo.folderPath,
        fullPath: downloadInfo.fullPath
      };
    });

    try {
      logDebug(`[JDownloader] Preparing to send ${downloadEntries.length} files...`);
      logDebug(`[JDownloader] Files to send:`, downloadEntries.map(e => e.filename));
      logDebug(`[JDownloader] Package name: ${packageName}`);

      // Try the action/add/links endpoint which is the most reliable
      // This endpoint works differently - we need to properly format the download path
      // by appending the filename to the Emby download URL as a path segment

      const modifiedEntries = downloadEntries.map(entry => {
        return {
          ...entry,
          packageName: packageName
        };
      });
      const sampleUrl = modifiedEntries[0] ? modifiedEntries[0].url : 'N/A';
      logDebug(`[JDownloader] Sample URL with filename:`, sampleUrl);

      // Method 1: Try the /action/add/links endpoint
      const actionPayload = {
        autostart: true,
        links: modifiedEntries.map(e => e.url).join('\r\n'),
        packageName: packageName,
        overwritePackagizerEnabled: false,
        priority: 'DEFAULT'
      };

      // Skip the action API and go straight to FlashGot (action API returns 501 Not Implemented)
      logDebug(`[JDownloader] Using FlashGot API...`);

      // Use the basic FlashGot API with URL fragments for filenames
      const flashgotPayload = new URLSearchParams({
        urls: modifiedEntries.map(e => e.url).join('\r\n'),
        package: packageName,
        autostart: '1',
        source: 'EmbyGrab'
      });

      const response = await gmFetch(`http://localhost:${port}/flashgot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: flashgotPayload.toString(),
        signal: { timeout: CONFIG.jdownloader.timeout } // Adapted for gmFetch
      });

      logDebug(`[JDownloader] FlashGot response status: ${response.status}`);
      const responseText = await response.text();
      logDebug(`[JDownloader] FlashGot response:`, responseText);

      if (!response.ok) {
        throw new Error(`JDownloader FlashGot API failed. Status: ${response.status}, Response: ${responseText}`);
      }

      logDebug(`[JDownloader] Successfully sent ${uniqueItems.length} downloads to package: ${packageName}`);

      return true;
    } catch (error) {
      console.error('Failed to send links to JDownloader:', error);
      throw new Error(`Failed to send links to JDownloader: ${error.message}`);
    }
  }

  // ---------- JDownloader Rename Script Generator ----------
  function downloadJDownloaderRenameScript(items, server, token, packageName, platform = 'python') {
    const downloadInfo = items.map(item => buildDownloadInfo(item, server, token));
    const sanitizedPackageName = packageName.replace(/[^a-z0-9]/gi, '_');
    let scriptContent, filename, fileType;

    // Generate Python script
    const pythonScript = `#!/usr/bin/env python3
"""
EmbyGrab JDownloader File Renamer
Generated: ${new Date().toLocaleString()}
Package: ${packageName}

This script renames Download.mp4, Download_2.mp4, etc. to their proper filenames.
"""

import os
import sys

# Filename mapping (in download order)
filenames = [
${downloadInfo.map((info, i) => `    "${info.filename}",  # ${i + 1}`).join('\n')}
]

def rename_files(folder_path):
    if not os.path.exists(folder_path):
        print(f"[ERROR] Error: Folder not found: {folder_path}")
        print("   Make sure JDownloader finished downloading!")
        return False

    print(f"[INFO] Scanning: {folder_path}\\n")

    # Find all Download*.* files
    download_files = []
    for filename in os.listdir(folder_path):
        if filename.startswith("Download"):
            download_files.append(filename)

    if not download_files:
        print("[ERROR] No 'Download*' files found in this folder!")
        print("   Make sure you're in the correct JDownloader download folder.")
        return False

    # Sort files: Download.ext, Download_2.ext, Download_3.ext, etc.
    def sort_key(f):
        if '_' not in f:
            return 0
        try:
            return int(f.split('_')[1].split('.')[0])
        except:
            return 999999

    download_files.sort(key=sort_key)

    print(f"Found {len(download_files)} download files")
    print(f"Expected {len(filenames)} files\\n")

    if len(download_files) != len(filenames):
        print("[WARNING] Warning: File count mismatch!")
        response = input("Continue anyway? (y/n): ")
        if response.lower() != 'y':
            return False

    # Rename files
    renamed = 0
    for i, old_name in enumerate(download_files):
        if i >= len(filenames):
            print(f"[WARNING] Skipping {old_name} (no mapping)")
            continue

        old_path = os.path.join(folder_path, old_name)
        new_name = filenames[i]
        new_path = os.path.join(folder_path, new_name)

        try {
            if os.path.exists(new_path):
                print(f"[SKIP] Skipped: {new_name} (already exists)")
            else:
                os.rename(old_path, new_path)
                print(f"[OK] {old_name} -> {new_name}")
                renamed += 1
        except Exception as e:
            print(f"[ERROR] Error renaming {old_name}: {e}")

    print(f"\\n{'='*60}")
    print(f"[DONE] Renamed {renamed}/{len(download_files)} files")
    print(f"{'='*60}")
    return True

if __name__ == "__main__":
    print("="*60)
    print("EmbyGrab JDownloader File Renamer")
    print("="*60)
    print()

    if len(sys.argv) > 1:
        folder = sys.argv[1]
    else:
        print("Enter the full path to your JDownloader download folder:")
        print(f"Example: /Users/yourname/Downloads/{packageName}")
        print()
        folder = input("Path: ").strip().strip('"').strip("'")

    if folder:
        rename_files(folder)
    else:
        print("[ERROR] No folder path provided!")
`;

    // Windows Batch Script
    const windowsScript = `@echo off
REM EmbyGrab JDownloader File Renamer for Windows
REM Generated: ${new Date().toLocaleString()}
REM Package: ${packageName}

setlocal enabledelayedexpansion

echo ============================================================
echo EmbyGrab JDownloader File Renamer
echo ============================================================
echo.

set /p "FOLDER=Enter JDownloader download folder path: "

if "%FOLDER%"=="" (
    echo Error: No folder path provided!
    pause
    exit /b 1
)

cd /d "%FOLDER%" 2>nul
if errorlevel 1 (
    echo Error: Folder not found: %FOLDER%
    pause
    exit /b 1
)

echo.
echo Scanning: %FOLDER%
echo.

REM Define filenames array
${downloadInfo.map((info, i) => `set "FILE${i}=${info.filename}"`).join('\n')}

REM Rename files
set INDEX=0
set RENAMED=0

for %%F in (Download*.mp4 Download*.mkv Download*.avi) do (
    if exist "%%F" (
        call set "NEWNAME=%%FILE!INDEX!%%"
        if not "!NEWNAME!"=="" (
            if not exist "!NEWNAME!" (
                ren "%%F" "!NEWNAME!"
                echo [OK] %%F --^> !NEWNAME!
                set /a RENAMED+=1
            ) else (
                echo [SKIP] !NEWNAME! already exists
            )
        )
        set /a INDEX+=1
    )
)

echo.
echo ============================================================
echo Done! Renamed %RENAMED% files
echo ============================================================
pause
`;

    // macOS/Linux Shell Script
    const unixScript = `#!/bin/bash
# EmbyGrab JDownloader File Renamer
# Generated: ${new Date().toLocaleString()}
# Package: ${packageName}

echo "============================================================"
echo "EmbyGrab JDownloader File Renamer"
echo "============================================================"
echo ""

# Prompt for folder path
read -p "Enter JDownloader download folder path: " FOLDER

if [ -z "$FOLDER" ]; then
    echo "❌ Error: No folder path provided!"
    exit 1
fi

if [ ! -d "$FOLDER" ]; then
    echo "❌ Error: Folder not found: $FOLDER"
    exit 1
fi

cd "$FOLDER" || exit 1

echo ""
echo "📁 Scanning: $FOLDER"
echo ""

# Define filenames array
FILENAMES=(
${downloadInfo.map(info => `    "${info.filename}"`).join('\n')}
)

# Find and rename files
INDEX=0
RENAMED=0

for file in Download*.mp4 Download*.mkv Download*.avi Download_*.mp4 Download_*.mkv Download_*.avi; do
    if [ -f "$file" ]; then
        if [ $INDEX -lt ${downloadInfo.length} ]; then
            NEWNAME="${'${FILENAMES[$INDEX]}'}"
            if [ ! -f "$NEWNAME" ]; then
                mv "$file" "$NEWNAME"
                echo "✓ $file → $NEWNAME"
                ((RENAMED++))
            else
                echo "[SKIP] $NEWNAME already exists"
            fi
        fi
        ((INDEX++))
    fi
done

echo ""
echo "============================================================"
echo "[DONE] Renamed $RENAMED files"
echo "============================================================"
`;

    // Select script based on platform
    if (platform === 'windows') {
      scriptContent = windowsScript;
      filename = `rename_jdownloader_${sanitizedPackageName}.bat`;
      fileType = 'application/x-bat';
    } else if (platform === 'macos') {
      scriptContent = unixScript;
      filename = `rename_jdownloader_${sanitizedPackageName}.command`;
      fileType = 'text/plain';
    } else if (platform === 'linux') {
      scriptContent = unixScript;
      filename = `rename_jdownloader_${sanitizedPackageName}.sh`;
      fileType = 'text/x-sh';
    } else { // python
      scriptContent = pythonScript;
      filename = `rename_jdownloader_${sanitizedPackageName}.py`;
      fileType = 'text/x-python';
    }

    // Create downloadable file
    const blob = new Blob([scriptContent], { type: fileType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[SUCCESS] ${platform.toUpperCase()} rename script downloaded: ${filename}`);
  }

  // ---------- wget/curl Script Generator ----------
  function generateWgetCurlScript(items, server, token, packageName) {
    const uniqueItems = deduplicateItems(items);
    const downloadInfo = uniqueItems.map(item => {
      const info = buildDownloadInfo(item, server, token);
      const url = getFullBypassUrl(item, server, token);
      return { ...info, url };
    });
    const sanitizedPackageName = packageName.replace(/[^a-z0-9_-]/gi, '_');

    // Detect OS
    const isWindows = navigator.platform.toLowerCase().includes('win');
    const isMac = navigator.platform.toLowerCase().includes('mac');

    let scriptContent, filename, fileType;

    if (isWindows) {
      // Windows Batch Script using curl (built-in Windows 10+)
      scriptContent = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================
echo EmbyGrab Download Script for Windows
echo ============================================
echo.
echo Package: ${packageName}
echo Files: ${downloadInfo.length}
echo.
echo Downloads will be saved to current folder
echo Press Ctrl+C to cancel
echo.
pause

echo.
echo Starting downloads...
echo.

`;

      downloadInfo.forEach((info, index) => {
        const url = info.url;
        const filename = info.filename.replace(/"/g, '\\"');
        scriptContent += `echo [${index + 1}/${downloadInfo.length}] ${filename}\n`;
        scriptContent += `curl -L -o "${filename}" "${url}"\n`;
        scriptContent += `if errorlevel 1 (\n`;
        scriptContent += `  echo ERROR: Failed to download ${filename}\n`;
        scriptContent += `) else (\n`;
        scriptContent += `  echo SUCCESS: ${filename}\n`;
        scriptContent += `)\n`;
        scriptContent += `echo.\n\n`;
      });

      scriptContent += `echo.
echo ============================================
echo Download Complete!
echo ============================================
echo.
pause
`;

      filename = `embygrab_${sanitizedPackageName}.bat`;
      fileType = 'text/plain';

    } else {
      // Unix Shell Script (Mac/Linux) using wget or curl
      scriptContent = `#!/bin/bash

echo "============================================"
echo "EmbyGrab Download Script"
echo "============================================"
echo ""
echo "Package: ${packageName}"
echo "Files: ${downloadInfo.length}"
echo ""
echo "Downloads will be saved to current folder"
echo "Press Ctrl+C to cancel"
echo ""
read -p "Press Enter to start downloading..."

echo ""
echo "Starting downloads..."
echo ""

# Check if wget is available, otherwise use curl
if command -v wget &> /dev/null; then
  DOWNLOADER="wget"
elif command -v curl &> /dev/null; then
  DOWNLOADER="curl"
else
  echo "ERROR: Neither wget nor curl found. Please install one of them."
  exit 1
fi

FAILED=0
SUCCESS=0

`;

      downloadInfo.forEach((info, index) => {
        const url = info.url;
        const filename = info.filename.replace(/'/g, "'\\''");
        scriptContent += `echo "[${index + 1}/${downloadInfo.length}] ${filename}"\n`;
        scriptContent += `if [ "$DOWNLOADER" = "wget" ]; then\n`;
        scriptContent += `  wget -O '${filename}' '${url}'\n`;
        scriptContent += `else\n`;
        scriptContent += `  curl -L -o '${filename}' '${url}'\n`;
        scriptContent += `fi\n\n`;
        scriptContent += `if [ $? -eq 0 ]; then\n`;
        scriptContent += `  echo "SUCCESS: ${filename}"\n`;
        scriptContent += `  SUCCESS=$((SUCCESS + 1))\n`;
        scriptContent += `else\n`;
        scriptContent += `  echo "ERROR: Failed to download ${filename}"\n`;
        scriptContent += `  FAILED=$((FAILED + 1))\n`;
        scriptContent += `fi\n`;
        scriptContent += `echo ""\n\n`;
      });

      scriptContent += `
echo ""
echo "============================================"
echo "Download Complete!"
echo "============================================"
echo "Success: $SUCCESS"
echo "Failed: $FAILED"
echo ""
`;

      if (isMac) {
        filename = `embygrab_${sanitizedPackageName}.command`;
      } else {
        filename = `embygrab_${sanitizedPackageName}.sh`;
      }
      fileType = 'text/x-shellscript';
    }

    // Create downloadable file
    const blob = new Blob([scriptContent], { type: fileType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Show instructions
    let instructions;
    if (isWindows) {
      instructions = `Windows Instructions:
1. Find the downloaded file: ${filename}
2. Double-click it to run
3. Files will download to the same folder

Note: If Windows blocks the script, right-click → Properties → Unblock`;
    } else if (isMac) {
      instructions = `macOS Instructions:
1. Find the downloaded file: ${filename}
2. Double-click it to run (Terminal will open)
3. Files will download to the same folder

Note: If blocked, right-click → Open, or run in Terminal:
  chmod +x "${filename}" && ./"${filename}"`;
    } else {
      instructions = `Linux Instructions:
1. Open Terminal in the folder with ${filename}
2. Make it executable: chmod +x "${filename}"
3. Run it: ./"${filename}"
4. Files will download to current folder`;
    }

    showNotification(`wget/curl script downloaded!\n\n${instructions}`, 'success', 8000);
    console.log(`[SUCCESS] wget/curl download script generated: ${filename}`);
  }


  // ---------- Post-Scan Results Dialog ----------
  function showResultsDialog(items, server, token, operationType) {
    const isDarkMode = Settings.get('darkMode');

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 2147483649;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      animation: fadeIn 0.3s ease;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white;
      border-radius: 16px;
      padding: 24px;
      max-width: 550px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      animation: modalSlideIn 0.3s ease;
    `;

    // Apply dark mode if enabled
    if (Settings.get('darkMode')) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    const sizeInfo = calculateTotalSize(items);
    const operationTitle = {
      'collection': 'Collection',
      'folder': 'Folder',
      'show': 'TV Show',
      'movie': 'Movie'
    }[operationType] || 'Items';

    // Improved package naming with more detail
    let packageName;
    const uniqueItems = deduplicateItems(items);

    if (operationType === 'show') {
      const seriesName = uniqueItems[0]?.SeriesName || 'TV Show';
      const seasonNames = [...new Set(uniqueItems.map(item => item.SeasonName).filter(Boolean))];
      if (seasonNames.length === 1) {
        packageName = `${seriesName} - ${seasonNames[0]}`;
      } else if (seasonNames.length > 1) {
        packageName = `${seriesName} - Multiple Seasons`;
      } else {
        packageName = seriesName;
      }
    } else if (operationType === 'movie') {
      const movieName = uniqueItems[0]?.Name || 'Movie';
      const year = uniqueItems[0]?.ProductionYear;
      packageName = year ? `${movieName} (${year})` : movieName;
    } else if (operationType === 'collection') {
      // Use stored collection name, fallback to trying to extract from items
      const collectionName = currentCollectionName || uniqueItems[0]?.ParentCollectionName || uniqueItems[0]?.CollectionName || 'Collection';
      // Only add "Collection" suffix if the name doesn't already contain it
      packageName = collectionName.toLowerCase().includes('collection') ? collectionName : `${collectionName} Collection`;
      // Reset the global collection name for next operation
      currentCollectionName = null;
    } else {
      packageName = `Emby ${operationTitle} - ${new Date().toLocaleDateString()}`;
    }

    const jdownloaderEnabled = Settings.get('jdownloaderEnabled');

    // Check for blocked downloads
    const hasBlockedDownloads = uniqueItems.some(item => item.CanDownload === false);
    const bypassEnabled = Settings.get('bypassMode') !== 'disabled';

    // Banner for blocked downloads
    // Banner for blocked downloads
    const blockedBanner = (hasBlockedDownloads && !bypassEnabled) ? `
      <div id="bypass-suggestion" style="
        margin: 0 0 16px 0;
        padding: 12px;
        background: ${isDarkMode ? '#451a1a' : '#fee2e2'};
        border: 1px solid #ef4444;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      ">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${Icons.alert}
          <div style="position: relative; ">
            <span style="font-weight: 600; color: ${isDarkMode ? '#fca5a5' : '#b91c1c'}; font-size: 14px;">Downloads Restricted</span>
            <span style="color: ${isDarkMode ? '#fecaca' : '#7f1d1d'}; font-size: 13px;">Server has disabled downloads for some items.</span>
          </div>
        </div>
        <button id="enable-bypass-btn" style="
          padding: 6px 12px;
          background: #ef4444;
          color: white;
          border: none;
          border-radius: 4px;
          font-weight: 500;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.2s;
        ">Enable Bypass</button>
      </div>
    ` : '';

    dialog.innerHTML = `
      <!-- ── Header ── -->
      <div style="
        padding: 20px 24px 0 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
        padding-bottom: 16px;
        margin-bottom: 0;
      ">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="
            width: 40px; height: 40px; border-radius: 10px;
            background: ${getTheme().primary}22;
            display: flex; align-items: center; justify-content: center;
            color: ${getTheme().primary};
          ">${Icons.check}</div>
          <div>
            <h3 style="margin: 0; font: 700 18px system-ui; color: ${isDarkMode ? '#f3f4f6' : '#111827'};">
              Scan Complete
            </h3>
            <p style="margin: 2px 0 0; font: 13px system-ui; color: ${isDarkMode ? '#9ca3af' : '#6b7280'};">
              ${uniqueItems.length} item${uniqueItems.length === 1 ? '' : 's'} ready${items.length !== uniqueItems.length ? ` &bull; ${items.length - uniqueItems.length} dupes removed` : ''}
            </p>
          </div>
        </div>
        <button id="results-close" style="
          width: 32px; height: 32px; border-radius: 8px;
          border: none; background: ${isDarkMode ? '#2a2a2a' : '#f3f4f6'};
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer; font-size: 18px; line-height: 1;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.15s;
        " onmouseover="this.style.background='${isDarkMode ? '#3a3a3a' : '#e5e7eb'}'" 
           onmouseout="this.style.background='${isDarkMode ? '#2a2a2a' : '#f3f4f6'}'">&#x2715;</button>
      </div>

      <!-- ── Stats card ── -->
      <div style="padding: 16px 24px;">

        <div style="
          display: grid; grid-template-columns: repeat(3,1fr); gap: 8px;
          margin-bottom: 16px;
        ">
          <div style="
            padding: 12px; border-radius: 10px; text-align: center;
            background: ${isDarkMode ? '#1a1a2e' : '#eff6ff'};
            border: 1px solid ${isDarkMode ? '#1e3a5f' : '#bfdbfe'};
          ">
            <div style="font: 700 22px system-ui; color: ${isDarkMode ? '#60a5fa' : '#2563eb'};">${uniqueItems.length}</div>
            <div style="font: 500 11px system-ui; color: ${isDarkMode ? '#93c5fd' : '#3b82f6'}; margin-top:2px;">FILES</div>
          </div>
          <div style="
            padding: 12px; border-radius: 10px; text-align: center;
            background: ${isDarkMode ? '#0f2619' : '#f0fdf4'};
            border: 1px solid ${isDarkMode ? '#1a4731' : '#bbf7d0'};
          ">
            <div style="font: 700 22px system-ui; color: ${isDarkMode ? '#4ade80' : '#16a34a'};">${sizeInfo.totalSize > 0 ? formatFileSize(sizeInfo.totalSize) : 'N/A'}</div>
            <div style="font: 500 11px system-ui; color: ${isDarkMode ? '#86efac' : '#22c55e'}; margin-top:2px;">TOTAL SIZE</div>
          </div>
          <div style="
            padding: 12px; border-radius: 10px; text-align: center;
            background: ${isDarkMode ? '#1a1121' : '#faf5ff'};
            border: 1px solid ${isDarkMode ? '#3b1f5e' : '#e9d5ff'};
          ">
            <div style="font: 700 13px system-ui; color: ${isDarkMode ? '#c084fc' : '#7c3aed'}; margin-top:4px;">${CONFIG.outputFormats[Settings.get('outputFormat')]}</div>
            <div style="font: 500 11px system-ui; color: ${isDarkMode ? '#d8b4fe' : '#a855f7'}; margin-top:2px;">FORMAT</div>
          </div>
        </div>

        <!-- ── Primary Action Buttons ── -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
          <button id="download-manager" style="
            padding: 13px 16px; border: none; border-radius: 10px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white; cursor: pointer; font: 600 14px system-ui;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 3px 10px rgba(16,185,129,0.35);
            transition: all 0.2s ease;
          " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(16,185,129,0.45)'"
             onmouseout="this.style.transform='';this.style.boxShadow='0 3px 10px rgba(16,185,129,0.35)'">
            ${Icons.manager} Download Manager
          </button>

          <button id="send-jdownloader" style="
            padding: 13px 16px; border: none; border-radius: 10px;
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: white; cursor: pointer; font: 600 14px system-ui;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 3px 10px rgba(245,158,11,0.35);
            transition: all 0.2s ease;
          " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(245,158,11,0.45)'"
             onmouseout="this.style.transform='';this.style.boxShadow='0 3px 10px rgba(245,158,11,0.35)'">
            ${Icons.jdownloader} JDownloader
          </button>

          <button id="copy-clipboard" style="
            padding: 13px 16px; border: none; border-radius: 10px;
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white; cursor: pointer; font: 600 14px system-ui;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 3px 10px rgba(59,130,246,0.35);
            transition: all 0.2s ease;
          " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(59,130,246,0.45)'"
             onmouseout="this.style.transform='';this.style.boxShadow='0 3px 10px rgba(59,130,246,0.35)'">
            ${Icons.clipboard} Copy to Clipboard
          </button>

          <button id="wget-curl-script" style="
            padding: 13px 16px; border: none; border-radius: 10px;
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
            color: white; cursor: pointer; font: 600 14px system-ui;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 3px 10px rgba(139,92,246,0.35);
            transition: all 0.2s ease;
          " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px rgba(139,92,246,0.45)'"
             onmouseout="this.style.transform='';this.style.boxShadow='0 3px 10px rgba(139,92,246,0.35)'">
            ${Icons.terminal} wget/curl Script
          </button>
        </div>


        <!-- ── Secondary / More Options ── -->
        <details style="margin-top: 4px;">
          <summary style="
            cursor: pointer; padding: 10px 14px;
            background: ${isDarkMode ? '#1e1e1e' : '#f9fafb'};
            border: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
            border-radius: 8px; font: 500 13px system-ui;
            color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
            user-select: none; display: flex; align-items: center; gap: 8px;
            list-style: none;
          ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            More Options &amp; Scripts
          </summary>
          <div style="
            margin-top: 8px; padding: 12px;
            background: ${isDarkMode ? '#141414' : '#fafafa'};
            border: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
            border-radius: 8px; display: flex; flex-direction: column; gap: 6px;
          ">
            <button id="generate-qr" style="
              padding: 9px 14px; text-align: left;
              border: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
              border-radius: 6px; background: ${isDarkMode ? '#1e1e1e' : 'white'};
              color: ${isDarkMode ? '#d1d5db' : '#374151'};
              cursor: pointer; font: 13px system-ui;
              display: flex; align-items: center; gap: 8px; transition: background 0.15s;
            " onmouseover="this.style.background='${isDarkMode ? '#2a2a2a' : '#f3f4f6'}'" onmouseout="this.style.background='${isDarkMode ? '#1e1e1e' : 'white'}'">
              ${Icons.qr} Generate QR Code
            </button>
            <button id="email-links" style="
              padding: 9px 14px; text-align: left;
              border: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
              border-radius: 6px; background: ${isDarkMode ? '#1e1e1e' : 'white'};
              color: ${isDarkMode ? '#d1d5db' : '#374151'};
              cursor: pointer; font: 13px system-ui;
              display: flex; align-items: center; gap: 8px; transition: background 0.15s;
            " onmouseover="this.style.background='${isDarkMode ? '#2a2a2a' : '#f3f4f6'}'" onmouseout="this.style.background='${isDarkMode ? '#1e1e1e' : 'white'}'">
              ${Icons.email} Email Links
            </button>
            <!-- JDownloader rename scripts removed because Strict Bypass is always active and JDownloader natively grabs filenames -->
          </div>
        </details>


        <!-- ── Footer meta ── -->
        <div style="
          margin-top: 12px; padding: 8px 12px;
          border-radius: 6px;
          background: ${isDarkMode ? '#0f2619' : '#f0fdf4'};
          border-left: 3px solid #10b981;
          font: 12px system-ui; color: ${isDarkMode ? '#86efac' : '#047857'};
          display: flex; align-items: center; gap: 6px;
        ">
          ${Icons.check}
          JDownloader package: &ldquo;${packageName}&rdquo;
        </div>
      </div>
    `;

    const cleanup = () => {
      overlay.style.animation = 'fadeIn 0.2s ease reverse';
      setTimeout(() => overlay.remove(), 200);
    };

    // Event listeners
    dialog.querySelector('#results-close').addEventListener('click', cleanup);

    dialog.querySelector('#copy-clipboard').addEventListener('click', async () => {
      try {
        dialog.querySelector('#copy-clipboard').disabled = true;
        dialog.querySelector('#copy-clipboard').innerHTML = `${Icons.download} Copying...`;

        const outputFormat = Settings.get('outputFormat');
        const formatter = OutputFormatters[outputFormat];
        const text = formatter(uniqueItems, server, token);

        await copyToClipboard(text);

        const formatName = CONFIG.outputFormats[outputFormat];
        showNotification(`Copied ${uniqueItems.length} links (${formatName}) to clipboard!`, 'success');
        cleanup();
      } catch (error) {
        showNotification(`Failed to copy: ${error.message}`, 'error');
        dialog.querySelector('#copy-clipboard').disabled = false;
        dialog.querySelector('#copy-clipboard').innerHTML = `${Icons.clipboard} Copy to Clipboard`;
      }
    });

    dialog.querySelector('#send-jdownloader').addEventListener('click', async () => {
      const jdownloaderBtn = dialog.querySelector('#send-jdownloader');

      // Check connection first
      if (!Settings.get('jdownloaderEnabled')) {
        jdownloaderBtn.disabled = true;
        jdownloaderBtn.innerHTML = `${Icons.jdownloader} Connecting...`;

        const isConnected = await testJDownloaderConnection();
        if (!isConnected) {
          showNotification('JDownloader not detected! Please ensure it is open and installed.', 'error', 4000);
          jdownloaderBtn.disabled = false;
          jdownloaderBtn.innerHTML = `${Icons.jdownloader} JDownloader`;
          return;
        }
        Settings.set('jdownloaderEnabled', true);
      }

      try {
        jdownloaderBtn.disabled = true;
        jdownloaderBtn.innerHTML = `${Icons.download} Sending...`;

        await sendToJDownloader(uniqueItems, server, token, packageName);
        showNotification(`Sent ${uniqueItems.length} downloads to JDownloader!`, 'success');
        cleanup();
      } catch (error) {
        showNotification(`JDownloader error: ${error.message}`, 'error');
        jdownloaderBtn.disabled = false;
        jdownloaderBtn.innerHTML = `${Icons.jdownloader} JDownloader`;
      }
    });

    // QR Code generation
    dialog.querySelector('#generate-qr').addEventListener('click', () => {
      const qrData = OutputFormatters.qrcode(uniqueItems, server, token);
      showQRDialog(qrData, uniqueItems.length);
    });

    // Email links
    dialog.querySelector('#email-links').addEventListener('click', () => {
      const mailtoLink = OutputFormatters.email(uniqueItems, server, token);
      window.location.href = mailtoLink;
      showNotification('Opening email client...', 'success');
    });

    // Download Manager
    dialog.querySelector('#download-manager').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      showDownloadManager(uniqueItems, server, token);
    });

    // wget/curl Script Generator
    dialog.querySelector('#wget-curl-script').addEventListener('click', () => {
      generateWgetCurlScript(uniqueItems, server, token, packageName);
    });

    // Download JDownloader Rename Scripts
    const addRenameListener = (id, type, os) => {
      const btn = dialog.querySelector(id);
      if (btn) {
        btn.addEventListener('click', () => {
          downloadJDownloaderRenameScript(uniqueItems, server, token, packageName, type);
          showNotification(`[SUCCESS] ${os} script downloaded! Run after JDownloader finishes.`, 'success', 5000);
        });
      }
    };

    addRenameListener('#download-script-windows', 'windows', 'Windows batch');
    addRenameListener('#download-script-macos', 'macos', 'macOS');
    addRenameListener('#download-script-linux', 'linux', 'Linux shell');
    addRenameListener('#download-script-python', 'python', 'Python');

    // Auto-bypass listener
    const bypassBtn = dialog.querySelector('#enable-bypass-btn');
    if (bypassBtn) {
      bypassBtn.addEventListener('click', () => {
        Settings.set('bypassMode', 'directplay');
        cleanup(); // Constants like overlay usage need cleanup

        // Re-open dialog with bypass enabled (this effectively refreshes it)
        // We need to wait a tick for cleanup to process
        setTimeout(() => {
          showResultsDialog(originalItems, server, token);
        }, 100);

        showNotification('Bypass enabled! Using direct stream links.', 'success', 4000);
      });
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
      }
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ---------- QR Code Dialog ----------
  function showQRDialog(qrDataJSON, itemCount) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 2147483650;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white;
      border-radius: 16px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    `;

    // Apply dark mode if enabled
    if (Settings.get('darkMode')) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    dialog.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #1f2937; font: 600 20px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
        ${Icons.qr}
        <span>QR Code Generated</span>
      </h3>
      <p style="margin: 0 0 20px 0; color: #6b7280; font: 14px system-ui, sans-serif;">
        Scan this QR code with your mobile device to get the download links (${itemCount} items).
      </p>

      <div style="display: flex; justify-content: center; margin: 20px 0;">
        <div id="qr-code-container" style="
          padding: 16px;
          background: white;
          border: 8px solid #f9fafb;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        "></div>
      </div>

      <div style="
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        padding: 12px;
        margin: 16px 0;
        font: 12px system-ui, sans-serif;
        color: #92400e;
        display: flex;
        align-items: start;
        gap: 8px;
      ">
        ${Icons.info}
        <div><strong>Tip:</strong> The QR code contains JSON data with all download URLs. You can scan it and process the links on your mobile device.</div>
      </div>

      <div style="display: flex; gap: 12px; justify-content: flex-end; margin-top: 20px;">
        <button id="qr-close" style="
          padding: 8px 16px;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          background: white;
          color: #374151;
          cursor: pointer;
          font: 13px system-ui, sans-serif;
        ">Close</button>
      </div>
    `;

    // Generate QR code using canvas-based approach
    const container = dialog.querySelector('#qr-code-container');

    // Load QRCode library if not already loaded
    if (typeof QRCode === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      script.onload = () => {
        generateQRCode(container, qrDataJSON);
      };
      script.onerror = () => {
        // Fallback: show text instead
        container.innerHTML = `
          <div style="padding: 20px; text-align: center; color: #6b7280; font: 13px system-ui, sans-serif;">
            <div style="margin-bottom: 12px; color: #ef4444;">QR Code generation failed</div>
            <div>Data too large for QR code. Try selecting fewer items or use "Copy to Clipboard" instead.</div>
          </div>
        `;
      };
      document.head.appendChild(script);
    } else {
      generateQRCode(container, qrDataJSON);
    }

    function generateQRCode(container, data) {
      try {
        // Clear container
        container.innerHTML = '';

        // Check data size
        if (data.length > 2953) {
          // QR Code capacity exceeded
          container.innerHTML = `
            <div style="padding: 20px; text-align: center; color: #6b7280; font: 13px system-ui, sans-serif;">
              <div style="margin-bottom: 12px; color: #f59e0b;">⚠️ Too much data</div>
              <div>You have ${itemCount} items. QR codes work best with fewer items (typically under 20).</div>
              <div style="margin-top: 8px;">Try selecting fewer items or use "Copy to Clipboard" instead.</div>
            </div>
          `;
          return;
        }

        new QRCode(container, {
          text: data,
          width: 256,
          height: 256,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L // Low error correction for more data capacity
        });
      } catch (error) {
        console.error('[QRCode] Generation error:', error);
        container.innerHTML = `
          <div style="padding: 20px; text-align: center; color: #6b7280; font: 13px system-ui, sans-serif;">
            <div style="margin-bottom: 12px; color: #ef4444;">QR Code generation failed</div>
            <div>${error.message || 'Unknown error'}</div>
          </div>
        `;
      }
    }

    dialog.querySelector('#qr-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ---------- Built-in Download Manager ----------
  let downloadManagerState = null;
  let currentAbortController = null;
  let currentDownloadIndex = -1; // Track which item is currently downloading

  // Browser notification support
  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function sendDownloadCompleteNotification(completed, failed) {
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = 'EmbyGrab - Downloads Complete';
      let body = `${completed} download(s) completed successfully`;
      if (failed > 0) {
        body += `, ${failed} failed`;
      }

      try {
        const notification = new Notification(title, {
          body: body,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
          tag: 'embygrab-download-complete',
          requireInteraction: false
        });

        // Auto-close after 5 seconds
        setTimeout(() => notification.close(), 5000);
      } catch (error) {
        console.log('[EmbyGrab] Notification error:', error);
      }
    }
  }

  function showDownloadManager(items, server, token) {
    // Request notification permission
    requestNotificationPermission();
    // Try to restore previous state if available
    const savedState = GM_getValue('downloadManagerState', null);
    if (savedState && downloadManagerState === null) {
      downloadManagerState = savedState;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 2147483650;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    `;

    const manager = document.createElement('div');
    manager.id = 'emby-grab-manager';
    manager.style.cssText = `
      background: white;
      border-radius: 16px;
      padding: 16px;
      box-sizing: border-box;
      max-width: 1200px;
      width: 98%;
      height: 96vh;
      max-height: 96vh;
      min-height: 80vh;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      position: relative;
      display: flex;
      flex-direction: column;
      
    `;
    console.log('[DownloadManager] Created manager with dimensions - max-width: 1200px, width: 98%, max-height: 96vh, min-height: 80vh');

    // Apply dark mode immediately if enabled
    if (Settings.get('darkMode')) {
      manager.setAttribute('data-dark-mode', 'true');
      console.log('[DownloadManager] Applied dark mode attribute on creation');
    }

    // Initialize or restore download queue
    let downloadQueue;
    const hasPreviousQueue = downloadManagerState && downloadManagerState.server === server && downloadManagerState.queue.length > 0;
    const hasIncompleteItems = hasPreviousQueue && downloadManagerState.queue.some(item =>
      item.status === 'pending' || item.status === 'paused' || item.status === 'downloading'
    );

    // Ask user if they want to resume or start fresh
    if (hasPreviousQueue && hasIncompleteItems) {
      const previousCount = downloadManagerState.queue.length;
      const incompleteCount = downloadManagerState.queue.filter(item =>
        item.status === 'pending' || item.status === 'paused' || item.status === 'downloading'
      ).length;

      const resume = confirm(
        `You have ${incompleteCount} incomplete download(s) from a previous session (${previousCount} total items).\n\n` +
        `Click OK to RESUME previous downloads.\n` +
        `Click Cancel to START FRESH with ${items.length} new item(s).`
      );

      if (resume) {
        downloadQueue = downloadManagerState.queue;
        logDebug('[DownloadManager] Restored previous state with', downloadQueue.length, 'items');
      } else {
        // User wants fresh start
        downloadManagerState = null;
        downloadQueue = items.map((item, index) => {
          const size = item.Size || item.FileSize || 0;
          const downloadInfo = buildDownloadInfo(item, server, token);
          // Use displayName from buildDownloadInfo as primary fallback
          const displayName = item.Name || downloadInfo.displayName || downloadInfo.filename.split('.')[0] || `Item ${index + 1}`;
          logDebug(`[DownloadManager] Item ${index}: ${displayName}, Size: ${size}, Type: ${item.Type}`);
          return {
            id: item.Id,
            name: displayName,
            url: constructDownloadUrl(item, server, token),
            status: 'pending',
            progress: 0,
            downloadInfo: { ...downloadInfo, _rawItem: item },
            error: null,
            selected: false,
            size: size
          };
        });
        logDebug('[DownloadManager] Starting fresh with', downloadQueue.length, 'new items');
      }
    } else {
      // No previous queue or all completed - use new items
      downloadQueue = items.map((item, index) => {
        const size = item.Size || item.FileSize || 0;
        const downloadInfo = buildDownloadInfo(item, server, token);
        // Use displayName from buildDownloadInfo as primary fallback
        const displayName = item.Name || downloadInfo.displayName || downloadInfo.filename.split('.')[0] || `Item ${index + 1}`;
        logDebug(`[DownloadManager] Item ${index}: ${displayName}, Size: ${size}, Type: ${item.Type}`);
        return {
          id: item.Id,
          name: displayName,
          url: constructDownloadUrl(item, server, token),
          status: 'pending',
          progress: 0,
          downloadInfo: downloadInfo,
          error: null,
          selected: false,
          size: size
        };
      });
    }

    let isPaused = downloadManagerState ? downloadManagerState.isPaused : true; // Start paused – user presses Start
    let isDownloading = false;
    let downloadOnlySelected = false; // Track if we're only downloading selected items
    let downloadSingleItem = false; // Track if we're only downloading a single item
    let searchFilter = ''; // Track search filter
    let statusFilter = 'all'; // Track status tab filter: 'all'|'downloading'|'paused'|'completed'|'error'|'pending'
    const userAbortedIndices = new Set(); // Track indices aborted by user (vs global pause)

    // NEW v6.54: Concurrent downloads support
    const activeDownloads = new Map(); // Map<index, {abortController, startTime}>
    const maxConcurrentDownloads = Settings.get('concurrentDownloads') || 3;

    // Save state function
    function saveState() {
      // Create a clean copy of the queue without memory-heavy binary chunks or raw items
      const strippedQueue = downloadQueue.map(item => {
        const { _savedChunks, _liveChunks, ...rest } = item;
        const cleanDownloadInfo = rest.downloadInfo ? { ...rest.downloadInfo } : {};
        if (cleanDownloadInfo._rawItem) delete cleanDownloadInfo._rawItem;

        return {
          ...rest,
          downloadInfo: cleanDownloadInfo
        };
      });

      downloadManagerState = {
        queue: strippedQueue,
        server: server,
        isPaused: isPaused,
        lastUpdated: Date.now()
      };
      GM_setValue('downloadManagerState', downloadManagerState);
    }

    const isDarkMode = Settings.get('darkMode');

    manager.innerHTML = `
      <div id="dm-inner" style="display:flex;flex-direction:column;flex:1;min-height:0;box-sizing:border-box;overflow:hidden;">

      <!-- ══ HEADER ══ -->
      <div style="
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 0 12px 0; margin-bottom: 10px;
        border-bottom: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};
        flex-shrink: 0;
      ">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="
            width: 34px; height: 34px; border-radius: 9px;
            background: linear-gradient(135deg, ${getTheme().primary}, ${getTheme().primaryDark || getTheme().primary});
            display: flex; align-items: center; justify-content: center;
            color: white; box-shadow: 0 2px 8px ${getTheme().primary}50;
          ">${Icons.manager}</div>
          <div>
            <div style="font: 700 17px system-ui; color: ${isDarkMode ? '#f3f4f6' : '#111827'}; line-height: 1;">Download Manager</div>
            <div style="font: 12px system-ui; color: ${isDarkMode ? '#6b7280' : '#9ca3af'}; margin-top: 2px;">
              ${downloadQueue.length} item${downloadQueue.length !== 1 ? 's' : ''} in queue
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button id="toggle-view" title="Toggle Stats / List" style="
            padding: 6px 12px; border-radius: 7px;
            border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
            background: ${isDarkMode ? '#1f2937' : '#f9fafb'};
            color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
            cursor: pointer; font: 500 12px system-ui;
            display: flex; align-items: center; gap: 5px;
            transition: all 0.15s;
          ">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            <span id="view-label">Stats</span>
          </button>
          <button id="close-manager" title="Close" style="
            width: 32px; height: 32px; border-radius: 7px;
            border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
            background: ${isDarkMode ? '#1f2937' : '#f9fafb'};
            color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
            cursor: pointer; font-size: 16px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.15s;
          ">✕</button>
        </div>
      </div>

      <!-- ══ SEARCH BAR ══ -->
      <div style="position: relative; flex-shrink: 0; margin-bottom: 8px;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#9ca3af;pointer-events:none;">${Icons.search || '🔍'}</span>
        <input type="text" id="download-search" placeholder="Search downloads by name..."
          style="
            width: 100%; padding: 8px 10px 8px 34px; box-sizing: border-box;
            border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'}; border-radius: 8px;
            background: ${isDarkMode ? '#111827' : '#f9fafb'};
            color: ${isDarkMode ? '#e5e7eb' : '#374151'};
            font: 13px system-ui; outline: none; transition: border-color 0.15s;
          "
          onfocus="this.style.borderColor='${getTheme().primary}'"
          onblur="this.style.borderColor='${isDarkMode ? '#374151' : '#e5e7eb'}'">
      </div>

      <!-- ══ ACTION TOOLBAR ══ -->
      <div style="
        display: flex; gap: 6px; flex-shrink: 0; margin-bottom: 8px;
      ">
        <button id="start-all" style="
          flex: 1; padding: 9px 0; border: none; border-radius: 8px;
          background: linear-gradient(135deg, #10b981, #059669);
          color: white; cursor: pointer; font: 700 13px system-ui;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          box-shadow: 0 2px 8px rgba(16,185,129,0.3); transition: all 0.15s;
        " onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">
          ${Icons.play} Start
        </button>
        <button id="pause-all" style="
          flex: 1; padding: 9px 0;
          border: 2px solid #f59e0b; border-radius: 8px;
          background: ${isDarkMode ? 'rgba(245,158,11,0.12)' : '#fffbeb'};
          color: #f59e0b; cursor: pointer; font: 700 13px system-ui;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          transition: all 0.15s;
        " onmouseover="this.style.background='${isDarkMode ? 'rgba(245,158,11,0.2)' : '#fef3c7'}'" onmouseout="this.style.background='${isDarkMode ? 'rgba(245,158,11,0.12)' : '#fffbeb'}'">
          ${Icons.pause} Pause
        </button>
        <button id="download-selected" style="
          flex: 1; padding: 9px 0;
          border: 2px solid #8b5cf6; border-radius: 8px;
          background: ${isDarkMode ? 'rgba(139,92,246,0.12)' : '#faf5ff'};
          color: #8b5cf6; cursor: pointer; font: 700 13px system-ui;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          transition: all 0.15s;
        " onmouseover="this.style.background='${isDarkMode ? 'rgba(139,92,246,0.22)' : '#ede9fe'}'" onmouseout="this.style.background='${isDarkMode ? 'rgba(139,92,246,0.12)' : '#faf5ff'}'">
          ${Icons.download} Selected
        </button>
        <button id="retry-failed" title="Retry Failed" style="
          padding: 9px 10px; border-radius: 8px;
          border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
          background: ${isDarkMode ? '#1f2937' : '#f9fafb'};
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer; display: flex; align-items: center; gap: 4px;
          font: 500 12px system-ui; transition: all 0.15s;
        ">${Icons.retry}</button>
        <button id="clear-completed" title="Clear Completed" style="
          padding: 9px 10px; border-radius: 8px;
          border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
          background: ${isDarkMode ? '#1f2937' : '#f9fafb'};
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer; display: flex; align-items: center; gap: 4px;
          font: 500 12px system-ui; transition: all 0.15s;
        ">${Icons.trash}</button>
        <button id="cancel-all" title="Cancel All" style="
          padding: 9px 10px; border-radius: 8px;
          border: 1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
          background: ${isDarkMode ? '#1f2937' : '#f9fafb'};
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer; display: flex; align-items: center; gap: 4px;
          font: 500 12px system-ui; transition: all 0.15s;
        ">${Icons.cancel}</button>
      </div>

      <!-- ══ INFO / BULK ACTIONS BANNER ══ -->
      <div id="download-info" style="
        flex-shrink: 0; margin-bottom: 6px; padding: 8px 12px;
        background: ${isDarkMode ? 'rgba(59,130,246,0.12)' : '#eff6ff'};
        border: 1px solid ${isDarkMode ? '#1e3a5f' : '#bfdbfe'};
        border-radius: 8px; font: 12px system-ui;
        color: ${isDarkMode ? '#93c5fd' : '#1d4ed8'}; display: none;
      "></div>

      <div id="bulk-actions" style="
        flex-shrink: 0; margin-bottom: 6px; padding: 7px 12px;
        background: ${isDarkMode ? 'rgba(139,92,246,0.1)' : '#f5f3ff'};
        border: 1px solid ${isDarkMode ? '#3b1f5e' : '#ddd6fe'};
        border-radius: 8px; display: none; align-items: center; gap: 8px;
      ">
        <span style="flex:1;font:600 12px system-ui;color:${isDarkMode ? '#c084fc' : '#6d28d9'};">
          <span id="bulk-selection-count">0</span> selected
          <span id="bulk-selection-size" style="font-weight:400;font-size:11px;"></span>
        </span>
        <button id="bulk-select-all" style="padding:5px 10px;border:1px solid ${getTheme().primary};border-radius:6px;background:${isDarkMode ? '#1f2937' : 'white'};color:${getTheme().primary};cursor:pointer;font:500 11px system-ui;">${Icons.check} All</button>
        <button id="bulk-download"   style="padding:5px 10px;border:none;border-radius:6px;background:${getTheme().primary};color:white;cursor:pointer;font:500 11px system-ui;">${Icons.play} Download</button>
        <button id="bulk-remove"     style="padding:5px 10px;border:1px solid #ef4444;border-radius:6px;background:${isDarkMode ? '#1f2937' : 'white'};color:#ef4444;cursor:pointer;font:500 11px system-ui;">${Icons.trash} Remove</button>
        <button id="bulk-deselect"   style="padding:5px 10px;border:1px solid ${isDarkMode ? '#374151' : '#e5e7eb'};border-radius:6px;background:${isDarkMode ? '#1f2937' : 'white'};color:${isDarkMode ? '#9ca3af' : '#6b7280'};cursor:pointer;font:500 11px system-ui;">Deselect</button>
      </div>

      <!-- ══ LIST VIEW (scrollable) ══ -->
      <div id="list-view" style="
        flex: 1 1 0; min-height: 0; overflow-y: auto;
        border: 1px solid ${isDarkMode ? '#1f2937' : '#e5e7eb'};
        border-radius: 10px;
        background: ${isDarkMode ? '#0d1117' : '#f8fafc'};
        display: block;
      ">
        <div id="download-list"></div>
      </div>

      <!-- ══ STATS VIEW (replaces list) ══ -->
      <div id="stats-view" style="
        flex: 1 1 0; min-height: 0; overflow-y: auto;
        border: 1px solid ${isDarkMode ? '#1f2937' : '#e5e7eb'};
        border-radius: 10px;
        background: ${isDarkMode ? '#0d1117' : '#f8fafc'};
        display: none; padding: 12px;
      "></div>

      <!-- ══ BOTTOM STATUS BAR ══ -->
      <div style="
        flex-shrink: 0; margin-top: 8px; padding: 8px 14px;
        background: ${isDarkMode ? '#111827' : '#f1f5f9'};
        border: 1px solid ${isDarkMode ? '#1f2937' : '#e2e8f0'};
        border-radius: 8px; display: flex; align-items: center; gap: 12px;
      ">
        <div style="display:flex;gap:10px;flex:1;align-items:center;">
          <span style="font:500 11px system-ui;color:${isDarkMode ? '#6b7280' : '#94a3b8'};text-transform:uppercase;letter-spacing:0.5px;">Queue</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <span style="padding:2px 8px;border-radius:99px;font:600 11px system-ui;background:${isDarkMode ? 'rgba(59,130,246,0.15)' : '#dbeafe'};color:${isDarkMode ? '#60a5fa' : '#1d4ed8'};">${downloadQueue.length} total</span>
            <span id="completed-count" style="padding:2px 8px;border-radius:99px;font:600 11px system-ui;background:${isDarkMode ? 'rgba(16,185,129,0.15)' : '#d1fae5'};color:${isDarkMode ? '#34d399' : '#065f46'};">0 done</span>
            <span id="speed-box" style="display:none;padding:2px 8px;border-radius:99px;font:600 11px system-ui;background:${isDarkMode ? 'rgba(245,158,11,0.15)' : '#fef3c7'};color:${isDarkMode ? '#fbbf24' : '#92400e'};"><span id="current-speed">0 MB/s</span></span>
          </div>
        </div>
        <div id="queue-status" style="font:500 12px system-ui;color:${isDarkMode ? '#9ca3af' : '#64748b'};display:flex;align-items:center;gap:6px;">
          <span style="color:#6b7280;">●</span> Ready
        </div>
      </div>

      </div><!-- /dm-inner -->
    `;

    const downloadList = manager.querySelector('#download-list');

    const queueStatus = manager.querySelector('#queue-status');
    const completedCount = manager.querySelector('#completed-count');
    const currentSpeed = manager.querySelector('#current-speed');
    const speedBox = manager.querySelector('#speed-box');
    const downloadInfo = manager.querySelector('#download-info');
    const listView = manager.querySelector('#list-view');
    const statsView = manager.querySelector('#stats-view');
    const toggleViewBtn = manager.querySelector('#toggle-view');
    const viewLabel = manager.querySelector('#view-label');
    const bulkActions = manager.querySelector('#bulk-actions');
    // bulkActionsContainer removed – download-info and bulk-actions are now inline in the new layout
    const bulkSelectionCount = manager.querySelector('#bulk-selection-count');
    const bulkSelectionSize = manager.querySelector('#bulk-selection-size');
    const searchInput = manager.querySelector('#download-search');

    // download-info and bulk-actions are already in the correct position in the new HTML layout

    let currentView = 'list'; // 'list' or 'stats'

    function updateBulkActions() {
      const selected = downloadQueue.filter(i => i.selected);
      if (selected.length > 0) {
        bulkActions.style.display = 'flex';
        bulkSelectionCount.textContent = selected.length;

        // Calculate total size of selected items
        const totalBytes = selected.reduce((sum, item) => sum + (item.size || 0), 0);
        if (totalBytes > 0) {
          const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
          const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
          bulkSelectionSize.textContent = totalBytes > 1024 * 1024 * 1024
            ? `(${totalGB} GB)`
            : `(${totalMB} MB)`;
        } else {
          bulkSelectionSize.textContent = '';
        }
      } else {
        bulkActions.style.display = 'none';
      }
    }

    function updateStats() {
      const completed = downloadQueue.filter(i => i.status === 'completed').length;
      const failed = downloadQueue.filter(i => i.status === 'error').length;
      const downloading = downloadQueue.filter(i => i.status === 'downloading').length;
      const pending = downloadQueue.filter(i => i.status === 'pending').length;
      const paused = downloadQueue.filter(i => i.status === 'paused').length;

      completedCount.textContent = `${completed} done${failed > 0 ? ` (${failed} ✗)` : ''}`;

      // Update bulk actions toolbar
      updateBulkActions();

      // Show/hide speed box
      if (downloading > 0) {
        speedBox.style.display = 'block';
        const _totalRemaining = downloadQueue.filter(i => i.status === 'pending' || i.status === 'paused' || i.status === 'downloading').reduce((s, i) => s + (i.size || 0), 0);
        const _avgSpeed = [...activeDownloads.values()].reduce((s, d) => s + (downloadQueue[currentDownloadIndex]?.speed || 0), 0) || downloadQueue.filter(i => i.status === 'downloading').reduce((s, i) => s + (i.speed || 0), 0);
        const _qEta = _avgSpeed > 0 ? `· ETA ${formatETA(Math.ceil(_totalRemaining / _avgSpeed))}` : '';
        queueStatus.innerHTML = `<span style="color:#6366f1;">●</span> Downloading ${downloading} item(s) ${_qEta}`;
      } else {
        speedBox.style.display = 'none';
        if (isPaused || paused > 0) {
          queueStatus.innerHTML = `<span style="color:#f59e0b;">●</span> Paused (${paused} item(s))`;
        } else if (pending > 0) {
          queueStatus.innerHTML = `<span style="color:#6b7280;">●</span> ${pending} item(s) pending`;
        } else if (completed === downloadQueue.length) {
          queueStatus.innerHTML = `<span style="color:#10b981;">●</span> All downloads complete!`;
        } else if (failed > 0 && completed + failed === downloadQueue.length) {
          queueStatus.innerHTML = `<span style="color:#ef4444;">●</span> Completed with ${failed} error(s)`;
        } else {
          queueStatus.innerHTML = `<span style="color:#6b7280;">●</span> Ready to download`;
        }
      }
    }

    function updateDownloadInfo() {
      const downloading = downloadQueue.find(i => i.status === 'downloading');
      const selected = downloadQueue.filter(i => i.selected);
      const pending = downloadQueue.filter(i => i.status === 'pending');

      // Hide if not downloading
      if (!downloading) {
        downloadInfo.style.display = 'none';
        return;
      }

      // Show and update content
      downloadInfo.style.display = 'block';

      const parts = [];

      // Current download
      parts.push(`<span style="font-weight: 600;">Downloading:</span> ${downloading.downloadInfo.filename}`);
      if (downloading.size > 0) {
        parts.push(`(${formatFileSize(downloading.size)})`);
      }

      // Show mode and selection info if in selected mode
      if (downloadOnlySelected && selected.length > 0) {
        const selectedPending = selected.filter(i => i.status === 'pending').length;
        parts.push(`<span style="margin-left: 12px; color: #6366f1;">•</span> <span style="font-weight: 600;">${selected.length}</span> selected`);
        if (selectedPending > 0) {
          parts.push(`<span style="color: #6b7280;">(${selectedPending} remaining)</span>`);
        }
      } else if (!downloadOnlySelected && pending.length > 0) {
        parts.push(`<span style="margin-left: 12px; color: #6366f1;">•</span> <span style="color: #6b7280;">${pending.length} items remaining</span>`);
      }

      downloadInfo.innerHTML = parts.join(' ');
    }

    function renderStatsView() {
      const isDarkMode = Settings.get('darkMode');

      const stats = {
        total: downloadQueue.length,
        completed: downloadQueue.filter(i => i.status === 'completed').length,
        downloading: downloadQueue.filter(i => i.status === 'downloading').length,
        pending: downloadQueue.filter(i => i.status === 'pending').length,
        paused: downloadQueue.filter(i => i.status === 'paused').length,
        error: downloadQueue.filter(i => i.status === 'error').length,
        totalSize: downloadQueue.reduce((sum, i) => sum + (i.size || 0), 0),
        completedSize: downloadQueue.filter(i => i.status === 'completed').reduce((sum, i) => sum + (i.size || 0), 0),
      };

      // Group by folder
      const folderStats = {};
      downloadQueue.forEach(item => {
        const folder = item.downloadInfo.folderPath || 'Other';
        if (!folderStats[folder]) {
          folderStats[folder] = {
            total: 0,
            completed: 0,
            downloading: 0,
            pending: 0,
            error: 0,
            size: 0
          };
        }
        folderStats[folder].total++;
        folderStats[folder][item.status]++;
        folderStats[folder].size += item.size || 0;
      });

      const donePercent = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
      const totalDownloaded = downloadQueue.reduce((s, i) => s + (i.status === 'completed' ? (i.size || 0) : 0), 0);
      const pendingSize = downloadQueue.filter(i => i.status === 'pending' || i.status === 'paused').reduce((s, i) => s + (i.size || 0), 0);
      const activeItems = downloadQueue.filter(i => i.status === 'downloading');
      const avgSpeed = activeItems.reduce((s, i) => s + (i.speed || 0), 0);
      const remainingSize = downloadQueue.filter(i => i.status === 'pending' || i.status === 'paused' || i.status === 'downloading')
        .reduce((s, i) => s + (i.size || 0), 0);
      const queueEta = avgSpeed > 0 ? Math.ceil(remainingSize / avgSpeed) : null;

      statsView.innerHTML = `
        <div style="display:grid;gap:10px;padding:2px;">

          <!-- Big stat row -->
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;">
            ${[
          { label: 'Total', val: stats.total, sub: stats.totalSize > 0 ? formatFileSize(stats.totalSize) : '', color: '#60a5fa', bg: isDarkMode ? 'rgba(59,130,246,0.12)' : '#eff6ff' },
          { label: 'Done', val: stats.completed, sub: totalDownloaded > 0 ? formatFileSize(totalDownloaded) : '', color: '#34d399', bg: isDarkMode ? 'rgba(16,185,129,0.12)' : '#f0fdf4' },
          { label: 'Active', val: stats.downloading, sub: avgSpeed > 0 ? formatFileSize(avgSpeed) + '/s' : '', color: '#818cf8', bg: isDarkMode ? 'rgba(129,140,248,0.12)' : '#eef2ff' },
          { label: 'Queued', val: stats.pending + stats.paused, sub: pendingSize > 0 ? formatFileSize(pendingSize) : '', color: '#94a3b8', bg: isDarkMode ? 'rgba(148,163,184,0.1)' : '#f8fafc' },
          { label: 'Failed', val: stats.error, sub: '', color: '#f87171', bg: isDarkMode ? 'rgba(239,68,68,0.12)' : '#fef2f2' },
        ].map(card => `
              <div style="padding:12px 10px;border-radius:10px;background:${card.bg};border:1px solid ${card.color}30;text-align:center;">
                <div style="font:700 22px system-ui;color:${card.color};line-height:1;">${card.val}</div>
                <div style="font:600 10px system-ui;color:${card.color}aa;text-transform:uppercase;letter-spacing:0.5px;margin-top:3px;">${card.label}</div>
                ${card.sub ? `<div style="font:10px system-ui;color:${isDarkMode ? '#64748b' : '#94a3b8'};margin-top:3px;">${card.sub}</div>` : ''}
              </div>
            `).join('')}
          </div>

          <!-- Segmented progress bar -->
          <div style="padding:14px;border-radius:10px;background:${isDarkMode ? '#111827' : '#f8fafc'};border:1px solid ${isDarkMode ? '#1f2937' : '#e2e8f0'};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <span style="font:600 13px system-ui;color:${isDarkMode ? '#f1f5f9' : '#1e293b'};">Overall Progress</span>
              <span style="font:700 15px system-ui;color:${isDarkMode ? '#60a5fa' : '#2563eb'};">${donePercent}%</span>
            </div>
            <!-- Segmented bar -->
            <div style="width:100%;height:10px;border-radius:6px;overflow:hidden;background:${isDarkMode ? '#1f2937' : '#e2e8f0'};display:flex;">
              <div style="width:${stats.total > 0 ? (stats.completed / stats.total) * 100 : 0}%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.downloading / stats.total) * 100 : 0}%;background:linear-gradient(90deg,#6366f1,#818cf8);transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.paused / stats.total) * 100 : 0}%;background:linear-gradient(90deg,#f59e0b,#fbbf24);transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.error / stats.total) * 100 : 0}%;background:#ef4444;transition:width 0.4s;"></div>
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
              ${[
          { label: 'Done', color: '#10b981', n: stats.completed },
          { label: 'Active', color: '#6366f1', n: stats.downloading },
          { label: 'Paused', color: '#f59e0b', n: stats.paused },
          { label: 'Pending', color: '#94a3b8', n: stats.pending },
          { label: 'Failed', color: '#ef4444', n: stats.error },
        ].filter(l => l.n > 0).map(l => `
                <span style="font:500 11px system-ui;color:${isDarkMode ? '#94a3b8' : '#64748b'};display:flex;align-items:center;gap:4px;">
                  <span style="width:8px;height:8px;border-radius:50%;background:${l.color};display:inline-block;"></span>
                  ${l.label} (${l.n})
                </span>
              `).join('')}
              ${queueEta ? `<span style="margin-left:auto;font:500 11px system-ui;color:${isDarkMode ? '#60a5fa' : '#2563eb'};">ETA: ${formatETA(queueEta)}</span>` : ''}
            </div>
          </div>

          <!-- Folder breakdown table -->
          ${Object.keys(folderStats).length > 0 ? `
          <div style="padding:14px;border-radius:10px;background:${isDarkMode ? '#111827' : '#f8fafc'};border:1px solid ${isDarkMode ? '#1f2937' : '#e2e8f0'};">
            <div style="font:600 13px system-ui;color:${isDarkMode ? '#f1f5f9' : '#1e293b'};margin-bottom:10px;">By Folder</div>
            <div style="display:grid;gap:6px;">
              ${Object.entries(folderStats).map(([folder, fs]) => {
          const fp = fs.total > 0 ? Math.round((fs.completed / fs.total) * 100) : 0;
          return `
                <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:8px 10px;border-radius:8px;background:${isDarkMode ? '#0f172a' : 'white'};border:1px solid ${isDarkMode ? '#1f2937' : '#e2e8f0'};">
                  <div style="min-width:0;">
                    <div style="font:600 12px system-ui;color:${isDarkMode ? '#e2e8f0' : '#1e293b'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${folder}</div>
                    <div style="margin-top:5px;width:100%;height:4px;border-radius:2px;overflow:hidden;background:${isDarkMode ? '#1f2937' : '#e2e8f0'};">
                      <div style="width:${fp}%;height:100%;background:linear-gradient(90deg,#10b981,#34d399);"></div>
                    </div>
                  </div>
                  <div style="text-align:right;flex-shrink:0;">
                    <div style="font:700 12px system-ui;color:${fp === 100 ? '#10b981' : isDarkMode ? '#94a3b8' : '#64748b'};">${fs.completed}/${fs.total}</div>
                    ${fs.size > 0 ? `<div style="font:10px system-ui;color:${isDarkMode ? '#475569' : '#94a3b8'};margin-top:1px;">${formatFileSize(fs.size)}</div>` : ''}
                    ${fs.error > 0 ? `<div style="font:600 10px system-ui;color:#ef4444;">${fs.error} failed</div>` : ''}
                  </div>
                </div>`;
        }).join('')}
            </div>
          </div>
          ` : ''}

          <!-- Active downloads detail -->
          ${activeItems.length > 0 ? `
          <div style="padding:14px;border-radius:10px;background:${isDarkMode ? 'rgba(99,102,241,0.08)' : '#eef2ff'};border:1px solid ${isDarkMode ? 'rgba(99,102,241,0.2)' : '#c7d2fe'};">
            <div style="font:600 13px system-ui;color:${isDarkMode ? '#818cf8' : '#4338ca'};margin-bottom:10px;">
              Currently Downloading (${activeItems.length})
            </div>
            <div style="display:grid;gap:6px;">
              ${activeItems.map(item => `
              <div style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:${isDarkMode ? 'rgba(99,102,241,0.1)' : 'white'};border:1px solid ${isDarkMode ? 'rgba(99,102,241,0.2)' : '#c7d2fe'};">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font:600 12px system-ui;color:${isDarkMode ? '#e2e8f0' : '#1e293b'};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</span>
                  <span style="font:700 11px system-ui;color:#6366f1;margin-left:8px;">${item.progress || 0}%</span>
                </div>
                <div style="width:100%;height:4px;border-radius:2px;overflow:hidden;background:${isDarkMode ? '#1f2937' : '#e0e7ff'};">
                  <div style="width:${item.progress || 0}%;height:100%;background:linear-gradient(90deg,#6366f1,#818cf8);transition:width 0.3s;"></div>
                </div>
                <div style="font:10px system-ui;color:${isDarkMode ? '#6366f1' : '#4338ca'};">
                  ${item.speed > 0 ? formatFileSize(item.speed) + '/s' : 'Starting…'}${item.eta ? ' · ETA ' + formatETA(item.eta) : ''}
                </div>
              </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
        </div>
      `;
    }

    function toggleView() {
      if (currentView === 'list') {
        currentView = 'stats';
        listView.style.display = 'none';
        statsView.style.display = 'block';
        viewLabel.textContent = 'List';
        renderStatsView();
      } else {
        currentView = 'list';
        listView.style.display = 'block';
        statsView.style.display = 'none';
        viewLabel.textContent = 'Stats';
      }
    }

    // Keyboard shortcuts
    function handleDMKeydown(e) {
      if (!document.body.contains(manager)) {
        document.removeEventListener('keydown', handleDMKeydown);
        return;
      }
      if (e.key === 'Escape') {
        manager.querySelector('#close-manager')?.click();
      } else if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        if (isPaused) {
          manager.querySelector('#start-all')?.click();
        } else {
          manager.querySelector('#pause-all')?.click();
        }
      }
    }
    document.addEventListener('keydown', handleDMKeydown);

    function renderQueue(needsHandlerSetup = false) {
      // Only set up handlers when queue structure changes (items added/removed)
      // Not on every progress update to avoid flashing buttons
      if (needsHandlerSetup) {
        setupHandlers();
      }

      // Update stats view if active
      if (currentView === 'stats') {
        renderStatsView();
        return;
      }

      // Filter items based on text search
      let filteredQueue = downloadQueue;
      if (searchFilter.trim()) {
        const filter = searchFilter.toLowerCase();
        filteredQueue = downloadQueue.filter(item =>
          item.name.toLowerCase().includes(filter) ||
          item.downloadInfo.filename.toLowerCase().includes(filter) ||
          item.downloadInfo.folderPath.toLowerCase().includes(filter)
        );
      }

      // Filter by status tab
      if (statusFilter !== 'all') {
        filteredQueue = filteredQueue.filter(item => item.status === statusFilter);
      }

      // Smart grouping: Movies together, TV Shows by series/season, Music by artist/album
      const groups = {};
      downloadQueue.forEach((item, index) => {
        // Skip items not in filtered results
        if (!filteredQueue.includes(item)) {
          return;
        }

        const folderPath = item.downloadInfo.folderPath || 'Other';
        const pathParts = folderPath.split('/');
        let groupKey;

        // Smart grouping logic based on content type
        if (pathParts[0] === 'TV Shows' && pathParts.length >= 3) {
          // TV Shows: Group by "TV Shows/Series Name/Season Name"
          groupKey = pathParts.slice(0, 3).join('/');
        } else if (pathParts[0] === 'Music' && pathParts.length >= 3) {
          // Music: Group by "Music/Artist/Album"
          groupKey = pathParts.slice(0, 3).join('/');
        } else if (pathParts[0] === 'Movies') {
          // Movies: Group all together as just "Movies"
          groupKey = 'Movies';
        } else {
          // Other: Use full path for everything else
          groupKey = folderPath;
        }

        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push({ item, index });
      });

      const statusColors = {
        pending: '#6b7280',
        downloading: '#3b82f6',
        completed: '#10b981',
        error: '#ef4444',
        paused: '#f59e0b'
      };

      const isDarkMode = Settings.get('darkMode');

      const bgColors = isDarkMode ? {
        completed: 'linear-gradient(135deg, #1a2e1a 0%, #1e3a1e 100%)',
        error: 'linear-gradient(135deg, #2e1a1a 0%, #3a1e1e 100%)',
        downloading: 'linear-gradient(135deg, #1a2436 0%, #1e2e44 100%)',
        pending: '#1c1c1c',
        paused: 'linear-gradient(135deg, #2e2a1a 0%, #3a341e 100%)'
      } : {
        completed: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
        error: 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)',
        downloading: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
        pending: '#ffffff',
        paused: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)'
      };

      const statusIcons = {
        pending: Icons.pending,
        downloading: Icons.downloading,
        completed: Icons.completed,
        error: Icons.error,
        paused: Icons.pause
      };

      // Render grouped items — show empty state when nothing matches filter
      const groupEntries = Object.entries(groups);
      if (groupEntries.length === 0) {
        const emptyMessages = {
          all: { icon: '📭', title: 'Queue is empty', sub: 'Add items using the download button on any media page.' },
          downloading: { icon: '⏳', title: 'Nothing downloading', sub: 'Press Start All or click ▶ on an item to begin.' },
          paused: { icon: '⏸', title: 'No paused downloads', sub: 'Downloads you pause will appear here.' },
          pending: { icon: '🕐', title: 'No queued items', sub: 'Pending items waiting to start will appear here.' },
          completed: { icon: '✅', title: 'No completed downloads yet', sub: 'Finished downloads will appear here.' },
          error: { icon: '✓', title: 'No failed downloads', sub: 'All downloads completed without errors.' },
        };
        const em = emptyMessages[statusFilter] || emptyMessages.all;
        downloadList.innerHTML = `<div style="
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 48px 24px; gap: 10px;
          color: ${isDarkMode ? '#4b5563' : '#9ca3af'};
          text-align: center;
        ">
          <div style="font-size: 32px; line-height: 1;">${em.icon}</div>
          <div style="font: 600 14px system-ui; color: ${isDarkMode ? '#6b7280' : '#6b7280'};">${em.title}</div>
          <div style="font: 13px system-ui; max-width: 260px; line-height: 1.5;">${em.sub}</div>
        </div>`;
        return;
      }

      downloadList.innerHTML = groupEntries.map(([folderPath, items]) => {
        const groupId = folderPath.replace(/[^a-z0-9]/gi, '-');
        const groupStats = {
          total: items.length,
          completed: items.filter(({ item }) => item.status === 'completed').length,
          downloading: items.filter(({ item }) => item.status === 'downloading').length,
          error: items.filter(({ item }) => item.status === 'error').length,
          pending: items.filter(({ item }) => item.status === 'pending').length,
          totalSize: items.reduce((sum, { item }) => sum + (item.size || 0), 0)
        };

        const allSelected = items.length > 0 && items.every(({ item }) => item.selected);

        const groupDonePercent = groupStats.total > 0 ? Math.round((groupStats.completed / groupStats.total) * 100) : 0;
        return `
          <!-- GROUP: ${folderPath} -->
          <div style="
            margin: 6px; border-radius: 10px; overflow: hidden;
            border: 1px solid ${isDarkMode ? '#1f2937' : '#e2e8f0'};
            background: ${isDarkMode ? '#0f172a' : '#ffffff'};
          ">
            <!-- Group Header -->
            <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.group-arrow').style.transform = this.nextElementSibling.style.display === 'none' ? 'rotate(0deg)' : 'rotate(90deg)';" style="
              padding: 10px 12px;
              background: ${isDarkMode ? '#111827' : '#f1f5f9'};
              cursor: pointer; user-select: none;
              display: flex; align-items: center; gap: 10px;
            ">
              <span class="group-arrow" style="font-size:9px;color:#6b7280;transition:transform 0.2s;transform:rotate(90deg);">▶</span>
              <input type="checkbox" class="group-checkbox" data-group-path="${folderPath}"
                ${allSelected ? 'checked' : ''}
                onclick="event.stopPropagation();"
                style="width:14px;height:14px;accent-color:${getTheme().primary};cursor:pointer;flex-shrink:0;">
              <div style="flex:1;min-width:0;">
                <div style="font:600 13px system-ui;color:${isDarkMode ? '#f1f5f9' : '#1e293b'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${folderPath.split('/').pop() || folderPath}
                </div>
                <div style="font:11px system-ui;color:${isDarkMode ? '#64748b' : '#94a3b8'};margin-top:2px;display:flex;gap:8px;align-items:center;">
                  <span>${groupStats.total} file${groupStats.total !== 1 ? 's' : ''}</span>
                  ${groupStats.totalSize > 0 ? `<span>•</span><span>${formatFileSize(groupStats.totalSize)}</span>` : ''}
                  ${groupStats.completed > 0 ? `<span>•</span><span style="color:#10b981;">${groupStats.completed} done</span>` : ''}
                  ${groupStats.error > 0 ? `<span>•</span><span style="color:#ef4444;">${groupStats.error} failed</span>` : ''}
                  ${groupStats.downloading > 0 ? `<span>•</span><span style="color:#3b82f6;">${groupStats.downloading} active</span>` : ''}
                </div>
                ${groupStats.completed > 0 ? `<div style="margin-top:5px;width:100%;height:3px;background:${isDarkMode ? '#1f2937' : '#e2e8f0'};border-radius:2px;overflow:hidden;">
                  <div style="width:${groupDonePercent}%;height:100%;background:linear-gradient(90deg,#10b981,#34d399);transition:width 0.4s;"></div>
                </div>` : ''}
              </div>
              <button class="download-group-btn" data-group-path="${folderPath}" onclick="event.stopPropagation();" style="
                padding: 5px 11px; border-radius: 6px; flex-shrink:0;
                border: 1.5px solid ${getTheme().primary};
                background: ${isDarkMode ? 'rgba(16,185,129,0.1)' : '#ecfdf5'};
                color: ${getTheme().primary};
                cursor: pointer; font: 600 11px system-ui;
                display: flex; align-items: center; gap: 4px;
              ">${Icons.play} All</button>
            </div>
            <!-- Items -->
            <div style="display:block;">
              ${items.map(({ item, index: itemIndex }) => {
          const isDownloading = item.status === 'downloading';
          const isPausedItem = item.status === 'paused';
          const isError = item.status === 'error';
          const isDone = item.status === 'completed';
          const showBar = isDownloading || isPausedItem;
          const barColor = isPausedItem
            ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
            : 'linear-gradient(90deg, #3b82f6, #60a5fa)';
          const rowAccent = {
            downloading: isDarkMode ? '#1e3a5f' : '#dbeafe',
            completed: isDarkMode ? '#14532d' : '#dcfce7',
            error: isDarkMode ? '#450a0a' : '#fee2e2',
            paused: isDarkMode ? '#422006' : '#fef3c7',
            pending: isDarkMode ? '#1a1f2e' : '#f8fafc',
          }[item.status] || (isDarkMode ? '#1a1f2e' : '#f8fafc');
          const statusLabel = { downloading: 'Downloading', completed: 'Done', error: 'Error', paused: 'Paused', pending: 'Pending' }[item.status] || item.status;
          const statusBg = { downloading: '#1d4ed8', completed: '#166534', error: '#991b1b', paused: '#92400e', pending: '#374151' }[item.status];
          return `
                  <div style="
                    padding: 9px 12px;
                    border-top: 1px solid ${isDarkMode ? '#1f2937' : '#f1f5f9'};
                    background: ${rowAccent};
                    display: flex; align-items: flex-start; gap: 10px;
                    transition: background 0.15s;
                  ">
                    <!-- Checkbox -->
                    <input type="checkbox" class="item-checkbox" data-index="${itemIndex}"
                      ${item.selected ? 'checked' : ''}
                      style="width:14px;height:14px;flex-shrink:0;margin-top:3px;accent-color:${getTheme().primary};cursor:pointer;">

                    <!-- Status icon -->
                    <div style="width:20px;height:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:${statusColors[item.status]};margin-top:1px;">
                      ${statusIcons[item.status]}
                    </div>

                    <!-- Main info -->
                    <div style="flex:1;min-width:0;">
                      <!-- Title -->
                      <div style="font:600 12px/1.3 system-ui;color:${isDarkMode ? '#e2e8f0' : '#1e293b'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${item.name}
                      </div>
                      <!-- Subtitle -->
                      <div style="font:10px system-ui;color:${isDarkMode ? '#64748b' : '#94a3b8'};margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${item.downloadInfo.folderPath}${item.size > 0 ? ` &bull; <strong>${formatFileSize(item.size)}</strong>` : ''}
                      </div>
                      <!-- Progress bar (only when downloading/paused) -->
                      ${showBar ? `
                      <div style="margin-top:6px;">
                        <div style="width:100%;height:5px;background:${isDarkMode ? '#1f2937' : '#e2e8f0'};border-radius:3px;overflow:hidden;">
                          <div id="item-progress-bar-${itemIndex}" style="
                            width:${item.progress}%;height:100%;
                            background:${barColor};border-radius:3px;
                            transition:width 0.3s ease;
                          "></div>
                        </div>
                        <div style="display:flex;justify-content:space-between;margin-top:3px;font:10px system-ui;">
                          <span id="item-speed-eta-${itemIndex}" style="color:${isDarkMode ? '#60a5fa' : '#3b82f6'};">
                            ${isPausedItem ? 'Paused' : (item.speed > 0 ? formatSpeed(item.speed) : 'Starting…')}
                            ${isDownloading && item.eta ? ' &bull; ' + formatETA(item.eta) : ''}
                          </span>
                          <span id="item-progress-text-${itemIndex}" style="color:${isDarkMode ? '#94a3b8' : '#64748b'};font-weight:600;">
                            ${item.progress}%
                          </span>
                        </div>
                      </div>` : ''}
                      <!-- Error message -->
                      ${isError && item.error ? `
                      <div style="margin-top:4px;font:10px system-ui;color:#f87171;display:flex;align-items:center;gap:4px;">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                        ${item.error}
                      </div>` : ''}
                    </div>

                    <!-- Status pill -->
                    <div style="
                      flex-shrink:0; align-self:flex-start; margin-top:2px;
                      padding:3px 8px; border-radius:99px;
                      font:700 9px system-ui; letter-spacing:0.4px; text-transform:uppercase;
                      background:${statusBg}; color:white;
                    ">${statusLabel}</div>

                    <!-- Action buttons -->
                    <div style="flex-shrink:0;align-self:flex-start;display:flex;flex-direction:column;gap:4px;">
                      ${item.status === 'pending' ? `
                        <button data-action="start" data-index="${itemIndex}" title="Start download" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid ${getTheme().primary};
                          background:${isDarkMode ? 'rgba(16,185,129,0.1)' : '#ecfdf5'};
                          color:${getTheme().primary};cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></button>
                      ` : ''}
                      ${item.status === 'paused' ? `
                        <button data-action="start" data-index="${itemIndex}" title="Resume download" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #6366f1;
                          background:${isDarkMode ? 'rgba(99,102,241,0.1)' : '#eef2ff'};
                          color:#6366f1;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></button>
                        <button data-action="stop" data-index="${itemIndex}" title="Stop and reset" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #ef4444;
                          background:${isDarkMode ? 'rgba(239,68,68,0.1)' : '#fef2f2'};
                          color:#ef4444;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
                      ` : ''}
                      ${item.status === 'downloading' ? `
                        <button data-action="pause" data-index="${itemIndex}" title="Pause download" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #f59e0b;
                          background:${isDarkMode ? 'rgba(245,158,11,0.1)' : '#fffbeb'};
                          color:#f59e0b;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>
                        <button data-action="stop" data-index="${itemIndex}" title="Stop and reset" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #ef4444;
                          background:${isDarkMode ? 'rgba(239,68,68,0.1)' : '#fef2f2'};
                          color:#ef4444;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
                      ` : ''}
                      ${item.status === 'completed' ? `
                        <div style="width:28px;height:28px;border-radius:7px;
                          background:${isDarkMode ? 'rgba(16,185,129,0.15)' : '#d1fae5'};
                          display:flex;align-items:center;justify-content:center;color:#10b981;"
                          title="Download complete">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                        <button data-action="redownload" data-index="${itemIndex}" title="Download again" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #10b981;
                          background:transparent;
                          color:#10b981;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                          opacity:0.5;
                        " onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.5'">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.47"/></svg>
                        </button>
                      ` : ''}
                      ${item.status === 'error' ? `
                        <button data-action="retry" data-index="${itemIndex}" title="Retry download" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid #f59e0b;
                          background:${isDarkMode ? 'rgba(245,158,11,0.1)' : '#fffbeb'};
                          color:#f59e0b;cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        " title="Retry"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.47"/></svg></button>
                        <button data-action="dismiss" data-index="${itemIndex}" title="Remove this item" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid ${isDarkMode ? '#374151' : '#e5e7eb'};
                          background:transparent;
                          color:${isDarkMode ? '#6b7280' : '#9ca3af'};cursor:pointer;
                          display:flex;align-items:center;justify-content:center;transition:all 0.15s;
                        "><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                      ` : ''}
                    </div>
                  </div>
                `;
        }).join('')}
            </div>
          </div>
        `;
      }).join('');

      // Create group download handlers and selection handlers
      manager.querySelectorAll('.group-checkbox').forEach(checkbox => {
        const groupPath = checkbox.dataset.groupPath;
        const groupItems = groups[groupPath] || [];
        const allSelected = groupItems.length > 0 && groupItems.every(({ item }) => item.selected);
        const someSelected = groupItems.some(({ item }) => item.selected);
        if (someSelected && !allSelected) {
          checkbox.indeterminate = true;
        }
      });

      Object.entries(groups).forEach(([folderPath, items]) => {
        const groupId = folderPath.replace(/[^a-z0-9]/gi, '-');

        // Download all items in group
        window[`downloadGroup_${groupId}`] = () => {
          console.log(`[DownloadManager] Starting group download: ${folderPath}`);
          isPaused = false;
          isDownloading = true;
          // Set all items in group to pending
          items.forEach(({ item, index }) => {
            if (item.status !== 'completed') {
              item.status = 'pending';
              item.error = null;
            }
          });
          renderQueue();
          saveState();
          // Start concurrent downloads (will process all pending items in group)
          startNextDownload();
        };

        // Toggle selection for all items in group
        window[`toggleGroupSelection_${groupId}`] = (checked) => {
          items.forEach(({ item, index }) => {
            downloadQueue[index].selected = checked;
            const checkbox = manager.querySelector(`.item-checkbox[data-index="${index}"]`);
            if (checkbox) checkbox.checked = checked;
          });
          saveState();
        };
      });

      updateStats();
      setupCheckboxHandlers(); // Set up checkbox event listeners
    }

    // Event delegation for item action buttons
    function setupHandlers() {
      logDebug('[DownloadManager] Setting up event handlers on downloadList');
      // Remove old listener if exists
      downloadList.removeEventListener('click', handleItemButtonClick);

      // Add event listener to download list for button clicks
      downloadList.addEventListener('click', handleItemButtonClick);
      logDebug('[DownloadManager] Event handlers set up successfully');
    }

    function handleItemButtonClick(e) {
      const button = e.target.closest('button[data-action]');

      if (!button) {
        return;
      }

      const action = button.getAttribute('data-action');
      const index = parseInt(button.getAttribute('data-index'));

      const item = downloadQueue[index];

      if (!item) {
        return;
      }

      switch (action) {
        case 'start':
          logDebug(`[DownloadManager] Starting/resuming item ${index}: ${item.name}`);
          userAbortedIndices.delete(index);
          isPaused = false;
          downloadSingleItem = true;
          item.status = 'pending';
          item.error = null;
          renderQueue();
          saveState();
          downloadItem(index);
          break;

        case 'pause':
          // Pause a currently downloading item – abort it, mark as user-initiated so catch block doesn't overwrite status
          console.log(`[DownloadManager] Pausing item ${index}: ${item.name}`);
          userAbortedIndices.add(index);
          if (activeDownloads.has(index)) {
            const download = activeDownloads.get(index);
            download.abortController.abort();
            activeDownloads.delete(index);
          }
          item.status = 'paused';
          renderQueue();
          updateStats();
          saveState();
          // Don't call startNextDownload – user explicitly paused this item
          break;

        case 'stop':
          // Stop and reset to pending – abort and mark so catch block keeps 'pending' status
          console.log(`[DownloadManager] Stopping item ${index}: ${item.name}`);
          userAbortedIndices.add(index);
          if (activeDownloads.has(index)) {
            const download = activeDownloads.get(index);
            download.abortController.abort();
            activeDownloads.delete(index);
          }
          item.status = 'pending';
          item.progress = 0;
          item.error = null;
          renderQueue();
          updateStats();
          saveState();
          // Don't call startNextDownload – user explicitly stopped this item
          break;

        case 'cancel':
          // Legacy alias for pause – same guard
          console.log(`[DownloadManager] Cancel (pause) item ${index}: ${item.name}`);
          userAbortedIndices.add(index);
          if (activeDownloads.has(index)) {
            const download = activeDownloads.get(index);
            download.abortController.abort();
            activeDownloads.delete(index);
          }
          item.status = 'paused';
          item.progress = 0;
          renderQueue();
          updateStats();
          saveState();
          // Don't call startNextDownload – user explicitly paused this item
          break;

        case 'retry':
          console.log(`[DownloadManager] Retrying item ${index}: ${item.name}`);
          item.status = 'pending';
          item.error = null;
          item.progress = 0;
          renderQueue();
          updateStats();
          saveState();
          // Auto-start the retry
          if (!isPaused) {
            setTimeout(() => startNextDownload(), 1500);
          }
          break;

        case 'redownload':
          console.log(`[DownloadManager] Re-downloading item ${index}: ${item.name}`);
          item.status = 'pending';
          item.progress = 0;
          item.error = null;
          renderQueue();
          saveState();
          downloadSingleItem = true;
          downloadItem(index);
          break;

        case 'dismiss':
          downloadQueue.splice(index, 1);
          renderQueue(true);
          updateStats();
          saveState();
          break;
      }
    }

    // Set up handlers initially
    setupHandlers();
    renderQueue(); // Initial render without handler setup since we just did it above

    async function downloadItem(index) {
      if (isPaused || index >= downloadQueue.length) return;

      const item = downloadQueue[index];
      if (item.status === 'completed') {
        // Skip completed items, try to start next
        startNextDownload();
        return;
      }

      // NEW v6.54: Check if already downloading
      if (activeDownloads.has(index)) {
        return; // Already downloading this item
      }

      // NEW v6.54: Check concurrent download limit
      if (activeDownloads.size >= maxConcurrentDownloads) {
        return; // Wait for a slot to free up
      }

      // Note: HTTP Range requests let us resume from where we paused.
      // Check if we have saved chunks from a previous pause.
      const savedChunks = item._savedChunks || [];
      const resumeFrom = item._savedReceivedLength || 0;
      const isResume = savedChunks.length > 0 && resumeFrom > 0;
      item._savedChunks = null;
      item._savedReceivedLength = 0;

      // Initialise item state for this download run
      item.status = 'downloading';
      item.progress = isResume ? item.progress : 0;
      item.error = null;
      item.speed = 0;
      item.eta = null;
      item.startTime = Date.now();
      isDownloading = true;

      const abortController = new AbortController();
      activeDownloads.set(index, { abortController, startTime: Date.now() });
      currentDownloadIndex = index;

      renderQueue();
      updateDownloadInfo();

      const fetchHeaders = {};
      if (isResume) {
        fetchHeaders['Range'] = `bytes=${resumeFrom}-`;
        console.log(`[DownloadManager] Resuming item ${index} from byte ${resumeFrom}: ${item.name}`);
      }

      try {

        const response = await fetch(item.url, {
          signal: abortController.signal,
          headers: fetchHeaders
        });

        // 206 = Partial Content (range supported), 200 = full restart
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const contentLength = +response.headers.get('Content-Length') || 0;
        // Total size = what server is sending + what we already have
        const totalLength = isResume && response.status === 206 ? resumeFrom + contentLength : contentLength;

        // If server didn't support range, start fresh
        let chunks = (isResume && response.status === 206) ? savedChunks : [];
        let receivedLength = (isResume && response.status === 206) ? resumeFrom : 0;

        // Keep live references so the abort handler can snapshot them on pause
        item._liveChunks = chunks;
        item._liveReceivedLength = receivedLength;

        let lastUpdate = Date.now();
        let lastReceived = receivedLength;

        while (true) {
          if (isPaused) {
            // Global pause-all: save progress for range-resume
            item._savedChunks = chunks.slice(); // snapshot
            item._savedReceivedLength = receivedLength;
            item._liveChunks = null;
            item.status = 'paused';
            renderQueue();
            updateDownloadInfo();
            saveState();
            return;
          }

          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          receivedLength += value.length;

          // Update progress and speed
          const now = Date.now();
          if (contentLength && (now - lastUpdate > 200 || receivedLength === contentLength)) {
            item.progress = totalLength > 0 ? Math.round((receivedLength / totalLength) * 100) : 0;

            // Calculate speed
            const timeDiff = (now - lastUpdate) / 1000;
            const bytesDiff = receivedLength - lastReceived;
            const speedBps = bytesDiff / timeDiff;
            item.speed = speedBps;

            // Calculate ETA
            if (speedBps > 0 && totalLength > receivedLength) {
              const remainingBytes = totalLength - receivedLength;
              item.eta = Math.ceil(remainingBytes / speedBps);
            } else {
              item.eta = null;
            }

            // Update live reference
            item._liveReceivedLength = receivedLength;

            // Update info panel speed display
            const speedMBps = (speedBps / 1024 / 1024).toFixed(2);
            if (currentSpeed) currentSpeed.textContent = `${speedMBps} MB/s`;

            lastUpdate = now;
            lastReceived = receivedLength;

            // Targeted DOM Update instead of renderQueue()
            const progressBar = document.getElementById(`item-progress-bar-${index}`);
            if (progressBar) progressBar.style.width = `${item.progress}%`;

            const progressText = document.getElementById(`item-progress-text-${index}`);
            if (progressText) progressText.textContent = `${item.progress}%`;

            const speedEta = document.getElementById(`item-speed-eta-${index}`);
            if (speedEta) speedEta.textContent = `${isResume ? '[Resume] ' : ''}${item.speed > 0 ? formatSpeed(item.speed) : ''} ${item.eta ? '• ' + formatETA(item.eta) : ''}`;

            updateDownloadInfo();
          }
        }

        // Create and download blob
        item._liveChunks = null;
        item._savedChunks = null;
        item._savedReceivedLength = 0;
        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // Try to get filename from Content-Disposition header, fall back to our generated filename
        let filename = item.downloadInfo.filename;
        const contentDisposition = response.headers.get('Content-Disposition');
        if (contentDisposition) {
          const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (filenameMatch && filenameMatch[1]) {
            const headerFilename = filenameMatch[1].replace(/['"]/g, '');
            // Only use header filename if it's not the generic "download" name
            if (headerFilename && headerFilename !== 'download' && !headerFilename.startsWith('download.')) {
              filename = headerFilename;
            }
          }
        }

        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        item.status = 'completed';
        item.progress = 100;

        // NEW v6.59: Download Subtitles
        if (item.downloadInfo && item.downloadInfo.subtitles && item.downloadInfo.subtitles.length > 0) {
          for (const sub of item.downloadInfo.subtitles) {
            try {
              const subLink = document.createElement('a');
              subLink.href = sub.url;
              subLink.download = sub.filename;
              document.body.appendChild(subLink);
              subLink.click();
              document.body.removeChild(subLink);
              await new Promise(r => setTimeout(r, 500)); // Small delay between downloads
            } catch (e) {
              console.warn('Failed to download subtitle:', sub.filename, e);
            }
          }
        }

        // NEW v6.54: Remove from active downloads
        activeDownloads.delete(index);

        renderQueue();
        updateDownloadInfo();
        saveState();

        // NEW v6.54: Try to start next downloads with a slight delay to avoid Emby stream limits
        if (!isPaused && !downloadSingleItem) {
          setTimeout(() => startNextDownload(), 1500);
        } else if (downloadSingleItem) {
          downloadSingleItem = false;
        }

        // NEW v6.54: Check if all downloads are complete
        if (activeDownloads.size === 0 && downloadQueue.every(i => i.status !== 'downloading')) {
          isDownloading = false;
          const completed = downloadQueue.filter(i => i.status === 'completed').length;
          const failed = downloadQueue.filter(i => i.status === 'error').length;
          if (completed > 0 || failed > 0) {
            sendDownloadCompleteNotification(completed, failed);
          }
        }
      } catch (error) {
        // Remove from active downloads on error
        activeDownloads.delete(index);

        if (error.name === 'AbortError') {
          // If abort was user-initiated (pause/stop button), keep the status the action handler already set
          if (userAbortedIndices.has(index)) {
            userAbortedIndices.delete(index);
            if (item.status === 'paused') {
              // Save chunks for range-resume on next Start
              item._savedChunks = item._liveChunks ? item._liveChunks.slice() : [];
              item._savedReceivedLength = item._liveReceivedLength || 0;
              console.log(`[DownloadManager] Paused at byte ${item._savedReceivedLength}, ${item._savedChunks.length} chunks saved: ${item.name}`);
            } else {
              // Stopped — discard saved data, truly restart next time
              item._savedChunks = null;
              item._savedReceivedLength = 0;
            }
            item._liveChunks = null;
          } else {
            // Global pause (isPaused flag) triggered the abort
            item._savedChunks = item._liveChunks ? item._liveChunks.slice() : [];
            item._savedReceivedLength = item._liveReceivedLength || 0;
            item._liveChunks = null;
            item.status = 'paused';
            console.log('[DownloadManager] Global pause, saved chunks for resume:', item.name);
          }
          renderQueue();
          updateDownloadInfo();
          saveState();
          if (activeDownloads.size === 0) isDownloading = false;
          return; // Don't call startNextDownload for any abort – user must press Start/Resume
        } else {
          item.status = 'error';

          // Provide actionable error messages
          let errorMessage = error.message;
          if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
            errorMessage = 'Network error - check your connection and try again';
          } else if (error.message.includes('HTTP 401') || error.message.includes('HTTP 403')) {
            errorMessage = 'Access denied - check your Emby credentials';
            if (Settings.get('bypassMode') === 'disabled') {
              errorMessage += ' (Bypass Mode Required)';

              // Only show the modal once per queue run to avoid spamming
              if (!window.bypassModalShown) {
                window.bypassModalShown = true;
                showBypassModal();
              }
            }
            // Stop further downloads on auth error to prevent spamming
            isPaused = true;
            console.log('[DownloadManager] Pausing queue due to authentication error');
          } else if (error.message.includes('HTTP 404')) {
            errorMessage = 'File not found on server';
          } else if (error.message.includes('HTTP 500') || error.message.includes('HTTP 503')) {
            errorMessage = 'Server error - try again later';
          } else if (error.message.includes('timeout')) {
            errorMessage = 'Download timeout - check connection or try again';
          } else if (error.message.includes('disk') || error.message.includes('quota')) {
            errorMessage = 'Storage full - free up disk space';
          } else if (error.message.includes('HTTP')) {
            errorMessage = `Server error (${error.message})`;
          }

          item.error = errorMessage;
          console.error('[DownloadManager] Download error:', error);
        }

        renderQueue();
        updateDownloadInfo();
        saveState();

        // Try to start next download after a real error (not abort) with a delay
        if (!isPaused && !downloadSingleItem) {
          setTimeout(() => startNextDownload(), 1500);
        } else if (downloadSingleItem) {
          downloadSingleItem = false;
        }

        if (activeDownloads.size === 0) {
          isDownloading = false;
        }
      }
    }

    // NEW v6.54: Helper function to start next pending downloads
    function startNextDownload() {
      // Fill up to maxConcurrentDownloads
      while (activeDownloads.size < maxConcurrentDownloads && !isPaused) {
        let nextIndex = -1;

        if (downloadOnlySelected) {
          nextIndex = downloadQueue.findIndex((i, idx) =>
            i.status === 'pending' &&
            i.selected &&
            !activeDownloads.has(idx)
          );
        } else {
          nextIndex = downloadQueue.findIndex((i, idx) =>
            i.status === 'pending' &&
            !activeDownloads.has(idx)
          );
        }

        if (nextIndex !== -1) {
          downloadItem(nextIndex);
        } else {
          break; // No more items to download
        }
      }
    }

    // Button handlers
    manager.querySelector('#start-all').addEventListener('click', () => {
      const hasSelection = downloadQueue.some(i => i.selected && i.status !== 'completed');
      if (hasSelection) {
        manager.querySelector('#download-selected').click();
        return;
      }

      isPaused = false;
      downloadOnlySelected = false;

      // Revert paused items to pending so startNextDownload picks them up
      downloadQueue.forEach(i => {
        if (i.status === 'paused') {
          i.status = 'pending';
          i.error = null;
        }
      });

      saveState();
      isDownloading = true;
      // NEW v6.54: Start multiple downloads concurrently
      startNextDownload();
      renderQueue();
    });

    manager.querySelector('#pause-all').addEventListener('click', () => {
      isPaused = true;
      // NEW v6.54: Abort all active downloads
      for (const [index, download] of activeDownloads.entries()) {
        download.abortController.abort();
      }
      activeDownloads.clear();
      saveState();
      renderQueue();
    });

    manager.querySelector('#clear-completed').addEventListener('click', () => {
      const remaining = downloadQueue.filter(item => item.status !== 'completed');
      downloadQueue.length = 0;
      downloadQueue.push(...remaining);
      saveState();
      renderQueue(true); // Queue structure changed
    });

    manager.querySelector('#retry-failed').addEventListener('click', () => {
      downloadQueue.forEach(item => {
        if (item.status === 'error') {
          item.status = 'pending';
          item.error = null;
          item.progress = 0;
        }
      });
      saveState();
      renderQueue();
    });

    manager.querySelector('#download-selected').addEventListener('click', async () => {
      const selectedIndices = downloadQueue
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.selected && item.status !== 'completed')
        .map(({ index }) => index);

      if (selectedIndices.length === 0) {
        showNotification('No items selected. Use checkboxes to select items to download.', 'info', 3000);
        return;
      }

      console.log(`[DownloadManager] Starting ${selectedIndices.length} selected items`);
      isPaused = false;
      downloadOnlySelected = true; // Enable selected-only mode

      // Set selected items to pending
      selectedIndices.forEach(index => {
        if (downloadQueue[index].status !== 'completed') {
          downloadQueue[index].status = 'pending';
          downloadQueue[index].error = null;
        }
      });

      renderQueue();
      saveState();

      // NEW v6.54: Start downloading selected items (concurrent)
      isDownloading = true;
      startNextDownload();
    });

    manager.querySelector('#cancel-all').addEventListener('click', () => {
      const incompleteCount = downloadQueue.filter(item =>
        item.status === 'pending' || item.status === 'paused' || item.status === 'downloading'
      ).length;

      if (incompleteCount === 0) {
        showNotification('No pending or paused downloads to cancel.', 'info', 3000);
        return;
      }

      const confirmed = confirm(
        `Cancel all ${incompleteCount} pending/paused downloads?\n\n` +
        `This will stop any active downloads and remove all incomplete items from the queue.\n` +
        `Completed downloads will not be affected.`
      );

      if (!confirmed) return;

      console.log(`[DownloadManager] Cancelling ${incompleteCount} incomplete items`);

      // Stop current download if any
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }

      isPaused = true;
      window.bypassModalShown = false; // Reset flag when cancelled

      // Remove all pending, paused, and downloading items
      const completedItems = downloadQueue.filter(item => item.status === 'completed' || item.status === 'error');
      downloadQueue.length = 0;
      downloadQueue.push(...completedItems);

      currentDownloadIndex = -1;
      renderQueue(true); // Queue structure changed
      saveState();

      showNotification(`Cancelled ${incompleteCount} incomplete download(s). ${completedItems.length} completed items remain.`, 'success', 4000);
    });

    // Bulk actions handlers
    manager.querySelector('#bulk-select-all').addEventListener('click', () => {
      downloadQueue.forEach(i => i.selected = true);
      renderQueue();
      updateStats();
      saveState();
    });

    manager.querySelector('#bulk-download').addEventListener('click', () => {
      manager.querySelector('#download-selected').click();
    });

    manager.querySelector('#bulk-remove').addEventListener('click', () => {
      const selected = downloadQueue.filter(i => i.selected);
      if (selected.length === 0) return;

      if (confirm(`Remove ${selected.length} selected item(s) from the queue?`)) {
        downloadQueue = downloadQueue.filter(i => !i.selected);
        renderQueue(true); // Queue structure changed
        updateStats();
        saveState();
        showNotification(`Removed ${selected.length} item(s)`, 'success', 2000);
      }
    });

    manager.querySelector('#bulk-deselect').addEventListener('click', () => {
      downloadQueue.forEach(i => i.selected = false);
      renderQueue();
      updateStats();
      saveState();
    });

    // ---------- NEW v6.61: Bypass Mode Modal ----------
    function showBypassModal() {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.85);
        z-index: 2147483655; /* Higher than manager */
        display: flex;
      align-items: center;
      justify-content: center;
        backdrop-filter: blur(4px);
        animation: fadeIn 0.2s ease;
      `;

      const isDarkMode = Settings.get('darkMode');
      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: ${isDarkMode ? '#1f2937' : 'white'};
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        position: relative;
        
        color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};
      `;

      dialog.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
          <div style="color: #ef4444; width: 32px; height: 32px;">
            ${Icons.alert}
          </div>
          <h3 style="margin: 0; font: 600 20px system-ui, sans-serif;">Downloads Blocked by Server</h3>
        </div>
        
        <p style="font: 14px/1.6 system-ui, sans-serif; margin: 0 0 16px 0;">
          The Emby server administrator has specifically disabled the "Allow media download" permission for your account or for these specific items.
        </p>
        
        <div style="background: ${isDarkMode ? '#371c1c' : '#fef2f2'}; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 20px; border-radius: 4px;">
          <h4 style="margin: 0 0 8px 0; font: 600 14px system-ui, sans-serif; color: ${isDarkMode ? '#fca5a5' : '#b91c1c'};">About Strict Bypass</h4>
          <p style="margin: 0; font: 13px/1.5 system-ui, sans-serif; color: ${isDarkMode ? '#fecaca' : '#991b1b'};">
            EmbyGrab can attempt to circumvent this restriction by forcing "Direct Play" and regenerating the internal stream URLs to access the original file. 
            <br><br>
            <strong>Disclaimer:</strong> Bypassing constraints set by the server administrator may violate their terms of service. You are solely responsible for ensuring you have permission to download this content. For this reason, this feature is disabled by default.
            <br><br>
            If you enable this, you can turn it off anytime from the EmbyGrab Settings gear icon under <strong>"Unlock / Bypass Options"</strong>.
          </p>
        </div>
        
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="modal-cancel" style="
            padding: 10px 16px;
            background: ${isDarkMode ? '#374151' : '#f3f4f6'};
            color: ${isDarkMode ? '#e0e0e0' : '#374151'};
            border: none;
            border-radius: 6px;
            font: 500 14px system-ui, sans-serif;
            cursor: pointer;
            transition: background 0.2s;
          ">Cancel Downloads</button>
          
          <button id="modal-enable" style="
            padding: 10px 16px;
            background: #ef4444;
            color: white;
            border: none;
            border-radius: 6px;
            font: 500 14px system-ui, sans-serif;
            cursor: pointer;
            transition: opacity 0.2s;
          ">Enable Strict Bypass</button>
        </div>
      `;

      dialog.querySelector('#modal-cancel').addEventListener('click', () => {
        overlay.remove();
        window.bypassModalShown = false; // Allow it to show again if more access-denied errors occur
        showNotification('Downloads paused. Enable Bypass Mode in Settings → Bypass Options to retry.', 'info', 6000);
      });

      dialog.querySelector('#modal-enable').addEventListener('click', () => {
        Settings.set('bypassMode', 'directplay');
        overlay.remove();
        showNotification('Strict Bypass enabled. Rebuilding links and resuming...', 'success', 4000);

        // Regenerate download URLs with bypass mode on, reset access-denied errors
        downloadQueue.forEach(item => {
          if (item.status === 'error' || item.status === 'paused' || item.status === 'pending') {
            // Rebuild the URL now that bypass is enabled
            item.url = constructDownloadUrl(item.downloadInfo._rawItem || { Id: item.id }, server, token);
            if (item.status === 'error' && item.error && item.error.includes('Access denied')) {
              item.status = 'pending';
              item.error = null;
              item.progress = 0;
            }
          }
        });

        window.bypassModalShown = false;
        isPaused = false;
        isDownloading = true;
        saveState();
        renderQueue();
        startNextDownload();
      });

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    }

    // Search/filter handler
    searchInput.addEventListener('input', (e) => {
      searchFilter = e.target.value;
      renderQueue();
    });

    toggleViewBtn.addEventListener('click', toggleView);

    // Checkbox change handlers
    function setupCheckboxHandlers() {
      // Individual item checkboxes
      manager.querySelectorAll('.item-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
          const index = parseInt(this.dataset.index);
          downloadQueue[index].selected = this.checked;
          updateBulkActions();
          saveState();
        });
      });



      // Group checkboxes
      manager.querySelectorAll('.group-checkbox').forEach(checkbox => {
        checkbox.addEventListener('click', (e) => e.stopPropagation()); // Prevent expansion
        checkbox.addEventListener('change', function () {
          const groupPath = this.dataset.groupPath;
          const isChecked = this.checked;

          // Apply to all items in this group
          downloadQueue.forEach(item => {
            const itemFolder = item.downloadInfo.folderPath || 'Other';

            // Match grouping logic from renderQueue
            const pathParts = itemFolder.split('/');
            let itemGroupKey;
            if (pathParts[0] === 'TV Shows' && pathParts.length >= 3) {
              itemGroupKey = pathParts.slice(0, 3).join('/');
            } else if (pathParts[0] === 'Music' && pathParts.length >= 3) {
              itemGroupKey = pathParts.slice(0, 3).join('/');
            } else if (pathParts[0] === 'Movies') {
              itemGroupKey = 'Movies';
            } else {
              itemGroupKey = itemFolder;
            }

            if (itemGroupKey === groupPath) {
              item.selected = isChecked;
            }
          });

          renderQueue(); // Re-render to update item checkboxes
          updateStats();
          saveState();
        });
      });

      // Group download buttons
      manager.querySelectorAll('.download-group-btn').forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          const groupPath = this.dataset.groupPath;

          // Start all pending items in this group
          let startedCount = 0;
          downloadQueue.forEach((item, index) => {
            const itemFolder = item.downloadInfo.folderPath || 'Other';

            // Match grouping logic
            const pathParts = itemFolder.split('/');
            let itemGroupKey;
            if (pathParts[0] === 'TV Shows' && pathParts.length >= 3) {
              itemGroupKey = pathParts.slice(0, 3).join('/');
            } else if (pathParts[0] === 'Music' && pathParts.length >= 3) {
              itemGroupKey = pathParts.slice(0, 3).join('/');
            } else if (pathParts[0] === 'Movies') {
              itemGroupKey = 'Movies';
            } else {
              itemGroupKey = itemFolder;
            }

            if (itemGroupKey === groupPath && item.status === 'pending') {
              // Logic to start download is complex (check concurrency), 
              // simpler to just call downloadItem if slots available, 
              // but `downloadItem` manages queue. 
              // Better: ensure they are pending and let queue manager pick them up? 
              // Actually, user expects "Start Now". 
              // We can set them to 'pending' (if paused/error) or just trigger processing?
              // If they are 'pending', they will be picked up.
              // If they are 'paused', set to 'pending'.
              if (item.status === 'paused' || item.status === 'error') {
                item.status = 'pending';
              }
            }
          });

          processQueue();
          renderQueue();
          saveState();
          showNotification('Started downloads for group', 'info', 2000);
        });
      });
    }

    manager.querySelector('#close-manager').addEventListener('click', () => {
      if (isDownloading) {
        if (confirm('Downloads are in progress. Close anyway? Progress will be saved and you can resume later.')) {
          isPaused = true;
          if (currentAbortController) {
            currentAbortController.abort();
          }
          saveState();
          overlay.remove();
        }
      } else {
        overlay.remove();
      }
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (isDownloading) {
          if (confirm('Downloads are in progress. Close anyway? Progress will be saved and you can resume later.')) {
            isPaused = true;
            if (currentAbortController) {
              currentAbortController.abort();
            }
            saveState();
            overlay.remove();
          }
        } else {
          saveState();
          overlay.remove();
        }
      }
    });

    // Search filter handler
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchFilter = e.target.value;
        renderQueue();
        updateFilterTabs();
      });
    }

    // Status filter tab bar — inject below the top toolbar
    const isDarkModeForTabs = Settings.get('darkMode');
    const filterTabBar = document.createElement('div');
    filterTabBar.id = 'dm-status-filter-bar';
    filterTabBar.style.cssText = `
      display: flex; align-items: center; gap: 4px;
      padding: 6px 12px;
      border-bottom: 1px solid ${isDarkModeForTabs ? '#1f2937' : '#e5e7eb'};
      background: ${isDarkModeForTabs ? '#0f172a' : '#f8fafc'};
      flex-shrink: 0;
      flex-wrap: nowrap;
      overflow-x: auto;
    `;

    const tabDefs = [
      { key: 'all', label: 'All', color: null },
      { key: 'downloading', label: 'Active', color: '#3b82f6' },
      { key: 'paused', label: 'Paused', color: '#f59e0b' },
      { key: 'pending', label: 'Queued', color: '#6b7280' },
      { key: 'completed', label: 'Done', color: '#10b981' },
      { key: 'error', label: 'Failed', color: '#ef4444' },
    ];

    function getTabCount(key) {
      if (key === 'all') return downloadQueue.length;
      return downloadQueue.filter(i => i.status === key).length;
    }

    function updateFilterTabs() {
      filterTabBar.querySelectorAll('.dm-status-tab').forEach(btn => {
        const key = btn.dataset.status;
        const count = getTabCount(key);
        const isActive = key === statusFilter;
        const def = tabDefs.find(t => t.key === key);
        const activeColor = def?.color || getTheme().primary;

        btn.style.background = isActive
          ? (isDarkModeForTabs ? `${activeColor}22` : `${activeColor}18`)
          : 'transparent';
        btn.style.color = isActive ? activeColor : (isDarkModeForTabs ? '#9ca3af' : '#64748b');
        btn.style.borderColor = isActive ? activeColor : 'transparent';
        btn.querySelector('.tab-count').textContent = count;
        btn.querySelector('.tab-count').style.background = isActive ? activeColor : (isDarkModeForTabs ? '#374151' : '#e2e8f0');
        btn.querySelector('.tab-count').style.color = isActive ? 'white' : (isDarkModeForTabs ? '#9ca3af' : '#64748b');
      });
    }

    tabDefs.forEach(({ key, label, color }) => {
      const count = getTabCount(key);
      const activeColor = color || getTheme().primary;
      const btn = document.createElement('button');
      btn.className = 'dm-status-tab';
      btn.dataset.status = key;
      btn.style.cssText = `
        display: flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 99px;
        border: 1.5px solid transparent;
        font: 600 11px system-ui, sans-serif;
        cursor: pointer; white-space: nowrap;
        transition: all 0.15s ease;
        background: transparent;
        color: ${isDarkModeForTabs ? '#9ca3af' : '#64748b'};
      `;
      btn.innerHTML = `${label}<span class="tab-count" style="
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 16px; height: 16px; padding: 0 4px;
        border-radius: 99px; font: 700 9px system-ui;
        background: ${isDarkModeForTabs ? '#374151' : '#e2e8f0'};
        color: ${isDarkModeForTabs ? '#9ca3af' : '#64748b'};
      ">${count}</span>`;
      btn.addEventListener('click', () => {
        statusFilter = key;
        updateFilterTabs();
        renderQueue();
      });
      filterTabBar.appendChild(btn);
    });

    // Insert the tab bar right after the search/toolbar row
    const searchRow = listView.querySelector('div[style*="search"]') || listView.firstElementChild?.nextElementSibling;
    if (searchRow && searchRow.parentNode === listView) {
      listView.insertBefore(filterTabBar, searchRow.nextSibling);
    } else {
      listView.insertBefore(filterTabBar, downloadList);
    }

    // Set initial active tab styling
    updateFilterTabs();
    // Also hook renderQueue to update counts
    const _origRenderQueue = renderQueue;
    // Update tabs after each renderQueue call
    const origRQ = renderQueue;
    renderQueue = function (...args) {
      origRQ(...args);
      updateFilterTabs();
    };

    // Keyboard shortcut hint — sticky strip at the very bottom of list-view
    const kbHint = document.createElement('div');
    kbHint.style.cssText = `
      position: sticky; bottom: 0;
      padding: 5px 12px;
      border-top: 1px solid ${isDarkModeForTabs ? '#1f2937' : '#e5e7eb'};
      background: ${isDarkModeForTabs ? '#0a0f1a' : '#f1f5f9'};
      display: flex; align-items: center; gap: 12px;
      font: 11px system-ui; color: ${isDarkModeForTabs ? '#4b5563' : '#9ca3af'};
      flex-shrink: 0; z-index: 1; pointer-events: none;
    `;
    const kbItems = [
      ['Space', 'pause / resume all'],
      ['Esc', 'close manager'],
      ['⌘F / Ctrl+F', 'search queue'],
    ];
    kbHint.innerHTML = kbItems.map(([key, desc]) =>
      `<span><kbd style="
        display:inline-block;padding:1px 5px;border-radius:4px;
        border:1px solid ${isDarkModeForTabs ? '#374151' : '#d1d5db'};
        background:${isDarkModeForTabs ? '#1f2937' : '#fff'};
        font:600 10px system-ui;color:${isDarkModeForTabs ? '#d1d5db' : '#374151'};
        margin-right:3px;box-shadow:0 1px 0 ${isDarkModeForTabs ? '#374151' : '#d1d5db'};
      ">${key}</kbd>${desc}</span>`
    ).join('<span style="color:#374151;opacity:0.3;"> · </span>');
    listView.appendChild(kbHint);

    // Keyboard shortcuts for download manager
    const keyboardHandler = (e) => {
      // Ignore if typing in input field
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        // Only handle Escape in input fields
        if (e.key === 'Escape') {
          e.target.blur();
          searchInput.value = '';
          searchFilter = '';
          renderQueue();
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          // Close download manager
          e.preventDefault();
          manager.querySelector('#close-manager').click();
          break;

        case ' ': // Space
          e.preventDefault();
          // Toggle pause/resume
          if (isPaused || !isDownloading) {
            manager.querySelector('#start-all').click();
          } else {
            manager.querySelector('#pause-all').click();
          }
          break;

        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          // Remove selected items
          const selected = downloadQueue.filter(i => i.selected);
          if (selected.length > 0) {
            if (confirm(`Remove ${selected.length} selected item(s) ? `)) {
              downloadQueue = downloadQueue.filter(i => !i.selected);
              renderQueue(true); // Queue structure changed
              updateStats();
              saveState();
            }
          }
          break;

        case 'a':
        case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            // Select all items
            downloadQueue.forEach(i => i.selected = true);
            renderQueue();
            saveState();
          }
          break;

        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            // Deselect all
            downloadQueue.forEach(i => i.selected = false);
            renderQueue();
            saveState();
          }
          break;

        case 'f':
        case 'F':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            // Focus search
            searchInput.focus();
          }
          break;
      }
    };

    document.addEventListener('keydown', keyboardHandler);

    // Clean up keyboard handler when manager closes
    const originalRemove = overlay.remove.bind(overlay);
    overlay.remove = () => {
      document.removeEventListener('keydown', keyboardHandler);
      originalRemove();
    };

    // No need to call renderQueue() here - already called after setupHandlers() above
    overlay.appendChild(manager);
    document.body.appendChild(overlay);

    // Log actual computed dimensions after adding to DOM
    setTimeout(() => {
      const computedStyle = window.getComputedStyle(manager);
      console.log('[DownloadManager] Manager actual dimensions:', {
        width: computedStyle.width,
        height: computedStyle.height,
        maxWidth: computedStyle.maxWidth,
        maxHeight: computedStyle.maxHeight,
        padding: computedStyle.padding
      });
    }, 100);

    // Auto-start if there are actually resumeable downloads (has progress or was recently active)
    const hasResumeableDownloads = downloadQueue.some(i =>
      (i.status === 'paused' && i.progress > 0) ||
      (i.status === 'downloading')
    );

    if (!isPaused && hasResumeableDownloads && downloadManagerState?.lastUpdated) {
      const timeSinceUpdate = Date.now() - downloadManagerState.lastUpdated;
      // Only prompt if last update was within 1 hour
      if (timeSinceUpdate < 3600000) {
        const nextIndex = downloadQueue.findIndex(i => i.status === 'pending' || i.status === 'paused');
        if (nextIndex !== -1 && confirm('Resume previous downloads?')) {
          setTimeout(() => downloadItem(nextIndex), 1000);
        }
      }
    }
  }

  // ---------- UI Components ----------
  function createButton() {
    const existingButton = document.getElementById(CONFIG.buttonId);
    if (existingButton) {
      existingButton.remove();
    }

    const theme = getTheme();
    const position = Settings.get('buttonPosition');

    button = document.createElement("button");
    button.id = CONFIG.buttonId;
    button.setAttribute('aria-label', 'Get download links with EmbyGrab');
    button.setAttribute('title', 'EmbyGrab - Get download links (Ctrl+D)');

    const positionStyles = getButtonPosition(position);
    const buttonStyles = {
      ...CONFIG.styles,
      ...positionStyles,
      backgroundColor: theme.primary,
      boxShadow: `0 8px 25px ${theme.shadow} `
    };

    Object.assign(button.style, buttonStyles);

    button.innerHTML = `
      ${Icons.download}
      <span class="button-text">${CONFIG.buttonText}</span>
      `;

    // Add hover effects
    button.addEventListener('mouseenter', () => {
      if (!isProcessing) {
        button.style.backgroundColor = theme.primaryHover;
        button.style.transform = "translateY(-2px) scale(1.05)";
        button.style.boxShadow = `0 12px 35px ${theme.shadow} `;
      }
    });

    button.addEventListener('mouseleave', () => {
      if (!isProcessing) {
        button.style.backgroundColor = theme.primary;
        button.style.transform = "translateY(0) scale(1)";
        button.style.boxShadow = `0 8px 25px ${theme.shadow} `;
      }
    });

    button.addEventListener('click', handleButtonClick);
    document.body.appendChild(button);

    // Create settings button
    createSettingsButton();

    return button;
  }

  function getButtonPosition(position) {
    const positions = {
      'bottom-right': { bottom: "20px", right: "20px", left: "auto", top: "auto" },
      'bottom-left': { bottom: "20px", left: "20px", right: "auto", top: "auto" },
      'top-right': { top: "20px", right: "20px", left: "auto", bottom: "auto" },
      'top-left': { top: "20px", left: "20px", right: "auto", bottom: "auto" }
    };
    return positions[position] || positions['bottom-right'];
  }

  function createSettingsButton() {
    const existingSettings = document.getElementById(CONFIG.settingsId);
    if (existingSettings) {
      existingSettings.remove();
    }

    const theme = getTheme();
    const position = Settings.get('buttonPosition');
    const positionStyles = getButtonPosition(position);

    const settingsBtn = document.createElement("button");
    settingsBtn.id = CONFIG.settingsId;
    settingsBtn.setAttribute('aria-label', 'Open settings');
    settingsBtn.setAttribute('title', 'Settings');

    const settingsStyles = {
      position: "fixed",
      ...positionStyles,
      zIndex: "2147483647",
      padding: "8px",
      backgroundColor: theme.primary,
      color: "white",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer",
      transition: "all 0.3s ease",
      opacity: "0.7"
    };

    Object.assign(settingsBtn.style, settingsStyles);
    settingsBtn.innerHTML = Icons.settings;

    settingsBtn.addEventListener('mouseenter', () => {
      settingsBtn.style.opacity = "1";
      settingsBtn.style.backgroundColor = theme.primaryHover;
    });

    settingsBtn.addEventListener('mouseleave', () => {
      settingsBtn.style.opacity = "0.7";
      settingsBtn.style.backgroundColor = theme.primary;
    });

    settingsBtn.addEventListener('click', showSettingsPanel);
    document.body.appendChild(settingsBtn);

    // Update settings button position dynamically
    updateSettingsButtonPosition();
  }

  function updateSettingsButtonPosition() {
    const settingsBtn = document.getElementById(CONFIG.settingsId);
    if (!settingsBtn || !button) return;

    const position = Settings.get('buttonPosition');
    const buttonRect = button.getBoundingClientRect();
    const gap = 12; // Gap between buttons

    if (position.includes('right')) {
      const rightOffset = window.innerWidth - buttonRect.left + gap;
      settingsBtn.style.right = `${rightOffset}px`;
    } else {
      const leftOffset = buttonRect.right + gap;
      settingsBtn.style.left = `${leftOffset}px`;
    }
  }

  function updateButtonState(processing, text = null, progress = null) {
    if (!button) return;

    const theme = getTheme();
    isProcessing = processing;
    button.disabled = processing;

    const buttonText = button.querySelector('.button-text');
    if (buttonText) {
      if (processing && text) {
        buttonText.textContent = text;
      } else {
        buttonText.textContent = processing ? "Processing..." : CONFIG.buttonText;
      }
    }

    if (processing) {
      button.style.backgroundColor = theme.primaryDisabled;
      button.style.cursor = "wait";
      button.style.transform = "translateY(0) scale(1)";

      // Add progress indicator
      if (progress !== null) {
        button.style.background = `linear-gradient(to right, ${theme.primary} ${progress} %, ${theme.primaryDisabled} ${progress} %)`;
      }
    } else {
      button.style.backgroundColor = theme.primary;
      button.style.cursor = "pointer";
      button.style.background = theme.primary;
    }

    // Update settings button position when button text changes
    setTimeout(updateSettingsButtonPosition, 0);
  }

  function createProgressModal() {
    const existingModal = document.getElementById(CONFIG.progressId);
    if (existingModal) {
      existingModal.remove();
    }

    const isDarkMode = Settings.get('darkMode');

    const overlay = document.createElement('div');
    overlay.id = CONFIG.progressId;
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 2147483648;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: ${isDarkMode ? '#1c1c1c' : 'white'};
      border-radius: 16px;
      padding: 24px;
      max-width: 480px;
      width: 90%;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: modalSlideIn 0.3s ease;
      `;

    // Apply dark mode if enabled
    if (isDarkMode) {
      modal.setAttribute('data-dark-mode', 'true');
    }

    const title = document.createElement('h3');
    title.style.cssText = `
      margin: 0 0 16px 0;
      color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};
      font: 600 18px system-ui, sans-serif;
      display: flex;
      align-items: center;
      gap: 8px;
      `;
    title.innerHTML = `${Icons.download} Processing Download Links`;

    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = `
      margin: 16px 0;
      `;

    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressBar.style.cssText = `
      width: 100%;
      height: 20px;
      background: ${isDarkMode ? 'linear-gradient(135deg, #1f2937 0%, #111827 100%)' : 'linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%)'};
      border-radius: 10px;
      overflow: hidden;
      margin: 12px 0;
      border: 2px solid ${isDarkMode ? '#374151' : '#d1d5db'};
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
      `;

    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressFill.style.cssText = `
      height: 100%;
      background: linear-gradient(90deg, #10b981 0%, #34d399 50%, #10b981 100%);
      background-size: 200% 100%;
      animation: shimmer 2s infinite linear;
      width: 0%;
      transition: width 0.3s ease;
      border-radius: 8px;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.6);
      `;

    progressBar.appendChild(progressFill);

    const statusText = document.createElement('div');
    statusText.className = 'status-text';
    statusText.style.cssText = `
      color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
      font: 14px system-ui, sans-serif;
      margin: 8px 0;
      `;

    const timeInfo = document.createElement('div');
    timeInfo.className = 'time-info';
    timeInfo.style.cssText = `
      color: ${isDarkMode ? '#9ca3af' : '#9ca3af'};
      font: 12px system-ui, sans-serif;
      margin: 4px 0;
      `;

    const errorList = document.createElement('div');
    errorList.className = 'error-list';
    errorList.style.cssText = `
      margin-top: 16px;
      max-height: 150px;
      overflow-y: auto;
      `;

    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 24px;
      `;

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      background: white;
      color: #374151;
      cursor: pointer;
      font: 13px system-ui, sans-serif;
      transition: all 0.2s ease;
      `;

    cancelBtn.addEventListener('click', () => {
      if (abortController) {
        abortController.abort();
      }
      hideProgressModal();
    });

    // Add animation styles
    if (!document.getElementById('modal-styles')) {
      const style = document.createElement('style');
      style.id = 'modal-styles';
      style.textContent = `
      @keyframes modalSlideIn {
          from {
          transform: translateY(20px) scale(0.95);
          opacity: 0;
        }
          to {
          transform: translateY(0) scale(1);
          opacity: 1;
        }
      }
      @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
      }
      @keyframes shimmer {
        0% { background- position: 200% 0;
      }
      100% { background- position: -200% 0;
    }
  }
  /* Button hover effects */
  button: not(: disabled):hover {
    opacity: 0.85!important;
    transform: translateY(-1px);
    transition: all 0.2s ease;
  }
  button: not(: disabled):active {
    transform: translateY(0);
  }
        /* Smooth scrolling */
        * {
    scroll- behavior: smooth;
}
  `;
      document.head.appendChild(style);
    }

    progressContainer.appendChild(progressBar);
    progressContainer.appendChild(statusText);
    progressContainer.appendChild(timeInfo);
    progressContainer.appendChild(errorList);

    buttonContainer.appendChild(cancelBtn);

    modal.appendChild(title);
    modal.appendChild(progressContainer);
    modal.appendChild(buttonContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    progressModal = overlay;
    return overlay;
  }

  function updateProgressModal(current, total, status = '', errors = []) {
    if (!progressModal) return;

    const progressFill = progressModal.querySelector('.progress-fill');
    const statusText = progressModal.querySelector('.status-text');
    const timeInfo = progressModal.querySelector('.time-info');
    const errorList = progressModal.querySelector('.error-list');

    if (progressFill && total > 0) {
      const percentage = Math.round((current / total) * 100);
      progressFill.style.width = `${percentage}% `;
    }

    if (statusText) {
      statusText.textContent = status || `Processing ${current} of ${total} items...`;
    }

    if (timeInfo && processingStats.startTime) {
      const elapsed = Date.now() - processingStats.startTime;
      const rate = current / (elapsed / 1000);
      const remaining = total > current ? (total - current) / rate : 0;

      timeInfo.textContent = `Elapsed: ${formatTime(elapsed / 1000)} | Remaining: ${formatTime(remaining)} `;
    }

    if (errorList && errors.length > 0) {
      errorList.innerHTML = errors.map(error => `
  < div style = "
color: #dc2626;
font: 12px system-ui, sans-serif;
padding: 4px 8px;
background: #fef2f2;
border-left: 3px solid #dc2626;
margin: 2px 0;
border-radius: 4px;
">
          ${Icons.alert} ${error}
        </div >
  `).join('');
    }
  }

  function hideProgressModal() {
    if (progressModal) {
      progressModal.style.animation = 'modalSlideIn 0.2s ease reverse';
      setTimeout(() => {
        if (progressModal) {
          progressModal.remove();
          progressModal = null;
        }
      }, 200);
    }
  }

  function formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)} s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds} s`;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);

    return `${size} ${sizes[i]} `;
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) return '0 B/s';

    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(1024));
    const speed = (bytesPerSecond / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);

    return `${speed} ${sizes[i]} `;
  }

  function formatETA(seconds) {
    if (!seconds || seconds <= 0) return 'calculating...';

    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60} s`;

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes} m`;
  }

  function calculateTotalSize(items) {
    let totalSize = 0;
    let itemsWithSize = 0;

    items.forEach(item => {
      // Check various possible size properties in Emby API responses
      const size = item.Size || item.FileSize || item.MediaSources?.[0]?.Size || item.RunTimeTicks || 0;
      if (size > 0) {
        // If RunTimeTicks, convert to approximate file size (very rough estimate)
        if (item.RunTimeTicks && !item.Size && !item.FileSize) {
          // Rough estimate: 1 hour ≈ 1-2GB for standard quality
          const hours = item.RunTimeTicks / 36000000000; // RunTimeTicks to hours
          totalSize += hours * 1.5 * 1024 * 1024 * 1024; // 1.5GB per hour estimate
        } else {
          totalSize += size;
        }
        itemsWithSize++;
      }
    });

    return {
      totalSize,
      itemsWithSize,
      hasEstimates: items.some(item => item.RunTimeTicks && !item.Size && !item.FileSize)
    };
  }

  function showSettingsPanel() {
    if (settingsPanel) {
      hideSettingsPanel();
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
position: fixed;
top: 0;
left: 0;
right: 0;
bottom: 0;
background: rgba(0, 0, 0, 0.7);
z-index: 2147483649;
display: flex;
      align-items: center;
      justify-content: center;
backdrop-filter: blur(4px);
animation: fadeIn 0.3s ease;
`;

    const panel = document.createElement('div');
    panel.id = 'emby-grab-settings';
    const isDarkMode = Settings.get('darkMode');

    panel.style.cssText = `
        background: ${isDarkMode ? '#1c1c1c' : 'white'};
        border-radius: 16px;
        max-width: 900px;
        width: 92%;
        height: 85vh;
        max-height: 85vh;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        animation: modalSlideIn 0.3s ease;
        position: relative;
        
        overflow: hidden;
      `;

    // Apply dark mode immediately if enabled
    if (isDarkMode) {
      panel.setAttribute('data-dark-mode', 'true');
      console.log('[EmbyGrab] Applied dark mode attribute to settings panel');
    }

    const currentSettings = Settings.getAll();

    panel.innerHTML = `
      <!-- Header -->
      <div style="position: absolute; top: 0; left: 0; right: 0; height: 68px; padding: 0 24px; border-bottom: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'}; display: flex; justify-content: space-between; align-items: center; background: ${isDarkMode ? '#1c1c1c' : 'white'}; z-index: 2;">
        <h3 style="margin: 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 600 20px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
          ${Icons.settings} EmbyGrab Settings
        </h3>
        <button id="close-settings" style="
          background: none;
          border: none;
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer;
          padding: 8px;
          border-radius: 8px;
          transition: all 0.2s ease;
        ">${Icons.close}</button>
      </div>

      <!-- Settings Layout Container -->
      <div style="position: absolute; top: 68px; bottom: 64px; left: 0; right: 0; display: flex; flex-direction: row;">
      
        <!-- Left Sidebar (25% Width) -->
        <div style="width: 250px; flex-shrink: 0; border-right: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'}; background: ${isDarkMode ? '#171717' : '#f9fafb'}; padding: 16px 0; overflow-y: auto;">
          <style>
            .setting-nav-item {
              padding: 12px 24px;
              color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
              font: 500 14px system-ui, sans-serif;
              cursor: pointer;
              display: flex;
              align-items: center;
              gap: 12px;
              transition: all 0.2s ease;
              border-left: 3px solid transparent;
            }
            .setting-nav-item:hover {
              background: ${isDarkMode ? '#2a2a2a' : '#f1f5f9'};
              color: ${isDarkMode ? '#e0e0e0' : '#1e293b'};
            }
            .setting-nav-item.active {
              background: ${isDarkMode ? '#2a2a2a' : '#f1f5f9'};
              color: ${getTheme().primary};
              border-left-color: ${getTheme().primary};
              font-weight: 600;
            }
            
            /* Custom Toggle Switch CSS */
            .custom-toggle {
              position: relative;
              display: inline-block;
              width: 36px;
              height: 20px;
              flex-shrink: 0;
            }
            .custom-toggle input {
              opacity: 0;
              width: 0;
              height: 0;
            }
            .toggle-slider {
              position: absolute;
              cursor: pointer;
              top: 0; left: 0; right: 0; bottom: 0;
              background-color: ${isDarkMode ? '#4b5563' : '#cbd5e1'};
              transition: .3s;
              border-radius: 20px;
            }
            .toggle-slider:before {
              position: absolute;
              content: "";
              height: 16px;
              width: 16px;
              left: 2px;
              bottom: 2px;
              background-color: white;
              transition: .3s;
              border-radius: 50%;
              box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            }
            input:checked + .toggle-slider {
              background-color: ${getTheme().primary};
            }
            input:checked + .toggle-slider:before {
              transform: translateX(16px);
            }
            
            .setting-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 16px 0;
              border-bottom: 1px solid ${isDarkMode ? '#2a2a2a' : '#f1f5f9'};
            }
            .setting-row:last-child {
              border-bottom: none;
            }
            .setting-info {
              display: flex;
              flex-direction: column;
              gap: 4px;
              padding-right: 24px;
            }
            .setting-title {
              color: ${isDarkMode ? '#e0e0e0' : '#1e293b'};
              font: 500 14px system-ui, sans-serif;
            }
            .setting-desc {
              color: ${isDarkMode ? '#9ca3af' : '#64748b'};
              font: 400 12px system-ui, sans-serif;
              line-height: 1.4;
            }
            .setting-control {
              min-width: 160px;
              display: flex;
              justify-content: flex-end;
            }
            .modern-input {
              width: 100%;
              padding: 8px 12px;
              border: 1px solid ${isDarkMode ? '#374151' : '#d1d5db'};
              border-radius: 8px;
              font: 14px system-ui, sans-serif;
              background: ${isDarkMode ? '#2a2a2a' : 'white'};
              color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};
              transition: all 0.2s;
              box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            }
            .modern-input:focus {
              outline: none;
              border-color: ${getTheme().primary};
              box-shadow: 0 0 0 2px ${getTheme().primary}40;
            }
            .settings-section-title {
              margin: 0 0 24px 0;
              color: ${isDarkMode ? '#e0e0e0' : '#0f172a'};
              font: 600 22px system-ui, sans-serif;
              display: flex;
              align-items: center;
              gap: 12px;
            }
            .settings-card {
              background: ${isDarkMode ? '#252525' : 'white'};
              border: 1px solid ${isDarkMode ? '#374151' : '#e2e8f0'};
              border-radius: 12px;
              padding: 0 24px;
              margin-bottom: 24px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.02);
            }
          </style>
          
          <div class="setting-nav-item active" data-target="panel-general">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            General Basics
          </div>
          <div class="setting-nav-item" data-target="panel-appearance">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
            Appearance
          </div>
          <div class="setting-nav-item" data-target="panel-filters">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
            Filters & History
          </div>
          <div class="setting-nav-item" data-target="panel-jdownloader">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            JDownloader
          </div>
          <div class="setting-nav-item" data-target="panel-templates">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
            Naming Templates
          </div>
          <div class="setting-nav-item" data-target="panel-subtitles">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            Subtitles
          </div>
        </div>
        
        <!-- Right Content Area (Flex 1) -->
        <div style="flex: 1; overflow-y: auto; overflow-x: hidden; padding: 32px; background: ${isDarkMode ? '#1c1c1c' : '#ffffff'}; position: relative;">
          
          <!-- General Section -->
          <div id="panel-general" class="settings-panel-section" style="display: block;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              General Basics
            </h2>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Floating Button Position</div>
                  <div class="setting-desc">Where the EmbyGrab quick-access button docks on the screen.</div>
                </div>
                <div class="setting-control" style="max-width: 200px;">
                  <select id="button-position" class="modern-input">
                    <option value="bottom-right" ${currentSettings.buttonPosition === 'bottom-right' ? 'selected' : ''}>Bottom Right</option>
                    <option value="bottom-left" ${currentSettings.buttonPosition === 'bottom-left' ? 'selected' : ''}>Bottom Left</option>
                    <option value="top-right" ${currentSettings.buttonPosition === 'top-right' ? 'selected' : ''}>Top Right</option>
                    <option value="top-left" ${currentSettings.buttonPosition === 'top-left' ? 'selected' : ''}>Top Left</option>
                  </select>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Default Output Format</div>
                  <div class="setting-desc">The format URLs and scripts are natively generated in.</div>
                </div>
                <div class="setting-control" style="max-width: 200px;">
                  <select id="output-format" class="modern-input">
                    ${Object.entries(CONFIG.outputFormats).map(([key, label]) => `<option value="${key}" ${currentSettings.outputFormat === key ? 'selected' : ''}>${label}</option>`).join('')}
                  </select>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Batch Size Limit</div>
                  <div class="setting-desc">Concurrent items to process (10-200). Higher = faster but resource intensive.</div>
                </div>
                <div class="setting-control" style="max-width: 120px;">
                  <input type="number" id="batch-size" class="modern-input" value="${currentSettings.batchSize}" min="10" max="200">
                </div>
              </div>
            </div>
            
            <h3 style="margin: 32px 0 16px 0; color: ${isDarkMode ? '#e0e0e0' : '#1e293b'}; font: 600 18px system-ui, sans-serif;">Advanced Controls</h3>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Concurrent Active Downloads</div>
                  <div class="setting-desc">Recommended 2-3 to prevent browser network saturation.</div>
                </div>
                <div class="setting-control" style="max-width: 120px;">
                  <input type="number" id="concurrent-downloads" class="modern-input" value="${currentSettings.concurrentDownloads || 3}" min="1" max="5">
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Skip Large Batch Confirmations</div>
                  <div class="setting-desc">Never prompt for permission on giant folder downloads.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="auto-confirm" ${currentSettings.autoConfirm ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Show Fetch Progress Dialog</div>
                  <div class="setting-desc">Disabling this speeds up background polling natively.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="show-progress" ${currentSettings.showProgress ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title" style="color: #dc2626;">Enable API Rate Limiting</div>
                  <div class="setting-desc">Caps fetches to 10 per second to protect weak Emby Servers.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="enable-rate-limit" ${currentSettings.enableRateLimit ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Verbose Debug Logging</div>
                  <div class="setting-desc">Print detailed network activity to browser console (F12).</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="debug-mode" ${currentSettings.debugMode ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Appearance Section -->
          <div id="panel-appearance" class="settings-panel-section" style="display: none;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
              Interface Appearance
            </h2>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Accent Theme</div>
                  <div class="setting-desc">The primary color used for buttons, toggles, and highlights.</div>
                </div>
                <div class="setting-control" style="max-width: 200px;">
                  <select id="theme" class="modern-input">
                    <option value="green" ${currentSettings.theme === 'green' ? 'selected' : ''}>Emerald Green</option>
                    <option value="blue" ${currentSettings.theme === 'blue' ? 'selected' : ''}>Ocean Blue</option>
                    <option value="purple" ${currentSettings.theme === 'purple' ? 'selected' : ''}>Royal Purple</option>
                  </select>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Dark Mode</div>
                  <div class="setting-desc">Apply high-contrast dark backgrounds across all menus.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="dark-mode" ${currentSettings.darkMode ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Compact View</div>
                  <div class="setting-desc">Condense list padding to show more downloaded items per page.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="compact-mode" ${currentSettings.compactMode ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Filters & History Section -->
          <div id="panel-filters" class="settings-panel-section" style="display: none;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
              Filters & History
            </h2>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Enable Download History Tracking</div>
                  <div class="setting-desc">Local tracking of all URLs and files retrieved by the extension.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="enable-history" ${currentSettings.enableHistory ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Skip Previously Downloaded Items</div>
                  <div class="setting-desc">Exclude files that already exist in your local download history tracker.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="skip-downloaded" ${currentSettings.skipDownloaded ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row" style="flex-wrap: wrap; justify-content: flex-start; gap: 12px; border-bottom: none;">
                <button id="view-history" style="padding: 10px 16px; border: 1px solid ${isDarkMode ? '#374151' : '#e2e8f0'}; border-radius: 8px; background: transparent; color: ${isDarkMode ? '#e0e0e0' : '#1e293b'}; cursor: pointer; font: 500 13px system-ui, sans-serif; transition: all 0.2s;">View SQLite History</button>
                <button id="export-history" style="padding: 10px 16px; border: 1px solid ${isDarkMode ? '#374151' : '#e2e8f0'}; border-radius: 8px; background: transparent; color: ${isDarkMode ? '#e0e0e0' : '#1e293b'}; cursor: pointer; font: 500 13px system-ui, sans-serif; transition: all 0.2s;">Export CSV Data</button>
                <button id="clear-history" style="padding: 10px 16px; border: 1px solid #ef4444; border-radius: 8px; background: transparent; color: #ef4444; cursor: pointer; font: 500 13px system-ui, sans-serif; transition: all 0.2s;">Nuke History DB</button>
              </div>
            </div>
            
            <h3 style="margin: 32px 0 16px 0; color: ${isDarkMode ? '#e0e0e0' : '#1e293b'}; font: 600 18px system-ui, sans-serif;">Smart Filtering Options</h3>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Filter: Exclude Extras</div>
                  <div class="setting-desc">Automatically drop trailers, behind-the-scenes, and bonus featurettes.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="filter-exclude-extras" ${currentSettings.filterOptions?.excludeExtras ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info" style="width: 100%; padding-right: 0;">
                  <div class="setting-title">Quality Presets Minimum</div>
                  <div class="setting-desc" style="margin-bottom: 12px;">Files below this resolution threshold will be excluded from the batch.</div>
                  
                  <div id="quality-presets" style="display: flex; gap: 8px; width: 100%;">
                    <button class="quality-preset" data-quality="" style="flex: 1; padding: 10px; border: 1px solid ${isDarkMode ? '#374151' : '#d1d5db'}; border-radius: 8px; background: ${(!currentSettings.filterOptions || !currentSettings.filterOptions.minQuality) ? getTheme().primary : (isDarkMode ? '#252525' : '#f8fafc')}; color: ${(!currentSettings.filterOptions || !currentSettings.filterOptions.minQuality) ? 'white' : (isDarkMode ? '#e0e0e0' : '#1f2937')}; cursor: pointer; font: 600 13px system-ui, sans-serif; transition: all 0.15s ease;">Any</button>
                    <button class="quality-preset" data-quality="720p" style="flex: 1; padding: 10px; border: 1px solid ${isDarkMode ? '#374151' : '#d1d5db'}; border-radius: 8px; background: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '720p' ? getTheme().primary : (isDarkMode ? '#252525' : '#f8fafc')}; color: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '720p' ? 'white' : (isDarkMode ? '#e0e0e0' : '#1f2937')}; cursor: pointer; font: 600 13px system-ui, sans-serif; transition: all 0.15s ease;">HD 720p</button>
                    <button class="quality-preset" data-quality="1080p" style="flex: 1; padding: 10px; border: 1px solid ${isDarkMode ? '#374151' : '#d1d5db'}; border-radius: 8px; background: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '1080p' ? getTheme().primary : (isDarkMode ? '#252525' : '#f8fafc')}; color: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '1080p' ? 'white' : (isDarkMode ? '#e0e0e0' : '#1f2937')}; cursor: pointer; font: 600 13px system-ui, sans-serif; transition: all 0.15s ease;">FHD 1080p</button>
                    <button class="quality-preset" data-quality="4K" style="flex: 1; padding: 10px; border: 1px solid ${isDarkMode ? '#374151' : '#d1d5db'}; border-radius: 8px; background: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '4K' ? getTheme().primary : (isDarkMode ? '#252525' : '#f8fafc')}; color: ${currentSettings.filterOptions && currentSettings.filterOptions.minQuality === '4K' ? 'white' : (isDarkMode ? '#e0e0e0' : '#1f2937')}; cursor: pointer; font: 600 13px system-ui, sans-serif; transition: all 0.15s ease;">UHD 4K+</button>
                  </div>
                </div>
              </div>
              
              <div class="setting-row" style="border-bottom: none;">
                <div class="setting-info" style="width: 100%; padding-right: 0;">
                  <div class="setting-title" style="display: flex; justify-content: space-between;">
                    File Size Thresholds (GB)
                    <span id="size-range-display" style="color: ${getTheme().primary}; padding: 2px 8px; background: ${getTheme().primary}20; border-radius: 12px; font-size: 12px;">${currentSettings.filterOptions?.minFileSize || 0} GB - ${currentSettings.filterOptions?.maxFileSize || '∞'} GB</span>
                  </div>
                  <div class="setting-desc" style="margin-bottom: 24px;">Files outside this size range will be eliminated from the download list.</div>
                  
                  <div style="display: flex; gap: 24px; align-items: center; margin-bottom: 16px;">
                    <div style="flex: 1;">
                      <label style="color: ${isDarkMode ? '#9ca3af' : '#64748b'}; font-size: 12px; margin-bottom: 4px; display: block;">Min Floor</label>
                      <input type="number" id="filter-size-min" class="modern-input" value="${currentSettings.filterOptions?.minFileSize || ''}" placeholder="0 GB" min="0" step="0.1">
                    </div>
                    <div style="flex: 1;">
                      <label style="color: ${isDarkMode ? '#9ca3af' : '#64748b'}; font-size: 12px; margin-bottom: 4px; display: block;">Max Ceiling</label>
                      <input type="number" id="filter-size-max" class="modern-input" value="${currentSettings.filterOptions?.maxFileSize || ''}" placeholder="No Limit" min="0" step="0.1">
                    </div>
                  </div>
                  
                  <!-- Sliders overlay -->
                  <div style="position: relative; height: 30px;">
                    <input type="range" id="filter-size-slider-min" min="0" max="20" step="0.5" value="${currentSettings.filterOptions?.minFileSize || 0}" style="position: absolute; top: 0; left: 0; width: 100%; height: 6px; background: ${isDarkMode ? '#374151' : '#e2e8f0'}; border-radius: 3px; outline: none; -webkit-appearance: none; accent-color: ${getTheme().primary}; point-events: none; z-index: 2;">
                    <input type="range" id="filter-size-slider-max" min="0" max="20" step="0.5" value="${currentSettings.filterOptions?.maxFileSize || 20}" style="position: absolute; top: 12px; left: 0; width: 100%; height: 6px; background: ${isDarkMode ? '#374151' : '#e2e8f0'}; border-radius: 3px; outline: none; -webkit-appearance: none; accent-color: #ef4444; z-index: 1;">
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <!-- JDownloader Section -->
          <div id="panel-jdownloader" class="settings-panel-section" style="display: none;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              JDownloader Connect
            </h2>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Enable JD Local Socket Binding</div>
                  <div class="setting-desc">Injects links directly to local JDownloader 2 instance.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="jdownloader-enabled" ${currentSettings.jdownloaderEnabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Automatic Silent Detection</div>
                  <div class="setting-desc">Pings localhost port 9666 every 60s for live JD instance. (Will spawn 1 browser security prompt initially)</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="jdownloader-auto-detect" ${currentSettings.enableJDownloaderAutoDetect ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row" style="border-bottom: none;">
                <div class="setting-info">
                  <div class="setting-title">FlashGot Listener Port</div>
                  <div class="setting-desc">Target TCP Port. Do not change unless manually configured in JD Advanced Settings.</div>
                </div>
                <div class="setting-control" style="width: 140px; display: flex; gap: 8px; flex-direction: column;">
                  <input type="number" id="jdownloader-port" class="modern-input" value="${currentSettings.jdownloaderPort || 9666}" min="1" max="65535">
                  <button id="test-jdownloader" style="width: 100%; padding: 8px; background: transparent; border: 1px solid ${getTheme().primary}; color: ${getTheme().primary}; border-radius: 6px; cursor: pointer; font: 500 12px system-ui;">Test Net Bind</button>
                </div>
              </div>
            </div>
            
            <div style="background: ${isDarkMode ? 'rgba(56, 189, 248, 0.1)' : '#f0f9ff'}; border: 1px solid ${isDarkMode ? 'rgba(56, 189, 248, 0.3)' : '#bae6fd'}; border-radius: 12px; padding: 16px; margin-top: 16px;">
              <h4 style="color: ${isDarkMode ? '#38bdf8' : '#0369a1'}; margin: 0 0 12px 0; font: 600 14px system-ui;">1-Minute Setup Guide</h4>
              <ul style="color: ${isDarkMode ? '#9ca3af' : '#334155'}; font: 13px system-ui; margin: 0; padding-left: 20px; line-height: 1.6;">
                <li>Open JDownloader 2 and click <strong style="color: ${isDarkMode ? '#e0e0e0' : 'black'}">Settings</strong></li>
                <li>Navigate down to <strong style="color: ${isDarkMode ? '#e0e0e0' : 'black'}">Advanced Settings</strong></li>
                <li>Search for <code style="background: ${isDarkMode ? '#334155' : '#e2e8f0'}; padding: 2px 6px; border-radius: 4px;">RemoteAPI: port</code> and verify it's 9666.</li>
                <li>If the checkbox above is checked, we bypass HTTP CORS blocks via browser API.</li>
                <li>EmbyGrab will automatically structure folders by Movies vs Shows on execution.</li>
              </ul>
            </div>
          </div>
          
          <!-- Templates Section -->
          <div id="panel-templates" class="settings-panel-section" style="display: none;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
              Naming Templates
            </h2>
            
            <div class="settings-card">
              <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 8px;">
                <div class="setting-info" style="width: 100%; padding: 0;">
                  <div class="setting-title">TV Episode File Structure</div>
                  <div class="setting-desc" style="margin-bottom: 8px;">Macro string structure when renaming TV Series files.</div>
                </div>
                <input type="text" id="filename-template-episode" class="modern-input" value="${currentSettings.filenameTemplateEpisode || '{Series} - S{season}E{episode} - {Title}'}">
              </div>
              
              <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 8px; border-bottom: none;">
                <div class="setting-info" style="width: 100%; padding: 0;">
                  <div class="setting-title">Theatrical Movie Structure</div>
                  <div class="setting-desc" style="margin-bottom: 8px;">Macro string structure when parsing Film objects.</div>
                </div>
                <input type="text" id="filename-template-movie" class="modern-input" value="${currentSettings.filenameTemplateMovie || '{Title} ({Year})'}">
              </div>
            </div>
            
            <div style="background: ${isDarkMode ? '#252525' : '#f8fafc'}; border: 1px dashed ${isDarkMode ? '#4b5563' : '#cbd5e1'}; border-radius: 12px; padding: 16px;">
              <div style="color: ${isDarkMode ? '#e0e0e0' : '#334155'}; font-weight: 500; font-size: 13px; margin-bottom: 12px;">Valid Substitution Tokens:</div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Series}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Season}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Episode}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Title}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Year}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Resolution}</code>
                <code style="background: ${getTheme().primary}20; border: 1px solid ${getTheme().primary}40; color: ${isDarkMode ? '#e0e0e0' : 'black'}; padding: 4px 8px; border-radius: 6px; font-size: 13px;">{Codec}</code>
              </div>
            </div>
          </div>
          
          <!-- Subtitles Section -->
          <div id="panel-subtitles" class="settings-panel-section" style="display: none;">
            <h2 class="settings-section-title">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
              Subtitle Extractions
            </h2>
            
            <div class="settings-card">
              <div class="setting-row">
                <div class="setting-info">
                  <div class="setting-title">Auto-Download Local Subtitles</div>
                  <div class="setting-desc">Spawns subsequent HTTP fetches to download independent VTT and SRT streams alongside the main file payload.</div>
                </div>
                <div class="setting-control">
                  <label class="custom-toggle">
                    <input type="checkbox" id="dl-external-subtitles" ${currentSettings.dlExternalSubtitles ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
              
              <div class="setting-row" style="flex-direction: column; align-items: stretch; border-bottom: none;">
                <div class="setting-info" style="width: 100%; padding: 0; margin-bottom: 16px;">
                  <div class="setting-title">Allowed Language Matrices</div>
                  <div class="setting-desc">Check explicit ISO codes to whitelist them. Leaving all boxes UNCHECKED downloads EVERY available subtitle unconditionally.</div>
                </div>
                
                <div id="subtitle-language-container" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
                  ${(() => {
        const commonLangs = [
          { code: 'eng', name: 'English' }, { code: 'spa', name: 'Spanish' },
          { code: 'fra', name: 'French' }, { code: 'deu', name: 'German' },
          { code: 'ita', name: 'Italian' }, { code: 'por', name: 'Portuguese' },
          { code: 'rus', name: 'Russian' }, { code: 'jpn', name: 'Japanese' },
          { code: 'zho', name: 'Chinese' }, { code: 'kor', name: 'Korean' },
          { code: 'ara', name: 'Arabic' }, { code: 'hin', name: 'Hindi' }
        ];
        const selected = (currentSettings.subtitleLanguages || '').split(',').map(s => s.trim());
        return commonLangs.map(lang => `
                      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 10px; background: ${isDarkMode ? '#1c1c1c' : '#f8fafc'}; border: 1px solid ${isDarkMode ? '#374151' : '#e2e8f0'}; border-radius: 8px;">
                        <input type="checkbox" value="${lang.code}" ${selected.includes(lang.code) ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: ${getTheme().primary}; cursor: pointer;">
                        <span style="color: ${isDarkMode ? '#e0e0e0' : '#1e293b'}; font-size: 13px; font-weight: 500;">${lang.name}</span>
                      </label>
                    `).join('');
      })()}
                </div>
              </div>
            </div>
          </div>
          
        </div>
      </div>
      
      <!-- Footer (Absolutely Fixed to Bottom) -->
      <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 64px; padding: 0 24px; border-top: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'}; background: ${isDarkMode ? '#1a1a1a' : '#f9fafb'}; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 8px;">
          <button id="show-about" class="modern-btn" style="padding: 8px 16px; background: transparent; border: 1px solid transparent; border-radius: 6px; color: ${isDarkMode ? '#e0e0e0' : '#334155'}; cursor: pointer; font: 500 13px system-ui;">About</button>
          <button id="show-wiki" class="modern-btn" style="padding: 8px 16px; background: transparent; border: 1px solid transparent; border-radius: 6px; color: ${isDarkMode ? '#e0e0e0' : '#334155'}; cursor: pointer; font: 500 13px system-ui;">Wiki</button>
          <button id="import-config" class="modern-btn" style="padding: 8px 16px; background: transparent; border: 1px solid ${isDarkMode ? '#4b5563' : '#cbd5e1'}; border-radius: 6px; color: ${isDarkMode ? '#e0e0e0' : '#334155'}; cursor: pointer; font: 500 13px system-ui;">Import Setup</button>
          <button id="export-config" class="modern-btn" style="padding: 8px 16px; background: transparent; border: 1px solid ${isDarkMode ? '#4b5563' : '#cbd5e1'}; border-radius: 6px; color: ${isDarkMode ? '#e0e0e0' : '#334155'}; cursor: pointer; font: 500 13px system-ui;">Export Setup</button>
        </div>
        <div style="display: flex; gap: 8px;">
          <button id="reset-settings" style="padding: 8px 16px; background: transparent; border: 1px solid transparent; border-radius: 6px; color: #ef4444; cursor: pointer; font: 500 13px system-ui;">Reset Config</button>
          <button id="save-settings" style="padding: 8px 24px; background: ${getTheme().primary}; border: none; border-radius: 6px; color: white; cursor: pointer; font: 600 13px system-ui; box-shadow: 0 4px 6px ${getTheme().primary}40;">Save Parameters & Reload</button>
        </div>
      </div>
    `;

    // Initialize Sidebar Navigation
    setTimeout(() => {
      const navItems = panel.querySelectorAll('.setting-nav-item');
      const sections = panel.querySelectorAll('.settings-panel-section');
      navItems.forEach(item => {
        item.addEventListener('click', () => {
          navItems.forEach(n => n.classList.remove('active'));
          sections.forEach(s => s.style.display = 'none');
          item.classList.add('active');
          const targetId = item.getAttribute('data-target');
          if (panel.querySelector('#' + targetId)) {
            panel.querySelector('#' + targetId).style.display = 'block';
          }
        });
      });
    }, 10);

    // Event listeners
    panel.querySelector('#close-settings').addEventListener('click', hideSettingsPanel);
    panel.querySelector('#reset-settings').addEventListener('click', resetSettings);
    panel.querySelector('#save-settings').addEventListener('click', saveSettings);
    panel.querySelector('#test-jdownloader').addEventListener('click', testJDownloaderFromSettings);

    // History buttons
    panel.querySelector('#view-history').addEventListener('click', showHistoryDialog);
    panel.querySelector('#export-history').addEventListener('click', () => DownloadHistory.export());
    panel.querySelector('#clear-history').addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all download history? This cannot be undone.')) {
        DownloadHistory.clear();
      }
    });

    // Export/Import config
    panel.querySelector('#export-config').addEventListener('click', exportConfiguration);
    panel.querySelector('#import-config').addEventListener('click', importConfiguration);

    // About/Wiki buttons
    panel.querySelector('#show-about').addEventListener('click', showAboutDialog);
    panel.querySelector('#show-wiki').addEventListener('click', showWikiDialog);

    // NEW v6.55: Quality preset buttons
    const qualityPresets = panel.querySelectorAll('.quality-preset');
    qualityPresets.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const quality = e.target.getAttribute('data-quality');

        // Update active state
        qualityPresets.forEach(b => {
          b.classList.remove('active');
          b.style.background = getComputedStyle(panel).getPropertyValue('background-color') === 'rgb(42, 42, 42)' ? '#2a2a2a' : 'white';
          b.style.color = getComputedStyle(panel).getPropertyValue('background-color') === 'rgb(42, 42, 42)' ? '#e0e0e0' : '#1f2937';
        });

        e.target.classList.add('active');
        e.target.style.background = getTheme().primary;
        e.target.style.color = 'white';

        updateFilterPreview();
      });
    });

    // NEW v6.55: File size sliders sync with inputs
    const sizeMinInput = panel.querySelector('#filter-size-min');
    const sizeMaxInput = panel.querySelector('#filter-size-max');
    const sizeMinSlider = panel.querySelector('#filter-size-slider-min');
    const sizeMaxSlider = panel.querySelector('#filter-size-slider-max');
    const sizeRangeDisplay = panel.querySelector('#size-range-display');

    const updateSizeDisplay = () => {
      const min = parseFloat(sizeMinInput.value) || 0;
      const max = parseFloat(sizeMaxInput.value);
      sizeRangeDisplay.textContent = `${min.toFixed(1)} - ${max ? max.toFixed(1) : '∞'} GB`;
      updateFilterPreview();
    };

    sizeMinInput.addEventListener('input', (e) => {
      sizeMinSlider.value = e.target.value;
      updateSizeDisplay();
    });

    sizeMaxInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val) {
        sizeMaxSlider.value = val;
      }
      updateSizeDisplay();
    });

    sizeMinSlider.addEventListener('input', (e) => {
      sizeMinInput.value = e.target.value;
      updateSizeDisplay();
    });

    sizeMaxSlider.addEventListener('input', (e) => {
      sizeMaxInput.value = e.target.value;
      updateSizeDisplay();
    });

    // NEW v6.55: Filter preview update
    const updateFilterPreview = () => {
      const previewEl = panel.querySelector('#filter-preview');
      const activeQuality = panel.querySelector('.quality-preset.active')?.getAttribute('data-quality');
      const minSize = parseFloat(sizeMinInput.value);
      const maxSize = parseFloat(sizeMaxInput.value);
      const excludeExtras = panel.querySelector('#filter-exclude-extras').checked;

      const filters = [];
      if (activeQuality && activeQuality !== '') {
        filters.push(activeQuality === '720p' ? 'HD+' : activeQuality === '1080p' ? 'Full HD+' : '4K only');
      }
      if (minSize > 0) {
        filters.push(`≥${minSize}GB`);
      }
      if (maxSize > 0 && maxSize < 20) {
        filters.push(`≤${maxSize}GB`);
      }
      if (excludeExtras) {
        filters.push('No extras');
      }

      if (previewEl) {
        if (filters.length > 0) {
          previewEl.textContent = filters.join(' • ');
        } else {
          previewEl.textContent = 'No filters active';
        }
      }
    };

    // Add change listeners to update preview
    panel.querySelector('#filter-exclude-extras').addEventListener('change', updateFilterPreview);

    // Initialize preview
    updateFilterPreview();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        hideSettingsPanel();
      }
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    settingsPanel = overlay;
  }

  function hideSettingsPanel() {
    if (settingsPanel) {
      settingsPanel.style.animation = 'fadeIn 0.2s ease reverse';
      setTimeout(() => {
        if (settingsPanel) {
          settingsPanel.remove();
          settingsPanel = null;
        }
      }, 200);
    }
  }

  async function testJDownloaderFromSettings() {
    const testBtn = document.getElementById('test-jdownloader');
    const portInput = document.getElementById('jdownloader-port');

    if (!testBtn || !portInput) return;

    const originalText = testBtn.innerHTML;
    testBtn.disabled = true;
    testBtn.innerHTML = `${Icons.download} Testing...`;

    try {
      const port = parseInt(portInput.value) || CONFIG.jdownloader.defaultPort;
      const isConnected = await testJDownloaderConnection(port);

      if (isConnected) {
        testBtn.innerHTML = `${Icons.check} Connected!`;
        testBtn.style.borderColor = '#10b981';
        testBtn.style.color = '#10b981';
        showNotification('JDownloader connection successful!', 'success', 2000);
      } else {
        throw new Error('Connection failed');
      }
    } catch (error) {
      testBtn.innerHTML = `${Icons.alert} Failed`;
      testBtn.style.borderColor = '#ef4444';
      testBtn.style.color = '#ef4444';
      showNotification('JDownloader connection failed. Make sure it\'s running with FlashGot extension enabled.', 'error', 4000);
    }

    setTimeout(() => {
      testBtn.disabled = false;
      testBtn.innerHTML = originalText;
      testBtn.style.borderColor = getTheme().primary;
      testBtn.style.color = getTheme().primary;
    }, 2000);
  }

  function saveSettings() {
    if (!settingsPanel) return;

    // Show loading state
    const saveBtn = settingsPanel.querySelector('#save-settings');
    if (saveBtn) {
      const originalText = saveBtn.innerHTML;
      saveBtn.disabled = true;
      saveBtn.innerHTML = `${Icons.download} Saving...`;

      // Use setTimeout to ensure UI updates
      setTimeout(() => {
        try {
          const buttonPosition = settingsPanel.querySelector('#button-position').value;
          const outputFormat = settingsPanel.querySelector('#output-format').value;
          const theme = settingsPanel.querySelector('#theme').value;
          const darkMode = settingsPanel.querySelector('#dark-mode').checked;
          const compactMode = settingsPanel.querySelector('#compact-mode').checked;
          const batchSize = parseInt(settingsPanel.querySelector('#batch-size').value);
          const showProgress = settingsPanel.querySelector('#show-progress').checked;
          const autoConfirm = settingsPanel.querySelector('#auto-confirm').checked;
          const jdownloaderEnabled = settingsPanel.querySelector('#jdownloader-enabled').checked;
          const jdownloaderPort = parseInt(settingsPanel.querySelector('#jdownloader-port').value);
          const jdownloaderAutoDetect = settingsPanel.querySelector('#jdownloader-auto-detect').checked;

          // New settings
          const enableHistory = settingsPanel.querySelector('#enable-history').checked;
          const skipDownloaded = settingsPanel.querySelector('#skip-downloaded').checked;
          const enableRateLimit = settingsPanel.querySelector('#enable-rate-limit').checked;
          const debugMode = settingsPanel.querySelector('#debug-mode').checked;
          const concurrentDownloads = parseInt(settingsPanel.querySelector('#concurrent-downloads').value) || 2;

          // NEW v6.55: Enhanced filter options
          const filterQuality = settingsPanel.querySelector('.quality-preset.active')?.getAttribute('data-quality') || null;
          const filterSizeMin = parseFloat(settingsPanel.querySelector('#filter-size-min').value) || null;
          const filterSizeMax = parseFloat(settingsPanel.querySelector('#filter-size-max').value) || null;
          const filterExcludeExtras = settingsPanel.querySelector('#filter-exclude-extras').checked;

          // NEW v6.58: Filename Templates
          const filenameTemplateEpisode = settingsPanel.querySelector('#filename-template-episode').value;
          const filenameTemplateMovie = settingsPanel.querySelector('#filename-template-movie').value;

          Settings.set('buttonPosition', buttonPosition);
          Settings.set('outputFormat', outputFormat);
          Settings.set('theme', theme);
          Settings.set('darkMode', darkMode);
          Settings.set('compactMode', compactMode);
          Settings.set('batchSize', Math.max(10, Math.min(200, batchSize)));
          Settings.set('showProgress', showProgress);
          Settings.set('autoConfirm', autoConfirm);
          Settings.set('jdownloaderEnabled', jdownloaderEnabled);
          Settings.set('jdownloaderPort', Math.max(1, Math.min(65535, jdownloaderPort || CONFIG.jdownloader.defaultPort)));

          // Save Templates
          if (filenameTemplateEpisode) Settings.set('filenameTemplateEpisode', filenameTemplateEpisode);
          if (filenameTemplateMovie) Settings.set('filenameTemplateMovie', filenameTemplateMovie);

          // NEW v6.59: Save Subtitle Settings
          const dlExternalSubtitles = settingsPanel.querySelector('#dl-external-subtitles').checked;

          // Collect checked languages
          const checkedLangs = Array.from(settingsPanel.querySelectorAll('#subtitle-language-container input:checked'))
            .map(cb => cb.value)
            .join(',');

          Settings.set('subtitleLanguages', checkedLangs);

          // Handle auto-detect toggle
          const wasAutoDetectEnabled = Settings.get('enableJDownloaderAutoDetect');
          Settings.set('enableJDownloaderAutoDetect', jdownloaderAutoDetect);

          if (jdownloaderAutoDetect && !wasAutoDetectEnabled) {
            // Just enabled - start detection
            startJDownloaderDetection();
          } else if (!jdownloaderAutoDetect && wasAutoDetectEnabled) {
            // Just disabled - stop detection
            stopJDownloaderDetection();
          }

          // Save new settings
          Settings.set('enableHistory', enableHistory);
          Settings.set('skipDownloaded', skipDownloaded);
          Settings.set('enableRateLimit', enableRateLimit);
          Settings.set('debugMode', debugMode);
          Settings.set('concurrentDownloads', Math.max(1, Math.min(5, concurrentDownloads))); // NEW v6.54: Save concurrent downloads

          Settings.set('filterOptions', {
            minQuality: filterQuality,
            minFileSize: filterSizeMin,
            maxFileSize: filterSizeMax,
            excludeExtras: filterExcludeExtras,
            excludeSubtitles: false,
            includeTypes: ['Movie', 'Episode', 'Video', 'Audio']
          });

          // Update rate limiter
          CONFIG.rateLimit.enabled = enableRateLimit;

          // Update CONFIG with new batch size
          CONFIG.batchSize = Settings.get('batchSize');

          // Apply dark mode immediately
          applyDarkMode();

          hideSettingsPanel();

          // Recreate UI with new settings
          cleanup();
          setTimeout(createButton, 100);

          showNotification('Settings saved successfully!', 'success', 2000);
        } catch (error) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = originalText;
          showNotification(`Error saving settings: ${error.message}`, 'error', 3000);
        }
      }, 50);
    }
  }

  function resetSettings() {
    Object.entries(Settings.defaults).forEach(([key, value]) => {
      Settings.set(key, value);
    });

    applyDarkMode();
    hideSettingsPanel();
    cleanup();
    setTimeout(createButton, 100);

    showNotification('Settings reset to defaults', 'info', 2000);
  }

  function exportConfiguration() {
    const config = {
      version: '5.0',
      exported: new Date().toISOString(),
      settings: Settings.getAll(),
      history: DownloadHistory.getAll()
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `emby-downloader-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showNotification('Configuration exported successfully!', 'success', 2000);
  }

  function importConfiguration() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const config = JSON.parse(text);

        // Validate format
        if (!config.version || !config.settings) {
          throw new Error('Invalid configuration file format');
        }

        // Import settings
        Object.entries(config.settings).forEach(([key, value]) => {
          Settings.set(key, value);
        });

        // Import history if present
        if (config.history && Object.keys(config.history).length > 0) {
          const shouldImportHistory = confirm(
            `Import ${Object.keys(config.history).length} history entries?\n\nThis will merge with your existing history.`
          );
          if (shouldImportHistory) {
            DownloadHistory.import(JSON.stringify(config.history));
          }
        }

        showNotification('Configuration imported successfully! Refreshing...', 'success', 2000);

        // Refresh UI
        hideSettingsPanel();
        cleanup();
        setTimeout(() => {
          createButton();
          showNotification('Configuration applied!', 'success', 2000);
        }, 500);

      } catch (error) {
        console.error('Import failed:', error);
        showNotification(`Import failed: ${error.message}`, 'error', 4000);
      }
    });

    input.click();
  }

  function showAboutDialog() {
    const isDarkMode = Settings.get('darkMode');

    const overlay = document.createElement('div');
    overlay.id = 'about-overlay';
    overlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.7);
                        z-index: 2147483650;
                        display: flex;
      align-items: center;
      justify-content: center;
                        backdrop-filter: blur(4px);
                        animation: fadeIn 0.3s ease;
                        `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
                        background: ${isDarkMode ? '#1c1c1c' : 'white'};
                        border-radius: 16px;
                        padding: 24px;
                        max-width: 800px;
                        width: 90%;
                        max-height: 80vh;
                        overflow-y: auto;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        animation: modalSlideIn 0.3s ease;
                        `;

    // Apply dark mode if enabled
    if (isDarkMode) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    dialog.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                          <h3 style="margin: 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 600 20px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <circle cx="12" cy="12" r="10"></circle>
                              <line x1="12" y1="16" x2="12" y2="12"></line>
                              <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                            EmbyGrab v${SCRIPT_VERSION}
                          </h3>
                          <button id="close-about" style="
          background: none;
          border: none;
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer;
          font-size: 24px;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
      align-items: center;
      justify-content: center;
        ">&times;</button>
                        </div>

                        <div style="padding: 20px; background: ${isDarkMode ? 'linear-gradient(135deg, #1a2436 0%, #1e2e44 100%)' : 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)'}; border-radius: 12px; border-left: 4px solid ${isDarkMode ? '#60a5fa' : '#3b82f6'}; margin-bottom: 20px;">
                          <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 20px;">
                            <img src="data:image/png;base64,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" style="width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 6px 16px rgba(0,0,0,0.2);">
                            <h4 style="margin: 0; color: ${isDarkMode ? '#60a5fa' : '#1e40af'}; font: 600 28px system-ui, sans-serif;">About EmbyGrab</h4>
                          </div>
                          <p style="margin: 0 0 12px 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 14px system-ui, sans-serif; line-height: 1.6;">
                            EmbyGrab is the ultimate download manager for Emby media servers. Created for the high seas community,
                            this tool provides powerful features for organizing, managing, and downloading your media library.
                          </p>
                          <div style="color: ${isDarkMode ? '#d1d5db' : '#374151'}; font: 13px system-ui, sans-serif; line-height: 1.5;">
                            <strong>Features:</strong>
                            <ul style="margin: 8px 0; padding-left: 20px;">
                              <li>10+ output formats (URLs, wget, aria2c, curl, JDownloader, and more)</li>
                              <li>Built-in Download Manager with search, bulk actions, and progress tracking</li>
                              <li>JDownloader integration for automatic downloads</li>
                              <li>Keyboard shortcuts for quick access (Ctrl+D, Ctrl+H, Ctrl+S, Escape)</li>
                              <li>Selective downloads with checkboxes and Select All functionality</li>
                              <li>QR codes for mobile transfers</li>
                              <li>Download history tracking with export capability</li>
                              <li>Filter by quality and file size</li>
                              <li>Dark mode with Emby-themed colors</li>
                              <li>Grouped downloads by series/season</li>
                              <li>Stats view for monitoring progress</li>
                            </ul>
                          </div>
                        </div>

                        <div style="padding: 20px; background: ${isDarkMode ? 'linear-gradient(135deg, #2e2a1a 0%, #3a341e 100%)' : 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)'}; border-radius: 12px; border-left: 4px solid ${isDarkMode ? '#fbbf24' : '#f59e0b'}; margin-bottom: 20px;">
                          <h4 style="margin: 0 0 12px 0; color: ${isDarkMode ? '#fbbf24' : '#92400e'}; font: 600 16px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                              <line x1="12" y1="9" x2="12" y2="13"></line>
                              <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
                            Legal Disclaimer
                          </h4>
                          <p style="margin: 0; color: ${isDarkMode ? '#d1d5db' : '#78350f'}; font: 13px system-ui, sans-serif; line-height: 1.6;">
                            <strong>Important:</strong> EmbyGrab is a tool designed to facilitate downloading content from <em>your own</em> Emby server.
                            The developers of EmbyGrab are <strong>NOT responsible</strong> for any illegal downloads, copyright violations, or misuse of this tool.
                          </p>
                          <p style="margin: 12px 0 0 0; color: ${isDarkMode ? '#d1d5db' : '#78350f'}; font: 13px system-ui, sans-serif; line-height: 1.6;">
                            Users are solely responsible for ensuring they have the legal right to download and possess any content.
                            This tool is provided "as-is" for legitimate personal backup and media management purposes only.
                          </p>
                          <p style="margin: 12px 0 0 0; color: ${isDarkMode ? '#fbbf24' : '#92400e'}; font: 13px system-ui, sans-serif; line-height: 1.6;">
                            <strong>We simply provide the means to sail the high seas - where you choose to anchor is your responsibility!</strong>
                          </p>
                        </div>

                        <div style="padding: 16px; background: ${isDarkMode ? '#252525' : '#f9fafb'}; border-radius: 8px; border: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'};">
                          <div style="display: flex; flex-direction: column; gap: 12px; font: 13px system-ui, sans-serif; color: ${isDarkMode ? '#d1d5db' : '#374151'};">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                              <span><strong style="color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};">Version:</strong> ${SCRIPT_VERSION}</span>
                              <span><strong style="color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};">Namespace:</strong> embygrab.manager</span>
                            </div>

                            <div style="padding-top: 12px; border-top: 1px solid ${isDarkMode ? '#404040' : '#e5e7eb'}; display: flex; justify-content: space-between; align-items: center;">
                              <div style="display: flex; flex-direction: column; gap: 4px;">
                                <div style="font-weight: 500;">
                                  Developed by <a href="https://hexadexa.dev" target="_blank" style="color: ${getTheme().primary}; text-decoration: none; font-weight: 600;">Hexadexa</a>
                                </div>
                                <div style="font-size: 12px; opacity: 0.8;">
                                  <a href="mailto:andrei@hexadexa.dev" style="color: inherit; text-decoration: none;">andrei@hexadexa.dev</a>
                                </div>
                              </div>
                              
                              <a href="https://buymeacoffee.com/hexadexa" target="_blank" style="
                                display: inline-flex;
                                align-items: center;
                                gap: 6px;
                                padding: 8px 14px;
                                background-color: ${isDarkMode ? '#1a1a1a' : '#FFDD00'};
                                color: ${isDarkMode ? '#FFDD00' : '#000000'};
                                border: 1px solid ${isDarkMode ? '#404040' : 'transparent'};
                                border-radius: 6px;
                                text-decoration: none;
                                font-family: 'Cookie', cursive, sans-serif;
                                font-weight: 600;
                                font-size: 14px;
                                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                                transition: transform 0.1s ease;
                              " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.216 6.415l-.132-.666c-.119-.596-.385-1.135-.77-1.566-.751-.841-1.803-1.173-2.924-.928-1.123 2.508-6.194 1.34-8.899 3.013-1.373.849-1.928 2.378-2.028 2.659l-.666.132c-.596.119-1.135.385-1.566.77-.841.751-1.173 1.803-.928 2.924.275 1.258 1.408 2.391 2.666 2.666.596.119 1.135-.147 1.566-.532l.279.124c.783.349 1.637.525 2.492.525 3.383 0 6.541-2.73 7.027-6.083l.858.171c.596.119 1.135-.147 1.566-.532.841-.751 1.173-1.803.928-2.924-.136-.622-.472-1.164-.913-1.536zm-17.766 5.86c-.171-.781.057-1.439.52-1.853.208-.186.467-.313.755-.371l.666-.132c.168.799.539 2.057 1.248 2.955l.132.666c.119.596-.147 1.135-.532 1.566-.414.463-1.072.691-1.853.52-1.258-.275-2.391-1.408-2.666-2.666-.118-.54-.083-1.082.096-1.583-.096.347-.193.684-.266 1.018-.073-.628.096-1.218.441-1.701-.441.483-.61 1.073-.537 1.701.073-.334.17-.671.266-1.018zm17.962 1.272c-.171-.781.057-1.439.52-1.853.463-.414 1.072-.691 1.853-.52 1.258.275 2.391 1.408 2.666 2.666.275 1.258-2.391 2.666-2.666 2.666-.781-.171-1.439-.057-1.853-.52-.414-.463-.691-1.072-.52-1.853z" /></svg>
                                Buy me a coffee
                              </a>
                            </div>
                          </div>
                        </div>

                        <div style="margin-top: 20px; text-align: center;">
                          <button id="close-about-bottom" style="
          padding: 10px 24px;
          border: none;
          border-radius: 6px;
          background: ${getTheme().primary};
          color: white;
          cursor: pointer;
          font: 600 14px system-ui, sans-serif;
        ">Close</button>
                        </div>
                        `;

    const closeAbout = () => {
      overlay.remove();
    };

    dialog.querySelector('#close-about').addEventListener('click', closeAbout);
    dialog.querySelector('#close-about-bottom').addEventListener('click', closeAbout);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeAbout();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function showWikiDialog() {
    const isDarkMode = Settings.get('darkMode');

    const overlay = document.createElement('div');
    overlay.id = 'wiki-overlay';
    overlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.7);
                        z-index: 2147483650;
                        display: flex;
      align-items: center;
      justify-content: center;
                        backdrop-filter: blur(4px);
                        animation: fadeIn 0.3s ease;
                        `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
                        background: ${isDarkMode ? '#1c1c1c' : 'white'};
                        border-radius: 16px;
                        padding: 24px;
                        max-width: 900px;
                        width: 90%;
                        max-height: 80vh;
                        overflow-y: auto;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        animation: modalSlideIn 0.3s ease;
                        `;

    // Apply dark mode if enabled
    if (isDarkMode) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    dialog.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                          <h3 style="margin: 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 600 20px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                            </svg>
                            EmbyGrab Wiki & Help
                          </h3>
                          <button id="close-wiki" style="
          background: none;
          border: none;
          color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
          cursor: pointer;
          font-size: 24px;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
      align-items: center;
      justify-content: center;
        ">&times;</button>
                        </div>

                        <style>
                          .wiki-details {margin-bottom: 12px; border-radius: 8px; overflow: hidden; border: 1px solid ${isDarkMode ? '#3a3a3a' : '#e5e7eb'}; }
                          .wiki-summary {padding: 12px 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; background: ${isDarkMode ? 'linear-gradient(135deg, #2a2a2a 0%, #333 100%)' : 'linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%)'}; color: ${isDarkMode ? '#e0e0e0' : '#374151'}; transition: background 0.2s; }
                          .wiki-summary:hover {background: ${isDarkMode ? '#333' : '#e5e7eb'}; }
                          .wiki-content {padding: 16px; background: ${isDarkMode ? '#1a1a1a' : '#ffffff'}; color: ${isDarkMode ? '#d1d5db' : '#4b5563'}; font-size: 13px; line-height: 1.6; border-top: 1px solid ${isDarkMode ? '#3a3a3a' : '#e5e7eb'}; }
                          .wiki-content ul, .wiki-content ol {margin: 0; padding-left: 20px; }
                          .wiki-content li {margin-bottom: 6px; }
                          .wiki-icon {width: 18px; height: 18px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
        /* Remove default marker */
        .wiki-details > summary {list-style: none; }
        .wiki-details > summary::-webkit-details-marker {display: none; }
                          .wiki-chevron {margin-left: auto; transition: transform 0.2s; }
                          .wiki-details[open] .wiki-chevron {transform: rotate(90deg); }
                        </style>

                        <div style="max-height: 500px; overflow-y: auto; padding-right: 8px;">

                          <details class="wiki-details" open>
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                              Quick Start
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <ol>
                                <li>Navigate to a movie, TV show, season, or collection page on your Emby server.</li>
                                <li>Press <strong>Ctrl+D</strong> or click the floating "Get Links" button.</li>
                                <li>Choose your preferred output format or use the built-in Download Manager.</li>
                                <li>Links are automatically generated and copied to your clipboard.</li>
                              </ol>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="11 3 11 11 14 8 17 11 17 3"></polyline></svg>
                              Collection & Whole Server Download
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <p style="margin-top:0;"><strong>Collections:</strong> Navigate to any Collection/BoxSet page. The script will automatically fetch all movies and TV shows within it.</p>
                              <p><strong>Whole Server:</strong> Go to the Emby home page (Home icon). The script will prompt you to scan all libraries, or specific libraries like "Movies" or "TV Shows".</p>
                              <ul>
                                <li>Massively bulk-download entire libraries.</li>
                                <li>Filters (like Quality Presets) are strictly respected.</li>
                                <li><em>Note: Scanning massive libraries may take several minutes.</em></li>
                              </ul>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
                              Bypass Download Restrictions
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <p style="margin-top:0;">If the server administrator has disabled the "Allow media download" permission, EmbyGrab natively bypasses this constraint by reconstructing the stream URLs used for DirectPlay.</p>
                              <ul>
                                <li><strong>Strict Bypass:</strong> This feature is permanently enabled under the hood. It ensures you receive the pristine original file without forced transcoding.</li>
                                <li><strong>Original Filenames:</strong> Bypassing the native download endpoint guarantees that JDownloader and scripts grab the actual media filename rather than a generic stream ID.</li>
                              </ul>
                              <p style="margin-bottom: 0; color: ${isDarkMode ? '#fbbf24' : '#b45309'};"><strong>Disclaimer:</strong> Bypassing constraints set by the server administrator may violate their terms of service. You are solely responsible for ensuring you have permission to download this content.</p>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                              Download Manager Features
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <ul>
                                <li><strong>Concurrent Downloads:</strong> Download 1-5 files simultaneously (configurable).</li>
                                <li><strong>Smart Grouping:</strong> Organizes items by Movie, Series, and Season directories.</li>
                                <li><strong>Selective Downloads:</strong> Group checkboxes allow downloading specific seasons instantly.</li>
                                <li><strong>Search/Filter:</strong> Quickly locate items in massive queues.</li>
                                <li><strong>Persistent State:</strong> Your queue and progress survive page refreshes.</li>
                              </ul>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                              Content Filters & Formats
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <p style="margin-top:0;"><strong>Formats:</strong> Export as Wget script, Aria2, plain text, JSON, cURL, PowerShell, JDownloader, or use the Native Download Manager.</p>
                              <p><strong>Filters:</strong> Accessible via the Settings gear.</p>
                              <ul>
                                <li>Filter by minimum and maximum file size to exclude samples/trailers.</li>
                                <li>Quick preset buttons for Any, HD (720p+), FHD (1080p+), or 4K.</li>
                                <li>Option to exclude "Extras" (behind the scenes, interviews).</li>
                              </ul>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>
                              Subtitles & Templates
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <p style="margin-top:0;"><strong>Subtitles:</strong> Select desired languages in Settings. EmbyGrab will automatically extract internal subtitle tracks natively, or download external subtitles (SRT/ASS/VTT) if available on the server.</p>
                              <p><strong>Naming Templates:</strong> Customize output filenames per type.</p>
                              <ul>
                                <li><strong>Movies:</strong> <code>{Name} ({Year}) - {Quality}</code></li>
                                <li><strong>Episodes:</strong> <code>{ShowName} - S{Season}E{Episode} - {Name}</code></li>
                                <li>Use tags like <code>{Resolution}</code>, <code>{Codec}</code>, or <code>{AudioCodec}</code>.</li>
                              </ul>
                            </div>
                          </details>

                          <details class="wiki-details">
                            <summary class="wiki-summary">
                              <svg class="wiki-icon" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                              Keyboard Shortcuts
                              <svg class="wiki-icon wiki-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            </summary>
                            <div class="wiki-content">
                              <ul>
                                <li><strong>Ctrl+D:</strong> Open EmbyGrab main dialog/Generate links.</li>
                                <li><strong>Ctrl+H:</strong> Open download history.</li>
                                <li><strong>Ctrl+S:</strong> Save settings (when panel is open).</li>
                                <li><strong>Escape:</strong> Close any open dialog or modal.</li>
                              </ul>
                            </div>
                          </details>
                        </div>

                        <div style="margin-top: 20px; text-align: center;">
                          <button id="close-wiki-bottom" style="
          padding: 10px 24px;
          border: none;
          border-radius: 6px;
          background: ${getTheme().primary};
          color: white;
          cursor: pointer;
          font: 600 14px system-ui, sans-serif;
        ">Close</button>
                        </div>
                        `;

    const closeWiki = () => {
      overlay.remove();
    };

    dialog.querySelector('#close-wiki').addEventListener('click', closeWiki);
    dialog.querySelector('#close-wiki-bottom').addEventListener('click', closeWiki);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeWiki();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function showHistoryDialog() {
    const history = DownloadHistory.getAll();
    const stats = DownloadHistory.getStats();
    const entries = Object.entries(history);

    if (entries.length === 0) {
      showNotification('No download history yet', 'info', 2000);
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.7);
                        z-index: 2147483650;
                        display: flex;
      align-items: center;
      justify-content: center;
                        backdrop-filter: blur(4px);
                        animation: fadeIn 0.3s ease;
                        `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
                        background: white;
                        border-radius: 16px;
                        padding: 24px;
                        max-width: 600px;
                        width: 90%;
                        max-height: 80vh;
                        overflow-y: auto;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        animation: modalSlideIn 0.3s ease;
                        `;

    // Apply dark mode if enabled
    if (Settings.get('darkMode')) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    dialog.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                          <h3 style="margin: 0; color: #1f2937; font: 600 18px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                              <polyline points="7 10 12 15 17 10"></polyline>
                              <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                            Download History
                          </h3>
                          <button id="close-history" style="
          background: none;
          border: none;
          color: #6b7280;
          cursor: pointer;
          padding: 4px;
        ">${Icons.close}</button>
                        </div>

                        <div style="
        background: #f9fafb;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      ">
                          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
                            <div>
                              <div style="color: #6b7280; font: 12px system-ui, sans-serif;">Total Items</div>
                              <div style="color: #1f2937; font: 600 20px system-ui, sans-serif;">${stats.total}</div>
                            </div>
                            <div>
                              <div style="color: #6b7280; font: 12px system-ui, sans-serif;">Total Size</div>
                              <div style="color: #1f2937; font: 600 20px system-ui, sans-serif;">${formatFileSize(stats.totalSize)}</div>
                            </div>
                            <div>
                              <div style="color: #6b7280; font: 12px system-ui, sans-serif;">Movies</div>
                              <div style="color: #1f2937; font: 600 16px system-ui, sans-serif;">${stats.movies}</div>
                            </div>
                            <div>
                              <div style="color: #6b7280; font: 12px system-ui, sans-serif;">Episodes</div>
                              <div style="color: #1f2937; font: 600 16px system-ui, sans-serif;">${stats.episodes}</div>
                            </div>
                          </div>
                        </div>

                        <div style="max-height: 400px; overflow-y: auto;">
                          ${entries.slice(0, 100).map(([id, item]) => `
          <div style="
            padding: 8px 12px;
            border-bottom: 1px solid #e5e7eb;
            display: flex;
            justify-content: space-between;
            align-items: center;
          ">
            <div style="flex: 1;">
              <div style="color: #1f2937; font: 14px system-ui, sans-serif;">${item.name}</div>
              <div style="color: #6b7280; font: 12px system-ui, sans-serif;">${item.type} • ${item.date}</div>
            </div>
            ${item.size ? `<div style="color: #6b7280; font: 12px system-ui, sans-serif;">${formatFileSize(item.size)}</div>` : ''}
          </div>
        `).join('')}
                          ${entries.length > 100 ? `
          <div style="padding: 12px; text-align: center; color: #6b7280; font: 12px system-ui, sans-serif;">
            Showing 100 of ${entries.length} items
          </div>
        ` : ''}
                        </div>
                        `;

    dialog.querySelector('#close-history').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function showNotification(message, type = 'info', duration = 4000) {
    document.querySelectorAll('.emby-dl-notification').forEach(n => n.remove());

    const notification = document.createElement('div');
    notification.className = 'emby-dl-notification';

    const colors = {
      success: '#10b981',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };

    const icons = {
      success: Icons.check,
      error: Icons.alert,
      warning: Icons.alert,
      info: Icons.download
    };

    notification.style.cssText = `
                        position: fixed;
                        top: 20px;
                        right: 20px;
                        z-index: 2147483650;
                        padding: 12px 16px;
                        border-radius: 8px;
                        color: white;
                        background: ${colors[type] || colors.info};
                        font: 14px system-ui, sans-serif;
                        max-width: 350px;
                        word-wrap: break-word;
                        box-shadow: 0 8px 25px rgba(0,0,0,0.2);
                        transform: translateX(100%);
                        opacity: 0;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        cursor: pointer;
                        `;

    notification.innerHTML = `${icons[type] || icons.info} ${message}`;
    document.body.appendChild(notification);

    requestAnimationFrame(() => {
      notification.style.transform = 'translateX(0)';
      notification.style.opacity = '1';
    });

    setTimeout(() => {
      notification.style.transform = 'translateX(100%)';
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), 300);
    }, duration);
  }

  function showConfirmDialog(title, details, items, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.7);
                        z-index: 2147483649;
                        display: flex;
      align-items: center;
      justify-content: center;
                        backdrop-filter: blur(4px);
                        animation: fadeIn 0.3s ease;
                        `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
                        background: white;
                        border-radius: 16px;
                        padding: 24px;
                        max-width: 500px;
                        width: 90%;
                        max-height: 70vh;
                        overflow-y: auto;
                        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                        animation: modalSlideIn 0.3s ease;
                        `;

    // Apply dark mode if enabled
    if (Settings.get('darkMode')) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    // Calculate file size information
    const sizeInfo = calculateTotalSize(items || []);
    const sizeDetails = [];

    if (sizeInfo.totalSize > 0) {
      sizeDetails.push(`Total size: ${formatFileSize(sizeInfo.totalSize)}${sizeInfo.hasEstimates ? ' (estimated)' : ''}`);
      if (sizeInfo.itemsWithSize < items.length) {
        sizeDetails.push(`${sizeInfo.itemsWithSize}/${items.length} items have size information`);
      }
    } else {
      sizeDetails.push(`Size information not available`);
    }

    dialog.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                          <div style="
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: ${getTheme().primary}20;
          display: flex;
      align-items: center;
      justify-content: center;
          color: ${getTheme().primary};
        ">
                            ${Icons.download}
                          </div>
                          <h3 style="
          margin: 0;
          color: #1f2937;
          font: 600 18px system-ui, sans-serif;
        ">${title}</h3>
                        </div>

                        <div style="
        background: #f9fafb;
        border-radius: 8px;
        padding: 16px;
        margin: 16px 0;
        border-left: 4px solid ${getTheme().primary};
      ">
                          ${details.concat(sizeDetails).map(detail => `
          <div style="
            color: #374151;
            font: 14px system-ui, sans-serif;
            margin: 4px 0;
            display: flex;
            align-items: center;
            gap: 8px;
          ">
            <span style="
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: ${getTheme().primary};
            "></span>
            ${detail}
          </div>
        `).join('')}
                        </div>

                        <div style="
        padding: 12px;
        background: #fef3c7;
        border-radius: 6px;
        margin: 16px 0;
        border-left: 3px solid #f59e0b;
      ">
                          <div style="
          color: #92400e;
          font: 13px system-ui, sans-serif;
          display: flex;
          align-items: center;
          gap: 6px;
        ">
                            ${Icons.alert}
                            This may take a while and generate a very long list of links.
                          </div>
                        </div>

                        <div style="
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        margin-top: 24px;
      ">
                          <button id="confirm-cancel" style="
          padding: 10px 20px;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          background: white;
          color: #374151;
          cursor: pointer;
          font: 500 14px system-ui, sans-serif;
          transition: all 0.2s ease;
        ">Cancel</button>
                          <button id="confirm-proceed" style="
          padding: 10px 20px;
          border: none;
          border-radius: 6px;
          background: ${getTheme().primary};
          color: white;
          cursor: pointer;
          font: 500 14px system-ui, sans-serif;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 6px;
        ">
                            ${Icons.download}
                            Continue
                          </button>
                        </div>
                        `;

    const cleanup = () => {
      overlay.style.animation = 'fadeIn 0.2s ease reverse';
      setTimeout(() => overlay.remove(), 200);
    };

    dialog.querySelector('#confirm-cancel').addEventListener('click', () => {
      cleanup();
      onCancel?.();
    });

    dialog.querySelector('#confirm-proceed').addEventListener('click', () => {
      cleanup();
      onConfirm?.();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        onCancel?.();
      }
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    setTimeout(() => dialog.querySelector('#confirm-proceed').focus(), 100);
  }

  // NEW v1.0: Options dialog for whole server download
  function showServerDownloadOptionsDialog(libraries, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.8);
                        z-index: 2147483650;
                        display: flex;
      align-items: center;
      justify-content: center;
                        backdrop-filter: blur(5px);
                        animation: fadeIn 0.3s ease;
                        `;

    const isDark = Settings.get('darkMode');
    const dialog = document.createElement('div');
    dialog.style.cssText = `
                        background: ${isDark ? '#1c1c1c' : 'white'};
                        border-radius: 16px;
                        padding: 24px;
                        max-width: 600px;
                        width: 90%;
                        max-height: 85vh;
                        overflow-y: auto;
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                        animation: modalSlideIn 0.3s ease;
                        color: ${isDark ? '#e0e0e0' : '#1f2937'};
                        `;

    if (isDark) {
      dialog.setAttribute('data-dark-mode', 'true');
    }

    // Group libraries by type
    const librariesByType = libraries.reduce((acc, lib) => {
      const type = lib.CollectionType || 'other';
      if (!acc[type]) acc[type] = [];
      acc[type].push(lib);
      return acc;
    }, {});

    const typeLabels = {
      'movies': 'Movies',
      'tvshows': 'TV Shows',
      'music': 'Music',
      'homevideos': 'Home Videos',
      'boxsets': 'Collections',
      'other': 'Other'
    };

    let librariesHtml = '';
    Object.entries(librariesByType).forEach(([type, libs]) => {
      if (libs.length === 0) return;

      librariesHtml += `
                        <div style="margin-bottom: 16px;">
                          <h4 style="
            margin: 0 0 8px 0; 
            font-size: 14px; 
            text-transform: uppercase; 
            letter-spacing: 0.05em; 
            color: ${isDark ? '#9ca3af' : '#6b7280'};
          ">${typeLabels[type] || type}</h4>
                          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px;">
                            ${libs.map(lib => `
              <label style="
                display: flex; 
                align-items: center; 
                gap: 8px; 
                padding: 8px; 
                background: ${isDark ? '#2a2a2a' : '#f3f4f6'}; 
                border-radius: 6px; 
                cursor: pointer;
                transition: background 0.2s;
              " onmouseover="this.style.background='${isDark ? '#374151' : '#e5e7eb'}'" 
                onmouseout="this.style.background='${isDark ? '#2a2a2a' : '#f3f4f6'}'">
                <input type="checkbox" class="lib-checkbox" value="${lib.Id}" checked style="accent-color: ${getTheme().primary};">
                <span style="font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${lib.Name}</span>
              </label>
            `).join('')}
                          </div>
                        </div>
                        `;
    });

    dialog.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px; border-bottom: 1px solid ${isDark ? '#333' : '#e5e7eb'}; padding-bottom: 16px;">
                          <div style="width: 48px; height: 48px; border-radius: 12px; background: ${getTheme().primary}20; display: flex;
      align-items: center;
      justify-content: center; color: ${getTheme().primary};">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                              <polyline points="7 10 12 15 17 10"></polyline>
                              <line x1="12" y1="15" x2="12" y2="3"></line>
                            </svg>
                          </div>
                          <div>
                            <h3 style="margin: 0; font-size: 20px; font-weight: 600;">Download Whole Server</h3>
                            <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.7;">Select libraries and configure download options</p>
                          </div>
                        </div>

                        <div style="margin-bottom: 24px;">
                          ${librariesHtml}
                        </div>

                        <div style="background: ${isDark ? '#2a2a2a' : '#f9fafb'}; padding: 16px; border-radius: 8px; margin-bottom: 24px; border: 1px solid ${isDark ? '#374151' : '#e5e7eb'};">
                          <h4 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600;">Advanced Options</h4>

                          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                            <div>
                              <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500;">Request Delay (Rate Limit)</label>
                              <select id="server-dl-delay" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid ${isDark ? '#4b5563' : '#d1d5db'}; background: ${isDark ? '#1c1c1c' : 'white'}; color: inherit;">
                                <option value="0">Fast (No delay)</option>
                                <option value="500" selected>Normal (500ms)</option>
                                <option value="2000">Safe (2s - Avoid Bans)</option>
                                <option value="5000">Extra Safe (5s)</option>
                              </select>
                            </div>
                            <div>
                              <label style="display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500;">Item Limit</label>
                              <input type="number" id="server-dl-limit" value="${CONFIG.maxServerItems}" min="100" max="1000000" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid ${isDark ? '#4b5563' : '#d1d5db'}; background: ${isDark ? '#1c1c1c' : 'white'}; color: inherit;">
                            </div>
                          </div>

                          <div style="display: flex; gap: 24px;">
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                              <input type="checkbox" id="server-dl-skip-watched" style="accent-color: ${getTheme().primary}; width: 16px; height: 16px;">
                                <span style="font-size: 13px;">Skip Watched Content</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                              <input type="checkbox" id="server-dl-videos-only" checked style="accent-color: ${getTheme().primary}; width: 16px; height: 16px;">
                                <span style="font-size: 13px;">Videos Only (Skip Music/Photos)</span>
                            </label>
                          </div>
                        </div>

                        <div style="padding: 12px; background: ${isDark ? '#3d2800' : '#fffbeb'}; border-radius: 6px; border-left: 4px solid #f59e0b; margin-bottom: 24px; font-size: 13px; color: ${isDark ? '#fbbf24' : '#92400e'}; display: flex; gap: 10px;">
                          ${Icons.alert}
                          <div>
                            <strong>Warning:</strong> This process will crawl your server and may take a long time.
                            Using 'Fast' mode on a remote server may result in a temporary IP ban.
                          </div>
                        </div>

                        <div style="display: flex; justify-content: flex-end; gap: 12px;">
                          <button id="server-dl-cancel" style="padding: 10px 20px; border: 1px solid ${isDark ? '#4b5563' : '#d1d5db'}; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; font-weight: 500;">Cancel</button>
                          <button id="server-dl-start" style="padding: 10px 24px; border: none; border-radius: 8px; background: ${getTheme().primary}; color: white; cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                            ${Icons.download} Start Download
                          </button>
                        </div>
                        `;

    const cleanup = () => {
      overlay.style.animation = 'fadeIn 0.2s ease reverse';
      setTimeout(() => overlay.remove(), 200);
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        onCancel?.();
      }
    });

    dialog.querySelector('#server-dl-cancel').addEventListener('click', () => {
      cleanup();
      onCancel?.();
    });

    dialog.querySelector('#server-dl-start').addEventListener('click', () => {
      const selectedLibIds = Array.from(dialog.querySelectorAll('.lib-checkbox:checked')).map(cb => cb.value);
      const options = {
        delay: parseInt(dialog.querySelector('#server-dl-delay').value),
        limit: parseInt(dialog.querySelector('#server-dl-limit').value),
        skipWatched: dialog.querySelector('#server-dl-skip-watched').checked,
        videosOnly: dialog.querySelector('#server-dl-videos-only').checked
      };

      if (selectedLibIds.length === 0) {
        alert('Please select at least one library.');
        return;
      }

      cleanup();
      onConfirm?.(selectedLibIds, options);
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // NEW v1.0: Helper to inject filename directly into the directplay URL for universal bypass mapping.
  // This guarantees that ANY client (curl, wget, email links, IDM) downloading the raw link 
  // will receive the correctly routed bypass stream natively stamped with the right filename.
  function getFullBypassUrl(item, server, token) {
    const info = buildDownloadInfo(item, server, token);
    const url = constructDownloadUrl(item, server, token);

    // Safety check - if we have no stream ext suffix, return raw url
    if (!url.includes('/stream.')) return url;

    // Emby directplay bypass trick: /stream.ext -> /the_actual_filename.ext
    const encodedName = encodeURIComponent(info.filename).replace(/%2F/g, '/');
    return url.replace(/\/stream\.([^?]+)/, `/${encodedName}`);
  }

  // ---------- Output Formatters ----------
  const OutputFormatters = {
    links: (items, server, token) => {
      return items.filter(item => item && item.Id).map(item => getFullBypassUrl(item, server, token)).join('\n');
    },

    wget: (items, server, token) => {
      const lines = [
        '#!/bin/bash',
        '# Emby Download Script',
        `# Generated: ${new Date().toISOString()}`,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a Wget script designed to download your Emby files.',
        '# Open a Terminal (Mac/Linux) or a Git Bash/WSL window (Windows).',
        '# Navigate to the folder where you want to save the files (e.g., `cd ~/Downloads`).',
        '# Paste this entire text block into the terminal and press Enter.',
        '# ==========================================================================',
        ''
      ];
      lines.push(...items.filter(item => item && item.Id).map(item => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        // Properly escape paths with single quotes
        const escapedPath = downloadInfo.fullPath.replace(/'/g, "'\\''");
        return `wget -O '${escapedPath}' "${url}"`;
      }));
      return lines.join('\n');
    },

    aria2: (items, server, token) => {
      const lines = [
        '# Emby Download Script (Aria2c)',
        `# Generated: ${new Date().toISOString()}`,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# Save this copied text into a new file named `downloads.txt`.',
        '# Open a terminal where `downloads.txt` is located and run:',
        '#   aria2c -i downloads.txt',
        '# ==========================================================================',
        ''
      ];

      const payload = items.map(item => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        return `${url}\n  out=${downloadInfo.fullPath}`;
      });

      lines.push(...payload);
      return lines.join('\n');
    },

    json: (items, server, token) => {
      const data = {
        generated: new Date().toISOString(),
        server: server,
        total: items.length,
        items: items.map(item => {
          const downloadInfo = buildDownloadInfo(item, server, token);
          return {
            id: item.Id,
            name: item.Name,
            type: item.Type,
            url: getFullBypassUrl(item, server, token),
            filename: downloadInfo.filename,
            folderPath: downloadInfo.folderPath,
            fullPath: downloadInfo.fullPath,
            seriesName: item.SeriesName,
            seasonName: item.SeasonName,
            indexNumber: item.IndexNumber,
            parentIndexNumber: item.ParentIndexNumber
          };
        })
      };
      return JSON.stringify(data, null, 2);
    },

    powershell: (items, server, token) => {
      const lines = [
        '# Emby Download Script (PowerShell)',
        `# Generated: ${new Date().toISOString()}`,
        '# Total items: ' + items.length,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a PowerShell script to download your Emby files.',
        '# Open Windows PowerShell as Administrator.',
        '# Navigate to the folder where you want to save the files (e.g., `cd ~/Downloads`).',
        '# Right-click to paste this entire text block and press Enter.',
        '# ==========================================================================',
        '',
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "Continue"',
        '',
        'function Download-EmbyItem {',
        '    param([string]$Url, [string]$OutFile)',
        '    $dir = Split-Path -Parent $OutFile',
        '    if ($dir -and !(Test-Path $dir)) {',
        '        New-Item -ItemType Directory -Path $dir -Force | Out-Null',
        '    }',
        '    Write-Host "Downloading: $OutFile"',
        '    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing',
        '}',
        '',
        'Write-Host "Starting download of ' + items.length + ' items..."',
        ''
      ];

      items.filter(item => item && item.Id).forEach((item, index) => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        const escapedPath = downloadInfo.fullPath.replace(/'/g, "''");
        lines.push(`Write-Progress -Activity "Downloading" -Status "${index + 1}/${items.length}" -PercentComplete ${Math.round(((index + 1) / items.length) * 100)}`);
        lines.push(`Download-EmbyItem -Url "${url}" -OutFile '${escapedPath}'`);
        lines.push('');
      });

      lines.push('Write-Host "Download complete!"');
      return lines.join('\n');
    },

    python: (items, server, token) => {
      const lines = [
        '#!/usr/bin/env python3',
        '"""Emby Download Script"""',
        `# Generated: ${new Date().toISOString()}`,
        '# Total items: ' + items.length,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# Save this copied text into a new file named `download.py`.',
        '# Open a terminal where `download.py` is located and run:',
        '#   python3 download.py',
        '# ==========================================================================',
        '',
        'import os',
        'import sys',
        'import urllib.request',
        'from pathlib import Path',
        '',
        'def download_file(url, filepath):',
        '    """Download file with progress bar"""',
        '    directory = os.path.dirname(filepath)',
        '    if directory:',
        '        Path(directory).mkdir(parents=True, exist_ok=True)',
        '    ',
        '    print(f"Downloading: {filepath}")',
        '    ',
        '    def progress_hook(count, block_size, total_size):',
        '        percent = int(count * block_size * 100 / total_size)',
        '        sys.stdout.write(f"\\rProgress: {percent}%")',
        '        sys.stdout.flush()',
        '    ',
        '    try:',
        '        urllib.request.urlretrieve(url, filepath, progress_hook)',
        '        print()  # New line after progress',
        '        return True',
        '    except Exception as e:',
        '        print(f"\\nError: {e}")',
        '        return False',
        '',
        'def main():',
        '    downloads = [',
      ];

      items.filter(item => item && item.Id).forEach(item => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        const escapedPath = downloadInfo.fullPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`        ("${url}", "${escapedPath}"),`);
      });

      lines.push('    ]');
      lines.push('    ');
      lines.push('    print(f"Starting download of {len(downloads)} items...")');
      lines.push('    success = 0');
      lines.push('    ');
      lines.push('    for i, (url, filepath) in enumerate(downloads, 1):');
      lines.push('        print(f"\\n[{i}/{len(downloads)}]")');
      lines.push('        if download_file(url, filepath):');
      lines.push('            success += 1');
      lines.push('    ');
      lines.push('    print(f"\\nDownload complete! {success}/{len(downloads)} successful")');
      lines.push('');
      lines.push('if __name__ == "__main__":');
      lines.push('    main()');

      return lines.join('\n');
    },

    curl: (items, server, token) => {
      const lines = [
        '#!/bin/bash',
        '# Emby Download Script (cURL)',
        `# Generated: ${new Date().toISOString()}`,
        '# Total items: ' + items.length,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a Bash script designed to download your Emby files.',
        '# Open a Terminal (Mac/Linux) or a Git Bash/WSL window (Windows).',
        '# Navigate to the folder where you want to save the files (e.g., `cd ~/Downloads`).',
        '# Paste this entire text block into the terminal and press Enter.',
        '# ==========================================================================',
        '',
        'set -e',
        '',
        'download_file() {',
        '    local url=$1',
        '    local filepath=$2',
        '    local dir=$(dirname "$filepath")',
        '    ',
        '    [ ! -d "$dir" ] && mkdir -p "$dir"',
        '    ',
        '    echo "Downloading: $filepath"',
        '    curl -# -L -o "$filepath" "$url"',
        '}',
        '',
        'echo "Starting download of ' + items.length + ' items..."',
        ''
      ];

      items.filter(item => item && item.Id).forEach(item => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        const escapedPath = downloadInfo.fullPath.replace(/'/g, "'\\''");
        lines.push(`download_file "${url}" '${escapedPath}'`);
      });

      lines.push('');
      lines.push('echo "Download complete!"');
      return lines.join('\n');
    },

    idm: (items, server, token) => {
      // IDM (Internet Download Manager) format
      const lines = [
        '<',
        `# Emby Downloads - Generated ${new Date().toISOString()}`,
        `# Total items: ${items.length}`,
        ''
      ];

      items.filter(item => item && item.Id).forEach(item => {
        const url = getFullBypassUrl(item, server, token);
        const downloadInfo = buildDownloadInfo(item, server, token);
        // IDM format: URL, save path, referrer (optional), cookie (optional)
        lines.push(url);
        lines.push(`localpath=${downloadInfo.fullPath}`);
        lines.push('');
      });

      return lines.join('\n');
    },

    qrcode: (items, server, token) => {
      // Generate data for QR code - returns JSON that can be encoded
      const urls = items.filter(item => item && item.Id)
        .map(item => getFullBypassUrl(item, server, token));

      return JSON.stringify({
        type: 'emby-downloads',
        generated: new Date().toISOString(),
        total: urls.length,
        urls: urls
      });
    },

    email: (items, server, token) => {
      // Generate mailto: link with download links in body
      const urls = items.filter(item => item && item.Id)
        .map(item => getFullBypassUrl(item, server, token));

      const subject = encodeURIComponent(`Emby Downloads (${items.length} items)`);
      const body = encodeURIComponent(
        `Emby Download Links\n` +
        `Generated: ${new Date().toISOString()}\n` +
        `Total: ${items.length} items\n\n` +
        urls.join('\n')
      );

      return `mailto:?subject=${subject}&body=${body}`;
    }
  };

  // ---------- Server-Wide Download Functions ----------
  async function fetchAllLibraries(server, token) {
    const url = `${server}/emby/Library/MediaFolders?api_key=${token}`;
    const data = await fetchWithRetry(url);
    return data.Items || [];
  }

  async function processLibrary(server, token, libraryId, libraryName, requestDelay = 0, skipWatched = false, videosOnly = false) {
    console.log(`[Library] Processing library: ${libraryName} (${libraryId})`);
    updateProgress(0, 0, `Scanning library: ${libraryName}...`);

    const allItems = [];

    try {
      // Get all items in the library
      // Pass filtering options to fetchAllFolderItems
      const libraryItems = await fetchAllFolderItems(server, token, libraryId,
        (current, total, status) => {
          updateProgress(current, total, `${libraryName}: ${status}`);
        },
        { delay: requestDelay, skipWatched }
      );

      console.log(`[Library] Found ${libraryItems.length} items in ${libraryName}`);

      // Process each item based on type
      for (let i = 0; i < libraryItems.length; i++) {
        if (abortController?.signal.aborted) break;

        const item = libraryItems[i];

        // Filter by Videos Only
        if (videosOnly) {
          const nonVideoTypes = ['Audio', 'MusicAlbum', 'MusicArtist', 'Photo', 'Book', 'Folder'];
          if (nonVideoTypes.includes(item.Type) && item.MediaType !== 'Video') {
            continue;
          }
        }

        updateProgress(i + 1, libraryItems.length, `${libraryName}: Processing ${item.Name}...`);

        // Rate limiting delay
        if (requestDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, requestDelay));
        }

        try {
          if (item.Type === 'Series') {
            // Expand TV series to episodes
            console.log(`[Library] Expanding series: ${item.Name}`);

            // Fetch seasons - manual fetch because fetchSeasonsREST doesn't support options yet
            const seasons = await fetchSeasonsREST(server, token, item.Id);

            for (const season of seasons) {
              // Rate limiting delay for season
              if (requestDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, requestDelay));
              }

              const episodeData = await fetchEpisodesREST(server, token, item.Id, season.Id);
              let episodes = episodeData?.Items || [];

              // Try fallback if needed
              if (!episodes.length && (episodeData?.apiNotAvailable || episodeData?.apiError)) {
                const fallbackData = await fetchFolderItems(server, token, season.Id, 0, CONFIG.batchSize, { delay: requestDelay, skipWatched });
                episodes = fallbackData?.Items?.filter(e => e.Type === 'Episode') || [];
              }

              // Filter episodes by watched status if needed (if not already done by fetchFolderItems)
              if (skipWatched) {
                episodes = episodes.filter(e => !e.UserData?.Played);
              }

              allItems.push(...episodes);
              console.log(`[Library] Added ${episodes.length} episodes from ${season.Name}`);
            }
          } else if (item.Type === 'BoxSet' || item.Type === 'Collection') {
            // Expand collections
            console.log(`[Library] Expanding collection: ${item.Name}`);
            const collectionItems = await processCollection(server, token, item.Id, { delay: requestDelay, skipWatched });
            allItems.push(...collectionItems);
          } else if (['Movie', 'Video', 'Audio', 'Episode'].includes(item.Type)) {
            // Direct downloadable item
            allItems.push(item);
          }

          // Small extra delay if no specific request delay was set
          if (requestDelay === 0 && i % 10 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (error) {
          console.error(`[Library] Failed to process ${item.Name}:`, error);
          processingStats.errors.push(`${item.Name}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`[Library] Failed to process library ${libraryName}:`, error);
      throw error;
    }

    console.log(`[Library] Library ${libraryName} complete: ${allItems.length} downloadable items`);

    // Ensure all items have names before returning
    const namedItems = allItems.map(item => ensureItemName(item));
    return namedItems;
  }

  async function processServerRoot(server, token) {
    console.log('[Server] Starting whole-server download...');
    updateProgress(0, 0, 'Fetching libraries...');
    showNotification('Scanning entire Emby server...', 'info', 3000);

    try {
      // Get all libraries
      const allLibraries = await fetchAllLibraries(server, token);
      console.log(`[Server] Found ${allLibraries.length} total libraries`);

      // Filter to media libraries only
      const mediaLibraries = allLibraries.filter(lib =>
        ['movies', 'tvshows', 'music', 'homevideos'].includes(lib.CollectionType?.toLowerCase())
      );

      console.log(`[Server] Found ${mediaLibraries.length} media libraries:`,
        mediaLibraries.map(l => l.Name).join(', '));

      if (mediaLibraries.length === 0) {
        throw new Error('No media libraries found on server');
      }

      // NEW v1.0: Server Options Dialog
      const { selectedLibIds, options } = await new Promise((resolve) => {
        showServerDownloadOptionsDialog(
          mediaLibraries,
          (ids, opts) => resolve({ selectedLibIds: ids, options: opts }),
          () => resolve({ selectedLibIds: null, options: null })
        );
      });

      if (!selectedLibIds) {
        throw new Error('User cancelled server download');
      }

      // Apply options
      const librariesToProcess = mediaLibraries.filter(lib => selectedLibIds.includes(lib.Id));
      const requestDelay = options.delay || 500;
      const skipWatched = options.skipWatched;
      const videosOnly = options.videosOnly;

      // Update config limit temporarily
      const originalMaxItems = CONFIG.maxServerItems;
      CONFIG.maxServerItems = options.limit || 10000;

      console.log(`[Server] Starting download with options:`, options);
      console.log(`[Server] Processing ${librariesToProcess.length} selected libraries`);

      // Process each library
      const allItems = [];
      processingStats.total = librariesToProcess.length;

      for (let i = 0; i < librariesToProcess.length; i++) {
        if (abortController?.signal.aborted) break;

        const library = librariesToProcess[i];
        processingStats.current = i + 1;

        console.log(`[Server] Processing library ${i + 1}/${librariesToProcess.length}: ${library.Name}`);

        try {
          const libraryItems = await processLibrary(server, token, library.Id, library.Name, requestDelay, skipWatched, videosOnly);
          allItems.push(...libraryItems);

          console.log(`[Server] Library ${library.Name} complete: ${libraryItems.length} items (running total: ${allItems.length})`);

          if (allItems.length >= CONFIG.maxServerItems) {
            console.warn(`[Server] Reached maximum server items limit: ${CONFIG.maxServerItems}`);
            showNotification(`Reached limit of ${CONFIG.maxServerItems} items`, 'warning', 5000);
            break;
          }
        } catch (error) {
          console.error(`[Server] Failed to process library ${library.Name}:`, error);
          processingStats.errors.push(`Library ${library.Name}: ${error.message}`);
          // Continue with next library
        }

        // Delay between libraries
        if (i < librariesToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Restore config
      CONFIG.maxServerItems = originalMaxItems;

      console.log(`[Server] Server scan complete: ${allItems.length} total items from ${librariesToProcess.length} libraries`);

      if (allItems.length === 0) {
        throw new Error('No downloadable items found on server');
      }

      showNotification(`Server scan complete: found ${allItems.length} items!`, 'success', 4000);
      return allItems;

    } catch (error) {
      console.error('[Server] Server download failed:', error);
      throw error;
    }
  }

  // ---------- Processing Functions ----------
  async function processWithProgress(processingFunction, ...args) {
    const showProgress = Settings.get('showProgress');

    processingStats = {
      current: 0,
      total: 0,
      errors: [],
      startTime: Date.now()
    };

    if (showProgress) {
      createProgressModal();
    }

    try {
      return await processingFunction(...args);
    } finally {
      if (showProgress) {
        hideProgressModal();
      }
    }
  }

  function updateProgress(current, total, status, error = null) {
    processingStats.current = current;
    processingStats.total = total;

    if (error) {
      processingStats.errors.push(error);
    }

    const showProgress = Settings.get('showProgress');
    if (showProgress && progressModal) {
      updateProgressModal(current, total, status, processingStats.errors);
    }

    // Update button progress
    const progress = total > 0 ? (current / total) * 100 : 0;
    updateButtonState(true, status, progress);
  }

  // ---------- Keyboard Shortcuts ----------
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+D: Open main dialog
      if ((e.ctrlKey || e.metaKey) && e.code === CONFIG.keyboardShortcut && !e.repeat) {
        e.preventDefault();
        if (!isProcessing && button) {
          handleButtonClick();
        }
        return;
      }

      // Escape: Close any open modal
      if (e.key === 'Escape') {
        // Close modals in priority order
        const aboutOverlay = document.getElementById('about-overlay');
        const wikiOverlay = document.getElementById('wiki-overlay');
        const historyOverlay = document.getElementById('history-overlay');
        const resultsDialog = document.getElementById('results-dialog');
        const managerOverlay = document.getElementById('download-manager-overlay');

        if (aboutOverlay) {
          aboutOverlay.remove();
          return;
        }
        if (wikiOverlay) {
          wikiOverlay.remove();
          return;
        }
        if (historyOverlay) {
          historyOverlay.remove();
          return;
        }
        if (resultsDialog) {
          resultsDialog.remove();
          return;
        }
        if (managerOverlay) {
          // Ask for confirmation if downloads are in progress
          const isDownloading = managerOverlay.querySelector('#download-list')?.innerHTML.includes('status === \'downloading\'');
          if (isDownloading) {
            if (confirm('Downloads are in progress. Close anyway? Progress will be saved and you can resume later.')) {
              managerOverlay.remove();
            }
          } else {
            managerOverlay.remove();
          }
          return;
        }
        if (settingsPanel) {
          hideSettingsPanel();
          return;
        }
      }

      // Ctrl+S: Save settings when settings panel is open
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && settingsPanel) {
        e.preventDefault();
        saveSettings();
        return;
      }

      // Ctrl+H: Open download history
      if ((e.ctrlKey || e.metaKey) && e.key === 'h' && !e.shiftKey) {
        e.preventDefault();
        // Close settings panel if open
        if (settingsPanel) {
          hideSettingsPanel();
          // Wait for animation to complete before showing history
          setTimeout(() => {
            showHistoryDialog();
          }, 250);
        } else {
          showHistoryDialog();
        }
        return;
      }
    });
  }

  // ---------- Helper Functions (unchanged from original) ----------
  function getApiClient() {
    try {
      return (typeof unsafeWindow !== 'undefined' && unsafeWindow.ApiClient) || window.ApiClient;
    } catch (error) {
      console.error('Failed to get API client:', error);
      return null;
    }
  }

  function getServerAndToken() {
    const apiClient = getApiClient();
    if (!apiClient) return { server: null, token: null, userId: null };

    // Attempt to extract userId if available (needed for Emby Connect full metadata)
    let userId = null;
    if (typeof apiClient.getCurrentUserId === 'function') {
      userId = apiClient.getCurrentUserId();
    } else if (apiClient._serverInfo && apiClient._serverInfo.UserId) {
      userId = apiClient._serverInfo.UserId;
    }

    return {
      server: normalizeServerAddress(apiClient.serverAddress()),
      token: apiClient.accessToken(),
      userId: userId
    };
  }

  function normalizeServerAddress(raw) {
    if (!raw) return null;
    try {
      let address = String(raw).trim();
      if (!/^https?:\/\//i.test(address)) {
        address = 'https://' + address;
      }
      address = address.replace(/\/+$/, '');
      new URL(address);
      return address;
    } catch (error) {
      console.error('Invalid server address:', raw, error);
      return null;
    }
  }

  function parseIdsFromPage() {
    try {
      const backs = document.querySelectorAll('div.itemBackdrop');
      if (!backs.length) return null;

      const styleAttr = backs[backs.length - 1].getAttribute('style') || '';
      const showMatch = styleAttr.match(/Items\/(\d+)\/Images\/Backdrop/i);
      if (!showMatch) return null;

      const showId = showMatch[1];
      const path = (history?.state?.path) || window.location.hash || '';
      const seasonMatch = path.match(/\/(?:item|details)\?id=(\d+)(?:&|$)/i);
      const seasonIdFromPath = seasonMatch ? seasonMatch[1] : showId;

      return { showId, seasonIdFromPath };
    } catch (error) {
      console.error('Error parsing IDs from page:', error);
      return null;
    }
  }

  function getItemIdFromUrl() {
    try {
      const hash = window.location.hash;
      const search = window.location.search;
      const combined = hash + search;

      const idMatch = combined.match(/id=([^&#]+)/i);
      return idMatch ? idMatch[1] : null;
    } catch (error) {
      console.error('Error getting item ID from URL:', error);
      return null;
    }
  }

  function detectPageType() {
    const hash = window.location.hash;
    console.log(`[EmbyGrab] Detecting page type for Hash: ${hash}`);

    if (!hash) return 'unknown';

    // NEW v1.0: Check for Home/Root
    if (hash === '#!/home' || hash === '#!/startup/home' || hash.endsWith('#!/')) {
      console.log('[EmbyGrab] Detected page type: server-root');
      return 'server-root';
    }

    // Check for explicit collection pages first
    if (hash.includes('/collection?id=') ||
      hash.includes('context=collections') ||
      (hash.includes('/item?id=') && hash.includes('context=collections'))) {
      console.log('[EmbyGrab] Detected page type: collection');
      return 'collection';
    }

    // Check for playlists
    if (hash.includes('/list?id=') || hash.includes('/playlist?id=')) {
      console.log('[EmbyGrab] Detected page type: playlist (treating as collection)');
      return 'collection';
    }

    // Check for library/folder pages
    const folderMarkers = [
      '/movies', '/tv', '/music', '/shows',
      '/genres', '/tags', '/folders',
      'parentId=', 'collectionType='
    ];

    if (folderMarkers.some(marker => hash.includes(marker)) && !hash.includes('context=collections')) {
      console.log('[EmbyGrab] Detected page type: folder');
      return 'folder';
    }

    // Individual item pages
    if (hash.includes('/item?id=') || hash.includes('/details?id=')) {
      console.log('[EmbyGrab] Detected page type: item');
      return 'item';
    }

    console.log('[EmbyGrab] Unknown page type');
    return 'unknown';
  }

  function getCurrentFolderId() {
    try {
      const hash = window.location.hash;
      const search = window.location.search;
      const combined = hash + search;

      console.log(`[Debug] Extracting folder ID from: ${combined}`);

      let match = combined.match(/parentId=([^&#]+)/i);
      if (match) {
        console.log(`[Debug] Found parentId: ${match[1]}`);
        return match[1];
      }

      match = combined.match(/id=([^&#]+)/i);
      if (match) {
        console.log(`[Debug] Found general id: ${match[1]}`);
        return match[1];
      }

      match = combined.match(/\/(movies|tv|shows|music|genres|tags|folders|collections)\/([^\/\?]+)/i);
      if (match) {
        console.log(`[Debug] Found path-style id: ${match[2]}`);
        return match[2];
      }

      console.log(`[Debug] No folder ID found, trying to extract from DOM`);

      const itemElements = document.querySelectorAll('[data-id], [data-itemid]');
      const folderElement = Array.from(itemElements).find(el => {
        const classes = el.className || '';
        return classes.includes('folder') || classes.includes('library') || classes.includes('collection');
      });

      if (folderElement) {
        const domId = folderElement.getAttribute('data-id') || folderElement.getAttribute('data-itemid');
        console.log(`[Debug] Found DOM-based id: ${domId}`);
        return domId;
      }

      console.log(`[Debug] No folder ID found anywhere`);
      return null;
    } catch (error) {
      console.error('Error getting folder ID:', error);
      return null;
    }
  }

  // ---------- API Functions with Retry Logic ----------
  async function fetchWithRetry(url, options = {}, attempts = CONFIG.retryAttempts) {
    for (let i = 0; i < attempts; i++) {
      try {
        if (abortController?.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorMsg = `HTTP ${response.status}: ${response.statusText}`;

          // Don't retry client errors (400-499) - they won't succeed
          if (response.status >= 400 && response.status < 500) {
            // Immediately throw without retrying for 4xx errors
            throw new Error(errorMsg);
          }

          // Retry server errors (500+) and rate limiting (429)
          if (i < attempts - 1) {
            console.warn(`Attempt ${i + 1} failed with ${errorMsg}, retrying...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * (i + 1)));
            continue; // Retry
          } else {
            throw new Error(errorMsg);
          }
        }

        return await response.json();
      } catch (error) {
        // Don't retry these error types
        if (error.name === 'AbortError' ||
          error.message === 'Operation cancelled' ||
          error.message.includes('HTTP 4')) { // 4xx client errors (400-499)
          throw error;
        }

        console.warn(`Attempt ${i + 1} failed for ${url}:`, error.message);

        if (i === attempts - 1) throw error;

        await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay * (i + 1)));
      }
    }
  }

  async function fetchCollectionItems(server, token, collectionId, startIndex = 0, limit = CONFIG.batchSize, options = {}) {
    const params = new URLSearchParams({
      StartIndex: startIndex.toString(),
      Limit: limit.toString(),
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'Path,FileName,OriginalTitle,ProductionYear,Container,MediaType,Type,MediaSources', // Request all fields needed for proper naming
      api_key: token
    });

    if (options.skipWatched) {
      params.append('IsPlayed', 'false');
    }

    const url = `${server}/emby/Collections/${encodeURIComponent(collectionId)}/Items?${params.toString()}`;
    console.log(`[Debug] Fetching collection items from: ${url}`);

    // Rate limiting delay
    if (options.delay && options.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    }

    try {
      const result = await fetchWithRetry(url);
      console.log(`[Debug] Collections API successful - returned ${result.Items?.length || 0} items`);

      // Log metadata completeness for first few items
      if (result.Items && result.Items.length > 0) {
        console.log(`[Debug] Sample item metadata:`, result.Items.slice(0, 3).map(item => ({
          Id: item.Id,
          Name: item.Name || 'MISSING',
          FileName: item.FileName || 'MISSING',
          Path: item.Path || 'MISSING',
          OriginalTitle: item.OriginalTitle || 'MISSING'
        })));
      }

      return result;
    } catch (error) {
      // If Collections endpoint doesn't exist (404), try Items API with ParentId
      if (error.message && (error.message.includes('404') || error.message.includes('HTTP 404'))) {
        console.log(`[Debug] Collections API returned 404, trying Items API fallback with ParentId`);
        const itemsParams = new URLSearchParams({
          ParentId: collectionId,
          StartIndex: startIndex.toString(),
          Limit: limit.toString(),
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          Recursive: 'false',
          Fields: 'Path,FileName,OriginalTitle,ProductionYear,Container,MediaType,Type', // Request all fields needed for proper naming
          api_key: token
        });
        const itemsUrl = `${server}/emby/Items?${itemsParams.toString()}`;
        console.log(`[Debug] Trying Items API fallback: ${itemsUrl}`);

        const result = await fetchWithRetry(itemsUrl);
        console.log(`[Debug] Items API fallback successful - returned ${result.Items?.length || 0} items`);

        // NEW v6.59: Playlist API Fallback
        // If Items API returned no items, it might be a Playlist that strictly requires the Playlists endpoint
        if (!result.Items || result.Items.length === 0) {
          const playlistUrl = `${server}/emby/Playlists/${encodeURIComponent(collectionId)}/Items?${params.toString()}`;
          console.log(`[Debug] Items API returned empty, trying Playlists API: ${playlistUrl}`);
          try {
            const playlistResult = await fetchWithRetry(playlistUrl);
            if (playlistResult.Items && playlistResult.Items.length > 0) {
              console.log(`[Debug] Playlists API successful - returned ${playlistResult.Items.length} items`);
              return playlistResult;
            }
          } catch (e) {
            console.warn('[Debug] Playlists API failed:', e);
          }
        }

        console.log(`[Debug] Items API fallback successful - returned ${result.Items?.length || 0} items`);

        // Log metadata completeness for first few items (fallback path)
        if (result.Items && result.Items.length > 0) {
          console.log(`[Debug] Sample item metadata (fallback API):`, result.Items.slice(0, 3).map(item => ({
            Id: item.Id,
            Name: item.Name || 'MISSING',
            FileName: item.FileName || 'MISSING',
            Path: item.Path || 'MISSING',
            OriginalTitle: item.OriginalTitle || 'MISSING'
          })));
        }

        return result;
      }
      console.error(`[Debug] fetchCollectionItems failed with non-404 error:`, error);
      throw error;
    }
  }

  async function fetchAllCollectionItems(server, token, collectionId, onProgress = null, options = {}) {
    const allItems = [];
    let startIndex = 0;
    let totalRecordCount = 0;

    do {
      if (abortController?.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      const data = await fetchCollectionItems(server, token, collectionId, startIndex, CONFIG.batchSize, options);
      const items = data.Items || [];

      // Exit if no items returned
      if (items.length === 0) {
        break;
      }

      allItems.push(...items);
      totalRecordCount = data.TotalRecordCount || items.length;
      startIndex += items.length; // Use actual items length, not CONFIG.batchSize

      if (onProgress) {
        onProgress(allItems.length, totalRecordCount, `Scanning collection... ${allItems.length}/${totalRecordCount}`);
      }

      updateProgress(allItems.length, totalRecordCount, `Scanning collection...`);

      if (allItems.length >= CONFIG.maxFolderItems) {
        console.warn(`Reached maximum collection items limit (${CONFIG.maxFolderItems})`);
        showNotification(`Reached limit of ${CONFIG.maxFolderItems} items`, 'warning', 4000);
        break;
      }

      if (items.length === CONFIG.batchSize) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } while (startIndex < totalRecordCount);

    return allItems;
  }

  async function fetchFolderItems(server, token, parentId, startIndex = 0, limit = CONFIG.batchSize, options = {}) {
    const params = new URLSearchParams({
      ParentId: parentId,
      StartIndex: startIndex.toString(),
      Limit: limit.toString(),
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Recursive: 'false',
      Fields: 'Path,FileName,OriginalTitle,ProductionYear,Container,MediaType,Type,MediaSources', // Request all fields needed for proper naming
      api_key: token
    });

    if (options.skipWatched) {
      params.append('IsPlayed', 'false');
    }

    const url = `${server}/emby/Items?${params.toString()}`;
    console.log(`[Debug] Fetching items (limit=${limit}) from: ${url}`);

    // Rate limiting delay
    if (options.delay && options.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    }

    try {
      const response = await fetchWithRetry(url);
      return response;
    } catch (error) {
      console.error(`[Debug] Folder API failed for parentId ${parentId}:`, error);
      throw error;
    }
  }

  async function fetchAllFolderItems(server, token, parentId, onProgress = null, options = {}) {
    const allItems = [];
    let startIndex = 0;
    let totalRecordCount = 0;

    do {
      if (abortController?.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      const data = await fetchFolderItems(server, token, parentId, startIndex, CONFIG.batchSize, options);
      const items = data.Items || [];

      // Exit if no items returned
      if (items.length === 0) {
        break;
      }

      allItems.push(...items);
      totalRecordCount = data.TotalRecordCount || 0;
      startIndex += items.length; // Use actual items length, not CONFIG.batchSize

      if (onProgress) {
        onProgress(allItems.length, totalRecordCount, `Scanning folder... ${allItems.length}/${totalRecordCount || '?'}`);
      }

      if (!options.silent) {
        updateProgress(allItems.length, totalRecordCount, `Scanning folder...`);
      }

      if (allItems.length >= CONFIG.maxFolderItems) {
        console.warn(`Reached maximum folder items limit (${CONFIG.maxFolderItems})`);
        showNotification(`Reached limit of ${CONFIG.maxFolderItems} items`, 'warning', 4000);
        break;
      }

      if (items.length === CONFIG.batchSize) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to avoid freezing
      }

    } while (startIndex < totalRecordCount);

    if (!options.silent) {
      updateProgress(allItems.length, totalRecordCount, `Folder scan complete`);
    }
    return allItems;
  }

  async function fetchSeasonsREST(server, token, showId) {
    const params = new URLSearchParams({
      Fields: 'Path,FileName,IndexNumber', // Request fields for season metadata
      api_key: token
    });
    const url = `${server}/emby/Shows/${encodeURIComponent(showId)}/Seasons?${params.toString()}`;

    // NEW v6.50: Check cache first
    const cacheKey = RequestCache.makeKey(url);
    const cached = RequestCache.get(cacheKey);
    if (cached) {
      return Array.isArray(cached.Items) ? cached.Items : [];
    }

    const data = await fetchWithRetry(url);

    // Cache the result
    RequestCache.set(cacheKey, data);

    return Array.isArray(data.Items) ? data.Items : [];
  }

  async function fetchEpisodesREST(server, token, showId, seasonId) {
    const params = new URLSearchParams({
      SeasonId: seasonId,
      SortBy: 'IndexNumber,SortName',
      SortOrder: 'Ascending',
      Limit: '0',
      Fields: 'Path,FileName,OriginalTitle,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,Container,MediaType,Type,MediaSources', // Request all fields needed for proper naming
      api_key: token
    });

    const url = `${server}/emby/Shows/${encodeURIComponent(showId)}/Episodes?${params.toString()}`;

    // NEW v6.50: Check cache first
    const cacheKey = RequestCache.makeKey(url);
    const cached = RequestCache.get(cacheKey);
    if (cached) {
      console.log(`[Debug] Using cached episodes for season ${seasonId}`);
      return cached;
    }

    console.log(`[Debug] Fetching episodes from REST API: ${url.split('?')[0]}`);

    try {
      const data = await fetchWithRetry(url);
      console.log(`[Debug] REST API success for season ${seasonId}:`, {
        items: data?.Items?.length || 0,
        total: data?.TotalRecordCount || 0
      });

      // Cache the result
      RequestCache.set(cacheKey, data);

      return data;
    } catch (error) {
      // Check if it's a 404 - API endpoint doesn't exist
      const is404 = error.message && error.message.includes('404');
      if (is404) {
        console.log(`[Debug] REST API returned 404 for season ${seasonId} - API endpoint doesn't exist, will use fallback`);
        return { Items: [], TotalRecordCount: 0, apiNotAvailable: true };
      }

      // For other errors, log but still return empty to trigger fallback
      console.warn(`[Debug] REST API failed for season ${seasonId}:`, error.message);
      return { Items: [], TotalRecordCount: 0, apiError: true };
    }
  }

  async function getItemInfo(server, token, id, userId = null) {
    try {
      const params = new URLSearchParams({
        Fields: 'Path,FileName,OriginalTitle,ProductionYear,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,Container,MediaType,Type,MediaSources', // Request all fields needed for proper naming
        api_key: token
      });

      // /Users/{UserId}/Items/{Id} endpoint returns complete metadata bypassing Connect restrictions
      const url = userId
        ? `${server}/emby/Users/${userId}/Items/${encodeURIComponent(id)}?${params.toString()}`
        : `${server}/emby/Items/${encodeURIComponent(id)}?${params.toString()}`;

      return await fetchWithRetry(url);
    } catch (error) {
      // Add context to error message
      throw new Error(`Failed to fetch item ${id}: ${error.message}`);
    }
  }

  async function copyToClipboard(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
        return true;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;opacity:0;top:-999px;left:-999px;';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, 99999);

      const success = document.execCommand('copy');
      textarea.remove();

      if (!success) {
        throw new Error('Copy command failed');
      }

      return true;
    } catch (error) {
      console.error('Clipboard operation failed:', error);
      throw new Error('Failed to copy to clipboard. Please copy manually from the console output.');
    }
  }





  // ---------- Processing Functions ----------
  async function processCollection(server, token, collectionId, options = {}) {
    currentOperation = 'collection';

    try {
      updateProgress(0, 0, "Scanning Collection...");
      showNotification('Scanning collection for downloadable items...', 'info');

      // Get collection metadata first
      let collectionInfo = null;
      try {
        collectionInfo = await getItemInfo(server, token, collectionId);
        console.log(`[Debug] Collection info:`, collectionInfo);
        // Store collection name in global for use in showResultsDialog
        if (collectionInfo?.Name) {
          currentCollectionName = collectionInfo.Name;
        }
      } catch (error) {
        console.warn(`[Debug] Could not fetch collection info:`, error);
      }

      let items = [];
      let errorMessages = [];

      try {
        console.log(`[Debug] Trying collection API for ID: ${collectionId}`);
        items = await fetchAllCollectionItems(server, token, collectionId, (current, total, status) => {
          updateProgress(current, total, status);
        }, options);
        console.log(`[Debug] Collection API returned ${items.length} items`);

        if (items.length > 0) {
          console.log(`[Debug] Collection API successful`);
        }
      } catch (error) {
        console.warn('Collection API failed:', error);
        errorMessages.push(`Collection API: ${error.message}`);
      }

      if (items.length === 0) {
        try {
          console.log(`[Debug] Trying folder API fallback for collection ${collectionId}`);
          items = await fetchAllFolderItems(server, token, collectionId, (current, total, status) => {
            updateProgress(current, total, status);
          }, options);
          console.log(`[Debug] Folder API fallback returned ${items.length} items`);
        } catch (folderError) {
          console.warn('Folder API fallback also failed:', folderError);
          errorMessages.push(`Folder API: ${folderError.message}`);
        }
      }

      if (items.length === 0) {
        console.log(`[Debug] Both APIs failed, trying to extract from page content`);
        const visibleItems = extractItemsFromPage();
        if (visibleItems.length > 0) {
          console.log(`[Debug] Extracted ${visibleItems.length} items from page content`);
          items = await Promise.all(
            visibleItems.map(async (itemId) => {
              try {
                return await getItemInfo(server, token, itemId);
              } catch (error) {
                console.warn(`Failed to get info for item ${itemId}:`, error);
                return null;
              }
            })
          );
          items = items.filter(item => item !== null);
        }
      }

      if (!items.length) {
        const errorSummary = errorMessages.length > 0 ? `\n\nAPI Errors:\n${errorMessages.join('\n')}` : '';
        throw new Error(`No items found in this collection. Tried multiple approaches but none succeeded.${errorSummary}`);
      }

      console.log(`[Debug] Raw items from collection (first 3):`, items.slice(0, 3));

      let downloadableItems = [];
      const foundSeasons = [];

      for (const item of items) {
        if (['Movie', 'Episode', 'Audio', 'Video'].includes(item.Type) && !item.IsFolder) {
          downloadableItems.push(item);
        } else if (item.Type === 'Season') {
          foundSeasons.push(item);
          console.log(`[Debug] Found season: ${item.Name} (ID: ${item.Id})`);
        } else if (item.Type === 'Series') {
          console.log(`[Debug] Found series in collection: ${item.Name}, skipping (not yet supported)`);
        }
      }

      console.log(`[Debug] Filtered to ${downloadableItems.length} downloadable items and ${foundSeasons.length} seasons`);

      if (!downloadableItems.length && foundSeasons.length > 0) {
        console.log(`[Debug] Found only seasons - this appears to be a TV show, not a collection. Expanding seasons to episodes...`);

        for (const season of foundSeasons) {
          try {
            console.log(`[Debug] Expanding season: ${season.Name} (ID: ${season.Id})`);
            updateProgress(foundSeasons.indexOf(season), foundSeasons.length, `Expanding ${season.Name}...`);

            const episodeData = await fetchFolderItems(server, token, season.Id, 0, CONFIG.batchSize, options);
            const episodes = episodeData?.Items?.filter(item => item.Type === 'Episode') || [];

            console.log(`[Debug] Season ${season.Name}: Found ${episodes.length} episodes`);

            if (episodes.length > 0) {
              downloadableItems.push(...episodes);
            }

            // Use options.delay if present, otherwise default seasonDelayMs
            const delay = (options.delay && options.delay > 0) ? options.delay : CONFIG.seasonDelayMs;
            await new Promise(resolve => setTimeout(resolve, delay));

          } catch (error) {
            const errorMsg = `Failed to expand season ${season.Name}: ${error.message}`;
            console.warn(errorMsg);
            updateProgress(foundSeasons.indexOf(season), foundSeasons.length, `Expanding ${season.Name}...`, errorMsg);
          }
        }

        console.log(`[Debug] After season expansion: ${downloadableItems.length} total episodes`);
      }

      if (!downloadableItems.length) {
        const itemTypes = [...new Set(items.map(i => i.Type))].join(', ');
        if (foundSeasons.length > 0) {
          throw new Error(`Found ${foundSeasons.length} seasons but no episodes could be extracted.\n\nThis might be a permissions issue or the episodes are organized differently.\n\nTry navigating to individual season pages instead.`);
        } else {
          throw new Error(`No downloadable media files found in this collection.\n\nFound item types: ${itemTypes}\n\nNote: Series in collections are not yet supported - please navigate to individual seasons.`);
        }
      }

      // Apply deduplication
      downloadableItems = deduplicateItems(downloadableItems);

      const autoConfirm = Settings.get('autoConfirm');
      if (!autoConfirm && downloadableItems.length > 20) {
        return new Promise((resolve, reject) => {
          const details = [
            `${downloadableItems.length} total items to download`,
            foundSeasons.length > 0 ? `Expanded from ${foundSeasons.length} seasons` : `Direct collection items`,
            `Output format: ${CONFIG.outputFormats[Settings.get('outputFormat')]}`
          ];

          showConfirmDialog(
            'Large Collection Detected',
            details,
            downloadableItems,
            () => resolve(downloadableItems),
            () => reject(new Error('User cancelled collection download'))
          );
        });
      }

      // Ensure all items have names before returning
      downloadableItems = downloadableItems.map(item => ensureItemName(item));

      return downloadableItems;

    } catch (error) {
      console.error('Error processing collection:', error);
      throw error;
    }
  }

  function extractItemsFromPage() {
    const itemIds = [];

    const selectors = [
      '[data-id]',
      '[data-itemid]',
      'a[href*="id="]',
      '.card[data-id]',
      '.listItem[data-id]'
    ];

    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        let id = el.getAttribute('data-id') ||
          el.getAttribute('data-itemid') ||
          el.getAttribute('data-item-id');

        if (!id) {
          const href = el.getAttribute('href');
          if (href) {
            const match = href.match(/id=([^&#]+)/);
            if (match) id = match[1];
          }
        }

        if (id && !itemIds.includes(id)) {
          itemIds.push(id);
        }
      });
    });

    console.log(`[Debug] Extracted ${itemIds.length} item IDs from page:`, itemIds);
    return itemIds;
  }

  async function processFolder(server, token, folderId) {
    currentOperation = 'folder';

    try {
      updateProgress(0, 0, "Scanning Folder...");
      showNotification('Scanning folder for downloadable items...', 'info');

      const items = await fetchAllFolderItems(server, token, folderId, (current, total, status) => {
        updateProgress(current, total, status);
      });

      console.log(`[Debug] Folder API returned ${items.length} items for folder ${folderId}`);

      if (!items.length) {
        throw new Error('No items found in this folder.');
      }

      console.log(`[Debug] Raw folder items (first 5):`, items.slice(0, 5));
      console.log(`[Debug] All item types found:`, [...new Set(items.map(i => i.Type))]);

      let downloadableItems = items.filter(item => {
        const isStandardDownloadable = ['Movie', 'Episode', 'Audio', 'Video'].includes(item.Type) && !item.IsFolder;
        const isVideoFile = item.MediaType === 'Video' && !item.IsFolder;
        const isAudioFile = item.MediaType === 'Audio' && !item.IsFolder;
        const hasVideoContainer = item.Container && ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v'].includes(item.Container.toLowerCase()) && !item.IsFolder;
        const hasAudioContainer = item.Container && ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'].includes(item.Container.toLowerCase()) && !item.IsFolder;

        return isStandardDownloadable || isVideoFile || isAudioFile || hasVideoContainer || hasAudioContainer;
      });

      const seriesItems = items.filter(item => item.Type === 'Series');
      const boxSetItems = items.filter(item => item.Type === 'BoxSet' || item.Type === 'Collection');

      console.log(`[Debug] Found ${downloadableItems.length} direct downloadable items, ${seriesItems.length} TV series, and ${boxSetItems.length} collections/boxsets`);

      // Process Collections/BoxSets
      if (boxSetItems.length > 0) {
        updateProgress(0, boxSetItems.length, "Expanding Collections...");
        showNotification(`Found ${boxSetItems.length} collections, expanding to downloadable items...`, 'info', 3000);

        let totalItemsFromCollections = 0;
        let successfulCollections = 0;

        for (let i = 0; i < boxSetItems.length; i++) {
          // Check if operation was cancelled
          if (abortController.signal.aborted) {
            console.log('[Debug] Collection expansion cancelled by user');
            throw new Error('Operation cancelled');
          }

          const collection = boxSetItems[i];
          try {
            const progressText = `Collection ${i + 1}/${boxSetItems.length}: ${collection.Name}`;
            updateProgress(i, boxSetItems.length, progressText);
            showNotification(progressText, 'info', 2000);
            console.log(`[Debug] Expanding collection ${i + 1}/${boxSetItems.length}: ${collection.Name} (ID: ${collection.Id})`);

            // Try collection API first
            let collectionItems = [];
            try {
              const collectionData = await fetchAllCollectionItems(server, token, collection.Id);
              collectionItems = collectionData || [];
              console.log(`[Debug] Collection ${collection.Name}: Collection API returned ${collectionItems.length} items`);
            } catch (collectionError) {
              console.warn(`[Debug] Collection API failed for ${collection.Name}, trying folder API`);
              // Fallback to folder API
              try {
                const folderData = await fetchAllFolderItems(server, token, collection.Id);
                collectionItems = folderData || [];
                console.log(`[Debug] Collection ${collection.Name}: Folder API returned ${collectionItems.length} items`);
              } catch (folderError) {
                console.warn(`[Debug] Both APIs failed for collection ${collection.Name}:`, folderError);
              }
            }

            if (collectionItems.length > 0) {
              // Filter for downloadable items within this collection
              const collectionDownloadables = collectionItems.filter(item => {
                const isStandardDownloadable = ['Movie', 'Episode', 'Audio', 'Video'].includes(item.Type) && !item.IsFolder;
                const isVideoFile = item.MediaType === 'Video' && !item.IsFolder;
                const isAudioFile = item.MediaType === 'Audio' && !item.IsFolder;
                const hasVideoContainer = item.Container && ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v'].includes(item.Container.toLowerCase()) && !item.IsFolder;
                const hasAudioContainer = item.Container && ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'].includes(item.Container.toLowerCase()) && !item.IsFolder;
                return isStandardDownloadable || isVideoFile || isAudioFile || hasVideoContainer || hasAudioContainer;
              });

              // Check for seasons within collections (TV show collections)
              const seasonsInCollection = collectionItems.filter(item => item.Type === 'Season');

              if (seasonsInCollection.length > 0) {
                console.log(`[Debug] Collection ${collection.Name}: Found ${seasonsInCollection.length} seasons, expanding to episodes`);

                for (const season of seasonsInCollection) {
                  try {
                    // Get the series ID from the season for proper episode fetching
                    const seasonData = await getItemInfo(server, token, season.Id);
                    const seriesId = seasonData.SeriesId || seasonData.ParentId;

                    if (seriesId) {
                      const episodeData = await fetchEpisodesREST(server, token, seriesId, season.Id);
                      const episodes = episodeData?.Items || [];

                      if (!episodes.length && episodeData?.TotalRecordCount > 0) {
                        // Fallback to folder API for episodes
                        const altEpisodeData = await fetchFolderItems(server, token, season.Id);
                        const altEpisodes = altEpisodeData?.Items?.filter(item => item.Type === 'Episode') || [];
                        collectionDownloadables.push(...altEpisodes);
                        console.log(`[Debug] Collection ${collection.Name}, Season ${season.Name}: ${altEpisodes.length} episodes (fallback)`);
                      } else {
                        collectionDownloadables.push(...episodes);
                        console.log(`[Debug] Collection ${collection.Name}, Season ${season.Name}: ${episodes.length} episodes`);
                      }
                    }

                    await new Promise(resolve => setTimeout(resolve, 100));

                  } catch (seasonError) {
                    console.warn(`Failed to expand season ${season.Name} in collection ${collection.Name}:`, seasonError);
                  }
                }
              }

              if (collectionDownloadables.length > 0) {
                downloadableItems.push(...collectionDownloadables);
                totalItemsFromCollections += collectionDownloadables.length;
                successfulCollections++;
                console.log(`[Debug] Collection ${collection.Name}: Added ${collectionDownloadables.length} items (running total: ${totalItemsFromCollections})`);
              } else {
                console.log(`[Debug] Collection ${collection.Name}: No downloadable items found`);
              }
            }

            if (i < boxSetItems.length - 1) {
              await new Promise(resolve => setTimeout(resolve, CONFIG.seasonDelayMs));
            }

          } catch (collectionError) {
            const errorMsg = `Failed to expand collection ${collection.Name}: ${collectionError.message}`;
            console.error(errorMsg);
            updateProgress(i, boxSetItems.length, `Expanding ${collection.Name}...`, errorMsg);
          }
        }

        console.log(`[Debug] Collection expansion complete: ${totalItemsFromCollections} items from ${successfulCollections}/${boxSetItems.length} collections`);

        if (totalItemsFromCollections > 0) {
          showNotification(`Expanded ${successfulCollections} collections into ${totalItemsFromCollections} downloadable items`, 'info', 3000);
        }
      }

      // Process TV Series (existing logic)
      if (seriesItems.length > 0) {
        updateProgress(0, seriesItems.length, "Expanding TV Shows...");
        showNotification(`Found ${seriesItems.length} TV series, expanding to episodes...`, 'info', 3000);

        let totalEpisodesFromSeries = 0;
        let successfulSeries = 0;

        for (let i = 0; i < seriesItems.length; i++) {
          // Check if operation was cancelled
          if (abortController.signal.aborted) {
            console.log('[Debug] TV series expansion cancelled by user');
            throw new Error('Operation cancelled');
          }

          const series = seriesItems[i];
          try {
            updateProgress(i, seriesItems.length, `Expanding ${series.Name}...`);
            console.log(`[Debug] Expanding TV series: ${series.Name} (ID: ${series.Id})`);

            const seasons = await fetchSeasonsREST(server, token, series.Id);
            seasons.sort((a, b) => (a.IndexNumber ?? 9999) - (b.IndexNumber ?? 9999));

            if (!seasons.length) {
              console.warn(`[Debug] No seasons found for series: ${series.Name}`);
              continue;
            }

            console.log(`[Debug] Series ${series.Name}: Found ${seasons.length} seasons`);

            // NEW v6.50: Fetch episodes in parallel if enabled
            let seriesEpisodes = [];
            if (Settings.get('enableParallelFetching') && seasons.length > 1) {
              const concurrency = Settings.get('parallelSeasonFetches') || CONFIG.parallelSeasonFetches;
              console.log(`[Parallel] Fetching ${seasons.length} seasons with concurrency ${concurrency} for ${series.Name}`);

              const fetchTasks = seasons.map(season => async () => {
                try {
                  const episodeData = await fetchEpisodesREST(server, token, series.Id, season.Id);
                  const episodes = episodeData?.Items || [];

                  if (!episodes.length && episodeData?.TotalRecordCount > 0) {
                    console.log(`[Debug] Episode API returned no items but TotalRecordCount is ${episodeData.TotalRecordCount}, trying folder API fallback`);
                    const altEpisodeData = await fetchFolderItems(server, token, season.Id);
                    const altEpisodes = altEpisodeData?.Items?.filter(item => item.Type === 'Episode') || [];
                    console.log(`[Debug] Series ${series.Name}, Season ${season.IndexNumber}: ${altEpisodes.length} episodes (fallback API)`);
                    return altEpisodes;
                  } else {
                    console.log(`[Debug] Series ${series.Name}, Season ${season.IndexNumber}: ${episodes.length} episodes`);
                    return episodes;
                  }
                } catch (seasonError) {
                  const errorMsg = `Failed to get episodes for ${series.Name} Season ${season.IndexNumber}: ${seasonError.message}`;
                  console.warn(errorMsg);
                  return [];
                }
              });

              const episodeArrays = await parallelFetch(fetchTasks, concurrency);
              seriesEpisodes = episodeArrays.flat();
              console.log(`[Parallel] Completed fetching ${seriesEpisodes.length} episodes for ${series.Name}`);
            } else {
              // Sequential fallback (original logic)
              for (const season of seasons) {
                try {
                  const episodeData = await fetchEpisodesREST(server, token, series.Id, season.Id);
                  const episodes = episodeData?.Items || [];

                  if (!episodes.length && episodeData?.TotalRecordCount > 0) {
                    console.log(`[Debug] Episode API returned no items but TotalRecordCount is ${episodeData.TotalRecordCount}, trying folder API fallback`);
                    const altEpisodeData = await fetchFolderItems(server, token, season.Id);
                    const altEpisodes = altEpisodeData?.Items?.filter(item => item.Type === 'Episode') || [];
                    seriesEpisodes.push(...altEpisodes);
                    console.log(`[Debug] Series ${series.Name}, Season ${season.IndexNumber}: ${altEpisodes.length} episodes (fallback API)`);
                  } else {
                    seriesEpisodes.push(...episodes);
                    console.log(`[Debug] Series ${series.Name}, Season ${season.IndexNumber}: ${episodes.length} episodes`);
                  }

                  await new Promise(resolve => setTimeout(resolve, 100));

                } catch (seasonError) {
                  const errorMsg = `Failed to get episodes for ${series.Name} Season ${season.IndexNumber}: ${seasonError.message}`;
                  console.warn(errorMsg);
                  updateProgress(i, seriesItems.length, `Expanding ${series.Name}...`, errorMsg);
                }
              }
            }

            if (seriesEpisodes.length > 0) {
              downloadableItems.push(...seriesEpisodes);
              totalEpisodesFromSeries += seriesEpisodes.length;
              successfulSeries++;
              console.log(`[Debug] Series ${series.Name}: Added ${seriesEpisodes.length} episodes (running total: ${totalEpisodesFromSeries})`);
            }

            if (i < seriesItems.length - 1) {
              await new Promise(resolve => setTimeout(resolve, CONFIG.seasonDelayMs));
            }

          } catch (seriesError) {
            const errorMsg = `Failed to expand TV series ${series.Name}: ${seriesError.message}`;
            console.error(errorMsg);
            updateProgress(i, seriesItems.length, `Expanding ${series.Name}...`, errorMsg);
          }
        }

        console.log(`[Debug] TV series expansion complete: ${totalEpisodesFromSeries} episodes from ${successfulSeries}/${seriesItems.length} series`);

        if (totalEpisodesFromSeries > 0) {
          showNotification(`Expanded ${successfulSeries} TV series into ${totalEpisodesFromSeries} episodes`, 'info', 3000);
        }
      }

      // NEW v6.52: Process regular Folders (recursive scan)
      const folderItems = items.filter(item => item.Type === 'Folder' && item.IsFolder);
      if (folderItems.length > 0) {
        updateProgress(0, folderItems.length, "Scanning subfolders...");
        showNotification(`Found ${folderItems.length} subfolders, scanning recursively...`, 'info', 3000);

        let totalItemsFromFolders = 0;
        let successfulFolders = 0;

        for (let i = 0; i < folderItems.length; i++) {
          if (abortController.signal.aborted) {
            console.log('[Debug] Subfolder scanning cancelled by user');
            throw new Error('Operation cancelled');
          }

          const folder = folderItems[i];
          try {
            const progressText = `Folder ${i + 1}/${folderItems.length}: ${folder.Name}`;
            updateProgress(i, folderItems.length, progressText);
            console.log(`[Debug] Scanning subfolder ${i + 1}/${folderItems.length}: ${folder.Name} (ID: ${folder.Id})`);

            // Recursively fetch items from this subfolder
            const subfolderItems = await fetchAllFolderItems(server, token, folder.Id);
            console.log(`[Debug] Subfolder ${folder.Name}: Found ${subfolderItems.length} items`);

            // Filter for downloadable items
            const subfolderDownloadables = subfolderItems.filter(item => {
              const isStandardDownloadable = ['Movie', 'Episode', 'Audio', 'Video'].includes(item.Type) && !item.IsFolder;
              const isVideoFile = item.MediaType === 'Video' && !item.IsFolder;
              const isAudioFile = item.MediaType === 'Audio' && !item.IsFolder;
              const hasVideoContainer = item.Container && ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v'].includes(item.Container.toLowerCase()) && !item.IsFolder;
              const hasAudioContainer = item.Container && ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a'].includes(item.Container.toLowerCase()) && !item.IsFolder;
              return isStandardDownloadable || isVideoFile || isAudioFile || hasVideoContainer || hasAudioContainer;
            });

            if (subfolderDownloadables.length > 0) {
              downloadableItems.push(...subfolderDownloadables);
              totalItemsFromFolders += subfolderDownloadables.length;
              successfulFolders++;
              console.log(`[Debug] Subfolder ${folder.Name}: Added ${subfolderDownloadables.length} items (running total: ${totalItemsFromFolders})`);
            } else {
              console.log(`[Debug] Subfolder ${folder.Name}: No direct downloadable items found`);
            }

            await new Promise(resolve => setTimeout(resolve, 100));

          } catch (folderError) {
            const errorMsg = `Failed to scan subfolder ${folder.Name}: ${folderError.message}`;
            console.error(errorMsg);
            updateProgress(i, folderItems.length, `Scanning ${folder.Name}...`, errorMsg);
          }
        }

        console.log(`[Debug] Subfolder scanning complete: ${totalItemsFromFolders} items from ${successfulFolders}/${folderItems.length} folders`);

        if (totalItemsFromFolders > 0) {
          showNotification(`Scanned ${successfulFolders} subfolders and found ${totalItemsFromFolders} downloadable items`, 'info', 3000);
        }
      }

      console.log(`[Debug] Final count: ${downloadableItems.length} total downloadable items`);

      if (!downloadableItems.length) {
        const itemTypes = [...new Set(items.map(i => i.Type))].join(', ');
        const mediaTypes = [...new Set(items.map(i => i.MediaType).filter(Boolean))].join(', ');
        const containers = [...new Set(items.map(i => i.Container).filter(Boolean))].join(', ');

        throw new Error(
          `No downloadable media files found in this folder after expansion.\n\n` +
          `Found ${items.length} items:\n` +
          `- Types: ${itemTypes}\n` +
          `- MediaTypes: ${mediaTypes || 'none'}\n` +
          `- Containers: ${containers || 'none'}\n` +
          `- Folders: ${items.filter(i => i.IsFolder).length}\n` +
          `- Series processed: ${seriesItems.length}\n` +
          `- Collections processed: ${boxSetItems.length}\n\n` +
          `This might be because the items have different types than expected, or expansion failed. Check the console for detailed logs of what was processed.`
        );
      }

      // Apply deduplication
      downloadableItems = deduplicateItems(downloadableItems);

      const autoConfirm = Settings.get('autoConfirm');
      if (!autoConfirm && downloadableItems.length > 50 && !window._embyGrabLargeFolderConfirmed) {
        return new Promise((resolve, reject) => {
          const directItems = downloadableItems.filter(i => i.Type !== 'Episode').length;
          const episodeItems = downloadableItems.filter(i => i.Type === 'Episode').length;

          const details = [
            `${downloadableItems.length} total items to download`,
            episodeItems > 0 && directItems > 0 ? `${directItems} direct files + ${episodeItems} episodes` :
              episodeItems > 0 ? `${episodeItems} episodes from ${seriesItems.length} TV series` :
                `${directItems} direct files`,
            `Output format: ${CONFIG.outputFormats[Settings.get('outputFormat')]}`
          ];

          window._embyGrabLargeFolderConfirmed = true;
          showConfirmDialog(
            'Large Folder Detected',
            details,
            downloadableItems,
            () => {
              // Ensure all items have names before resolving
              downloadableItems = downloadableItems.map(item => ensureItemName(item));
              // Do NOT reset flag here — keep it set until the next full handleButtonClick run
              resolve(downloadableItems);
            },
            () => {
              window._embyGrabLargeFolderConfirmed = false;
              reject(new Error('User cancelled folder download'));
            }
          );
        });
      }
      window._embyGrabLargeFolderConfirmed = false;

      // Ensure all items have names before returning
      downloadableItems = downloadableItems.map(item => ensureItemName(item));

      return downloadableItems;

    } catch (error) {
      console.error('Error processing folder:', error);
      throw error;
    }
  }

  async function processShow(server, token, api) {
    currentOperation = 'show';

    const ids = parseIdsFromPage();
    if (!ids) {
      throw new Error("Could not detect show/season IDs. Please ensure you're on a show or season page.");
    }

    const { showId, seasonIdFromPath } = ids;
    let items = [];
    let isWholeShow = (seasonIdFromPath === showId);

    console.log(`[Debug] Processing show - ShowID: ${showId}, SeasonID: ${seasonIdFromPath}, IsWholeShow: ${isWholeShow}`);

    if (isWholeShow) {
      try {
        updateProgress(0, 0, "Getting All Seasons...");
        showNotification('Fetching all episodes from all seasons...', 'info');

        const seasons = await fetchSeasonsREST(server, token, showId);
        seasons.sort((a, b) => (a.IndexNumber ?? 9999) - (b.IndexNumber ?? 9999));

        if (!seasons.length) {
          throw new Error(`No seasons found for show ID: ${showId}`);
        }

        console.log(`[Debug] Found ${seasons.length} seasons`);

        const allEpisodes = [];
        let successfulSeasons = 0;
        const seasonErrors = [];

        for (let i = 0; i < seasons.length; i++) {
          const season = seasons[i];
          try {
            updateProgress(i, seasons.length, `Season ${season.IndexNumber || '?'}...`);

            console.log(`[Debug] Fetching episodes for season: ${season.Name} (ID: ${season.Id}, Index: ${season.IndexNumber})`);

            let data = await fetchEpisodesREST(server, token, showId, season.Id);
            let episodes = data?.Items || [];

            // Try fallback if:
            // 1. No episodes returned, OR
            // 2. API said items exist but returned empty, OR
            // 3. API endpoint doesn't exist (404)
            const shouldTryFallback = !episodes.length && (
              (data && data.TotalRecordCount > 0) ||
              data?.apiNotAvailable ||
              data?.apiError
            );

            if (shouldTryFallback) {
              const reason = data?.apiNotAvailable ? 'REST API not available (404)' :
                data?.apiError ? 'REST API error' :
                  `API returned TotalRecordCount=${data.TotalRecordCount} but no items`;

              console.log(`[Debug] Trying Items API fallback - Reason: ${reason}`);

              try {
                const alternativeData = await fetchFolderItems(server, token, season.Id);
                episodes = alternativeData?.Items?.filter(item => item.Type === 'Episode') || [];
                console.log(`[Debug] Items API fallback returned ${episodes.length} episodes`);

                if (episodes.length > 0) {
                  console.log(`[Debug] ✓ Fallback successful - got ${episodes.length} episodes from Items API`);
                }
              } catch (altError) {
                console.warn(`[Debug] Items API fallback also failed:`, altError.message);
              }
            }

            console.log(`[Debug] Season ${season.IndexNumber} final result:`, {
              episodeCount: episodes.length,
              apiTotalRecords: data?.TotalRecordCount,
              firstEpisode: episodes[0] ? {
                name: episodes[0].Name,
                id: episodes[0].Id,
                type: episodes[0].Type
              } : 'none'
            });

            if (episodes.length > 0) {
              allEpisodes.push(...episodes);
              successfulSeasons++;
              console.log(`[Debug] Season ${season.IndexNumber}: Added ${episodes.length} episodes (total now: ${allEpisodes.length})`);
            } else {
              console.warn(`[Debug] Season ${season.IndexNumber}: No episodes found (API said ${data?.TotalRecordCount || 0} total records)`);
              seasonErrors.push(`Season ${season.IndexNumber}: No episodes found (API reported ${data?.TotalRecordCount || 0} total records but returned empty Items array)`);
            }

            if (i < seasons.length - 1) {
              await new Promise(resolve => setTimeout(resolve, CONFIG.seasonDelayMs));
            }

          } catch (error) {
            const errorMsg = `Failed to get episodes for season ${season.IndexNumber}: ${error.message}`;
            console.error(errorMsg);
            seasonErrors.push(errorMsg);
            updateProgress(i, seasons.length, `Season ${season.IndexNumber || '?'}...`, errorMsg);
          }
        }

        console.log(`[Debug] Season processing complete: ${successfulSeasons}/${seasons.length} successful, ${allEpisodes.length} total episodes`);

        items = allEpisodes;

        if (items.length > 0) {
          showNotification(`Found ${items.length} episodes across ${successfulSeasons}/${seasons.length} seasons`, 'info', 3000);

          const autoConfirm = Settings.get('autoConfirm');
          if (!autoConfirm && items.length > CONFIG.wholeShowConfirmThreshold) {
            return new Promise((resolve, reject) => {
              const details = [
                `${items.length} episodes across ${successfulSeasons} seasons`,
                `Output format: ${CONFIG.outputFormats[Settings.get('outputFormat')]}`
              ];

              showConfirmDialog(
                'Large TV Show Detected',
                details,
                items,
                () => resolve(items),
                () => reject(new Error('User cancelled whole show download'))
              );
            });
          }
        } else {
          const errorDetails = seasonErrors.length > 0 ? `\n\nDetailed errors:\n${seasonErrors.join('\n')}` : '';
          const suggestion = seasonErrors.some(err => err.includes('total records but returned empty'))
            ? '\n\nThis appears to be an API issue where the server reports episodes exist but returns empty data. Try:\n1. Navigate to individual season pages\n2. Check if episodes need different permissions\n3. Try refreshing the page and trying again'
            : '\n\nTry navigating to a specific season page instead.';

          throw new Error(`No episodes found in any of the ${seasons.length} seasons.${errorDetails}${suggestion}`);
        }

      } catch (error) {
        console.error('Error getting all seasons:', error);
        throw new Error(`Failed to get episodes for entire show: ${error.message}`);
      }

    } else {
      try {
        const opts = { SeasonId: seasonIdFromPath };
        const res1 = await api.getEpisodes(showId, opts);
        items = (res1 && res1.Items) || [];

        if (items.length > 0) {
          showNotification(`Found ${items.length} episodes in season`, 'info', 2000);
        }
      } catch (e) {
        console.warn('getEpisodes failed:', e);
      }

      if (!items.length) {
        try {
          updateProgress(0, 0, "Fetching Season Episodes...");
          const data = await fetchEpisodesREST(server, token, showId, seasonIdFromPath);
          items = (data && data.Items) || [];

          // If REST API failed or returned empty, try the Items API fallback
          if (!items.length && (data?.apiNotAvailable || data?.apiError)) {
            console.log('[Debug] REST API failed, trying Items API fallback for single season...');
            try {
              const fallbackData = await fetchFolderItems(server, token, seasonIdFromPath);
              items = fallbackData?.Items?.filter(item => item.Type === 'Episode') || [];
              if (items.length > 0) {
                console.log(`[Debug] ✓ Items API fallback successful - got ${items.length} episodes`);
                showNotification(`Found ${items.length} episodes in season`, 'info', 2000);
              }
            } catch (fallbackError) {
              console.warn('[Debug] Items API fallback also failed:', fallbackError.message);
            }
          }
        } catch (e) {
          console.warn('REST Episodes fallback failed:', e);
        }
      }
    }

    if (!items.length) {
      const scope = isWholeShow ? 'entire show' : 'season';
      throw new Error(`No episodes found for ${scope}.\nShow ID: ${showId}\nSeason ID: ${seasonIdFromPath}\n\nPossible causes:\n- Season has no episodes\n- API permissions issue\n- Content metadata not loaded\n\nTry refreshing the page or contact your server admin.`);
    }

    // Apply deduplication
    items = deduplicateItems(items);

    // Ensure all items have names before returning
    items = items.map(item => ensureItemName(item));

    return items;
  }

  async function processMovie(server, token, itemInfo) {
    currentOperation = 'movie';

    // Failsafe: If API didn't provide Name, try to extract from page
    if (!itemInfo.Name || !itemInfo.Name.trim()) {
      const titleMatch = document.querySelector('h1, .itemName, .detailPageTitle, h3.itemName');
      if (titleMatch) {
        itemInfo.Name = titleMatch.textContent.trim();
        console.log(`[EmbyGrab] API didn't provide movie name, extracted from page: ${itemInfo.Name}`);
      }
    }

    // Failsafe: If still no name, use filename or ID
    if (!itemInfo.Name || !itemInfo.Name.trim()) {
      itemInfo.Name = itemInfo.FileName?.split('.')[0] || `Movie_${itemInfo.Id}`;
      console.warn(`[EmbyGrab] Could not find movie name from API or page. Using fallback: ${itemInfo.Name}`);
    }

    showNotification(`Found movie: ${itemInfo.Name}`, 'info', 2000);
    return [itemInfo];
  }

  // ---------- Main Logic ----------
  async function handleButtonClick() {
    console.log('[EmbyGrab] Button clicked'); // debug log
    window._embyGrabLargeFolderConfirmed = false; // Reset guard for new operation

    if (isProcessing) {
      if (abortController) {
        abortController.abort();
        updateButtonState(false);
        showNotification('Operation cancelled', 'warning', 2000);
      }
      return;
    }

    abortController = new AbortController();

    try {
      updateButtonState(true, "Initializing...");
      showNotification('Initializing download link generation...', 'info');

      // Use the robust helper function
      const { server, token, userId } = getServerAndToken();

      if (!server || !token) {
        throw new Error('Could not read server address or access token. Please refresh the page and try again.');
      }

      const pageType = detectPageType();
      let items = [];

      console.log(`[Debug] Page type detected: ${pageType}, URL: ${window.location.href}`);

      const processFunction = async () => {
        // Handle server-root download
        if (pageType === 'server-root') {
          console.log('[Debug] Detected server-root page - whole server download');
          currentOperation = 'server';
          return await processServerRoot(server, token);
        }

        // Handle library download
        if (pageType === 'library') {
          const libraryId = getItemIdFromUrl();
          if (libraryId) {
            console.log('[Debug] Detected library page - library download');
            const itemInfo = await getItemInfo(server, token, libraryId);
            currentOperation = 'library';
            return await processLibrary(server, token, libraryId, itemInfo.Name || 'Library');
          }
        }

        // Existing handlers
        if (pageType === 'collection') {
          const collectionId = getItemIdFromUrl();
          if (!collectionId) {
            throw new Error("Could not detect collection ID. Please ensure you're on a collection page.");
          }

          console.log(`[Debug] Processing collection with ID: ${collectionId}`);
          return await processCollection(server, token, collectionId);

        } else if (pageType === 'folder') {
          const folderId = getCurrentFolderId();
          if (!folderId) {
            throw new Error("Could not detect folder ID. Please ensure you're on a library or folder page.");
          }

          console.log(`[Debug] Processing folder with ID: ${folderId}`);
          return await processFolder(server, token, folderId);

        } else {
          // Generic item page - fetch info and route based on Type
          const itemId = getItemIdFromUrl();
          if (!itemId) {
            throw new Error("Could not detect item ID. Please navigate to a specific movie, show, episode, or folder page.");
          }

          updateProgress(0, 0, "Getting Item Info...");
          let itemInfo;

          try {
            itemInfo = await getItemInfo(server, token, itemId, userId);
          } catch (error) {
            // If item info fails with 404, try alternative methods
            // Some servers (especially through Emby Connect) don't support /Items/{id}
            if (error.message && error.message.includes('404')) {
              console.log(`[Debug] Item ${itemId} returned 404 from Items API`);

              // Try to parse IDs from page (works for TV shows/seasons)
              const ids = parseIdsFromPage();
              if (ids) {
                console.log(`[Debug] Detected TV show/season from page, trying processShow`);
                try {
                  return await processShow(server, token, api);
                } catch (showError) {
                  console.log(`[Debug] processShow failed:`, showError.message);
                }
              }

              // Try as collection/boxset
              console.log(`[Debug] Trying as collection/boxset`);
              try {
                return await processCollection(server, token, itemId);
              } catch (collectionError) {
                console.log(`[Debug] Collection processing failed:`, collectionError.message);

                // Try as folder
                console.log(`[Debug] Trying as folder`);
                try {
                  return await processFolder(server, token, itemId);
                } catch (folderError) {
                  console.log(`[Debug] Folder processing failed:`, folderError.message);

                  // If user cancelled, don't create fallback - re-throw the error
                  if (folderError.message === 'Operation cancelled' ||
                    folderError.message === 'User cancelled folder download' ||
                    folderError.message === 'User cancelled collection download' ||
                    folderError.message === 'User cancelled whole show download') {
                    throw folderError;
                  }

                  // Last resort: treat as single downloadable item (movie/episode)
                  // Create a minimal item object with just the ID
                  console.log(`[Debug] Treating as single downloadable item with ID ${itemId}`);
                  const hash = window.location.hash;
                  const titleMatch = document.querySelector('h1, .itemName, .detailPageTitle');
                  const title = titleMatch ? titleMatch.textContent.trim() : `Item ${itemId}`;
                  const isEpisode = hash.includes('/tv/') || hash.includes('SeriesId=');

                  // Try to extract year from page for movies
                  let year = null;
                  if (!isEpisode) {
                    const yearMatch = document.querySelector('.itemMiscInfo, .year, .detailPageYear');
                    if (yearMatch) {
                      const yearText = yearMatch.textContent.match(/\b(19|20)\d{2}\b/);
                      if (yearText) {
                        year = parseInt(yearText[0]);
                      }
                    }
                  }

                  return [{
                    Id: itemId,
                    Name: title,
                    Type: isEpisode ? 'Episode' : 'Movie',
                    MediaType: 'Video',
                    Container: 'mkv', // Reasonable default
                    ProductionYear: year
                  }];
                }
              }
            }
            throw error;
          }

          if (!itemInfo || !itemInfo.Type) {
            throw new Error(
              `Could not fetch information for item ID ${itemId}. ` +
              `The item may not exist, you may not have permission to access it, ` +
              `or it may be a special item type.`
            );
          }

          console.log(`[Debug] Item info for ID ${itemId}:`, itemInfo);
          console.log(`[Debug] Item Type: ${itemInfo.Type}, Name: ${itemInfo.Name}`);

          // Route based on explicit Type field from API
          switch (itemInfo.Type) {
            case "Movie":
              console.log(`[Debug] Processing as single movie`);
              return await processMovie(server, token, itemInfo);

            case "Episode":
            case "Audio":
            case "Video":
            case "MusicVideo":
              // Failsafe: If API didn't provide Name, try to extract from page
              if (!itemInfo.Name || !itemInfo.Name.trim()) {
                const titleMatch = document.querySelector('h1, .itemName, .detailPageTitle, h3.itemName');
                if (titleMatch) {
                  itemInfo.Name = titleMatch.textContent.trim();
                  console.log(`[EmbyGrab] API didn't provide ${itemInfo.Type} name, extracted from page: ${itemInfo.Name}`);
                }
              }
              // Failsafe: If still no name, use filename or ID
              if (!itemInfo.Name || !itemInfo.Name.trim()) {
                itemInfo.Name = itemInfo.FileName?.split('.')[0] || `${itemInfo.Type}_${itemInfo.Id}`;
                console.warn(`[EmbyGrab] Could not find ${itemInfo.Type} name. Using fallback: ${itemInfo.Name}`);
              }

              console.log(`[Debug] Processing as single ${itemInfo.Type}: ${itemInfo.Name}`);
              currentOperation = itemInfo.Type.toLowerCase();
              showNotification(`Found ${itemInfo.Type}: ${itemInfo.Name}`, 'info', 2000);
              return [itemInfo];

            case "Series":
            case "Season":
              console.log(`[Debug] Processing as TV ${itemInfo.Type}: ${itemInfo.Name}`);
              updateProgress(0, 0, "Finding Episodes...");
              return await processShow(server, token, api);

            case "BoxSet":
            case "Collection":
              console.log(`[Debug] Processing as BoxSet/Collection: ${itemInfo.Name}`);
              return await processCollection(server, token, itemId);

            case "Folder":
            case "CollectionFolder":
            case "UserView":
              console.log(`[Debug] Processing as Folder: ${itemInfo.Name}`);
              return await processFolder(server, token, itemId);

            default:
              // Unknown type - log and try to determine best approach
              console.warn(`[Debug] Unknown item type: ${itemInfo.Type} for ${itemInfo.Name}`);

              // If it has children, treat as folder/collection
              if (itemInfo.IsFolder || itemInfo.ChildCount > 0) {
                console.log(`[Debug] Item has children - treating as folder/collection`);

                // Try collection API first, fall back to folder API
                try {
                  return await processCollection(server, token, itemId);
                } catch (collectionError) {
                  console.log(`[Debug] Collection processing failed, trying folder processing`);
                  return await processFolder(server, token, itemId);
                }
              } else {
                // Treat as single downloadable item
                console.log(`[Debug] Treating unknown type as single downloadable item`);
                currentOperation = 'item';
                showNotification(`Found item: ${itemInfo.Name}`, 'info', 2000);
                return [itemInfo];
              }
          }
        }
      };

      items = await processWithProgress(processFunction);

      // Apply final deduplication at the top level
      items = deduplicateItems(items);

      // Show results dialog or copy directly based on settings
      const shouldShowResultsDialog = Settings.get('showResultsDialog');

      if (shouldShowResultsDialog) {
        // Mark items as downloaded if history is enabled
        if (Settings.get('enableHistory') && items.length > 0) {
          DownloadHistory.mark(items);
          console.log(`[History] Marked ${items.length} items as downloaded`);
        }

        // Show the post-scan results dialog
        showResultsDialog(items, server, token, currentOperation);

        // Log to console for debugging
        const outputFormat = Settings.get('outputFormat');
        const formatter = OutputFormatters[outputFormat];
        const text = formatter(items, server, token);
        const formatName = CONFIG.outputFormats[outputFormat];
        console.info(`[EmbyGrab] Operation: ${currentOperation}, Items: ${items.length}, Format: ${formatName}\n${text}`);
      } else {
        // Legacy behavior - directly copy to clipboard
        updateProgress(0, items.length, "Generating Links...");

        const outputFormat = Settings.get('outputFormat');
        const formatter = OutputFormatters[outputFormat];

        if (!formatter) {
          throw new Error(`Unknown output format: ${outputFormat}`);
        }

        const text = formatter(items, server, token);

        // Copy to clipboard
        updateProgress(items.length, items.length, "Copying to Clipboard...");
        await copyToClipboard(text);

        // Success feedback
        const itemCount = items.length;
        const operationType = currentOperation || 'item';
        const formatName = CONFIG.outputFormats[outputFormat];

        // Calculate file size info for success message
        const sizeInfo = calculateTotalSize(items);
        const sizeText = sizeInfo.totalSize > 0 ?
          ` (${formatFileSize(sizeInfo.totalSize)}${sizeInfo.hasEstimates ? ' estimated' : ''})` : '';

        let successMessage = `Copied ${itemCount} download link${itemCount > 1 ? 's' : ''} (${formatName})${sizeText} to clipboard!`;
        if (operationType === 'folder') {
          const episodeCount = items.filter(i => i.Type === 'Episode').length;
          const directCount = itemCount - episodeCount;

          if (episodeCount > 0 && directCount > 0) {
            successMessage = `Copied ${itemCount} items from folder (${directCount} files + ${episodeCount} episodes) as ${formatName}${sizeText} to clipboard!`;
          } else if (episodeCount > 0) {
            successMessage = `Copied ${episodeCount} episodes from TV series in folder as ${formatName}${sizeText} to clipboard!`;
          } else {
            successMessage = `Copied ${itemCount} items from folder as ${formatName}${sizeText} to clipboard!`;
          }
        } else if (operationType === 'collection') {
          successMessage = `Copied ${itemCount} items from collection as ${formatName}${sizeText} to clipboard!`;
        } else if (operationType === 'show') {
          const ids = parseIdsFromPage();
          const isWholeShow = ids && (ids.seasonIdFromPath === ids.showId);
          if (isWholeShow) {
            successMessage = `Copied ${itemCount} episodes from entire show as ${formatName}${sizeText} to clipboard!`;
          } else {
            successMessage = `Copied ${itemCount} episodes from season as ${formatName}${sizeText} to clipboard!`;
          }
        }

        showNotification(successMessage, 'success');
        console.info(`[EmbyGrab] Operation: ${operationType}, Items: ${itemCount}, Format: ${formatName}\n${text}`);
      };

      try {
        items = await processFunction();
      } catch (error) {
        if (error.message !== 'Operation cancelled') {
          console.error('[EmbyGrab] Fatal error during processing:', error);
          showNotification(`Error: ${error.message}`, 'error', 5000);
        }
        throw error; // Re-throw to outer catch
      }

      if (abortController.signal.aborted) {
        throw new Error('Operation cancelled');
      }

    } catch (error) {
      if (error.message === 'Operation cancelled' ||
        error.message === 'User cancelled folder download' ||
        error.message === 'User cancelled collection download' ||
        error.message === 'User cancelled whole show download') {
        console.log('Operation cancelled by user');
        return;
      }

      console.error('Error getting download links:', error);
      const message = error.message || 'Unknown error occurred';
      showNotification(`Error: ${message}`, 'error', 6000);
    } finally {
      // CRITICAL START: Ensure button state is ALWAYS reset
      updateButtonState(false);
      isProcessing = false;
      currentOperation = null;
      hideProgressModal();
      abortController = null;
    }
  } // Closes handleButtonClick
  function applyDarkMode() {
    const darkMode = Settings.get('darkMode');
    console.log('[EmbyGrab] Dark mode setting:', darkMode);

    if (darkMode) {
      // Add dark mode class to body
      document.body.classList.add('embygrab-dark-mode');
      console.log('[EmbyGrab] Applied dark mode class to body');

      // Apply dark mode to download manager and settings panel if they exist
      const applyToElements = () => {
        const manager = document.querySelector('#emby-grab-manager');
        const settings = document.querySelector('#emby-grab-settings');
        if (manager) {
          manager.setAttribute('data-dark-mode', 'true');
          console.log('[EmbyGrab] Set data-dark-mode on manager:', manager.getAttribute('data-dark-mode'));
        }
        if (settings) {
          settings.setAttribute('data-dark-mode', 'true');
          console.log('[EmbyGrab] Set data-dark-mode on settings:', settings.getAttribute('data-dark-mode'));
        }
      };

      // Apply immediately and watch for changes
      applyToElements();
      const observer = new MutationObserver(applyToElements);
      observer.observe(document.body, { childList: true, subtree: true });

      // Inject dark mode styles if not already present
      if (!document.getElementById('embygrab-dark-mode-styles')) {
        const style = document.createElement('style');
        style.id = 'embygrab-dark-mode-styles';
        console.log('[EmbyGrab] Injecting dark mode CSS styles');
        style.textContent = `
                        /* ========== Emby-Themed Dark Mode Colors ========== */
                        /* Emby uses:
                           - Background: #101010 (very dark gray, almost black)
                           - Card/Panel: #1c1c1c (slightly lighter dark gray)
                           - Borders: #2a2a2a (subtle gray borders)
                           - Text: #e0e0e0 (light gray text)
                           - Accent: #00a4dc (Emby blue) and #52b54b (green for success)
                        */

                        body.embygrab-dark-mode {
                          background-color: #101010 !important;
                        color: #e0e0e0 !important;
          }

                        body.embygrab-dark-mode *::-webkit-scrollbar {
                          width: 10px;
                        height: 10px;
          }

                        body.embygrab-dark-mode *::-webkit-scrollbar-track {
                          background: #1c1c1c;
          }

                        body.embygrab-dark-mode *::-webkit-scrollbar-thumb {
                          background: #3a3a3a;
                        border-radius: 5px;
          }

                        body.embygrab-dark-mode *::-webkit-scrollbar-thumb:hover {
                          background: #4a4a4a;
          }

                        /* Emby containers */
                        body.embygrab-dark-mode .emby-container,
                        body.embygrab-dark-mode .card,
                        body.embygrab-dark-mode .cardContent,
                        body.embygrab-dark-mode .itemsContainer,
                        body.embygrab-dark-mode .verticalSection {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
          }

                        body.embygrab-dark-mode .cardText,
                        body.embygrab-dark-mode .cardTextCentered,
                        body.embygrab-dark-mode .sectionTitle,
                        body.embygrab-dark-mode .itemName,
                        body.embygrab-dark-mode .detailPageTitle {
                          color: #e0e0e0 !important;
          }

                        body.embygrab-dark-mode .pageTitleWithLogo,
                        body.embygrab-dark-mode h1,
                        body.embygrab-dark-mode h2,
                        body.embygrab-dark-mode h3 {
                          color: #ffffff !important;
          }

                        body.embygrab-dark-mode .backgroundContainer,
                        body.embygrab-dark-mode .mainAnimatedPage {
                          background-color: #101010 !important;
          }

                        /* ========== EmbyGrab Download Manager Dark Mode ========== */
                        #emby-grab-manager[data-dark-mode="true"],
                        body.embygrab-dark-mode #emby-grab-manager {
                          background-color: #1c1c1c !important;
          }

                        /* Main container backgrounds */
                        #emby-grab-manager[data-dark-mode="true"] #list-view,
                        #emby-grab-manager[data-dark-mode="true"] #stats-view,
                        body.embygrab-dark-mode #emby-grab-manager #list-view,
                        body.embygrab-dark-mode #emby-grab-manager #stats-view {
                          background-color: #151515 !important;
                        border-color: #2a2a2a !important;
          }

                        #emby-grab-manager[data-dark-mode="true"] #download-info,
                        body.embygrab-dark-mode #emby-grab-manager #download-info {
                          background-color: #1c1c1c !important;
                        border-color: #2a2a2a !important;
          }

                        /* Text colors - light gray for readability */
                        #emby-grab-manager[data-dark-mode="true"],
                        #emby-grab-manager[data-dark-mode="true"] *,
                        body.embygrab-dark-mode #emby-grab-manager,
                        body.embygrab-dark-mode #emby-grab-manager * {
                          color: #e0e0e0 !important;
          }

                        /* Headings - pure white for emphasis */
                        #emby-grab-manager[data-dark-mode="true"] h3,
                        #emby-grab-manager[data-dark-mode="true"] h4,
                        body.embygrab-dark-mode #emby-grab-manager h3,
                        body.embygrab-dark-mode #emby-grab-manager h4 {
                          color: #ffffff !important;
          }

                        /* Inputs and form elements */
                        #emby-grab-manager[data-dark-mode="true"] input,
                        #emby-grab-manager[data-dark-mode="true"] select,
                        #emby-grab-manager[data-dark-mode="true"] textarea,
                        body.embygrab-dark-mode #emby-grab-manager input,
                        body.embygrab-dark-mode #emby-grab-manager select,
                        body.embygrab-dark-mode #emby-grab-manager textarea {
                          background-color: #252525 !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #emby-grab-manager[data-dark-mode="true"] input::placeholder,
                        body.embygrab-dark-mode #emby-grab-manager input::placeholder {
                          color: #888888 !important;
          }

                        /* Buttons - dark gray with Emby blue accent on hover */
                        #emby-grab-manager[data-dark-mode="true"] button,
                        body.embygrab-dark-mode #emby-grab-manager button {
                          background-color: #2a2a2a !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #emby-grab-manager[data-dark-mode="true"] button:hover,
                        body.embygrab-dark-mode #emby-grab-manager button:hover {
                          background-color: #3a3a3a !important;
                        border-color: #00a4dc !important;
          }

                        /* Primary action buttons - Emby green */
                        #emby-grab-manager[data-dark-mode="true"] #start-all,
                        #emby-grab-manager[data-dark-mode="true"] #download-selected,
                        body.embygrab-dark-mode #emby-grab-manager #start-all,
                        body.embygrab-dark-mode #emby-grab-manager #download-selected {
                          background-color: #52b54b !important;
                        color: white !important;
                        border-color: #52b54b !important;
          }

                        #emby-grab-manager[data-dark-mode="true"] #start-all:hover,
                        #emby-grab-manager[data-dark-mode="true"] #download-selected:hover,
                        body.embygrab-dark-mode #emby-grab-manager #start-all:hover,
                        body.embygrab-dark-mode #emby-grab-manager #download-selected:hover {
                          background-color: #5ec556 !important;
                        border-color: #5ec556 !important;
          }

                        /* Pause button - Emby blue */
                        #emby-grab-manager[data-dark-mode="true"] #pause-all,
                        body.embygrab-dark-mode #emby-grab-manager #pause-all {
                          background-color: #00a4dc !important;
                        color: white !important;
                        border-color: #00a4dc !important;
          }

                        #emby-grab-manager[data-dark-mode="true"] #pause-all:hover,
                        body.embygrab-dark-mode #emby-grab-manager #pause-all:hover {
                          background-color: #00b8f5 !important;
                        border-color: #00b8f5 !important;
          }

                        /* SVG icons inherit text color */
                        #emby-grab-manager[data-dark-mode="true"] svg,
                        body.embygrab-dark-mode #emby-grab-manager svg {
                          fill: currentColor !important;
          }

                        /* Settings panel - same Emby styling */
                        #emby-grab-settings[data-dark-mode="true"],
                        body.embygrab-dark-mode #emby-grab-settings {
                          background-color: rgba(28, 28, 28, 0.98) !important;
          }

          #emby-grab-settings[data-dark-mode="true"] > div,
                        #emby-grab-settings[data-dark-mode="true"] div,
          body.embygrab-dark-mode #emby-grab-settings > div,
                        body.embygrab-dark-mode #emby-grab-settings div {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
                        border-color: #2a2a2a !important;
          }

                        #emby-grab-settings[data-dark-mode="true"] input,
                        #emby-grab-settings[data-dark-mode="true"] select,
                        body.embygrab-dark-mode #emby-grab-settings input,
                        body.embygrab-dark-mode #emby-grab-settings select {
                          background-color: #252525 !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #emby-grab-settings[data-dark-mode="true"] button,
                        body.embygrab-dark-mode #emby-grab-settings button {
                          background-color: #2a2a2a !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #emby-grab-settings[data-dark-mode="true"] button:hover,
                        body.embygrab-dark-mode #emby-grab-settings button:hover {
                          background-color: #3a3a3a !important;
                        border-color: #00a4dc !important;
          }

                        /* Notifications */
                        body.embygrab-dark-mode .emby-dl-notification {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
                        border-color: #2a2a2a !important;
          }

                        /* All dialogs/modals with data-dark-mode attribute */
                        [data-dark-mode="true"] {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
          }

                        [data-dark-mode="true"] h1,
                        [data-dark-mode="true"] h2,
                        [data-dark-mode="true"] h3,
                        [data-dark-mode="true"] h4 {
                          color: #ffffff !important;
          }

                        [data-dark-mode="true"] input,
                        [data-dark-mode="true"] select,
                        [data-dark-mode="true"] textarea {
                          background-color: #252525 !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        [data-dark-mode="true"] button {
                          background-color: #2a2a2a !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        [data-dark-mode="true"] button:hover {
                          background-color: #3a3a3a !important;
                        border-color: #00a4dc !important;
          }

                        [data-dark-mode="true"] label,
                        [data-dark-mode="true"] p,
                        [data-dark-mode="true"] span,
                        [data-dark-mode="true"] div {
                          color: #e0e0e0 !important;
          }

                        /* Override inline background colors in dark mode */
                        [data-dark-mode="true"] div[style*="background"] {
                          background-color: #252525 !important;
          }

                        /* Specifically target info boxes with light backgrounds */
                        [data-dark-mode="true"] div[style*="background: #f"] {
                          background-color: #1c1c1c !important;
          }

                        [data-dark-mode="true"] a {
                          color: #00a4dc !important;
          }

                        [data-dark-mode="true"] a:hover {
                          color: #00b8f5 !important;
          }

          /* Borders for all dialogs */
          [data-dark-mode="true"] > div,
                        [data-dark-mode="true"] hr {
                          border-color: #2a2a2a !important;
          }

                        /* ========== Checkbox Styling for Dark Mode ========== */
                        body.embygrab-dark-mode input[type="checkbox"],
                        [data-dark-mode="true"] input[type="checkbox"] {
                          appearance: none;
                        -webkit-appearance: none;
                        -moz-appearance: none;
                        background-color: #2a2a2a !important;
                        border: 2px solid #4a4a4a !important;
                        border-radius: 3px !important;
                        position: relative;
                        cursor: pointer;
          }

                        body.embygrab-dark-mode input[type="checkbox"]:hover,
                        [data-dark-mode="true"] input[type="checkbox"]:hover {
                          border-color: #6a6a6a !important;
                        background-color: #3a3a3a !important;
          }

                        body.embygrab-dark-mode input[type="checkbox"]:checked,
                        [data-dark-mode="true"] input[type="checkbox"]:checked {
                          background-color: #10b981 !important;
                        border-color: #10b981 !important;
          }

                        body.embygrab-dark-mode input[type="checkbox"]:checked::after,
                        [data-dark-mode="true"] input[type="checkbox"]:checked::after {
                          content: "✓";
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        color: white !important;
                        font-size: 12px;
                        font-weight: bold;
          }
                        `;
        document.head.appendChild(style);
      }
    } else {
      // Remove dark mode
      document.body.classList.remove('embygrab-dark-mode');
      const style = document.getElementById('embygrab-dark-mode-styles');
      if (style) {
        style.remove();
      }
    }
  }

  function initialize() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
      return;
    }

    setTimeout(() => {
      applyDarkMode();
      createButton();
      setupKeyboardShortcuts();
      // Only start auto-detection if user explicitly enabled it
      if (Settings.get('enableJDownloaderAutoDetect')) {
        startJDownloaderDetection();
      }

      // NEW v6.55: Background pre-fetching (Disabled by default to prevent UI hangs)
      if (Settings.get('enableBackgroundPrefetch') === true) {
        startBackgroundPrefetch();
      }

      console.log('EmbyGrab v1.0 loaded! 🚀 Features: 10+ formats, built-in download manager, wget/curl scripts, JDownloader integration, selective downloads!');
    }, 1000);
  }

  // NEW v6.55: Background Pre-fetching
  let prefetchInProgress = false;
  let prefetchedData = null;
  let prefetchPageId = null;

  async function startBackgroundPrefetch() {
    if (prefetchInProgress) return;

    try {
      const pageType = detectPageType();

      // Only prefetch for folder, collection, and show pages
      if (!['folder', 'collection', 'item'].includes(pageType)) {
        return;
      }

      const pageId = getCurrentFolderId();
      if (!pageId) return;

      // Check if we already prefetched this page
      if (prefetchPageId === pageId && prefetchedData) {
        console.log('[Prefetch] Already prefetched this page');
        return;
      }

      console.log(`[Prefetch] Starting background prefetch for ${pageType} (${pageId})`);
      prefetchInProgress = true;
      prefetchPageId = pageId;

      const { server, token } = getServerAndToken();
      if (!server || !token) {
        console.log('[Prefetch] No server/token available');
        prefetchInProgress = false;
        return;
      }

      // Prefetch in background (don't await)
      setTimeout(async () => {
        try {
          // Use cache if available
          const cacheKey = RequestCache.makeKey(`${server}/emby/Items`, { ParentId: pageId });
          let data = RequestCache.get(cacheKey);

          if (!data) {
            // Fetch and cache silently
            const items = await fetchAllFolderItems(server, token, pageId, null, { silent: true });
            prefetchedData = items;
            console.log(`[Prefetch] Prefetched ${items.length} items for quick access`);
          } else {
            prefetchedData = data;
            console.log(`[Prefetch] Using cached data (${data.length} items)`);
          }
        } catch (error) {
          console.log('[Prefetch] Failed:', error.message);
        } finally {
          prefetchInProgress = false;
        }
      }, 2000); // Wait 2 seconds after page load

    } catch (error) {
      console.log('[Prefetch] Error:', error.message);
      prefetchInProgress = false;
    }
  }

  function cleanup() {
    if (button) {
      button.remove();
      button = null;
    }
    if (settingsPanel) {
      hideSettingsPanel();
    }
    if (progressModal) {
      hideProgressModal();
    }
    stopJDownloaderDetection(); // Stop auto-detection when cleaning up
    document.querySelectorAll('.emby-dl-notification').forEach(n => n.remove());
    document.querySelectorAll('[style*="2147483649"]').forEach(n => n.remove());
    const settingsBtn = document.getElementById(CONFIG.settingsId);
    if (settingsBtn) {
      settingsBtn.remove();
    }
  }

  // Handle SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;

      // Cleanup previous page state
      cleanup();

      // Clear prefetch state
      prefetchedData = null;
      prefetchPageId = null;

      // Re-initialize after a short delay to allow DOM to settle
      setTimeout(() => {
        initialize();

        // Trigger prefetch if enabled
        if (Settings.get('enableBackgroundPrefetch')) {
          startBackgroundPrefetch();
        }
      }, 500);
    }
  }).observe(document, { subtree: true, childList: true });

  // Initialize on page load
  initialize();

})();