// ==UserScript==
// @name         PulseGrab - Complete Download Manager
// @namespace    pulsegrab.manager
// @version      1.0.1
// @description  Universal media server download tool for Emby, Plex & Jellyfin: 10 output formats, QR codes, email, built-in manager, wget/curl scripts, JDownloader integration & more!
// @match        https://*/emby/*
// @match        https://app.emby.media/*
// @match        https://app.plex.tv/*
// @match        https://*:32400/web/*
// @match        http://*:32400/web/*
// @match        *://*/web/index.html*
// @match        *://*/web/*
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Storage Migration (EmbyGrab → PulseGrab) ----------
  try {
    const legacySettings = GM_getValue('emby_dl_settings', null);
    if (legacySettings && !GM_getValue('pulse_dl_settings', null)) {
      GM_setValue('pulse_dl_settings', legacySettings);
    }
    const legacyHistory = GM_getValue('emby_dl_history', null);
    if (legacyHistory && !GM_getValue('pulse_dl_history', null)) {
      GM_setValue('pulse_dl_history', legacyHistory);
    }
  } catch (e) { /* migration failed silently */ }

  // ---------- Server Type Detection ----------
  function detectServerType() {
    const url = window.location.href;
    const hash = window.location.hash;
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // Plex checks (most distinctive)
    if (url.includes('app.plex.tv') || url.includes(':32400/web')) return 'plex';

    // Jellyfin checks (must come before Emby — Jellyfin also has ApiClient)
    if (win.ServerConnections) return 'jellyfin';
    try { if (localStorage.getItem('jellyfin_credentials')) return 'jellyfin'; } catch (e) {}
    if (hash.startsWith('#/') && hash.includes('#/details')) return 'jellyfin';

    // Emby checks
    if (url.includes('/emby/') || url.includes('app.emby.media')) return 'emby';
    if (win.ApiClient && !win.ServerConnections) return 'emby';
    if (hash.includes('#!/item') || hash.includes('#!/home')) return 'emby';

    // Heuristic: page title
    const title = document.title.toLowerCase();
    if (title.includes('jellyfin')) return 'jellyfin';
    if (title.includes('emby')) return 'emby';
    if (title.includes('plex')) return 'plex';

    return 'emby'; // Default fallback to Emby behavior
  }

  const SERVER_TYPE = detectServerType();
  console.log(`[PulseGrab] Detected server type: ${SERVER_TYPE}`);

  // ---------- API Prefix Helper ----------
  function apiPrefix() {
    return SERVER_TYPE === 'emby' ? '/emby' : '';
  }

  // ---------- Plex Constants & Token Capture ----------
  let capturedPlexToken = null;
  let capturedPlexServer = null;
  const PLEX_CLIENT_ID = (function() {
    if (SERVER_TYPE !== 'plex') return null;
    let id = GM_getValue('pulse_plex_client_id', null);
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      GM_setValue('pulse_plex_client_id', id);
    }
    return id;
  })();

  // Hook fetch, XHR, and WebSocket to capture Plex token & server from outgoing requests
  if (SERVER_TYPE === 'plex') {
    // Helper: extract token & server URL from any URL string
    function _plexCapture(url) {
      if (!url) return;
      const s = String(url);
      const tokenMatch = s.match(/X-Plex-Token=([^&\s]+)/);
      if (tokenMatch) capturedPlexToken = tokenMatch[1];
      try {
        const parsed = new URL(s, window.location.origin);
        if (parsed.hostname.includes('plex.direct') ||
            (parsed.port && parsed.port !== '443' && parsed.port !== '80' &&
             !parsed.hostname.includes('plex.tv'))) {
          capturedPlexServer = parsed.origin;
        }
      } catch(e) {}
    }

    // Helper: extract token from headers (Headers object, plain object, or array)
    function _plexCaptureHeaders(headers) {
      if (!headers) return;
      try {
        let token = null;
        if (headers instanceof Headers) {
          token = headers.get('X-Plex-Token');
        } else if (Array.isArray(headers)) {
          const entry = headers.find(([k]) => k && k.toLowerCase() === 'x-plex-token');
          if (entry) token = entry[1];
        } else if (typeof headers === 'object') {
          token = headers['X-Plex-Token'] || headers['x-plex-token'];
        }
        if (token) capturedPlexToken = token;
      } catch(e) {}
    }

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        _plexCapture(url);
        _plexCaptureHeaders(args[1]?.headers);
        if (args[0] instanceof Request) _plexCaptureHeaders(args[0].headers);
      } catch(e) {}
      return originalFetch.apply(this, args);
    };

    // Intercept XMLHttpRequest
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try { _plexCapture(url); } catch(e) {}
      return origXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      if (name && name.toLowerCase() === 'x-plex-token' && value) {
        capturedPlexToken = value;
      }
      return origXhrSetHeader.call(this, name, value);
    };

    // Intercept WebSocket to capture token from connection URLs
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OrigWebSocket, {
      construct(target, args) {
        try { _plexCapture(args[0]); } catch(e) {}
        return new target(...args);
      }
    });
  }

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
    settingsId: "pulseDlSettings",
    progressId: "pulseDlProgress",
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
      backgroundColor: "transparent", // Set dynamically by getTheme()
      color: "white",
      border: "none",
      borderRadius: "12px",
      cursor: "pointer",
      font: "600 14px system-ui, sans-serif",
      boxShadow: "none", // Set dynamically by getTheme()
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
      theme: 'auto',
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
        let stored = GM_getValue('pulse_dl_settings', '{}');
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
        const stored = GM_getValue('pulse_dl_settings', '{}');
        const settings = JSON.parse(stored);
        settings[key] = value;
        GM_setValue('pulse_dl_settings', JSON.stringify(settings));
      } catch (e) {
        console.warn('Failed to save setting:', e);
      }
    },

    getAll() {
      try {
        const stored = GM_getValue('pulse_dl_settings', '{}');
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
  const SCRIPT_VERSION = '1.0.1';
  const STORED_VERSION = GM_getValue('scriptVersion', null);

  if (STORED_VERSION !== SCRIPT_VERSION) {
    if (Settings.get('debugMode')) {
      console.log(`[PulseGrab] Version change detected: ${STORED_VERSION || 'none'} -> ${SCRIPT_VERSION}`);
      console.log('[PulseGrab] Clearing cached download manager state...');
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

      const history = JSON.parse(GM_getValue('pulse_dl_history', '{}'));
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

      GM_setValue('pulse_dl_history', JSON.stringify(history));
      logDebug(`Marked ${items.length} items as downloaded`);
    },

    isDownloaded(itemId) {
      if (!Settings.get('enableHistory')) return false;
      const history = JSON.parse(GM_getValue('pulse_dl_history', '{}'));
      return history[itemId] !== undefined;
    },

    getDownloadDate(itemId) {
      const history = JSON.parse(GM_getValue('pulse_dl_history', '{}'));
      return history[itemId]?.date;
    },

    clear() {
      GM_setValue('pulse_dl_history', '{}');
      logDebug('Download history cleared');
      showNotification('Download history cleared', 'info', 2000);
    },

    getAll() {
      return JSON.parse(GM_getValue('pulse_dl_history', '{}'));
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
      a.download = `pulse-download-history-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('History exported', 'success', 2000);
    },

    import(jsonString) {
      try {
        const imported = JSON.parse(jsonString);
        const current = this.getAll();
        const merged = { ...current, ...imported };
        GM_setValue('pulse_dl_history', JSON.stringify(merged));
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
        const cacheData = GM_getValue('pulse_request_cache', '{}');
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
        const cacheData = GM_getValue('pulse_request_cache', '{}');
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

        GM_setValue('pulse_request_cache', JSON.stringify(cache));
        logDebug(`Cache SET: ${key}`);
      } catch (error) {
        console.warn('[Cache] Set failed:', error);
      }
    },

    remove(key) {
      try {
        const cacheData = GM_getValue('pulse_request_cache', '{}');
        const cache = JSON.parse(cacheData);
        delete cache[key];
        GM_setValue('pulse_request_cache', JSON.stringify(cache));
      } catch (error) {
        console.warn('[Cache] Remove failed:', error);
      }
    },

    clear() {
      GM_setValue('pulse_request_cache', '{}');
      logDebug('All cache cleared');
      showNotification('Request cache cleared', 'info', 2000);
    },

    getStats() {
      try {
        const cacheData = GM_getValue('pulse_request_cache', '{}');
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

      const key = `pulse_dl_progress_${operationType}_${itemId}`;
      GM_setValue(key, {
        timestamp: Date.now(),
        state: state,
        itemsProcessed: state.itemsProcessed || [],
        total: state.total || 0
      });
    },

    load(operationType, itemId) {
      if (!Settings.get('enableResume')) return null;

      const key = `pulse_dl_progress_${operationType}_${itemId}`;
      const data = GM_getValue(key);

      // Clear if older than 1 hour
      if (data && Date.now() - data.timestamp > 3600000) {
        this.clear(operationType, itemId);
        return null;
      }

      return data;
    },

    clear(operationType, itemId) {
      const key = `pulse_dl_progress_${operationType}_${itemId}`;
      GM_deleteValue(key);
    },

    clearAll() {
      // Clear all progress keys
      const keys = GM_listValues?.() || [];
      keys.filter(k => k.startsWith('pulse_dl_progress_')).forEach(k => GM_deleteValue(k));
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
  // Server brand themes — automatically applied based on detected server
  const ServerThemes = {
    emby: {
      primary: '#10b981',
      primaryHover: '#059669',
      primaryLight: '#34d399',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(16, 185, 129, 0.3)',
      gradient: 'linear-gradient(135deg, #10b981, #059669)',
      progressGradient: 'linear-gradient(90deg, #10b981, #34d399)',
      name: 'Emby',
      serverLabel: 'Emby Server'
    },
    plex: {
      primary: '#E5A00D',
      primaryHover: '#CC8A00',
      primaryLight: '#F5C518',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(229, 160, 13, 0.3)',
      gradient: 'linear-gradient(135deg, #E5A00D, #CC8A00)',
      progressGradient: 'linear-gradient(90deg, #E5A00D, #F5C518)',
      name: 'Plex',
      serverLabel: 'Plex Media Server'
    },
    jellyfin: {
      primary: '#AA5CC3',
      primaryHover: '#9333EA',
      primaryLight: '#C084FC',
      primaryDisabled: '#6b7280',
      shadow: 'rgba(170, 92, 195, 0.3)',
      gradient: 'linear-gradient(135deg, #AA5CC3, #9333EA)',
      progressGradient: 'linear-gradient(90deg, #AA5CC3, #C084FC)',
      name: 'Jellyfin',
      serverLabel: 'Jellyfin Server'
    }
  };

  // User-selectable accent override (overrides server theme)
  const AccentOverrides = {
    green:  { primary: '#10b981', primaryHover: '#059669', primaryLight: '#34d399', shadow: 'rgba(16, 185, 129, 0.3)', gradient: 'linear-gradient(135deg, #10b981, #059669)', progressGradient: 'linear-gradient(90deg, #10b981, #34d399)' },
    blue:   { primary: '#3b82f6', primaryHover: '#2563eb', primaryLight: '#60a5fa', shadow: 'rgba(59, 130, 246, 0.3)', gradient: 'linear-gradient(135deg, #3b82f6, #2563eb)', progressGradient: 'linear-gradient(90deg, #3b82f6, #60a5fa)' },
    purple: { primary: '#8b5cf6', primaryHover: '#7c3aed', primaryLight: '#a78bfa', shadow: 'rgba(139, 92, 246, 0.3)', gradient: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', progressGradient: 'linear-gradient(90deg, #8b5cf6, #a78bfa)' },
    amber:  { primary: '#E5A00D', primaryHover: '#CC8A00', primaryLight: '#F5C518', shadow: 'rgba(229, 160, 13, 0.3)', gradient: 'linear-gradient(135deg, #E5A00D, #CC8A00)', progressGradient: 'linear-gradient(90deg, #E5A00D, #F5C518)' }
  };

  function getTheme() {
    const userTheme = Settings.get('theme');
    const serverTheme = ServerThemes[SERVER_TYPE] || ServerThemes.emby;
    // Priority: user override > server brand
    if (userTheme && userTheme !== 'auto' && AccentOverrides[userTheme]) {
      return { ...serverTheme, ...AccentOverrides[userTheme] };
    }
    return serverTheme;
  }

  // ---------- Plex Item Normalization ----------
  function normalizeItemPlex(plexItem) {
    const typeMap = {
      'movie': 'Movie', 'episode': 'Episode', 'show': 'Series',
      'season': 'Season', 'track': 'Audio', 'album': 'MusicAlbum',
      'artist': 'MusicArtist', 'collection': 'Collection',
      'clip': 'Video', 'playlist': 'Playlist', 'photo': 'Photo'
    };

    const media = plexItem.Media?.[0];
    const part = media?.Part?.[0];

    return {
      Id: String(plexItem.ratingKey),
      Name: plexItem.title,
      Type: typeMap[plexItem.type] || 'Unknown',
      MediaType: media ? (plexItem.type === 'track' ? 'Audio' : plexItem.type === 'photo' ? 'Photo' : 'Video') : null,
      Container: part?.container || media?.container || null,
      IsFolder: ['show', 'season', 'collection', 'artist', 'album'].includes(plexItem.type),

      SeriesName: plexItem.grandparentTitle || null,
      SeasonName: plexItem.parentTitle || null,
      ParentIndexNumber: plexItem.parentIndex ?? null,
      IndexNumber: plexItem.index ?? null,

      ProductionYear: plexItem.year || null,
      Size: part?.size || 0,
      Path: part?.file || null,
      FileName: part?.file?.split('/')?.pop() || null,
      OriginalTitle: plexItem.originalTitle || null,

      MediaSources: media ? [{
        Id: String(media.id),
        Container: media.container,
        Size: part?.size || 0,
        Bitrate: media.bitrate,
        MediaStreams: (part?.Stream || []).map(stream => ({
          Type: stream.streamType === 1 ? 'Video' : stream.streamType === 2 ? 'Audio' : 'Subtitle',
          Codec: stream.codec,
          Height: stream.height,
          Width: stream.width,
          Language: stream.language || stream.languageCode,
          IsExternal: stream.streamType === 3 && !!stream.key,
          Index: stream.index,
          _plexStreamKey: stream.key || null
        }))
      }] : [],

      _plexPartKey: part?.key || null,
      _plexMedia: plexItem.Media || [], // Preserve all media versions for multi-version selector

      UserData: { Played: (plexItem.viewCount || 0) > 0 },
      CanDownload: true,
      _raw: plexItem
    };
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
            json: () => { try { return Promise.resolve(JSON.parse(response.responseText)); } catch (e) { return Promise.reject(new Error(`Invalid JSON: ${response.responseText.substring(0, 200)}`)); } }
          });
        },
        onerror: (error) => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  function logDebug(...args) {
    if (Settings.get('debugMode')) {
      console.log('[PulseGrab]', ...args);
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
        }).finally(() => {
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

    console.warn(`[PulseGrab] Item missing name field. Type: ${item.Type}, ID: ${item.Id}`);

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
    // Plex: simple download via Part.key
    if (SERVER_TYPE === 'plex') {
      if (item._plexPartKey) {
        return `${server}${item._plexPartKey}?download=1&X-Plex-Token=${token}`;
      }
      return null;
    }

    // Emby & Jellyfin: DirectPlay bypass
    const bypassMode = 'directplay';
    const emulateClient = Settings.get('emulateClient');
    const prefix = apiPrefix(); // '/emby' for Emby, '' for Jellyfin

    if (item.MediaSources && item.MediaSources.length > 0) {
      const source = item.MediaSources[0];
      const container = (source.Container || item.Container || 'mkv').toLowerCase();
      const tagParam = source.ETag ? `&Tag=${source.ETag}` : '';

      let clientParams = '';
      if (emulateClient) {
        const clientName = SERVER_TYPE === 'jellyfin' ? 'Jellyfin Web' : 'Emby Web';
        clientParams = `&DeviceId=PulseGrab_Bypass&DeviceName=PulseGrab&Client=${clientName}`;
      }

      let streamParams = `&MediaSourceId=${source.Id}${tagParam}${clientParams}&PlayMethod=DirectPlay&Copy=true&AudioCodec=copy&VideoCodec=copy`;

      if (bypassMode === 'directplay') {
        return `${server}${prefix}/Videos/${item.Id}/stream.${container}?api_key=${token}&Static=true${streamParams}`;
      } else if (bypassMode === 'remux') {
        return `${server}${prefix}/Videos/${item.Id}/stream.${container}?api_key=${token}&Static=false${streamParams}`;
      }
    }

    return `${server}${prefix}/Items/${item.Id}/Download?api_key=${token}`;
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
        if (preferredLangs.length === 0) return true;
        const lang = (sub.Language || '').toLowerCase();
        return preferredLangs.some(p => lang === p || lang.includes(p));
      })
      .map(sub => {
        let codec = (sub.Codec || 'srt').toLowerCase();
        if (codec === 'subrip') codec = 'srt';
        const lang = sub.Language || 'und';
        const baseName = videoFilename.substring(0, videoFilename.lastIndexOf('.'));
        const subFilename = `${baseName}.${lang}.${codec}`;

        let apiUrl = server;
        let apiToken = token;

        if (typeof getApiClient === 'function') {
          const client = getApiClient();
          if (client) {
            apiUrl = apiUrl || normalizeServerAddress(client._serverAddress);
            apiToken = apiToken || (client._userAuthInfo?.AccessToken) || client.accessToken;
          }
        }

        // Plex: external subs have a key path
        if (SERVER_TYPE === 'plex') {
          if (!sub._plexStreamKey) return null;
          return {
            url: `${apiUrl}${sub._plexStreamKey}?X-Plex-Token=${apiToken}`,
            filename: subFilename,
            language: lang,
            isDefault: sub.IsDefault,
            isForced: sub.IsForced
          };
        }

        // Emby & Jellyfin: /Videos/{id}/{sourceId}/Subtitles/{index}/Stream.{codec}
        const prefix = apiPrefix();
        const emulateClient = Settings.get('emulateClient');
        const tagParam = source.ETag ? `&Tag=${source.ETag}` : '';
        const clientName = SERVER_TYPE === 'jellyfin' ? 'Jellyfin Web' : 'Emby Web';
        let clientParams = '';
        if (emulateClient) {
          clientParams = `&DeviceId=PulseGrab_Bypass&DeviceName=PulseGrab&Client=${clientName}`;
        }
        const bypassParams = `${tagParam}${clientParams}&Static=true&PlayMethod=DirectPlay`;

        return {
          url: `${apiUrl}${prefix}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${codec}?api_key=${apiToken}${bypassParams}`,
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

  async function sendToJDownloader(items, server, token, packageName = 'PulseGrab Downloads') {
    const port = Settings.get('jdownloaderPort');

    // Deduplicate items by ID to prevent duplicates
    const uniqueItems = deduplicateItems(items);

    logDebug(`[JDownloader] Sending ${uniqueItems.length} unique items (filtered from ${items.length} total)`);

    // Build download entries with proper folder structure and filenames
    const downloadEntries = uniqueItems.map(item => {
      const downloadInfo = buildDownloadInfo(item, server, token);

      // Log items with potentially missing metadata
      if (!item.Name && !item.FileName && !item.Path) {
        console.warn(`[JDownloader] ⚠️ Item ${item.Id} has NO metadata fields (Name, FileName, Path). Server will likely send generic filename.`, {
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
      // by appending the filename to the download URL as a path segment

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
        source: 'PulseGrab'
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
PulseGrab JDownloader File Renamer
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
    print("PulseGrab JDownloader File Renamer")
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
REM PulseGrab JDownloader File Renamer for Windows
REM Generated: ${new Date().toLocaleString()}
REM Package: ${packageName}

setlocal enabledelayedexpansion

echo ============================================================
echo PulseGrab JDownloader File Renamer
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
# PulseGrab JDownloader File Renamer
# Generated: ${new Date().toLocaleString()}
# Package: ${packageName}

echo "============================================================"
echo "PulseGrab JDownloader File Renamer"
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
echo PulseGrab Download Script for Windows
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

      filename = `pulsegrab_${sanitizedPackageName}.bat`;
      fileType = 'text/plain';

    } else {
      // Unix Shell Script (Mac/Linux) using wget or curl
      scriptContent = `#!/bin/bash

echo "============================================"
echo "PulseGrab Download Script"
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
        filename = `pulsegrab_${sanitizedPackageName}.command`;
      } else {
        filename = `pulsegrab_${sanitizedPackageName}.sh`;
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
      packageName = `PulseGrab ${operationTitle} - ${new Date().toLocaleDateString()}`;
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
            background: ${getTheme().gradient};
            color: white; cursor: pointer; font: 600 14px system-ui;
            display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 3px 10px ${getTheme().shadow};
            transition: all 0.2s ease;
          " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px ${getTheme().shadow.replace('0.3', '0.45')}'"
             onmouseout="this.style.transform='';this.style.boxShadow='0 3px 10px ${getTheme().shadow}'">
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
          border-left: 3px solid ${getTheme().primary};
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
          showResultsDialog(items, server, token, operationType);
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
      const title = 'PulseGrab - Downloads Complete';
      let body = `${completed} download(s) completed successfully`;
      if (failed > 0) {
        body += `, ${failed} failed`;
      }

      try {
        const notification = new Notification(title, {
          body: body,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="green" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
          tag: 'pulsegrab-download-complete',
          requireInteraction: false
        });

        // Auto-close after 5 seconds
        setTimeout(() => notification.close(), 5000);
      } catch (error) {
        console.log('[PulseGrab] Notification error:', error);
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
    manager.id = 'pulse-grab-manager';
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
          background: ${getTheme().gradient};
          color: white; cursor: pointer; font: 700 13px system-ui;
          display: flex; align-items: center; justify-content: center; gap: 6px;
          box-shadow: 0 2px 8px ${getTheme().shadow}; transition: all 0.15s;
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
            <span id="completed-count" style="padding:2px 8px;border-radius:99px;font:600 11px system-ui;background:${isDarkMode ? getTheme().shadow.replace('0.3', '0.15') : '#d1fae5'};color:${isDarkMode ? getTheme().primaryLight : '#065f46'};">0 done</span>
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
          queueStatus.innerHTML = `<span style="color:${getTheme().primary};">●</span> All downloads complete!`;
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
          { label: 'Done', val: stats.completed, sub: totalDownloaded > 0 ? formatFileSize(totalDownloaded) : '', color: getTheme().primaryLight, bg: isDarkMode ? getTheme().shadow.replace('0.3', '0.12') : '#f0fdf4' },
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
              <div style="width:${stats.total > 0 ? (stats.completed / stats.total) * 100 : 0}%;background:${getTheme().progressGradient};transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.downloading / stats.total) * 100 : 0}%;background:linear-gradient(90deg,#6366f1,#818cf8);transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.paused / stats.total) * 100 : 0}%;background:linear-gradient(90deg,#f59e0b,#fbbf24);transition:width 0.4s;"></div>
              <div style="width:${stats.total > 0 ? (stats.error / stats.total) * 100 : 0}%;background:#ef4444;transition:width 0.4s;"></div>
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
              ${[
          { label: 'Done', color: getTheme().primary, n: stats.completed },
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
                      <div style="width:${fp}%;height:100%;background:${getTheme().progressGradient};"></div>
                    </div>
                  </div>
                  <div style="text-align:right;flex-shrink:0;">
                    <div style="font:700 12px system-ui;color:${fp === 100 ? getTheme().primary : isDarkMode ? '#94a3b8' : '#64748b'};">${fs.completed}/${fs.total}</div>
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
        completed: getTheme().primary,
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
                  ${groupStats.completed > 0 ? `<span>•</span><span style="color:${getTheme().primary};">${groupStats.completed} done</span>` : ''}
                  ${groupStats.error > 0 ? `<span>•</span><span style="color:#ef4444;">${groupStats.error} failed</span>` : ''}
                  ${groupStats.downloading > 0 ? `<span>•</span><span style="color:#3b82f6;">${groupStats.downloading} active</span>` : ''}
                </div>
                ${groupStats.completed > 0 ? `<div style="margin-top:5px;width:100%;height:3px;background:${isDarkMode ? '#1f2937' : '#e2e8f0'};border-radius:2px;overflow:hidden;">
                  <div style="width:${groupDonePercent}%;height:100%;background:${getTheme().progressGradient};transition:width 0.4s;"></div>
                </div>` : ''}
              </div>
              <button class="download-group-btn" data-group-path="${folderPath}" onclick="event.stopPropagation();" style="
                padding: 5px 11px; border-radius: 6px; flex-shrink:0;
                border: 1.5px solid ${getTheme().primary};
                background: ${isDarkMode ? getTheme().shadow.replace('0.3', '0.1') : '#ecfdf5'};
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
                          background:${isDarkMode ? getTheme().shadow.replace('0.3', '0.1') : '#ecfdf5'};
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
                          background:${isDarkMode ? getTheme().shadow.replace('0.3', '0.15') : '#d1fae5'};
                          display:flex;align-items:center;justify-content:center;color:${getTheme().primary};"
                          title="Download complete">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        </div>
                        <button data-action="redownload" data-index="${itemIndex}" title="Download again" style="
                          width:28px;height:28px;border-radius:7px;
                          border:1.5px solid ${getTheme().primary};
                          background:transparent;
                          color:${getTheme().primary};cursor:pointer;
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

      if (!item.url) {
        item.status = 'error';
        item.error = 'No download URL available for this item';
        renderQueue();
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

        // NEW v6.54: Try to start next downloads with a slight delay to avoid server stream limits
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
            errorMessage = SERVER_TYPE === 'plex' ? 'Access denied - Plex token may be expired. Refresh the page.' : SERVER_TYPE === 'jellyfin' ? 'Access denied - refresh the Jellyfin page and try again.' : 'Access denied - check your server credentials';
            if (Settings.get('bypassMode') === 'disabled') {
              errorMessage += ' (Bypass Mode Required)';

              // Only show the modal once per queue run to avoid spamming
              if (!window.bypassModalShown && SERVER_TYPE !== 'plex') {
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
          The server administrator has specifically disabled the "Allow media download" permission for your account or for these specific items.
        </p>
        
        <div style="background: ${isDarkMode ? '#371c1c' : '#fef2f2'}; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 20px; border-radius: 4px;">
          <h4 style="margin: 0 0 8px 0; font: 600 14px system-ui, sans-serif; color: ${isDarkMode ? '#fca5a5' : '#b91c1c'};">About Strict Bypass</h4>
          <p style="margin: 0; font: 13px/1.5 system-ui, sans-serif; color: ${isDarkMode ? '#fecaca' : '#991b1b'};">
            PulseGrab can attempt to circumvent this restriction by forcing "Direct Play" and regenerating the internal stream URLs to access the original file. 
            <br><br>
            <strong>Disclaimer:</strong> Bypassing constraints set by the server administrator may violate their terms of service. You are solely responsible for ensuring you have permission to download this content. For this reason, this feature is disabled by default.
            <br><br>
            If you enable this, you can turn it off anytime from the PulseGrab Settings gear icon under <strong>"Unlock / Bypass Options"</strong>.
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

          startNextDownload();
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
      { key: 'completed', label: 'Done', color: getTheme().primary },
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
    button.setAttribute('aria-label', 'Get download links with PulseGrab');
    button.setAttribute('title', 'PulseGrab - Get download links (Ctrl+D)');

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
      background: linear-gradient(90deg, ${getTheme().primary} 0%, ${getTheme().primaryLight} 50%, ${getTheme().primary} 100%);
      background-size: 200% 100%;
      animation: shimmer 2s infinite linear;
      width: 0%;
      transition: width 0.3s ease;
      border-radius: 8px;
      box-shadow: 0 0 12px ${getTheme().shadow.replace('0.3', '0.6')};
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
      // Check various possible size properties in server API responses
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
    panel.id = 'pulse-grab-settings';
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
      console.log('[PulseGrab] Applied dark mode attribute to settings panel');
    }

    const currentSettings = Settings.getAll();

    panel.innerHTML = `
      <!-- Header -->
      <div style="position: absolute; top: 0; left: 0; right: 0; height: 68px; padding: 0 24px; border-bottom: 1px solid ${isDarkMode ? '#2a2a2a' : '#e5e7eb'}; display: flex; justify-content: space-between; align-items: center; background: ${isDarkMode ? '#1c1c1c' : 'white'}; z-index: 2;">
        <h3 style="margin: 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 600 20px system-ui, sans-serif; display: flex; align-items: center; gap: 8px;">
          ${Icons.settings} PulseGrab Settings
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
                  <div class="setting-desc">Where the PulseGrab quick-access button docks on the screen.</div>
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
                  <div class="setting-desc">Caps fetches to 10 per second to protect the server.</div>
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
                  <div class="setting-title">Theme</div>
                  <div class="setting-desc">Color scheme. "Auto" adapts to your server type (${(ServerThemes[SERVER_TYPE] || ServerThemes.emby).name}).</div>
                </div>
                <div class="setting-control" style="max-width: 200px;">
                  <select id="theme" class="modern-input">
                    <option value="auto" ${currentSettings.theme === 'auto' ? 'selected' : ''}>Auto (match server)</option>
                    <option value="green" ${currentSettings.theme === 'green' ? 'selected' : ''}>Emby Green</option>
                    <option value="amber" ${currentSettings.theme === 'amber' ? 'selected' : ''}>Plex Amber</option>
                    <option value="purple" ${currentSettings.theme === 'purple' ? 'selected' : ''}>Jellyfin Purple</option>
                    <option value="blue" ${currentSettings.theme === 'blue' ? 'selected' : ''}>Ocean Blue</option>
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
                <li>PulseGrab will automatically structure folders by Movies vs Shows on execution.</li>
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
        testBtn.style.borderColor = getTheme().primary;
        testBtn.style.color = getTheme().primary;
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
    a.download = `pulse-grab-config-${new Date().toISOString().split('T')[0]}.json`;
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
                            PulseGrab v${SCRIPT_VERSION}
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
                            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAYAAAAMzckjAAEAAElEQVR4nOz9B5fcSJYmiF4oV6EFI6jJpBYpq7pEV6sd8d45+9R5f3Z3Z3dmdmfeiO6e7urSWamZSSY1Q4drB/DOdw0XbjCHcI8Iavt4nAhoA2DisyuJLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLKrhTHGMhcWbAFtX7Xt5WxC/Qe0ifkfbz6t8x+9S2SwsLCwsLCwsLCws3le8a7NCi7errp1E/ZtVwvGuzc6PKuGJ37A+pKo8b9P3fZX96km9t1mv+zpwkv3FtNd+2d8yfovev8U7BksALd5XOG/owPuqrld1/Wmf75jlktPjt20gdKYs70mXf9r3Pdv3cZyZvqNTfd2prhfP8r7inH1OPOtbliOnqW9vat2zsDgRWAJocZJ1yJmCVDhGJxzPcO3k52C48pJ1N9mmlvinnxsXlkktx8fno7B0hYTFHHgNCZ050KaXkf1F18vfKs83e0uuIgjTEkBXX3cmnk8ulv++tNcf5xODOJqyPGa5zPWXQsRyKjjuI2XW72vef9r3Xl5/qyVXVcuq+5ReV+ONBdfHAXExmXOSZZx9b5PEMJb95vssfY/cU6iLJX1NWg9lv1YeVdfi8X2wNdLO039hUqgoOTeegVya+/U2NE09fdmTDIv3BJYAWrwugMC5juPwkoh8Hiwc8h1ed3z8TTFhGfA6H0NBQv5qRHwutnnkOJ7jkOsoIoiazUvHcdVS7joesXi767qlA6LneTMRJFV2dSP9qiwxUZsyA6c+gOYJYUrKx+fmnaRvKhLspIVxCwhbrAZKV72+gkfNFDq3nMllKhFPSncyBDBnf27vNfk+Yqfw/OMJxvIJ4JhI8P2iKCokBSmDKemFc75vZuISR/IdkvUxLZIJULa8TtI+pAxJ8dB28u4fx3H+/ZNSR1GYu13uL5JCVa6E66m/J95PHKv3pu8fV59JAsiMa8znMlUtuZZe/7IkLakPURRF2ulRsgyTE7EbD4hCRvy2FSGM4jjGdvxGahmrZay28TUoDh1yeIl9MY7l/em5YazWcc30RVpYvCpYAmgxSx0pIiP6zLj4OkzunIDJm0MNIqdO5DTH60z06o7r1DzXa7ie1/Q8r+V5XtP3g6Yf+I0gqDX8wA98P2h4rhu05uZqvu/5QVDzg1rNC4LAA2nzEuaCARQckLd5Hi/BeVzP4/2BH/BQ5WKr6zDhwpiLdWz3fR8bQCR5KJbjkmszQdLHaNdV15VNQiDNcVwGdtcFdzUGeu3PWhAUSA7T68jeXAKJ8V42836WiMhAHJMf4HMkK3m3GB87FlWmBXYoeY36QOvgb1lNxuF0PxY6F2ORbXq5AuGhUT5daIv751U6eRlFBFRK6Gb5UM7jj883OWRCGSbOSPbxcjgcRZn3D0bKSxH2ZK9qfsQwijKvxXVcN32XLP5N5xvjo7A/WTdfqXn9KFQPgFqd9/yj0ShX3o2vxd9SGKRMKIzrc2PT3+G4HjBXTq8fCWEDt8JORrpfzjFLMhwOI2ZlUcRFiaIwxt8psZM6hxsk2yNcCLdhWR92xBSGo2gUhnEYhvFoOAzDMMQR0Wg0irAyGo3C0WgYDYejcDQcRliLwmg0GAyGo9FoGIajwXA4GoyGw95oNByMRqN+GIb90XDYj+K4H0dRP4qiXhzHfcI6xX0iGjhEXSLqYRvWY6IhKXJZJTnWK5EOKx20mBqWAFqcZF3yHAeSO6fmMKlzakRUdxyqxeQ0KI5B9uZcz20GQW3OD4JWo9FqBbWg2Wg06o1Gs9ZsNuuNRiNoJBtac3OtRr3ebDZbzdZcq95qteqNZjNoNVv1Wq0W1Bt13/N9D5zQ8zwXCwySY4IDgSKR56JoCQHSJHUghcmg5GDMgMSDlwmR8TyRIIrELJXIkS4hE0mdoolK3IA/w9EonwAa15GBM0+gV/Hex6qufKKZXaYSGTVODIdDuUhCTIyb8/itBmR9mxwrz6/v1tcDIZiZwX88RoWhEnww7c5wmDhzL1EJmtLN0VgClS23UY6cl1Yl4Zwoa956OISwx7i346DuZIig9v4z79kLvImTc59n/B0Tgq0R6pIyajwoPT9zbEIAi6B/v7zrozh5150GuA6+f1LHMg/BNI3bn5f7XtNtnsMPoPiaEEFQvLS+ZCqdSAbTMgjxZGLIJJKJIo4TqhiFLAgEEQQhZG7IjDAMw+FwOBqOhmG30+n3+/1hp9Pp9Xq9YbfT6Q0Gg0Gn0+73ev1et9vtd9rtXrvd7nW7nV6/3++NhsPucDDojIbD9mg06oZR2KEYhDAeUAwyGA8pph45hEaKvwdE8TCOE2mjhcUxYQmgRV6dMCV90ulOjBaOwxK9OjlOi4jwWyDHWXDIWXJcZ6HRaC7XG/WFubn5pfmF+cXFhcXF5ZXlubW1U3OLi4v1lbW1Rr3RqjVbLb/RaHi1Ws3zIa3zfT8IAr/ZbEGYFySqYlb3hlHkuK6Lv51+vwdRHXp5l+KYlxj0EjJHvV4vER45LDlJBol0v+uYkqvxTwZAk7joY9CsBMIcJ+Mon3QVDeATx7rl1y+8b1Ius/xFBDJvWx5hMyEEswgY4POuZ55fVC7X90rFzlUq6KoOUO5TSLJSDWY+qupHmOUjE5Dvb75rnSDnlU+25RG47A3Ky2/WP/M+OkHLgxB8gfkdhQDqkwr9XlXvz/WC0nam17/x3Gy833e9VNKmJP+OIugJcQyCIEqE0zEkz5AZqnPx4ZzYr3towaw29jw3dh135DgOaCSIYtTv98AVR/1ef9jrgxh2QRIH3W5nMOj1+4f7+73Dg4Pe/v4+fp2D/f3Dg4ODzuHhQbvb7R2G4WgvDMPDKAwP4jg6pJj2iOLDOKYOUdyP43hoqMbLtDR5f1u8x7AE0GLqupJI96CqZUme47jzcRwvuq674AfBYqPRmG+15pYWlxYXVpZXlhcWFxfW19eXF5eW5k+dOrW0tra+sLS8hGMakPQFjYbf6w+DOI7d0XDo9AcDZ9Dv02CISS57NzjtTgd/O6PRiJcYMBK7Ia67jUYDgwivy1IfDJrN5qQqT5dg8BlROgCJSjeVPGmDrZyrr+sDYN4gHAR+3osc26TFJgEztcHTNFFVfvMeUiaTYOlEtozgmX+b12IJZzLAF52TR2DN/XmDv3ls3n5Yp0FFWoZKG8SK/TkSzsy6V6FCljo0UR6R2CYq9KICm+/XnISYBMksZ+UEYkYqMKsppX7/vDoSJhJIdhWJFQlLtP2Jijnz7rA/UxFGYWb/pMQ7573pf48GQ1OCqUu6nX6/nxJGkUCm13QSFbmjZnH4FtqEhvuhVquFbbHneVGtVotAKD3PC13HCVmSF8WjGAxxBBXyYADyt7Oz033+/Hl7b3e3vbO7s7e3u7e/s7N9sL+3v9/ptLcH/f7+aDTai6KoDTJIMR0yKSTqUBz3ElJoSZ5FJSwBfL9h2pMI9Gm7k6h058lxlxzHOeV67ma93jjXas2dXj91anN5bW35zJkzC5ubm/W1tfXW4uJCsLi0VJ+bm695nlePKQ7iKG4Mh8NgOBoFw+HQHw6HXhiGbq8/VNbRoxH/hBAk9noTEgZ0skLS9MHZlMrJ/sEAZjWJLaBG7FQnHUEFlttRairVPBVf5l7TSkjyyVb2+WbTpOUPrub6NIPhrGUwCWDefarKxU8QjzIEsEyilQedABwJFRKwXOI5gwTYPKeKwE1ThjxJdN56ngSu6tom9PIVSRmrUFQf8HeehDFPwlkE+KiYpE4/T+8jROovS9mvmy+I6llU7fV6faJc419ItVqNpbh4z+Y98IMGQsojfRL6BNd1I4ei2He9yPe8OKjVonqtFgdBMPJ9f+R5Hqt9oS7u9fp9qJQPDvZ7z58/P3j08GH70aNH+7u7O4fbL15sDfr9Z/1+/2EUhk8ojp8TxftEhJnzIHFSEXgFkkBLFt9TWAJokQeoXOcc112gmJbJcZZcz1ur1Wpri0tLZzY3T5++eu3a+cuXL29ev3X71NLS0vz83GIzotDrtnv+/uEedTt9CqMh9XtDZzDs0XAQOlE0dCDxgtoSplujOHIajRZLQTRi52idpGaErjpV08bMlNBIJyskMMcGKitxSmzIigYy3/cnpF7yt74sbGAVEjZxspxG9TorCSwrZyrB0lSwZdcxB1ZZ5kl49PN1I379OgI/SJy2CwhgngQrQ8ASFWARKgnKMQngLIS9zAay7Jy8b1dGkPTro/4eBzpZOsrzV0mAZd2clMh5VSpmZfkxabqR937zSLipIi/SFOQTwJjCeKQfB0lfxjFM+iBoMFh7EYbK1EQJEJ1w0B/3YYnUEN+sXq/HIJ/1ei32/SBqNBphs9EIXc8dDPqQFO53IS28f+/ezo8//vji3nff/fjkyeNHB/v7T4bDwXYURttxHO3FUbylVMZxh+0ILSw0WAL4fiFP4qfbj8BTokWOs+a63sVavX653mhcWltbP33x4sWNCxcvLp4/f355c3NzfnllZaHVmm/tHRw24phqg8HI63bbbqfTo+GwT0obi5kx7HjQkQcUBB75fo3XMa7IzBkEMEMotI7cTQiKTgp1Ne1gMJgYkIrsifJUmEIAzfN0G6Iy0ieddxHRqlbnTkqAyiSMJpTDYNn1Z5MimccZEpLMMTK4VRHPvEFVlpgklJFpXQJjXkMkgDlmlLnH5sE5LgGs4JdVEk0vx0RARx5B1N+hTvCOJAGsKH/e95+VAE4rzdWvL79qG8pJqaGOKgI56MH5lgqfp8rEgzCZjcYSwAkim2zPXF93eAqVBFzOwXX0b6ZPoEBWG41GND8/H7ZarTDw/WGrXu93u93u3t7uwYsXL/YfPXy4+8MPP+zdv//Ds+2trcftw8PvRqPR/SgMH8VxtBvHcVtiGOZofqxE8D2DJYAWIH1Nx3FXyXFWHMfZCGq1c6dObVy5cPHiB7du37l04eKFUxfOX1xuzTUbRG4NjhcHB4fu3uEBDfojGgxGTJRceGsEIHqBDPyO7ysvXEDvKJlseS5HUWWCl/SC4o0qIVvQAU6qbscdbBEBK1J36qoYPo53j0OVFKmSiga6sQQBpBTXx4ARpUtF8MbL7HaqJI1Vg6faP+koIOt5TgT6dccDrCq/WV4QdxUeTanMzefka2FMi4uX/I2TJSRu6lJqCRM4vqvy9E2XYiSpDlXRrvXtsoQvEAggfGHyliB4RfvHmPxOed9LkW19P7+N9P3lna+/t6JlzI6sxeeb3wXlkOua9Wya+2WWzJ7L71/0/FifRYWcOwHQnED0ejqtCniUEPg8UmpqAPLad9X3G42i8veDOWSkTFfMMoskU3s+1dskxzKBdz2KRmzXrPozOKEUkN446T8RmgbSQtDfeqPBdoYri0vh4spy5MbU2zvY7/34ww/bPz56+PRf/umfv3/67MkPu9vbP/T7/adOHD8jh3biKIaEUMigxXsKSwDfP4mfMAZwLoRqWSHHOed5tVsLSwtXL1y8fPnGjeubV6/d3NjYXF9aXVlfjp2o2esOa53uodft9N3+oEvhKB5LICSaf4HUq4xUMSkwJXAF0qNJMuZyByqDcZ6kQiQkumppPBBE6Qy/SAKY90x598ojfvrAre+X7XmSyokPWLo/kaCWqKjz3lue9C+/fHhfVE4gIAFJCFWMOIoqim5KtCiMSgla4DoUOfG0dCVLv9j+CzdxcwlnFTHl9xcpe3kVBk9RzsT6k9c9z9eiBqr9KpJI8k4jkcCVl9gkZmy75hRPFMrOm+VNVV3fZbOwo90P5ec6lI1olGkjVU4oID9FUvK8viO/3ubXaVMqmDdJTONA8ydF0Bd85ai68iRL3F63+UuJoPR1eTaUuhOW1o3kqajNZ1HEb7ze7/e5nYLIQprcCGphc74VNuvNvuu53X63u3f/wf3dr7/88vn3P3z//Onjx/cP9ve+DUfDLyiKHhCBCHIMwiKJoLUPfIdhCeD7B1bzOq675jjOpuN6F1dW169ev3nz9ocffXz16tVrZ5eXVxaDIGgiyuyjR4898cKVOHnJTJXrTphkWphQHRobitSIXm0cZiU5MHucJuHLJTjMMrI2N/rfokIxpYjqF1d2umWkUEkgxyq4vIGsSJIoy2mdCPKRtb8rG+CKCCwkHHnnVUk+5f5MArTA2Pq1q1V/UfL8xceVEQiXxS/q+5vPJagqPzzAM+kyKoh+dh0paRDq8hixBAvIU96x5WWZ7t4m8gjItOfi27OK2ClWd1dNcPQ4hGWmBOZ1x+1qUkVbVv/MbaNh1sva7GdMG9Zs4WIajLIqZP0a6vrlZndOEgWgrOwcs7pAgsltMIrikINcw846jvFN4Fji+b6zuLgQLS4shp7ndV68eH7wxZ///OiLP39+7/73332+t7fz7bDfv09x9Izi+EUcx4dWIvh+wRLAd1vqJ0vp5eDcseq47sVGs3V3YWnp1k9+8tPr589fOnvl6tWNU6c2Fl3Pnd/fP/APDg48hGQZhWHqPZvGyErAM9+SwVPfVjQw80TaJB66qhcEoMSOTjrQIvIyXZyy6VTApgoagE1j1XMXkb+TQz6J4z0VBDAIlI1d3rmmBDYXiS61ijgVlZuPKzFEK71OjDwYk993Jhs1jqlbTHzK4yRCC5cloNOUfxYCWGUOMKt93QQMG8hZroe2C9MPJcmsMjE42v2r6pUyGZ4kT/K3tP9UgmbYC2ICV9TGscyLY6mXAU4g5r2Ng/OfW/qHUdZJpUyCWTYZQDxrpR5mG8I0FBbKv7q6SktLSwhDgywjB71e9+D7e/ee3fvum0dffvGne7vb2192Dg//EIXhvTiOtjRnEd1r2EoD30FYAvje2Pg5sPHb8P3g0ur6+o2bt29/ePfDj67fufPRhSimhW63W2u325jxOiGkfYmkr9VqZYR5iXqDs2WwfYsRxyxPdVo0qGCfBMI1pXOyDU4gOsxreZwimAqPMY24sx11lDGizyNouhQwj0zAyaWMZOgDYJGqqwzlA2hx/D9zvUwCWHVsGaJ0bpF//UoCFiGOWjHpKD0/dogTtRhSFLMMxRdXdVipePMHcNNLOvuOHIo4jNxsUtxZCGDuOTMQtcpvOSMBK5IAFn3/qnJCdZlHbKYlu8pGlSoncHnkT5+cqXAy4YSNJSZ4ebaXskQg8rzrp/epeA+6BLSMyBa9h1HiRKKk/Sp93njSRzGylsBRrt/vs03D2upqfGpjAxcZ7O5uHz578vjxN19/+fW3X331+xcvnn8x6Pe+i6LoWRzHL5L0dFYF/A7DEsB3A7q0TyR+WHqO664Q0QXH8+6urK3fvnP37o2PP/7k3IWLF8+05uaWdvcO54aDgY8gzLgA4lr5vs8dSTjKhDgY30zr7IskTHkDRx4pEAKZ13lP4+Sh54XNg27jZwZ5BniGr7JJlQ52eQQQ5fPc4MgEbhoJZdUAztcvKX+ZWhqoBY2pCWwepncyKUBS9qrrnzQxSm8/I3GZUOHnTEBmKWfV960KozPt9ynC2Ali9ncHDgQbtDIJYBXMpy9Thea9Kz0T4FG8oMeZflyejAgRFIInTiApQTSJoqH+1sui919m/5ZKKLX6UyUBzEOovQDdBlH6q8BX/RMm9Ojr8L1QpxCc2vfdcH11td3rdfYeP3705Osvv7z/zTdf/3lna+tP4XDwhziKHsZxfCDFSWY6Igm0xPAdgCWA7yaChPid8jzvg+WVldtXb9z8+ONPP715/fqNC41mc+Hw8LC+tbVNHsKyOE7seh7ytkMWo3LhRuPo9npHlKqDEzKVFwh4FhWwKQE0Y2hlBsoc27SqTAx5mRzSv52Iw4wUzt5Lnkv2+14td3vR+qyoOl+pMKvPLxqg4cxznPuzir7kW0+ngj36/c0BflaCVHWfIgI1noBUxamrvsdRzpWMHDLAHxU6ASy6VyHQflpN5T1QUL+q4hDm1Y6y+mOum6mgzQmPKYE3J3KQjpn79euU2gBiAqmFcZGyJ/0nL83+Z4LYajGMyshv7jrcVbT6OSaASsOMeyPTCoJbS1B9PE+320VMwpjjDQZ+PD/fRD84PDw83Pv+3nf3vvryi88ffP/9v+zv730ejkbfU8yOIkIELd4hWAL4dsMxZ2WJg8dGrVa/OTe/8OGly5c/uXHz5tVbdz8815qbWz48OJjf29+HWpjTqMGNDVmYRJ0gXqW1oKai3GtxrPJUJxMFKuiwiwigdLB69g4l1RoTwpSUaTNc6fjgxcn7uDOcjMnV7XbT4yXGVpJOTssVPPYMNn9lEiL8+v1BaaddJYGpklBUnZ83QOWR3aMO0FXlUzZwR1cBKy/cYlQSSE0QcRSCVUXwijCtijPvHH296j66F3vetY4rQc6bQM3yTEoFOqluNcs/K8qIn/53vd7INSGRY/RAz3kEcGEBqcvHfY3+w7b5+Xn1nOl22EJrsUhJmQjwd8ixEYYWxSy3fn/dBKNI6pnpcySDZE4YHbPfkmdCH8WS2iTwNdJTghgOBgPHiSNOr4fA03OtFjKQ7G9tP3vxxZ8+//7et9/++fmzp7/udjt/CkfDewkJRIcgH123D7R4C2EJ4DuCxM5viVz3QlCr3Th37vwnd+9+9NFHn3x8q9WaOzUIw0a73YYnr6PE/z7n2o1ghJSko0jJlz6bRIgMDo2R7wQxjQ2a2bHpHaGfqGAkxhUTtWhM0A4P2xJJn9W1mLFjKWnj2p2DzH75yX4x4jbTQI1VNNOprkziNz6/OAxF0fX0bdWBnsv71irVW5UKuOz62FcpwYmyKvppyy3wxmEiC8tQen/DBtU8vkqCU2RaYO7Xr31USd5Rzqt6r7OqyGeVAFZKoHMckPT3NEv9rqqrefsHg2GhiYfe95jny7pOlvRA83ItsQHFEm1BX/Ikut6SzB2cdxzLxIyGrzE/P5ctX9KX6vE3zXemL00VMv/LsWNMNSo8wR1PlNFfLizMc3l7PQToR/o69LkUgxT6rsPSQMm1jkDTrVYrisPRwe7O1o+//c1vfv/g/g+/2dne+v1g0P8+jqKncRwjv115xbN4K2AJ4Nv7zdAzsDEKyJ/reuf8ILi1srr2k2s3bnx0686dq6fPnN3s9/srjuvUInbmVcGXofJlMhRrnbdRFWR7o9nkUAapxA0dTBRyxwQpoWTKQIcnZE55D49SFZWcK9k8+JghiNyIZ6aQ0h0cHFCn02GJXGK0zNeWmWsSADX9CVkUAqGTOz0oa14qOB1hUs6jQpLZFyFPylMkzSg6v+jckyAAlQShSoWaOGAcGRWZOCrhVRCUivdTpcKtPD8bUXpmkjcrwS/aX0TaqjJ5qDias90zc62KVCJV7y9Pgpk3QSp+hur3k9feppm4Fi3z1MwcegV9oO+zlE3IJABNy9zcXEoOZR3LVnOeCRn6UqWyVf2aXLvX71M9IZRp35tIbdF/wwa1P+izlI81N7WAj1WT4mx2Enlv+rqoqXEuhANojyi27/tD13W7+3t7z548/vH7b7768o8PHzz4Tadz+JsojB7EcYR8w6z9T37ZeEoWbwUsAXy7Ebiui7AuFxrN1kcXL1367O6HH3128eKlDxrz84jz5w+HQzcMR2EcsTOv48DWT8VeYy/fTGeWUx2GIzXDRqeCTgoQFSs6uaBWo+FgwIQOHY50KK1mk5qtFv/d7XTo4PCQ9vf36fDwMP2B7IH0iWRPD2osRA7H6eumFE9UiKb9Tlmu2skBqLjfqpSATWmDWDXgVJ1fdO5xJYhVz1dJIMvysE3jxDKlE0/xAfGxzh8Nj0egTQmmefxxv880uYKnvX/esQjEfJz7Ky/mcilyGaok5GXSSNUHlBdPlwDnSXDNVHVF76/oOXTpofxEQijn6pqVtN9MMibVa00mglA14wdiiCWkdo16gw7bh+NJ80BNxEWNi/661x8y6cNEG98KhFHSYwopLSOA8gzJJDuOkFtRlTkKAg/JnUZRFB5uP39+/+uvvvjjve++/ae9vd0/jobDb+Mo2kqyiVi8pbAE8O37VpKyoe467qmgVru7sLT8k6vXrv3so48+uX723NkzURTPdfvDmqjwogiuFonXouZkwQQwZ3wyCYZubyTSOOlgBv0B1YKAyR5muOhwO+02dXs9Pu7BgwephE9In66ixTXRYYlqV1TPsl8vk6nm0Z8nz34ntXMseDYowM1k8CaqBnDTCaTq/KMSwaLjj2sDVjXAQ2JRen7ixFOEWePAzUogqr5flQr42O9Pe/5p1P+zPn9V+cw4dWXlzSsPJIB5BGiqsjtR5fefFkVEME+CmCFwFfzUNNmY0BBocfxM1SoADUTRdXQnkmyGoawKV/8b3xNtCj8mi55aoh7LdqR2EwnhuXPnuF+FFJCvm5Bt6SfRfMf981jDksQDnJAAmwQQcRDlnYydSELlNuw4Lq7heU7ou+7hoN/ffvDgh3tff/XlHx4/evgP/V7nj3EU3U/yC+tpYqwk8C2BJYBvPswptu84zpzj+efq9cbtjc3NX9y4eeunH3740e25+fnVXq9X6/V6IbnKBiUIAqRXRaCGfBWIocIypYDokFjlGo1z+Hqumuny9f2A+r0eEz4QPUj5tre3eYnOEz+R9GGpD8i4lqg8JGemPlvmh4WtYomRNjpHuZZ+nGyrksDxsiIUSRmqwoDIc5nQCeysA2O+CvkoydSiI90/83xwvilJ9eY7bmkuXq5TJbeYLpB38fOrTC3Fz1+p4q2SYCZx4I5qQ6fHgTuuBDevXpi5cE3Iu88jL9PY8I3AwI7RfvJsLPX1PBV3Zr3CBMG0oZu0AXYpTmJZFtnhlRFAIVi6g5nuhIaf2CWbpin4W8IwSV+F7wnihx/6NmVHOE/Ly8sI5szkELaGSs2M/rfOKmBIB1V/qNTFyv5ZhfEqlwBORnng48JRlJQR9oGO58Tx4uIizIcOHjy4f/8Pv//dPz/88cE/Hezt/CaOo++jKNpGdZjuq1u8KbAE8M2HnqwTk7Il1/MuzS8u/cXps+d+8fFHH32ysXn6Ymt+cWU0GiGAH3cOruug4VJsiPhU1tWEMPEoXBJDjlUM/WTmivRCysYlsRfhjq7b6dLW1hY9ffqU9vb2mOjpZE+OE6mf3tFwhxWoTBq6DY1uZC0SHtO4W7YVEtscTO7Lqn/yUDUA6qmo8lCmgjbtifKvX2wvmDVyfzkEsIwgqUxsyg9XZinmErOPov1AUBFHser7jMnj0XLhTiXpKiuf9knyrlVJsI9JAKts16qkkjoBlKX+d3n9zJ/czFL+PAmifk7e9U0CMw3ynm8aPwbz/pl7O1EiQR1nEjLPEdtlU7shGo9eIkHU+zZdjYzzxclEJIMggiCEc60FWlxcpkYDEsI6SwdhCyhS4TwPcpMAovrJKk+sk6ILWQY9dl2XYwjiB5VwLQh6B3vbjx4/evTF737763882N/7p0G/96coil4kWUTQ6MCqrSTwDcfRfPQtXgVkrExE6g4C9S17XnB9fnHps8tXrv7V9Rs3P7565erFfr/b6Ha7Xq0WDGu1mjsahQ7CC/i+58CiIzvLNgnE5ECYDh4UU6NeT0mZskMZ0GG7zaQPhO/Jo8eEDCIqnIoaMHAMSCA7c/R6nM9XjKPlJ15yC3PzEwOW/jNVkOaAohtM55FAXYI0OZhIlofigaCaoFWrEMvUvrMQkPyyHM8JQ0+FN6sKWCeAR31/CIRb9gR6nLY86Knsip9PvtHkMgiOJwFlCVgBWaomUONc10eVgJrvR+6pS6jKyuMnKkP9mJnKX9F+qiSs/pRe+EX7Ki5fTUC1+p/Xf+i5xM19aHuDgUqWMUGsDQIOAifETnf26Pb7GZIIjYn0n9gO6R+2429shykNNCyQAuI3P7fMoWzW1taYGLJDSQ2OdwmBq5Twj8vLBFULiQVAulir1SLYB3YQRSJmSWBrYXHpEjnOfBiNGl9/9WXj2dPH7mgw/HMUR08ojkECLfl7C2AJ4JuLsajCcTzXcdf8Wu3myuqpv7ly7cYvrl67fnt1dWVjFEXzseNRvY7BzPfRkYCM4TTPw+eVWWkykOiBlxNPsrI4Xphx4pr7Bwe0u7ub/l68eMFLSBDQWSVp5DKqFXR4Z86eTaV7epgFuV+v080YUJuBoIskGbJNzXKz5+jLrI2bOaBVd5BV/RiHzi7dP3mNWez+qpxY5HsW37/kXo68v2KSMRwWG1khA0SIdGoltyh7vxBAI5DuUQmQKzZauhhuhvPx/KqtlBxS8a18IaBOTh3N2zZx/dLdpe/fTIUmyNp4jQme3EvfL9cvKqcZJikLJd0vQ6WE3VChV0ksJyeApZfP9YIeX0tinEofk+5JjynK9Z3cnWqBkgDqWTikzZpkXIieroquN5uaPV/IUj6JdIBtz549SzUhohKGqQ36W0zOnjs73IZBFNfX12lzc5Olg1W2seP3lw1WHY0ScxxXvTuVCs91XDd25hcWhMQ6g8GgHsZ06vLlDz6imJqu6za2Xjxv9rqd30RhiFAxAy1ShSWDbyisCvjNQ1Zb5jg113XXg1r9zuLSyi9v3Lr7tx99/MmdpeWVU4eHh3DtdWuNIPLdwO0Pew5GY9iBoNNgVQAClzKpUgOBiu1HnEPV9ZwkXEsxyYAx8cHePj169Ih/sO2TDgrXx4xUqQoc8gKfAqiJawG1Gk1qtJo07A+4k+dwE67DhBElEN4kpE+Wk0bKZQRN5SFN/9ZSNOk2YIqk6XxaX6djeslO52RRJAWsVjHnq7YnbLw4IWs8sXRB/HO2y/I4KlCcGRLSYUVH9+Kt8CKuIhi+w/Esi58PRSt5/ir+X2kDp5wmUxRJgorAuYxLMI2Kle9oLPVOJAIRMVTwwnbY1MLkrYYKs/z+Kh1aySsuXZrPUvSMxevTS8Dz7Bx9fzIOX56NX/69YYACIqeyb5hGDniNioCr/RHHN421/SoX+qRdXrasYkst9tSQBKJc8CBmuzzu48ZObyCC58+f5yVIYpkKuN8fcr511ENRT2O/SCvhJa6klSrjicQMRCixANqmQXdEcbT39OmTr775+qt/evzo4X/pdTt/iMIQaeS6lvy92bAE8M2DGC1BP+m7jrvu12p31zfO/N2djz7+5dVrN2/V6g2EeKnVakE8HI6c2IkiWG9wTs54LA1LL5jY08mskwe1KKZRNOS4gB6I4EipGBq1GjUbTep0uyzl+/LLL6l9cMgzTrEDwQy03+1yZ4FZqV+r0RyCoDabfL4DMsf2PTGykSM9CfmcNF4t+eHYfi/xQtOSyZsSv2mkZWUEr9wGbHoU2QKZgYhPGtN70R7FCeL4U3N4UZbR6GlTsR0VqEcMmDKAiM66PCYqBMCVKFegT0cAyyw9HWO/vj5NKsUqAsgSrhKCBwJRtP8k6kfVBKZyglMq4ZyCAGMCDTMITGS0eiXr7CSWbGdnE63+sYRQs8HMs1MUCaI4mrDdYOJUh/5aJHjQ1OAnwe9FInjhwgVeYp/YYYt0ENep15sshcd3EvtDQLP5kxeVR6Cdfr8bLS0txeFotPvwxx/uf/ftN//89Mmj/3a4v/cPo9HwPqmg0WITyKeWfxCLVwlLAN9cyV/dIedUrdH88NTm6V/d+eiTv7167cbt1tz8CkgfJH++70eD4ZC9fM2BAhsFY5UDbG7YM1jZ840G5PsOdXq9NHbfaDiiH3/8kcO3wMYPRuqQ8h3s7aXxpYCar2z55pIo82LXJ2RTOgvdu9d04kjCQ6ed8Cyq0fSlaSNwma1dMdx3hAAe7XxxCjoqxIOyCFXfIDopAvia8LoJICZZZSgynRAExySAVQSqygawKg7km04AnUSCV3TPrKNWzv443/tYVxvr15L9YkOIPhoTcqyL57D0seiPxWnk4sWLHFIG/bNobXB8KhBIs4iMbQclRJe6p5NXRoSKCfv9voeAPPV6rbe7s/39t19/9ev7P3z3f7UPD34djobIJdwxBdAWbwasDeCbA+mJwJR813VP+UEN5O9f3b774V/evvvhzVaztdLrD4M4jiO08X6/77q+WJmBM44vJn0MMlX4PghaYgsUofOAUXGU5P6NaWlxkRv9w0eP6JuvvmaPXol/tbu9ozzYRkoFAJUCjI/RscBexYzLZzpx6PtN+z51PIv/jkT+1HVkOXl+Xud70qi28Xq9BKXy+Y9ZvNf9fBblyLOhnaVdVEogj3n+204H8py8pukT0glkyTH69XTtjR7gGf0wJHkgghJrlSfmc3NM4NCPP3/+nPc/fPiQieCZM2d4H4ijEHSxwZa86GKXmAeNoKKQ3mg0cmEKsLi4OH/u/MXLruvVYoqbTx49XNjdfv6fozC8l6iDxSaQLzP9W7Z4WbAE8M2BMg5xHM9xnLWgXr+zsXnmLz/8+NNfXrx0+WYQBCuH7baDYO1BEIAAouE5kMSlF2CP3+xFRayP2H3I6gHip7ZBEtig/rBPL7a2uHO4d+8eHe4f8H6oCnZ2dmjU7pBbr7OnGToVyXMpP+kkioI2581+UwkhNuSQwlmQietcGibl7UTlYPLKSlJw/2OGAbF4NTDbwqsi7tUE8PXWj+PWzzyPfp10F4WxSbdrf8s30s+XFHCAHi9V7gVVMCbip0+fppWVFSZ1ElgfTnogg3AKATCxhw03iCJsBNGf4zoSlkbdWxFBsQc0n8+0J+z3+069Xo8cJw7b7Ta0Us2V1bWLN27eCprNpvdNOBwe7u974Wj4XRzHSOs09rqxeO2wBPDNkvwx+fOD2p31U5t/d+vO3b+6fffuTcf1lvv9QTAcDiM/qDsql1uc5t7li6SdRvaiSBkkQUGx1FXA2PbVV1/R48ePObSASOjQcaCTwMUW19ZSiR/IH0/hkmCnkAzC7o/LoHVieqBmDqPAwZZhK5SK68ZlLPDend4GsDzXroWFRbZdWFJ+khOc8kDbee89oy0xL6/H/SQVKJ+PcTFpVyFkBEwIu10mfdLnQt0LAgeJHyR/kACC+MEmEAQR9/zuu++4v4fHMIigrtaFo4pcCypi3exHf079HHgFo4S9Xs8dDDo4z19aXj6rkhDE3rfffN3a296mKBx9nUgCrU3gGwJLAF8/pHVBbrbiB7VbG6dP/+KjTz755dXr1295frCCWVYYRhFs/iC8GwwGzAFB7kbhMHe2qbdZkc7BO7ju16jb69KDBz+y1O/x00dM0tBRYDZ5COIH5475eVpdXeVAzRL8me1BEvsQUUPkqUCkPKYK2Jzpctkmyl3uVWkCp04++/QOJO+7Cthy5fdXBeyeiAr4/ZbwVvVXRVqIWVXwugmNrhJGH83pN5NQXFAHS4zAs2fPcr8OsgeHPqiHcTwm8yIJxA/bTp06lYT8itJ0nUXfXieAIIk4PgxDeCVGvufEbJrkukGzNXfm2vXb+Nv5+ssvu3s721EUju4lqeOsJPANgCWArw/SutT8znWX/aB2feP0mb/55LPP/urGrbu3mq3Wyu7uLnL6Rq4fIBqgixlnGA0pjuFwYWT5yFE5QMoHG0AJPvpib4uePHnCs0A4e6ysLTOxQ2DnsNMBS6QzFy/SXFPFo5JOR1c/eEkwZ0C2mXaA0kHlhVEp6jSPQ+Ly1FvvgqSjWgX8dks7X64LzbuPqveX1g6TiKQqSHqvcRIq4DL7yqK/9W1lfZzk9jVT2IkTSC/sMQlDIGj016IClr4b54MIYjskgo8ePqTFpSU+HiTxhx9+YGKI66mwMQ0+T8J8lQXi50kEoizEygsRRM9xvNiNIieKImc0GtUbzebm5StXP8VQ8c3XXwV729txOBp+GyvvYD0W13teE18P3u7R4+2GeES5SO/m+f7NlbX1v/zo00//bx9+/PFH8wvL651O2+t0up7rurHrQ5yu5botiOOWzhi18AKQ/KFBP3nylB78cJ87AgmA++zFU/4bhA4zQQlEivPRQWAGKYnLAelUJNyAHtw5E1DUSI5eKCl0sk4kJ+0FXN3BH88LuCIM4EsPg3JcL0qHw8Qc5wLHD6VyrNu/517As0qgJ/qLivJXXb+q/JXlO+b7O64XcFX5qwAv4Kr7lUkJi/pvvf/QHTJ0Rzr1ACrXMPaPHTmUXR9IHY6XcC6YjIPsYbKP4yHx29jY4GOxDyris2fP8zggtofjvMZZyWNq+x1ifEEaOiU5xL4gCGKIDFSEiihqNJqjfr/z5N633/zz119+8e/2dnb+PgxH4h3Mj20J4OuBJYCv750zM3AcZ971gmsra2t/9/EnP/nbz372F58uLC5ubm/vNLa3t6OllVXMplJxuXQ3qdSNG6eK4aQcM1QHEA5V1Hk0TnQAkPbB3g9BnXEcVAYSZR72IbAd4YackLbUeUQC+SKIc06GDlnPPGDJvllTqVXjGJkwGMcjaFVhYE56AJ/YXxXl4jWHgXnZcd5e9vWnIeC6PRSQZ+qg789IjI4ZRqhI2j31c1WEEao8/dgEqnx/kSYgNSGpSgWSc05mW6WPSjlBMwngrGWoKv9RCbQ++YZEUMgg+n6MB7ARhBoYx8AWEE5+GC9arXmOHQhiKF7E6pmVBkl34mPtT9J/pM+RFMhxEKnCcTudw2h+ft6bm2/2O+3Dh198/vn/+Pbrr/7T3s7Ofw7D0T2KY4SbkGCtXPSpXqTFicCqgF89nKSyo4HMe35weWll7S/ufvTJLz/65JO79UZz/fnzF16v14sWFhaSUEuOUzSzbNQxq+un6lZwRTYKJofm5lq0v3/AwZzh6IEGDXUBVMAggOLYgW0i5dNt9zKzzQInjZct4bJ4s/G6JXBvI94F73QLeuO8qPPqlRA/fdKOfh6aHowXkNrBRhAkEXaAOP6LL75gm8Fr166xZkgRP4QTU3RBJIMsdUwiPWRC2/DfnOInarXmOe744UEHAcvOXLz8wV84jhN9/cWfD/Z2d4ZRGD4AR02Ki8HENoxXCEsAX5PkD4GeXc+7MLew+Isbt+/+zU9/9ouPllZWNre2tpudTi+uNeoOPGwlHl+k5e/VZ3edTpcJHGZvEgMKqttBr08PHz6i77//nmd7kkJIsnpA2oc0QsjckebhRcNNCF1qcDzj+G4JgcVM9aUyTOEbSzClYFMPWOYgeSKFkLvHRnmmLJUdbV8vZu1fi9pOntRZtslkXmwHAYwZIIEYMzAeSKanZnOOxwZIB0EEQQphL9hotNK4gRJsGuc4/lhIwMKAxCwJAS3iOHTgIYzlYDDAwNJcW1s7v7i4MBoOh52vv/yCOocHoygMf0ziA+p28bZqvgJYAvjqJX/Q19Zd1z3XaM19fOvuh7/86V/87JNTG5tnHj1+VNvZ2YVKNm7NtUDuWPLHDSxHBYLfoNdLM3CIPR4aKWZwX3/9NS/RYLGNZ3rdHi0tL6cJw0V+l6p+JyR/2XuWPqANx2LxluHYRGzGYWpClXm8u1u8x2Az8Io6rGtyxvZ8akzBD0QQmiCE/oJteLfb59AwOAfrYku4tnYq1RBBKCHapHCkpRdNIE6DkHV0u93EO9iLRmHo9QeDWqvZPP/B1as/G42G/W+++GKn1+t24yh6oQWJtgTwFcESwJcPqcypBNBxnM1Gq/WTSx988Nf/07/6t5+snzp9rt3pzHc6fSR4c/yg7iI3L2ZctUZDBQvVLqhLAEHuOp1DXi4vLXAO32+++Yp+fPBAqYI9okePf6TOwQE15ubozLnT3HAVYXTIicbBR9nBQ+L3JYbHfi0bazBvxmqJ3xuNKknVzJKsGe9LU14/txxa3cq/3viANJxSxXrmeiWTmqrzp7r+DNc97ncoun98wgTYkDRaCvs6kff9dDMd3TFP7MTFkUPUw/iJQGB3d5/TgMImHJI/HPPo0SPq9QZsGwiyKF7DsB3vjCTBRwJjgEgkjo4fBCywhNQwiqL5tbX1K81PPul2Dg6379//vjcaDP4Qx/G2KLte8muzSGAJ4KsjgGpK5DjLfhBcvfTBBz/9m7/9u083T58+v7N7AIcPiMujWr3uIe5fFI9KXfDVlSOKQpXTEQ17Z3eXY/tB7bu/t5cGde6025xxAw0Wxr660a7YdeSFcslVVznlKjqrAn6/8LK/d3UcurcLkxLAt+0JLF4lpgmEbx5n9tvS14tjn2nHJ17AGBuQGhRewogPCGKIbRAugLjBkRDOIfAWxjkwLQr8htj8ZcYOUUVLvuHRKGQNGIDxrdlsttY3Nq98/MmnP2+3Dw6fPX26S1HUTgJFv97QAu8RLAF8+UjtGhzHWXI878bG6dM//Yuf/+yTO3fvfvDk6Yul3b0DbzgcQlTuer6nwrCQR/Vag/qjfi4hE/E/gJkbbDYkqwfOxw/kr9/r0eraGjdkNHaI72H7AXIp4QE4lEiSFF3uoYcUkHumD6R3NvqDolxHfDkWM7+yaV/1cRlGlSSr6rhpr2fuLyq3KTErum7RfZwpB9jpyjmelFWO1Mm91H9aKrAZ75teb8bjjyphNM+zjPUtIolmxAbdeY81PUm6NwnrBcKGXMEgfJwKdDTi+ICOM+CxRcKC4TicM073CdMjJefQbQKhZcJ1OX294zi+F3D6k263i1hma1euXv1od2+73e/3n+xB/BhFj2LlGczFt2Tw5cK6cL58cIvjuu/7mwuLSx/f/fDjn9y+/eEHnX5/cWd31/M8N240GpgcYaZEzWaDf3o0dj0IKM+wOPuaQ4uL8yzt+/7ePXr65An1ul0mfZjB9Q8PaXNjk2dsrUaTkDcYjRe/wK+T7yh1gP7TVQVs7Btnw0WALOq/MrwN0kAQ6bzftDhuHDOL9w9vQ7uwmHUINZcvH2V9T1EGEQnwLM4gYjeOpeR5Fy9hED8cC+IHqSC2gxj++c9/5vRyCDCtCJ8KRcaCO/ydkkAlXdTLwwFi4jhqt9vD7e0dz3Hd9bsffnjr8pUrPw1qtdtEtJiMmbZnfQWwEsCXh7HxkuPUyHFOeX5w4+5HH//kr/7ub+/69frmg/sPa54XuFHMTdl1PZ9F6cjeIUSsFiD/IzyuOmyfNz+PND4H1O11aHNzg3ZevKBvv/6aQ7sgJmA4HNGzx4/RsuncxUu00FpQRhWRQ41AieujYURQMbtONrekAKGtYhDCYUSe4yW664QDxtmW6Xq6l4h5oaztYvIujEPCE4njV2SHWHY+iB5S0eXf17iOqX3He+BdUWlH7MEI8xhx+HJs1DIb3OpAzkW2ZslKqm3JfVE5788IOJeIjif3mzZ2+dfnNKLF5c55tUYFcmeViGVtDInDVZQdp3smTuyPVXh2/nPCOkKZSKjjYtXI1Ynj7A9aHO1ZJXrJSXLZrK1kmVBIX9Hq/5FsCKsmgccPd1Nkaqh5nk55//x3EpXGUXQdN7st93HcQgKoq1+zz5NoWhy/NIZjtRd8nInFzuNGcg4vQ7XEP34WT4uhmLwTnvRi8o/TXBXbz3cD8mKfmrFyHuwPB9Ro1Smoz1N/2KMX28+p1ghobWWVhQ2D4YAFBiCQynFkSL4PqWC2f08yhmAs4yQijx8/DtbX1s7+xU9//hfPnz7ff/L44fNwNDqMVZBo9nHJvDiLE4WVAL4C2z/Hcef9ILh2anPz048/++zW0tLy6a3n2w3PC6RWo13IH5mlCu/S5hkZGtjW1jbPxGCg++zpE/rDH/5Ae9s71O906cXTZ3Swu0eLi0t0/sxZmm+2+Bqe3vNhwBwPmlPBjcdL/cflfAeaZZ7kjwM1Vpz3Ljy7hYXFcZBH/mbrX4/jRCf98ElBVxljiTGHc8LX6xxRAj8AkkHYmu/sbLEEsNVCCjls71MUQa08zhZiggmouknc7fZG2zs7rXPnzl35i5/97NNms3WXHOcsC02UV7DuQGlxwrAE8OShSwzQmhrkOueXlld/9stf/dXPPvzwk0vtdre1s7sL0Y3ruZiXKes5yFJkysOTMdhoDIbkYeYWIeRLn+JwRPXAp16nyw0QDRLGuJiFwTsLQHw/OHxwIYzsHVb9NH3DOOHGoX9a5wjbj/oTdYq5XoWq48zymveZqHd5v5z7VN23aL9ZnqL9Re972vub1zOfe9b3fFQU1RfzvtOWZ6rvWXK8xTGQRwJfZV9tEj9RG8O+HGOJpAiVcQaJBPA3PIQRbUKcS3CMeB/nSX/ZEFAlNuAMV61m09nb26vt7u+vffjRxzeu37jxi3qj8Ynruus50ndb304YlgCePKSSYvbiu6634Tjuzes3b378r/71v7kWRdHyw4eP3CQlT6quySNqsm1hYZ4bGRoe3PMR1Bl2GFD7Bq7HDiBojJLbEYGg0RA5VY8lfRYWFhZvPF735FwnfvI3AHtBOH3AJhCSQDgXYrwBKYSjCH4YmzDmiD2hfs2y5/KDgHMHf//9995gONz4xS9/8fHZs+d+4rjuJcdx5pLx1HoFvyRYAnjySGcrjuOseL5/5/ylSz/91V//9Y2lpaWNh48ezfX7fX9+fs6NY1gQEYmZSVb9q5SQkopHxOxoZPfv3+dYTSCCaHwwzEXDg+QP3r4gl1iXiO16o7aSwJwPFo9/RTBVxDGMu9jIRmSFkN+W/jS5on58ocRmoggFEpy44Gder0rSNm05inBUidC0kqzj3mfW8hRJxI57nZO+31ElgbO+31ct4XwvYBKk1yH50+8r44X8AE755nmpJBDjESSAGH8AkEGMQ1AL6ylFdRXwpO23cmbsdjt8XYxZjx8/Xlg/dfrqRx9/8unc/PxHnudfJCJlx2Qlzi8FlgC+PNQc1z09t7Dw0b/+N//m41u3b5/+6uuv67u7u87CwgK3BlT6cQPMb5A4Zm9vn6V6kARC7fvdd99xIwQZfP7sKTc6pOzBEo0S+/Li+9mAzbYBvGpMoQK2sHjv8bpVwGZbFQIo3sEAUoliXIGgAeQNcQFxLLZDAggtlXj9CgHMCx+WqobZFt1xoQpuNBrh3t6et72zs/ThRx9/cPv2nY/8ILjuOA4C19rJxkuCJYAnB31mXHM971Sj2bp+98OPPvzkk8+uRaGz9uzJ88DzPKfRaLiDwYg8b+zBqn6UutWPGw6ScLvcyB49esyNTnld9bjR1RsNjuIuAZ51t3uJ8ZS9hx10ixqC/iuCSP40ieBRJVJHlSgVba+S0ExrA3fUcpw03nQbsyobOfO4KgnutPeb9bwiVEkcqyTRVfXpTf9+bxxeV99skjRTDQwtFIigxP2DqZHEAeRwY/0+Cx6gGsYPY5VpU5hzT0bQqDuIEDgYDBzP8yFJDBzXOfXxp5/dPbW5+aHn+2eQOlVOM5YWx4QlgCcHGXRRn+dqtfrVlZXVD//27/7uCjnOysOHD0EKueGoOEyIu5drJJv5G9K81ZUVbliff/45NzaVsmeXDvb22eYP6xIzENeXzCBii2ElfwUfzCqwLCwsLAolkLJdcv9irME2aKQw9iA+IMYkCBtgi45xCWORJBIog+QVhqlSGEbQjMUHBwejz//0eXN1be3iZ5/95Ha90bjqOg4cQnAxawt4wrBxAE+O+EkL8qH6DWr1T/+nf/WvfnLt+vXzj588bW5vb3u1Wi0O/JrT7fW4kaAxRSMY2NY5ADRiMdXrNRoMhuxOPzcHzyui7a1tevzoR2of7vNMC16/8A5GA4R4XrfZcF01U0MjRQN0nLE3lopjNc77m26T+FE50kKx4zA9uo46Wz1+XLBCSIHiWe7nuMi5MtV1M5DYiI7jFcVPS+5f9Z7i0g0Il1Ww35kmTqD2nXLjzGn7j/RBc9MFTtizlpxvhhUsiIlWFCbpZaeiLYlj6FTE0WNIO0vjPE3uL3pB5vdN6/eMbcj87pn7af1Apv1o67nlkuNynsvcX1q4olAhOeU7sX4ke278UqVxRdeZUIcWlu/koZsdsS1ewX31McFMRCBSQiQZgCcwtFCXLl1igQWCRG9ubrKqGGrhPDtHuTZi3sJ+0HEdZxCOYuSrHw6Hza2t7Y3bd+7cuP/DDx//8Q+/34rjYS/JFcyXsPanJwMrATw5MCdwXHfZ9/3L165fv/PpZ59d3d3dW+q02650llGSMxESuiDw0+Tc/DFcl4mgGN1i3fc9evbsGc+sROQOpw/MxmCQWyBeP8HHsij74BYvH3n1+WUPkhYW7zuqJnVC7EACQfwwTokmCk4iEh5GhBNC/DCOSS5ijH9iC69lo4JKuB6G0Znbd+9+tLq2dtdx3A0rsDp5WAJ4fIxtXRxnnsi5vLi0fOdnP/v51QsXL208ffpirtPpe54XOI7jOaj0aASwd0AWB9gBQh2spHKw24P9RJzk6h3R1vYLevT4R5b6SSgYNJjl5SU+Xm9cVXYX7zimtckq8gBm00t9l34dCQzNSVKyNl1Htamrsp2qsvmr8uJ8J2yyyurxayaB/P61dmdCym5+ryqbwMz1c7ZP+x2r6tG05Sg676jPZfEWtrUiCTwIHggggJi0EE6ABEq8wCoJJzIhuV7AkvAwDLlOYTzrDgbu7uHB6s1bt27eun3n41q9/gE5znLCWXK1GRazwxLAkxwMiJZq9fqNW5Bd37p1Zmdnp9HpdDzMaMQrV8ieOGmIHSCIINoFZkDIAwzpIKR+X375JTcmzKhAAnEdqH7hOq8b2+ok0OLVwY50FhYWbytmsQ/P8+LXQ46BDGKswrgFYYWEisE4JYIPuQ6OxbmyXaSCruu6QRBEYRhGBweHkAJu3rl798ra+vpV13XPOMohxHa7JwRrA3hCtn+O4zRczzt9+vSZ23/9N39zc2VlZf2br7+poUJDjeu6jgP1Lg7Xo6ZHoxHVPJ98lziPbwBj26BG7U6Hnj5+TM+fPOXG0T1s07DXp42NU7Q0P0/DwZCDQFvp3wTiWWwExREkRioWta5sr5wCmzstOedrdiKRekfvMvLihxkbZjr/uPfXdyX/F0kjqtanrT3TSjtO6rjcdpKzv+p4c3vVdS1eE0x7xDL7RH0/Cx58n8kePIPhGALyh9zBsG/HdhBDCSMDwic2hILUBp1cSsyjHIyPo9HI7ff73sOHj+YuX7p09uq167d3dnYedTvtLYrjR9rYa+vTMWAlgMcHNIOe4zhrjUbz8vWbN69eu3b9zOHhYWtrW+XtRSUXaZ/EVhLihlyOaE+640av32N7ChjTqmCZXf7B7g+ZQHAtzK4gBcw6gKhrWlhYWFhYnJTNX9EvIWtM9DA2YV3CwmCMwt+QAIp9n0j6cI5kDtHHLV0aiPiAOzs7SBm3cvPWreubm6dvOI5ziogC+2VPBlYCeHSMJUGOs+C43pXTZ87c/uyzzy6RQyvPnj1vyP4oil2QP7OS8weAatgBQVSOHzjk6dNndO/et3RwsMcNCWJ1qIRXVpZT1bGI3LUyZJbvkZH8tBKIabdnEBVLbookHCaOu/+9hhiO54E9Cen1osi7V1DSDk+qvhQd/7KOK8JM7eoIsBLE19DeqlTEWIPkD+eAtEEoIc6KkkIO+yARNIken2/kDA4jolGiFk4khu79Rw+XLp0//8HtO3duPnny+I+9TvthHMdbRl19bwa8k4SVAJ6E7R97/gbXrl67cfPu3Y9O7e8d1Pb2Dtx6c47DgOiRDlCxYSSrJIIhuYFqcMojCgTQ4dhKyPOL4yBOV9K+BRaz9/sDbkxLS8s8s0LdV40Ky1f/OSujnLzhMFO8VUHUvjaG4KuD9QK2KIf1xz8KlPbJye3Xplk6cIcjovkFhCsbsQMIIlOAEOJv8QSGFBBjmQg9xGbd9b3UG1j2ifQPx0B17Pt+fP/+/VqrNbd2+86di8vLyx+4rgdbQAhYLOk7JqwEcHZkZhuqIjqbZ86dv/Gzn//yWhg6a09f7AaOV3eGwyEmOIjvIgdzZwXv3Rgi9Fipg7vtDkv0Go0m/eY3v6Gvv/6aWq15zvfb7fZpbW2NFhag+oUNIWZRLg2HaCQqb0XMthPKiWRcLjd/AOUWrEdfG2cjEeh2GlVexXysM4WtVsE18A7Kjim7Ds9WExus2HwG7XCzyNmLVcQhK4kBqC5eyB6lq6ySEE3s11Us1ZLc8vJXmwRMP2nIDzkk9zfLmdj2xBXXML+/+R3TYOlicifXka1Vg3/F+3Oqg9Uej3vMNkMy60POpC7zCsMomlaiV3TD3AJm2ph6B8oGViHLIrL3y9w3J46hk2xLOpjyckYxHK3RwYz3q9h1ev9U/BFgV6ZOco/0eTLPmnOskKAiTPar2XXPy2tTztRxEs3+a6J5VdnIgsipj8JtNXUbT9Y91+W3i9cfQouV7Pc4fCUyVPUoDh2qBx45NZ+G0YhqdZ/m5pvU73dpe3eH6s0G9QZ9iiim5eVVviY0Wy4s/1yEQeN4qkoAEkMTxt/KHQ5CWAY6zVrd++qrr1sffPDBmU8+/fT2f/6//q+HvW53iyjuWlvA48FKAI+OOGFjS0FQO3Plg2sXLl68vLF32G7u7R2Q53rUbDSJm0ym0UtHwPGOOOizmu0E9Pz5c46mjnXYAGIWhWCamFEpbyvlceUpt3let5/x1WM85llYWLxeREagJoujkoBZl0qYIfH9MJ6N49lCoKFLApP4fkz8IA2E9M9JUqGWIeB4uUG8vbPjHhwerFy5cu3q5unT1xyVHcTaAh4TlgAez/av6TjuucXl5SsfffzJuZWV1aWtre0AeQ0TZ4/M+xXJGuwBxSBW7Plw/OPHjzl2EhoUvKmwhGEtGpKyD7ThXgq+R9k83oxP5hT8qs4rul/R+VXlsrCYBdPGDSyqn9O2k6r4ftO2H/P+Rc8x7XNZvIGQcUmXVmIb1LcYt2CmhPBlQgKFAOrnlQESYFyr0+k4z5+/WLh0+dLFGzduXvOD4Cxs7w0OY/vbGWEJ4NEBgfm86/mXLl26fOXS5cvre3t7tXa77aLiw46h1+tPnmSk1AHg4LG9vcNev2go+AEwqJVUb4BOAMVWwsLCwsLC4nUgj8RJpAtoreAEAgIIW3YQP7F3N8PBFAH2g7gerrO/v4d4MisfXLlybnFp6YLjuqfIcbDNin6PCEsAp4eT8+5WG43mlY8/+fTq+vqptUePHvvwWmq1mi4CPk8DNBRk/Lh37x5L/SABhCoYxA8EUG9gkmD7JEO9wILoqL+3BFUSiKOeX3Sdqv1HLYfF+40qSfWsEuciyZ55vyJJX1X9PW67K7qOxRsEyembOnaIvXsiEUSWEBA/5PsVwYaERcOvCo7juJAiQqgyHI78Z8+ez505c2bz0qXLVz3Pv+QQLeTYn1pMCUsAjwiOSO66a6c2Ni58/PEnZz3Pn9vd3WXVr3gx1eu1vPOMSOoez5BA+lDR4TUFMTnIH1TD6YfivMAqb6JIAfUwMK8Db7sHsIWFhYXFySDPeQ3EDT9I8jDOYWwT06dpJICQ/GFcFKL55MkTr9lsrdy6fftyq9W67LjukiV+R4clgNND91ZD4OfFWlA7fePGzbPnzp1f397eqo9GI8f3vXgwGDogf2YFH8+UxrMlOIHA2xcNBI0CBBCu9PiZWT70GEpHIIDv6ky6SgJSZLt0VJjXKbIRLNpvHvdOhNE56s/i6K/+iJI/wUm1h5ctybaS8jcYppezbBNtFca05eVlJnKQAkLLJaZL02iyIPBI7OXZFvDg4MDv9XvL169fv3zm7NnLruuuJyFhMsU64cd8Z2EJ4OwA+woc11urNeqb16/fWPGDoPnkyVMPFTXwA66wtaCWawPIEQ00Qgev3/v373OjAAmE1xTi/WGfbuOnR0iX2dObkPXDDuIWFhYW7yd0oYT8hAAiXq1krIIUEOZNGO+SnL9TjV8Y6yRzFkgkxsjd3b3m2vr6+sWLl864nrdKjtPUJtsWM8DGATwCHHJacRyfuXjx0rlbt2+vbm9v1fr9nlev18NOFxV+zjlsH7J6F7OW/f0DqjcQ1NKjw8MDrsjNVp329/bpm2++4VAvcAB58eIFz3j0YJr4O3PvJAE3AEKo21xUILdx4PyjkjgWHXA8qJx905LTOP/4aTOZmJkYcq4zXTw07RLGsghmnLPcDAouxL3HnFHPet5JZoSprF8vYRJSlIkgNw7hce/1koUFs77/GSZ1jvF9pD46xyxfph6b9RvtLSmj2k+Fjmjp8eb99POr2uXLzmhU9b5P8v55bbQyzt9LRlWcV718RQHZhfCxkMI4RlS4GMcksQEiWywuLymzJk9J+CTD1XAwYNMnjHEge4eHXT4eRBIBKE+tr0NjFpw+fXrxxs2bG7/97b+cfvH8+XLsOIcUxyJxsWRwSlgJ4FHg0FytXj934cLF8/Pz84t7e3suKr/Y6SkD15AbBSo/tsHTVyR6IILD0ZAJH1Lm4Bhxk4e4HDMn2Eqg8bxMWNcpCwsLC4uXBdFc6YILSALxAzD2ybgokj7JDoK/MRZKyDTWikW8z2232/X19fXV1dXV857nnXaIIAW0mBGWAB7B+9dxnOWlpeVLn3z62aXW3Pzy82fPfdf14ADiohJLahux8QPhU9vHDaHT6XK6N3H6AAHE9tXV1XT2g8p/DBw1HthMMMPa5IW5OSaq4uxlvBkTCUie92GRV2PVe6my4XsnbPmOg+gYP4sTw1Hr4bQ2dlXXr/KKP+p9Ld5iiNRQVLgYByH0gEOIhITRCR72i5OIEMCEILIwGYIV9PHb29uNtbX19SvXrl1pNJsfEBGcQSyfmRH2hc0INjh13LXN02fO3r59Z2M0GjV39/YckfwJ8cNPKjUgnsFyHBoBfjgOsyE0BthKJAmw0/MtypFHNF+22sgiec/2RVhYWJRA4tiqqBgqOwhUwRj7IOTQpX4Y7yTKhYyd0r/LNravr9UQNQPhYRZu3Lx5dmFx8WxMtAghov0Ys8ESwGrIrBdsDEH4Fj3P27hw4dLmxubmCoI/h2EY+54XoxJDpK2CYKr4flD9IvMH/oY5GNYh/RNjWFRueEehgi8sLLBEEA0ENhO41jFQFdn/TZdcTSvB5HXMCnX7pxxiOG18vqpyVGUIsZINi7cZs9ZjKyG3KITErRUBiEgBofGCFFCcRSQ2oASRFkjwaBDD5BourgGhyeMnj5vnz59fP3Xq1KbjOEtJUGipk1KXLUpgCeAscBwO/4I4RJc/uLwwGo3qmIlgRiJJx6HmlUqskn2rpdg0AKi8qPwAZkJoDGgEYvuH41HJX4Uk67hevK9ABTxzeSwsLCwsXj9k3JMxEGMlfpD+bW1tpWnhRPUramA9vZxo1UQSCODvJ0+e+LVabf70mTPLQa226BDBaN6SvhlgCeAMcIgCx3GXFhcXly9dutxCTKL9/X3MSBxI60DgZLaDH1IBqwag4v6h0kISCO9e/CRCOnsFN5spYRRjWVnOiJlt096QOG6zllts/hi6JKKABB7p+ke4zpsuWbWwmAbT1mNb3y0KgTEO46IQPCxFuCGCEIyZIIWAHt5MyKCeMQTrEJJAndzr9YPBcLhw4cKFtbm5uTVSuYExaFoJ4JSwBHAWOE7Ndd35ufmFxc3NzUa73fFQGZXThiKAmKCgwsJbyQ+Ut6/nwzsYLv8qht9w2Kdhf5Bm/kAYGAn3AiKI68jM6OXg3bMtfJvtAIVIz7q0sLB4v6E7U826PDn6kDMfjl3+RaOQx7N6UFM28C7Ink+e49JooGwBOX4uj51KSKIHlBYnEJH+Oa5HXRDAWgMsz+11B41Tp04tzs3Pr7nICuI4x/KcfN9g4wDOAIecuut7yx9cu7Ya1JvzDx499f1aw+n2h45X86k37DuQ9sHmz/McGg4HRNGQomQC02gG9OL5Nm1vPad6zadn7QOaa9b5WBBHNfMZZ/zgIJiuqs+8LeE0aB95cd54mxMZcbgm6ILQCA7hFsehw411jAxz0kTumbhd4/tOsBEJ/aWOKwwTJgfLM+Vf0HGcohvB5m8ctG/8ftT/bhJsLCmM1uml10uejNI7GNcvL7l235J5VBhmZ7R8x+RRuVODiQA+m0hiY1VWXLFqScYLNmMI6h1p0f0ljmNRHMZKGh27E08/SyzD5DNNBeelmDBUVdCK3dm2M7m/4vmi4jh6R4J5u5I4f8laeQHR/pJrqEadCtzVuuMWVhGz3Wb6j3Q9Kq8g3DbNjEqql5Tyl53OREPddNIkhZ0Mjj2BLKdTVdepeP2l18K7kR4Qu6T/0Jcunj9Zn1jyiZP1b5bJcxwl6loH6lvlhcF9D5LFOxHVIczoD9BZk0sOjdhGnqhRC5j8Dfs96nXatLixQbujIY2S/ghSQtjJwzGy0ZqnIUfQcGkYxk691Yr7g1E8ikPv0dMn9SuXLy+fPnN28/Gjx+sOhQ9iIpV02KISVgI4AxzXadRqjbXNzc01cr1WbzCcENHFbAs4/rke+rgRLyEl7Pdh4xdRp9Pmv/XcvhP3K+0c3CN+vrTlq3u8PYKyE0d0Is9/9Cak3xr95axL+dvCwuL9A08cJUWom78s0yKcjCYhGYdi48c3cTM9pMdljcmN8XdMvkts/w5zKGjDQPr0HMG652/GtjxyUtrd7fZ8z/fmVtfWVoJasEyUOoJYTAFLAIuRF/9vYW5h4fSVq9c2B4NhU4JZAjzjyiETuvEqjk8imvPsR2wZQALNfL9y7gl471WtV20vuk+Rl27RetVxRd625nNVPU/RdSws3idU1ftp+4ui9loUX/Oo7dbiPYIkTRA7QIyFSIEqXr9iD28SQPmb5TGui3HUHQ6HjTNnziw3m63FmOKXmz3hHYMlgNMjIMedX1lZXbt06dJKt9utw5NJR573q57uBzMd2PzBpkEyf5gEUK5jkkELCwsLC4u3CRLLT/6WH8gbHD8g+YMwBOOinvZUHEaK1NESa7fX67mHh+3a2tp6q9VqzSH0oOU108MSwGpI7W3AyHRjc3N1ZXVtsd1u13S7Nd2uKnNyQuYg2gZhxAwHP6yLS7zu9n4COVzNGfm03q+zHm+eVxUfr0hCcNTnMrdXnTft8RYW7wKqJPBFkroizCrJsxI+i2zF04QaEv8PS5A/CEQkWDQgcQN1wqiPkVrWEGd/f7/WmoNr5sIikdMickzfBtvfF8ASwOnfU8vz/cUzZ87OE8X1/YMDTvumw4yBJ7MfcV2XTCGiOpagmGbFtng/cNwvDVsaCwuL9xc6Scr7vW7oZciTAJpSQDh96JlA8p5F15Dht7u35/u+31peXllwPbdJjnVunRaWABZj7LXmOL7juPP1en3p3Llz851ut9Zut2ETCCeu1Cs2T2onUcxRucWGAZVdZjt6YEtpGLL+htkKVR0/q8TwpK731gNE7ig/C4sTbNdVkv/j2vRavKcwVcC6DaBOAMXrV8ymdPWxXEezCUzH5/bhoR8EweL6qVPLvh/ME5ESI1ob00pYAjgFHCLfcZ1mrVabW1ldbfR7fR/q3LwZVp4KGJUdal9ZF0cQkSDmhid4TZk0LCwsLCwsTgJF0S1E2AESCM0YNGSwkYdQxDSHytOuiTNIFEXxYDj0/SBoraysLvq+P08xE0DLbaaAjQM4BeC1HkdRc219fW5+fr7Z6Xb8MAyhAmb/DpOoidMHp7+JQhXvaDhkuwaof1Hh4fEkmT7yHEDEyJXjKZWVbSwOT+L+pbMmJ59cVs7KM3G6cuwcq85P7SGlPFXHlxYmhxxPc1wcGd9EO1e/hnyrIszoiT2Bsph4r0JFc9z7V01CppkEHef96t8n97rHfIWz3P9NQSbOZiIJKfq2Vd+YQ8klp0zuykpv9IE3vf7Ryq7d5OVOcvWJtBkX86Suf6xzqr5PVRzBl7x/GowTMY0xHs9SopaMU6ruYB3jIcygMBZC+iep4ZaXl+nevXu8XcymBHqw6GQcjff397ztne3W6dOnF+fm5ha77XYzjmNIV5TUZWzjamHAsuQpgPiWnuc35ufnW0GtVhsOhr64qxdB9okrO4AKL7l+JfJ52bkWFu868vJH53nTW1hYvJsQTRhUwRhXIRjB+KjHBCxCst8d9Ae11lxrvtVqLZJDczDbejWlf7thCWAx9KmZX6/XF9bW1xfqtXrjsN32UFGRZUKkYkUDlq7+RYWGBFDs/6pm6TMOgEW2N1VeelVestNerwrWK3CKjzbr722HJYDTv6qK+HwmqvbP2h6Lrmd6Bxd5C1tYTFYqpIdLwqDBNAq28iB/kAyCEFaMiZKWxtk/OKg1Gs255ZWVJdjrw2zLvu5qWAI4DRynVqvVFtbW1hZdz2102m1XV/Oaaga9kuI4VGRUcCwldzAqua5KsbCwePO8HF/3/S0s3mWIkySkgLABhLkU1pvNJgtMzGPz1tEO9/f3fdd166urq3Ou6zYhWHylD/KWwhLAKYDo4rVGY2llZXU5DKN6p9tNg1RWqa0k5h+2w3EEf4v3L1TCgrxcrDNKAGf1pj2qEOmokoV3RWj1XuENIkDvq2Rp2jh7x30vVXE8p72+becWRyKAEI6AAAKQABYJVUxb9ER6CK1cbWlxqe55Xg12+/YzVMMSwKng1Br1+sLi4uLCYDAIUFF1D9488qcbqrIzSJL9Q6/ceUbJ1vbJwsLCwuJ9gETDEJs/EEAsxUa+SOqnr2P8DMPQOWwfeq25lh/UapDOWG4zBayefBLmbNd1HKo1OdL4Yqs/6PsggEHQVJ5NFRUUx6Aii/0fAAmgHugyD0dQD5+UOKbUK3AaL+ATKofFe4CqOi7e7UX1Kp69fs6EkvsrL9mTr+9xYTzScjhTtt9pMe19TbxP0lmLYwLjICSA+GHMgw0gTKWEFOZI/ibOB2CPf3jY9ur1Buz1/UMr3JoKliVP8Y4ccmvNRqPRaLVq4Sh0h0OVpgao9FqMVTgX8QBGvyqVvSoERbkKGBV/mhAVrrF8l1wIpoebszx+5bfN5x1SMVtYvFdIpzbHwrTjEJUKOkSjJiZT4hxSem4kIc/QV7gwsXKDIEBQaHiV2M55ClgJYCUcz/Xc2uraer3ZnK8/fvLMJceLHddlz1+HlJja89RgBXIo6d16vQ7PZlaW1+jB/Yf8NyKdj0Yhz27QcFw3+wlcNzvoRfFoskQyMCbkMiORiLDTiP2GTQgXxrG8tGvz/eSv8eUz18Mjlr2dRNJeGIes7OQp4oDl2UZOc3xe54aYVFwi3qkIRpQElDfvM14vf4LoCHHysmUKj3W+6xebulSHfMT1pfwT8SJzt886iCBQa0LmjHqFCZNDwzCNeymHZOLPyQ3GkjglOU+vn7w+nJx3vj5RS59I+1teX5mBebJuuh8mDzMeZ8xMPjLJkzho5nF87XAssUvulckrnvv9k6Lxn5EKeIk3LNdJjomnkrDSZP+SuYu2hiv5Xtq/ZL/TEZExYnwJYX/KYpLyNzLihabHThkHsmqOokmoCvrw8vP1Npz7firixJb3AdXErfKbVHQAk2ZR/Ffy/A55zohctOk4pPlWg7Vku7u7dOP6dXrx4gWFPHwlE8JkbJRsIKj6nuOhDXA5ut2eN1ev1ZrNZs1xHNeGkaqGJYBVcMh3Xa9Wrzdrnuf7UUKI0gGi5FQMcGIHyIGgR4j/d3JBhslBA57C1lXMIUyziPdMwJLwvnRp8fJh5svm75BK91yK0MMziVIBYwXydxgqgjKWCo7zgBZdX79OXr5uHVE4Gc9TXxeilheyiT37h+GEPa8QPvxg7yvX0c8zCWIeSZxGAmqlpBbHAsYEHkdeH6AdEyngcDRiZ0kAEsAo6qZJEbi4om1Dn5EINNRx3N5cPwhqvu/XrHpmOlgCWAwZBXzP84LW3BxmFd5oNOIcwIkNHyYaScc9zlsoS7Hzg+QPlVrsAU+IABbZ/BzVFso877jXs3i/kFtPNILDbUaH43gsQU8kESKxYkmYSPyatbHDlPqFaTYKoD/oJtcaZ8LhiyX7B0OYXRSTJt/NT8co28w2bf7t1wKWjaEfyEj2jBBQIokRhzAhiPWgJtdjIaMMdrieGSnAeM/Js6Qqg9z3r5X1qDZ9pfe3sDgO0DYgHBGbv3b3kMPBoN4qW/m9TJsat8lEg8PZRGoqwkY48gM/gLFWw3EcX6uoduwqgCWA1UDKN7/VanH6t0F/wAOUacOX5/whBq4jbVajew/z37Y7tXiHURbqCMTP85Sht5A6XZKGHwYDgRBA+ZuP8xRR0n+6DaGYY+SVgY9J2l+RFFBikY3VTmky+pTMybH6vWW/BLmV+8m2NI5omFVp6/fXiW4RrJmkxduMxIN3whN4OBpyLMAqlX6UtCe2HRyycAYBoVlY84of5a2EJYDlYD2VizxwjYY/Go38Xr/vSAxAHaa9jgwOzWadBzFUUAwQqOQyEPDxRyeAVZI/K7l7B1BJAF5ZSab2Ls2so0NPiJmTLNP9pgNVQngSZicq4JDPh40tbLt9v8EdvpC9oF5LJW9olyYBNKXspipXN2HKe9dC8HS1rk4AB6NhmtdU9uFvyWEqBNIktvIzDd31+0zjKJaDogpzUlPNk5Ikvin3eauRmDC/NieQk7Czk2uIcAR2gN1uj5rNRtqeS+4jGgMahUMviuNGa67VcF3XL7eutgAsAayG6/u+32g0mQAOBoMMATRJn0AGAhyLQUBUQcr5481MMm9hcdKo1WCOM4bExUxJVKQ6eLQTCQjLS18RvFarlewfH6MTwKFhI2hCTyeVt7/KRtAs/4Szk6dMQHTShnYvP0gzhBCyHXCyXee5eYRVt3mysHgZYL/AN+DVog3KeIi/EQoG7WZ5aSkNBaNLwxUhVG1DN5OIwghjdKPVYgJoJYBTwBLAYoh1uqcIYCOIosgfDocObBPQmSsP27F3k0kGpdJC/aurgGWweMNmzEV9wZvQR1i8epyIJEnzgk2FeyKtYwmYV0/VP/jVGzVeCskT7/r05qwCVqpglg4mXrhsY5cMCroqueZrXlfpNcaPIINHkQ1gkfdmauc3UmQOa4Gn1L1ObewIsrK0nEoC0WdImAuRGELaYRJInRDm2ACaZXzVDPFV3c8y3/cAYhIhknJMuDBpQ7vwkz5BJk5iQ8+To6Ste5gEDod8bhTHfhhG8/Nz8/OecgQpivFrkcASwArAywM2gI1GA+ll/DiOsR6nBDAH+iCEiqung0PlLQoNYGHxrkGXwKGjRwcP2x788HcQ1Ml1lOqWf95Ykqc86Mfn5zlk6E1IlwJWSegFmMyV7deRZ/ZR5BwiZE4cwfCsci+9f1hfX+fJIbIE4YdYoSIxNMtfUKrSvbaPsSivINEbQQCFxImABG0Cf4sGzbSHZfs/tC1OsqDMq9DFxBS3WnOtec/z0NhSDzOLfFgCWD5LQEwub3FxsQYC2G63/Waz6XS73RgdOges9NUsPQjUuvo7SNW/GOiePXvGHfvKyko608f5XKE1yeG0nbUxAMZlkkDdfsIYFDk+2wxWJKU2hebAO7Vg4hWSYJMM5El49P360jx/vLH6PnnnGmHxCu9xlDqhr+eFSdEBmzyQNByPOimzcZE8yQxcn31nnB6S65h2a6KqRRgUluzV6/zDPbJlGtu4RfDwHQmRy743Ff4lG75bHKlM4pd8V7YN0iTtGWHZ+Pum71mcu/i4ad9fhAIb713Fm0QZ+AiOV2ZCyuv7LtVqc7S0tKBsCgcDJoJQg2EQxLquPhY18dgzMj8XuRkmR8iovm8aG8MigjstYsTCSv6suk6RM8wM95oob5EqfdrrHoWAV/YZmUgR5eUwwwdNc/+ispRtq7p/0furej9Vx6GPgLQPph6qjra5nkIFjCXi5u7s7KRaArQD1a7T/lkFz3QcCGW8brc7Nzc3v9hsNpsHe3sQ/0P1ZqV+BbAEsBzwKvI9zw8cGJWOIg85B7FD7JbyOh/5W2wFpeOelehZWLwKSGYaJXFTs209RAMgKlpAyAhLqbQBDIMFSN7c3BwtLCww+cPP9MbNqjyLB4psm8kn61UDu+mwNXn8ZJvU23F1W80SKLMPkGtP2A5qfYFu/4f3h++BiSPeD4ig2BDjZ6qRG41W5h4mCRIJJJc0IY26o4x8X4v3E5wM4DXeX28vqWe89ENhmJqCmP0CEibwOWEqaY+grXNdr96o11sBvMUUv1G2Vxa5sASwHJAK+Mgug1iAw27f0zwVY5GG6JVTD+wqksA0FpiIrU+WAM5qu1flHWy9h98P8HeWvJuASP3ERk83WZCYdljq6pogUetiBo8fiIsu6YMUSyZBfFPDo1ZMdcaZPCRHtnj/yeQpOwiI6go+IEXevmVhmsbrKo6eHkewiDDmSU7GmVTGx+SRQJOYyb0k7ZVOzLAU4oz3qTuRSExRaBQUERyrmnUJrBBuUSWb8Qnz3tlLwrTSF+v1e5SX68z+8sfqLXrt0Emf1N10wjMccF+SF3UDYBtZPl/FGeWovI5T84OgHkAl5ziY2b6Gp3p7YAlgKbhK+UGtVmO38jDkHlMnfmNR/tiAWzpkdOKozOisdfWZrpaZJl2XhcXLgq4Kl5+EKhJyooczkf1C+Bo1pdoFUUF911OfibpGzsuTgpu+UBIAeewEIduN/MAi1coJ96ITKt2JIm8Q4SxS6bXz3k8+CRxL9ya9iHWyZw5wZXaEUlb9WYXIiQQW71z3Mt7bO+D3jD4GxFD3MtZVxXr/I9LDzPu0eCNRqa59Bz6frmaWsVFJvIdUr6uJpJih5EHG3KSvYq0dpDYO0TjmlEUuLAGsZoABAEcQVC6ZjaQDZxKRXLeLksqKgfHgoJchgNguru0nhCIbwKOeb263mUHebpTWDwlzoqsrJYSRTuBMKR9sczhESzxW6Uq2GyEcYreTFiRb5/nCuhBKl/QplS/Oycb1Q4ZPVSZJDKqIDiR4SSrd5LpOrPJv6DlyjaYRuzQap5ZLTTuy5R1bCSb2fbyeqq6Ry1gbZhRhHO9Ham51nr5vfHytrtTvcr9UmpfkqQ2TXK86iQtqHgWk+iGxRca7h7pYfqIyBimPIhBCnB+w6ky9W7FRfOUMokjSZ8fqI6HKx6FMBvhmQEifTHRQl0Xa3Zqbz2jOxu1DnyS5sUyeRmHoSeQOnp0pG48364HfIFgCWAaHXMd1/FqtpvIAR5Ers5VUtZKqqsbql7GjR5AjAVSBbWWWbiWAFq8TonJJY2kl5E9m1IuLi2yHA7u+5eVlXuoddpi0A7mW7nwgkyFBngTQdLLQpXF6oORUKuiKCUXCI5CcG+RIHBvkGsnSL8gCkm4Li21zVftM/h4TQk1qF1Hs+AYBzEr6dFKnL9PjjSKZIWEwIOpho8yMKQh3JraWsLsUJxL8RCIodoSSmUiX+lpYvE6YjjrS3mUCg1AweY4wQgilnUt9Tuo5BDVZjzGLXFgCWA4QvhokgKIC1issshskAoEJg2/dBhCDIKSB4r1UkOPzqJjWlq/Ktm/a0cCOGm83MrNhPeSIpC1D3QXRg9f65uZmuh91WAhJ6pWaJGPHdtPjVJeKy8/zvCRyv/JCH42UU5WOrC2gOg4SKyaBri/CuuQBomT/mAAm1+DjPI1t8TEi6UsOxTiR61yiIgBMEECYGo3JXUjkgoFyLvDk0LEXse7gYmYQkWuMoqxtpC7pk3cnZc8llYl3thBuEEFIBUEG5X5bW1vsSalnKtG/zSuGlcZYpEB91LVqSG2NpRBA9Ct6G9C936UtyHUwEQtHI1YPgACitdvKVg5LAMvhwgbQD4Ia0sHpHSfAhA4DVbKu2wBicEAVZAP4CKq0BldQVhm9QTPv46QS0s9HSxNhO0eYlyUZ6zn7LV4fpM5KfD6p3yB+ly5epOWVFdrb3aXdvT3ukFVqNhAnRfr8JOC+7hwikjuQq+FQd3IYz96lA6/V6hliM5bGpexpfL6H7YnELZYA0Bg0JtNF6U5Xsq5vTwmQPxnmxbTzS6K8Z8ib2qeS0WMfNAERyhLFvKRkiUA5vIwcCmOXc//KftR/P1JlFEJnDnQIh6FvMwmb5BUWBx0JwSPG82fOnKGHDx/ydkgFhcyPJ6BlKkQrQHndeNdtAM02BUk+j5mJLatMbHQb1sQUhPuQMI7IjdGGRhwUfoTWxQGieWZnK3AFLAEsaVLgJ67rBq1mK+j3+x46Twx64jkp+X0xawlHEfmBT8NwQL1Bl+qtGvl1j3Z2t3ggrDeUOni+2aJwMCQnte3x0jmxmU1kGuSEkcqR9InQg5cqfQnfjyUIMJbS75vYOClqlyMhyFx/PFBj9OOxkOXyvBliFgxuIhsxlgre8TpAw8x3wuCt6n3OkjM891JZSS6TC309IT1mycY+qJN9VNYOLV89KVIyj+P2gZiN+JKSTg1cQjxHWULkjnNQ6wQn8ANaXlyhlZWlNBYXAAkgvmG/26Fup02DXjclFjGFxLeLQnTAnOPX970YhGEs7YIqRuqPqE6VahdE0HWVJNCvqXKlUjwtDh//xpU1xqtyPUgaYfejzht0e6rSIddwjlOD77ppfD/91WdJnkmCxtdBdAkmehEkjeykohoRn+ghPo7DhA6SSCaj2AkbJUwWmRKqJxApJoJea6IJ3/MpjCCFVZqClJgpn2RqNef1sqQZERzy+Fz0N+LQUWuod8JkPBwo9bRHNLfQorVTqzTfn0vVZLu7u7QHUj9Sdp66FFEGYNgOig0nvh3aspBUOX44GDuu5NffHIKpfaIozsZRLDu2CqqWZdf52yTXyfQl6TeIsvmgJ+6X1JOiclTE8avCLHEYc29vCBRMcwbUrYl96QY2Yp36/nllyTObmOY5ZL1ebybB4tE+PK53KkB8wPUTbSYIMNb2qV4P6PCwzX0Q1rluujHX9aBec7h9xLFz2Ok4ru+h4ePlqo5Se+LSB37PYAlgOdgGEA4g7FGUWHHrqhrKq1GsEoJYGx2mNDAxan+zJIAnhSKSV7V8997Eq8Vg0OOBGKo/GbiV84aKoi92NSAM4imKddjz8W9pKQnYjCDQ6ICVxy/O6/V79GLrOZ8nXu3cEtjKOgnMmhAAOUc8V3EtEJSJEA6GpA7lyRAQXdLlOHxPQJe+69KyuhYHL1UDa8fpNoaTDh5QP02eI8fqbVW/v67O9QIlgRs5I3JlGyVSCy3kk05qmVwlkopur5eWSXIdiw0kAAkq3q3+fnU7Pjjj6JmG5Fi5HqR/ElQa0DOxrK2t0fbOFg/A+MaDofoW+K78rT2PDg7ayXOPJYtCIjm8VcUE7k0G+iD3Hc0TMe04c5IissrJesl5qZpXa3t6WCo9xFFWip98QJ6XKWcux/MQD1AIoEUJLAEsB0eWxL8ojnmGAYVOutMYJFQF1e0UxgNHXpyyozYYuYRaRLN6f5qK11m9fY9rQ2gxE+T75g+0rEqPRhTGiS0dUte4yLGrCGC73ab+EJk+EBvBp1PrqzEcO5aWlpgEzM3NJxIkclTqpXGHC6kUJF9JMFY+XwZ+HAMysbZ6SiRHbBs3HAzi/gAZLIbUGXX5mERCqAih68ZMyiTkTF0RPNM2TtDtdJSN31gNpM4XVbObBphOvIPzAznrBFEAD2NplqZkNIkrlp4jxump8C/BYDRM141y8rYR1OJj88DUeJ1JYBxRvVnLSGaxbewIAumHPxEWBpCA0MiioJM+0+4S31/srGSbpOSDlLfZajBBhKoZxw76KoKBEHMcN85l3J+IWzjuJrIkf/x3BcOy8phjIddxyWgHrwJFEr4q6KFdxJlL2oOkW5UJj56NSPoorX1L+4fMHzaAHuJC23GpHJYAlgP8jyWA+JttEtizfNzJ5jlzZAYALX5alvRZvmRxfHBHGI/zTKfZOkDAOh2un5DazM8vslMHpH5Q9cIsAVVRkQdMUlTUfVEhykACkqAPKsNRP63bOG57e5ulRRwTMHFAaMVzYxKTqCcB6cTZljBSqsxWGmRF2Q+IJFAIi76Un06IRgNld6hPukyVWK6TR9oODa/cgoFswi4w+Xuh2cjk+85ztEjLgeeAw0wSegfod7oT5devj2v6PsqoUkdCQiu5g0HcIhrfR96PpOGTdyXvXUimHphe0v/h+/F1213a39/nH67fas2nhFHFG1S2hpLbOK//0wmxxavH6yR+s97fPFYmFpJAQU+bKgQQkGNMqT5MNjhah8feYpYAVsASwHI4novJhO9DIMAzadmRM8sSw3DpzPVZzEv0tiuS4Jn7j3udouMso30lmLRTUxZOYQwyJ3UuDJU0CBI4dJCnTp2i9fV12jh1Om406tTvD5x+vwtyENfriBHHWhO2l9aNrwEM/GHIHWqqesSgLwGfQTB2d/bTrBQgDPV63UniBcY41iQ2YxvB5Kd582UkaSlBGXdRqnzquYTQtBpzmXNMaJK7iftIGJUy6ARKiJ1+f9jQ6apvCaI9Lm848Wy6NG5xXuUAFm9s/dqyHZNOEGaog/GuQf6wxPGr62sTz65LFFXZUWa5/7hvwvb+YU95cfs1mmvNU6PeTL8x7rOzs5eGj0G5Wy3UGZVATI/N9rqJiMXrf+8ncV/deUvyYKM+yvXzCKA+ORuNRk4Yhb6rwgWgcVs1cAksASwHK4DBAFH3iiQFJhnMkwDqpLBosLKwOCokGLB0mPDihcQPql5OzRZAWqNUeULwBgPEiUN9hOQoWydFVQiSKaSEZ+AJ2RRnAdiRSd0XwsJq556yTawntmSSyUIkTqkkjyWRWU/AIjKotzXBsD/pRGCqgPPO1SWAZcgLbaMTNNgAmsROfx9492YuXz07SC8Jns2SWC3HL9xf9Pcg3w6QQNzs7AMP45T8j7+TXFOPSyrSlfE2GCUrez44sUn5Jdg3jllZabN6GBJBlF2kgXAK0bUb2Xdq8TrwOt9/keS8apwzbXd1G0B2ihqNOJ6uPnamMQDzJpYxtwHXcV34f1l+UwH7gsrhQAUMPTD6zqoKbQ5augTgJZK+Iklc0TrNKDGc9noWLwW6A5vxWRwOQeQkUrEYJG5uboElfmfOnKO11VUaDIcOJHN7+7t8Ftt+1dXgDgcORQDV9fQcsqJKBJ/JBidOiYiyfasp28BaEMRQb0KcKJ0x0OsqFWda9412IHG+hCByaJmEIIqdoZyv2/8I6QlWlXRAT3mm388kPvox6iGyziV5tohjSdrY+UOeD2RXyHevM87AISFzOp12oiIeO3PoBFDKLmpb9fMQxiKNiQa7QMDzIFFt8j55P8+3tzJ9jT44itRWJ+zyTuQ5IOnTcw1LWeT7X7iwyh7D+C4ggfoEAh6a4qX+GsmI7Y9K3v3LFjQcVwVsStlZZ6vVZ4684as+Qm/TCN+UbGMNRdpueVYDHzXPx+Btba3KYQlgOdinCLYEeTOaoopuzmr08+ws2eIkIYM5JE2QxkHyB6kfpHoHh4dJiIVxkGeZQcs2qFhVuBYl7RJJEoBlvz/I2t8JAUvqM8I4cL2GxAnexwmJFEmf3iYA3YsPPxAoUauCqKZEK5k4CWEajuD0oEiKnu8WzynEdWz7phHFJLdwak9o2BHiuU2ClwaxhoQOHtAxYhwqKR6Ini7Jk6UeHkVIFyDetBIsG9I1SDTEQ7rRbGZIrXxTXRXMz6qSFqvvg+xCfXh0D6jVaqoYhLEifnpgXXl3Qhb160pZhcCZ3pViuoJDUbfOnTvH9Qo2n0IEVXmtJsPieORPhznxQn3V25N+jG6vbFyTDbeQvMGqgMthCWAZ2KPc82r1ut/tdh0MajKrNm2D0ElisMB2DBCIxN8fDHiAw3kYOKC2iUeq81UBdcez8uR2uUaxBUhaQRJQsMJbN5s+IZFI6j58WsIE/foZl0f9vifU81d1GNOoEF7m/fX7FKn9i9ST05QPfdQ4bt5YWqWkK2P13igcxBiUWa3KNjExE4Ca7zubp08z8UOdS71E+wNniFRKHuLzcUmSB0bsZBVkDgEgJWSMXl59AiN1Pu2AIXXUjpHnd9MMH6kNrJIrjo9l713f91liKKQE8TGTQ1OvW/2diSQtJV/9vlomRLDXVdK2TkfZC0mbFKcMCX9iSvZkKWrMom+lk0VdlS2SS8mOAmK3sDBP8/ML3M6hQtWlb7oEw9QMiBOJTvpULEdF2HQ1bkrePZ/chksO4gimNpuSNk45i6i4i+K0JnVJrUudU+eiXMqjN+G9EpAjqZeK7C0uztPS0gLbBoIIIk7b4WEnDTqteyNLfcH1xS5SnlGPN1gVqaNItaitFzbgN8HMJq94eUKEGfr9ma5fdS93Bi/dvHvmRbfQoTsJ6f2k/C0ED/VG6jyuj36HpevhiJotFepJAs2z7Z+X9QKWetUbwB555ARBgDgwVgJYAUsAy4FYQhxUiMfLnFhhOnTja73T1lXAVm9qoQNSLyF8ej2CGlCkSQeHe9zBgWQA6BixD4Tj1o2b1GjWUk85kCEe4EMzFli+BFoRRhUOxZTOqbJkY29BLSmTB1Otqv+tOzroxNCM7A+ilCGS2vEAvJbLCFzgKxs7kXbpA4Ke5s48bxrij2vpwbH1MgoxNFXO5kQBk0Kzb9Bt9URap19LV+NKpg/9F4okECRSCBTG2XQsRp+TTSGnD+Tjv9H9K9IsMN+LHsYK1wLZgyRQ4g8+ffqcYw0i1Ry2YxIicQcztp7Js8g2kVBas0GLTN3LseszNRdl7TfZrmIAys9WskJYAlgdB5BtAMuSpukDWGocrs3g5ZhZjGOnwElNb6e1DSw63uIY0FWz/HJj8cJV5GBvf4dDsYCI9HpdHnRB/DY2NtjJ4/Tp06Kyc5j8Rcqj1/dBUrh5JxdOJC7Gl1Zp1DBIjwf5rLRKedohfh+Xk8dzloZxBhBcV1d76mRQ4vYl2xwzxAtfJwksLeWEpDA5jo/XOn3ebpIuPK8QC5HS6TZEEkhaPctk1a3yzudQK6ZqWAqcECJThaxL8oSY68fIuXJvKbNuX6jb85kEkD0gOQMRVL8a+YxUhhV13iiOIrwvED71bfP7HgkqPVYNZ0ny2G4wtcmCM09dBYuGCQCWjx49SmMS4p2gzkrfZ9onyja1/tIDSVsbwZeIWTQo+jlFwhP9WOXIpCTgutevPt7mlom7CkSCtjaAVbAEsBysAoZBKYZK2ahLIsazk7FKFz+VMk55ZeozaDnf2s5YAKgnupSYs9tqKkIZRCWjDEjf5csX6eyZM+xhe7ivAv3K8eNYfuPZc1qZJzpMkAjxYs06WozrdZYYup6RNiwaO4zoxC4leJqkzJQCqvJMqpj0cuhtTpa6WgmOfqaEUR8gRAJnPn/h4GEMaHrWjTw1nT4oiarTVGEL2dGvI8fIfpMk6iTSJIC6lBbRXSTjiPKClGtjKcfKvYvjGcq6TgL1fk2+hQSgRm+I/Qvzi3T50iW2P/3+++/p6dOn/M7FdEDKpdtt6lJBi3cbVe1sQvqs1QvxZJdJo8SvlH15kze+RgyLFDiB2EwgVbAEcKpMIF5GAphj38Qdr5JYKMIX+D57ABYHgj4xICkr36LiUSbXeZxIW+hRC2bjAB4DWsDTWHnAupyRA9UE9WltbS2Gyhcq4QsXLtClSxdocWGBO0o4A+A8tiuNYs6Fiz4vHIU0GoaGBGzcWaadqIq5kGwblykrBUwdKFgihzm1LsUzCaBE5OdA/Ertl7YVnRSmf/MkfUyKZH+qKh7H1UttDPVn6CY2fmqfSg8vc7OYItgYjo1bjXNFgphW5BxVqEmix/dKrpEIVfEdEINRJ2z4e25ujk1H4KWtSxDl/JGrztEHREOtrHKchmEqSU22JyfgO46fB95qWBfvSLWdU1ImOZZxj3G/JZNW5WOi8hWXTXTHiXPVPTkGpDekubkG3b17i9bXV+nevXtsH6intlP5m8cZHXApKFZegXbOaizecOiCEdUljSfBEnpITympxtusOlj6EzUJ4vzkPiJ4WElLOSwBLId4E7lmJ60PWIBuzyOBU/UcnlXGskdCVZolizcepmpkLA1U9QvkD9KVM2dOs9p3YWFOGTv32tTp9Knh1WiQBPnVzzdDf0jHmiEvnD/TTaY22TRLY0lgnCVkBgFELlhdtQsU2QBOqIeRdk5zRZJy6ZI8eS59qf8NWzQdujRV7MzMd62/c2mX+jk6JAyNDv2Y+pzab4aI0Z05TAmbvq4bvuvXlXKJGlxXEevPgffHBFGzOYZE0J0IQaXfezIgtlk30uu7KrNM+i6Teikqf1363Gw2WDINO8Aff/yRnj17lnqhiwMNIP3iaAQPcxXGx+LtRJVAw2zDZefpBBAQAih9iz7mRqEab/Ouwd2fh/BtNhB0FSwBLAX8yV12AoFwukiNJAOHrgLOswE8IQngrBK7Ihu/k5b0WUngEd4n6kwyMLLkLwyHMeoMwrNwrt75Jt26dYsuXDjv9HodJoR8vEiQRqhjGOxlkqFInYQZSdUmSVYkyQTBdTFx6EAwYZOgjVOwGenZklzB6X43MIleauunqw7zru24EF8pOzONgGQc1kUFyy8sqypliVav1+PjtWMy0nlIIuVayXGJC7SMTJrISz6MastKzDa+Lp+qxx0DBqN+5rnlm0ISKvcERCKq9xHqo2dJFEt0k/snxI8lhzhftwFMr+W4DqwDQjcbBBoSQ5eQbzh2IieiMB6R40p4G4SV4YJSGA1T20v1HEoiC6mhPAur4kIV7masGlakFJlDQJJR/r29fSZ/sEudn5tjcr61tcW2gZItRiSC+rs9YVibvzcQRhtNt+fVgTwVsD6ZLTpvvI8lgBIGxtoZlMASwHLAjMB1PBiU5nvMm5K8tGPP8QJ+UzE5BGr7Kk8+4cK8ZxgMVOigWg3x4pQKDuvz83Ms+fv0s4/TQRjEzvMCzscKiV3N59RuGbswUZ2EExk1opQcKocPj0AMHHSusQoFkkvSkjh6ugRQX0eQVpFEETcSld3Ddz0O1sp1S9vu4Xogk05CALlVZT2AdZgTKPMYdvJLNJOyxP34+iBXyHOs7QfhxBLl4fVQEWCWpKEcOA7EODke19HPw/aIo2MnWoB6NlWdbsdnqnOLJBajCOneXF6m5YINp6fKg2UcQsoX8ZLfQer84dLIgR2izzmho1DlhuZ74v2OcGBEFONbwDvcodgLyY1gxBdSqCkRshJAmWCoeIAoFEtlITHGm4pUdpI+9VNTA5HGwiMYJjBXPviAtz158oR/MhkRaaBKT6fq9etCWmemhquV+eQ0MHr9fWlLuY/e579B/XeelFCX+plat0nIxAzWMPjZQJVVsASwBBz1wnM93/PRBTsxBkw35l/IcReUakOCoqJiStwuyKEx40U4BIRHEBXKWKKRkEJdjZtTsXP6Jm0aJJKM0g40kWQYF0GuKTWAFnn9pjZGZfuTiCCvDRgQy1Dl5Tk1Mde8LWWdr6+ZY+UZNIGAiB1ekr81sfXzWaIz7PdiTuvlUNxtH/I9zpw5Q1euXGEC6MaeM+wNaTDsjdWKjkfDYUTtYYedIDiGC7hMKlVSRAN11A0kfl+i8uXsX7Eif1hyjDdVj8fqWRUgWW1XEhshfaazRxxBsqQkjngIH5JGEMCkWoKDICIJ1tVSjT4eG89lbfrSfznxwnK+V/KH8oTl4ViWSZUAQUkHvOQr6QF3eBmmhFBJ6BKzWL4ON8+E+OFSyUDK7wh/o1fgdz7O1iJx9OJEgpipQjmhaPAWQP5gKunFHsWuIu/oY/iqUeSMOGdyFOP5PFwXgbt93wGJ47JDAsjf0kWZ4zBk5uqMRjE5nhODQ7MAWD2rg2dC6RBcuuYrTQWcx7l+ccx7ZRPI0kZkP2fbSuUpLKbQ2M42fKEisJ1Rl3puPyV3cUAUhTFtrG3wb/PUafrqq6/YNrDR8JhAHu4fcNvQJx56eBzUNQTg1r83F0VbVwrtXIgEt0gDEo+/gbY9Ro2dPHxMEqU/SUwHKhUxeapObYUl4KqdMK2Mk3YcZycqhcROm5jkLjWSy02SG8NYmoFvVFr63OAXmtlKMg6WmbXIhEj2mRJgCTquq3lFeyGx/2TypDsTqXNVnUPdRF1B3ev1Ok5NOYH4Br9/g+jumwFLACvAeh0WYOQzBUMtpc5RLpX0NsDs7mZBpEtWLHKBQQxqW9QNDHYI54LOUAIcI8PC48ePWU0G4nfjxg06c/p0miFCvC4H/XEKLiXlQ9ojDPTVZDZj95dIGGXJou2c+HxjFfA4NZz+S49NnEDM83UbxDz7vzx7swkbxSnbkFu2RNmT9bwlpH2SfkodLwVKjmNpYDxeJoOy0I+8dy3QJf+6jWFWmgFpXiLpwHdNlnxrJgHqfYwM2z/UBNmnfhgUIVVT0kDE90P3ruoMfNhgiwypH66NARP7FfnLs/8z6416CE8RHoQU0sLDGOF6MueFvvKSRlrCmzdvsqcw4gaKR7uknxPJNSCTZITg0bPJvF7oE0m9hoXHu2o8+XdmKaStYL+QxqOc/zZA7z/KJoayXbMnVrEALekrxZvSut5UJPbTnJdhwgawzIbhhOz9ZsGstn7T2vKVzrAtKj6KYQ/a7/f5vcGvCLNVGMqjrly6dInJ36VLlxzEUZOUY5KjVc+yoBOIiY9SMIjr6tOMY4aXJXvTEkDZ7lOWFJpEzyQYplOIWW6zozcdFaqed1Ygg0nVMboqyiyPeLTmlcl8PpP8JSXITCBNG0P9WCNESwyiyHLLaEy2lR2p0kIk79uRUDXck/HMIabYUzECNdtlR5Y6qRMJOmwT5d7mu5FvrKu+pbxIy4fVVrNJly9fppWVZZ4EwUkEEyNJlYdjUeexRP0fhzMax4E0P0vR55JXbiyLzrM2g28wMkKVBGb/oR/D2yDgZtWWJYBVsASwHKkdAetfcrya8gxTzQ7b4v2FpMJC3UjCvaSepVAJH+zv00cffUQff/wxZ70AyUOqLZH86Q4CeYTJXM9blhFA2ONhXU9bphM6PY6fqH91ohhAUmbk19VJoFkOU/qX17Hr2/MGgLz1IlQdp1swFE3YzLJkjxfbynLCVwQV+ixbRt1RJO8dpu9EHM6cfIljbnnlurABZBU/SFvWdtGU3Eo5zEDO5jPr+3XyhvqvcjkPaX39FDWbLbYNhEoYpC8xiWAyKBldJJKCeBFbHA2vWAhx4pA6ldcOTKTjLnsTw3zfEsAqWAJYDnbug54GM+PEU65wRDE7RT1g7Qmi6P7OCXvxFh1fddwbaF78+oA6g0EO9SaRbMQi1UPn9qtf/YrOnztHq6urLHnBsbIP0AdAPWRJnnORTsDM7ab6NSViOWpbUwpYtE9XIZsevzrhk20F72di/zREt2i96PrF0LJ7JBIx83xlJzb+l0LPwmG8c/3bFJUhbxKZV3aTPKf2UhIYWrObFO9lLW6gkDv2MhdzNqiX2WCQb63qmtQ5M8iuLuXT+j/xip4gu7rNF+o6wsNgG/IHt9uHtLCwSFevXOEJz29+8xueCKGegwBK3nSs43cMFXBRP2T2U283Q3rHodsOFglccpxDQP6STCBKJGiRD0sAK4AYgBxf1YhVZqqCYoMA6jYtFu8vMJBiIBMpB6R7+CGm3/Xr1+nOrds84MEGUAY7rGPgxGAoNlKmysO0OS36mftNGzwhgLLPtPOrtAHkgL7Z2bmOPKneLASvat+0ksAiFA0osjTDtuTd/zhlqCKBRffid59sN1O9pfsNByh5Dj2orlw3r1xFkwuzTHnPol+/2+2lZRkMhtTtdKjZatH58+d52/379+nBgwfsIII6L/XL9p8WusOHWa/yJmvJduXypmwALUpgCWApJCgZMzzUrlwBYO4g8PII4LQSuLR4xrIIRTPlovtOe957jdFo5GBQg+RPbJxOnTpFt2/f5t+wP8jYfInqVw9gbEpXitSism0yVMok8TMlgCaxy1MBm8fx+dkYfpmyoJx5EpyjEKajqoCnvW4VAdOlXNl3m+flOWm/l0cuzesWfdeEiKYbk/2OJ2VxVfQB/XxNmifxCZNMICkJTK9nOuqYkj25rVk2/T7Gsel1JRIC6gFs/2o1FQy61+3ScDCgixcvUqvV5P1wEIE0EPEvZfJzAphWEmjxlhLAHEcRp8QJBOv2myewBLACqiKRC7uCgv25s2Dzb4v3E5D+YeBjT97BgKUen37yCZ3a2GBJIMJAYPATKSCAARAdH7wg9dhxegeoO1lUkaQyNbFOBovUvUX7+Pw434u0aNtRjb7znuskoBMwub+5rVxymU1JVfZMRetVz5O3X769nqVSf3d62Aw5Xgi8TgRNJx1zMJ3QdJSQVHMdP9RrceoQz3eohGuBsoNtHx7SxsYmNRtNLhskgXKukEGLo+NtH4NMh6i8yVJe3XPZAhDmWzxHtSiAJYAlSCJDwHbGgSNdEAQxMg9gdhoPh8rbjpSqQuJWiQEzgA4vTxojy7IZdMmgkNkhmQ+mtb0r6bhzz9eOz72uih2mzpfZV9n9TroDywm3dqLXryq/GKvDq1dOSToqzuCAUBfw9EU9gLPHJ5984iAuZLvdjvu9HsfPk3hXUh8w8OmG93o59fLotlpFUjg5RrcfM4nChFo4x5YtT6XI25PMIpltWp03bXj06+d13nnfpYxAVX0fs8yT98lKGCbvXXRefnmqym6WmQNZ55AsOUY8ePV3pX8T1JswVpk/knfNXr+Q/Bkp5tJMJKJe5etwJBwH+YQdPeMJ+hW9HKjfSV2S62b2w9bVHKjFjAHQw730epCEY+KjPJbDnR1aWl6mv/zLv2S7wH/8x3/kyQ/CIuE8BJbGJApmFFATzyVZRl68eEG1Rnkqubz+LdnG/6lUhNOcPx25r0LVZOCkz6s6X7crnqVdTXsv8z5F5UnrkWHKIHWYx9xkiUmFxN+VTEX6fcJwBLm87/tBXiYQSwc1WAJYgTTzepFkIjUEn2w8b/vsy6IaugROPBglGC7qAQzfkR7r6tWr9OGHH/IAd3BwwJ3Y3Pw8ddudNLhpMnAXqgqLYJIqfb1ImpcnCSz6FZHDvHKZ7aNo4CkjfyeJ6nscrwyzPEPesUcdyPX3KE4geXWgKhTPLCiapJY9g5mlBkA9FxOHxlyD1yENl3aCCdUXX3zB2UOwDVJATIqA9fV1bj9Pnz7lyVVv0J/pGSzeLpjENG+/CaX9tXEAp4ElgKVg8z+VSJWj7pZjmjAweXZBx4R5kakkgTnHTWvz91ahWsJ3vOtD8pFIU1JJrE7kMNDduXMHkj+evSL2Gb5/vV53IOXAfhkQTTuuivumS5Oc5RFA05avTL2bt62MNJTdv6ju69umec6XjSIp4Kz3184fi91KJTjF78NUdxWUVbx9+VZmDD/NG1gkXxmpcDRJ4Pk6OmkTyb75TvT7J1ES0ueW9oD4gXmTB/m721NmDoN+n7q+z6QOtrEoI9rK/v4+T5pUhoce/5Lc2VU2gkU2flU20xZvqArYhKpv2dBDUleRC9hxHBi6mla61gZQg/WSqUDS1SERU27nzMfkdG559jX6uRbvBkDqhMBJnDyodEHusP2nP/0p3bp1iwcxSDkwqImEUOICCmHUc0cXzXxNCY4pnTP3mR69Rc4cRdc0CaCUoQjTEKay55sV+rWO85Nr5S1nKcs0zzmNJLDq3hkJ4DF+glmPyTunqJz6T+q4hEI6PGyzBBN1Ed7BkJhjPwKji0pYSB/UwFAHo72AKKKNWby/BBDI7Ucc3QnkFc0g31JYCWA5eDrM0fHDiJes9dVnwomQkBN0ptvG9jtFOMbgZ554VBuHKtvBoobzTkgGTwD8HpDTN8llGetx/KCqQuaDv/mbv0kGukO2HQWREm9gqLaQD1UnfeaAaqrc8gZhWZapdoukexwwYUaSUPpSCjKU6NIsXao1xfVMSVpm/bhQJm88UUslXMm3SF589j5mblmsJc+UHldA+iRunnm9if3GRDOzPfOT92CUW2wB5bzSV6U+qrFa7NVtfsOc5yntR6R8chpLKSM1AWLHp06HySDs/K5du8bH/MM//AMTP9jOijpYAkdHxd3dUXX/VjL4hhJAvU8UswdpKnqbU0EAPQ9SQDtOlcMSwDKowRGzCDcv8K5pC2hW1DQFk8U7qwLG9TEY4VuLlyOkE3fv3qVPP/00lQjqdQHSDwnwLNI/nfyVlb1KCqMTwbLjzWvm7SsjcmVlnFZ6NQ2O237K75X1MMxbznr9ovOOqgIuu+6YCI4Dg5vLaSSf+vfX66E4i+TtLyqzTu5l3ZzQ6HauaDsHB4fU9eHx26BWTeXKZg95Irpy5Qq3lV//+tcpCRSbQRBAi3cbeVmQBHn9ZTqRVjYRNhdwBSwBLIdMn51IzWx50q3tTDMD5Ek1TA9IHUWVegYUnXxc279pzzvucW87+PlGo1GsG9pvbm5yTl8EeYanIgzZIfnDPqisRPoHqSAnu3fHYTl0FA3Q05LAMunNtCRFL4cuodTrbhUBNDvo4xK6HIlTroRwOsi7ELO1SfI37fVEUmdCcuiaEsIciA1d7nlY14mdSPh4W2Keonvn4viEvLHXLmwBDVMD3p582NTURSSNRdJac32WupCsZySZ/X6fywUiiN8oUM4hsh8k7+bNm0xGf/e737H0TzyLQQw9dvQ8FkyJn7XPecMlgDqkTqI+a5ML5QaSjN2vvtRvD6wNYDmQChh6ssJK5Lg5g1o8dq3Pg9pebtvwKiHuLbMugQmFz2uCWPrOujwaxLlH2TLxYBVGbKcEtS/y+q6urnLCe6iyMGjB9k9s7/A3yB/UWbrdnw5dUpJ5zhwyqCDq33HcQJPwmRKlKQfsCYnR+AaTUibznMlXlxDJE6r6KoyLkhLM/qtWZx+vbLNLR/NQRJrRy6SSvjD7LcokgUZ4mIn75E8i3PSn6pj8Pd07NO8vKl8J6QGih31t2Ml2lKPU/MICDXp9Gg2GnDHnlz//Odef3e0datYbHF8Q9QjmN7xMfvwM8Zvf/+CHvvQ4/e+7gcl+rqpPAvT+bly/1DEqCmBFDCgLKwEsQxID2nFcz/F9pPJCLKKQB3I/QOyhkOeLg1GPAo9jwY0dPwgxrlSieGUnpH4U64F7xwLFMjVKGYpmR0Udsxk3EGv4oVTJ0tHXw8TWSPpW84c3ZL62l92uMlKlMHl+vF9ncuk7Hj8LD5Y5Sych60WdEAYXvGMQPdwXsSBjCilKYj/iJYTDEbUaDbrz4Yf0s5/9jLdvPX/hzDVbPMABMtihfvDA5bnUHw4oZguD5Fl08QPqkOeSl2TSSKUsiY1p8tjkpRk9/GRUQfpLVoFk87kiXh+O9ZLsH4lXME9gkh8IHcrCydRRr5IYh0z0lLyM/0GzwlKnEIGgMftWtq666hDl4vYQKsmVTMg9ONTjOCYAMb5RPCavmarDM3rPk8mU8jbVpetRNCLHxwDASlBVn5M3KO0iHI1j5mXvodpvUAvYk5CPT8lRcj7aYUmcSRyjx+nT7yv3lHAnEKzp5wkJQ5+iJozS5hMSlizDUZjE5VMxAz02a1LPH8ZDqgcBDSNkjoli2NIhP7D6jbiOur5HXF/jkRPFWEYxvieqCWLgjQbSrlUZVDHH70wJCeWdqPcmtXSsylUlVt/RjPmWToblOdhwWnUrDgUI5BbFyIgTRyMlCUQdQYxMtCs/cVZq1Gp08/oN8l2X/v7v/4FjAMJBZBiOaMDv2OFzpa3iGogR2O9l2zW6P44NLG1unNx5vCUXBRP2qLz/MZdoZtz/JOSPr5vtfzNLtHNl65ndruUBLKyf/DTyeBLQIvuwaYeTpzVQly+//rS9vTn5TE930BbQlyoF2zBU+Z+DmkftzigNrYUJgor3hz64zn0nzhUhH7aNRupc3w/c4XCUaIGnK9/7CqsCroAEap1s+9wU9Q4us5fPqZyqvV4JoKKnSUmcoy1fN9Lwy9rfmWXS6Rbtr3oO9CAS0JbVuD3lxYsOiWP3DUYs+UOMv5/85Ces2kWwWiZ5OL7Ty6R3k8E/DRWjFeBovRUGXSE3MipMBmzOW1fnlEkVJ9+FeYxXC5jMmcfpAWZ5Gw+UMYXotNEu5FpJmadRFU+qvkHus5o7Uy2pP5+OSamoGoDUu5T2jlRm+GbSUsbbhbC16g1dDZV+37wBVV+X4LWKOxfb66EeiZe5LrlLJccE+1IVlJ63gSRo36NM0ls5uKuSJsvEnIWJs6q36l3jfY1tWIvuVbQdz2XmW1YTBTX5XFxYoMODA9rZ2uYUimc2z9CtGzfpy5hob2+HCW7NUwH4R5hseR7VfBUmBjE2XS+Y+AYnqXmp7H9Klpl3ccT+9w3pho8INbHImf6m0CdWpmZBSf90gQomO6ouQmxzUo5i7zIsAayARMWq1BflYLoO9tgwZrBTH1d0fFXvONN7qOps3/QmKlIcSP4wu9Q7JM7eQQ7H+QP5g83foydPkDmGj4fR+igK2UsY10jVxSUD4rR9Vh5ZKyN2eXaDvCSPB/Xxz8msg6DwoSyvSZaJtR1LDcHtTMN/1P2Rij+XkiMxp+NnxDitJISjRIKS8z54g54T2SSWkACCKcSQXI6/WOYiUSolSKRqyW1kcjbq4wFROjd36YFAgOAwaR0veX8cZmLR6cRMylv0TaUOqGRDk99WzpH4kHJdPTMHXz89R2XVgPSPHdJYCgjhWhzjG+JvLnuMkKaQXGJ7KrpLROlKpm8WNSlP8vkhLVZqAiWV1Jf55gNSRLPe8+QqQjYlrRzJ/fqOQ36sUsXV4e0bRfT0+TNaWVrmtoYJ2H//7/+Vun3lPII2x+9JI6KcoQkS1jwNy2Q392bY47zHKDUdMfaPJdSmhFdlsUFjBwk0xqs3fLR59bAEsALSWegVD0j/Lpjl6wOBxdsNdDSw48MSscjggYgfbPiuXLrCal9sh8OHSAcl2wfGU9PmijuvRGoX5uTyrZLAmUQuf31SYldEGvNtvhRExSnlz6SEC4n68VARIqP8qbRD4g4mz6tLsADPU2q7Ips0SQGVJ9UKQUbUBu0aIIzj1FC6WlU/X/0xNtmYfJdqe0jKW3vy3STvhSKm0Pr709XNZaGggMFgqEhZgZ2m7jFrHsPb8BYMuzqZbEiaRj0wuXbxhICWj4msetQ+S0ayylLQcf2YFWWSSfnt7e+z5E/Zzh6yqQ08gWFr224f0O//+AcajZQEFJJ4TEaSsEwsPR0T5IJUm2+IHfb7jiI7P7M9mP2oLnnXx97UgsuiFJYAlkCNoaqaJV7AkwZvxbZ2lZ3/lKiqxBmbvinOK5IYTtsTFp3/TjY2lby+iTh+7LjRmmukgWkRp+wvf/6XvH97e5slHI16nY9D3D8MQJ2eCghtdmiOmxCEhGiUefvqf5u2bDppyeYFLvIONomOMuZXzpkyueHtDpZS7VnbmGDcAcc0GA01SV9CfrgqiAQLUjTY0inyiDO5ww6VZK9eH6vEdWmX3EP26anyZNswgv1XnyWAuvp17NxqOHuYJDMxpkodZ3LIMNt5FrxnPE0t8Mg3ciXrcRbl/PzMKlgqG0vpRozpJMWj5F3zu1AqUz1rzGg4rj+8znmB5R2oCQb+VuvJNVMjMkgx2Ssnx7RFfyU5nr7Ypn3nksE8019oUlF5YiXJhFkoCH0UcS5jsZmEjSOCQ9frNZqfX+AJ1YOHP1I9qHGQdeRB/uabr+n58+fscBU0GqmtLSZig+G4D1a3nJqsFvWrFieIKomf6SBnEsDc89IImdzJ6iJ2+y0NWAJYAQ6LgC46J6SL/rdZKae3sXm38bargDHYQronYVs6HeUYcf78efb2hXQCBukY0DHg7O7u8t+Li4v89wCOHrn2Xer600nzJmP8TSsBzJLCTMzfCeh2XOYsW/brEjOFbLabdL+m2kW4DteYGIlaXOzXJDYiftgHBwZc67DdnpBqCRkcxSH1Bl2KQKMzBBB/q+cQFa2sm+0UPLSMgEtO59xvwGZLIRNAM6uKrKNOYJtkXsH18PN9j6XAc/MLTALZ8D3Zh5+cr6dtk/cnklj+VtHYCUXIr97v6O8rg6Sc8B6ugtQbXcqiEblcyW3RID15jexAD4mq/M0q3ORaeF9McFFP+n1lrOA4nGJxOBzwBI3tCeH4ktgU6jEMp1ABW7xm5GkC9LpcNt7qf2OipKq39QKugiWA5XBcxBPnWcRkHEA+oEB1doIE0JS4HVUCVyTxm5WCzSpxfNsRQ6IAVaTyBI45Yf2nn3xCGxsbyFXK0QYwgEuqN9gCAiCMpuVoqgJNOjAPEqAK9a78baZtU9erlvRlrz9JGqVcyXGZHK55RFDHMMzErhv/RomESohdr09hYgOJbf1BnwaDPnXbKhOKkEIhgEwCNSKgO0HIEgRwGPcpyglHI1K/sd3lJCmB/aMiiMVV15z4Zb5HTAT5HltRGsG3hbQJCZF1iXeHnyKKKn0gSB/qGKTGWAoJhHQZS3WOR77nU61e5+Pg+YhnEHLJ3yNSZC/vm5jkS5WPrTgzNVQ1bXlukRxGPBWGpDg5MDfMWg4ZzH252ub0D5Fgspx4pKSm7W6XFhYW+PkODvb5vGazxZLAF9tbtLa2xjE3sf3evXu0e3DAx+Id4tuKDaBJVNP2c/RMIhYvEXr9lXorvzxTiMx53Phz4wC+q2PUkWEJ4BQwO46q/IR551m8ncAgBOkCSB0GXc93OLfv3Q8/5ET1IIcYnCHtA9lAaAp4AcMGELZKB+3DCcKVBOBN75FH4PTtRceouphP6HRkyUu584lZ1yX8jX4dveNFGA4hZSKlw8AbDoapBA/EGCnvRDWHY6BGHwx6FI2UjZ0QPVMVrHtMT0jvIPtzhikBzD5TltyaBLCIAJvXSSVviUQz816jmNzITW0AdQIq1wcZMd+pnpavVqtntmckjHCESImilxIbkEKoOyFdbLXmqRYIIaxxWBw5lu+d2C+bkhQu7xGC5ZkSwCJUqen095tXr6S8IMJsS8shiRTJ7fW67ORSb9To2bNndObMGZbSoz0+29ridyFe+mbZbZf8ZqJMDZwnYS77kEnKVskEYlECSwDHyBsdVVcJIWA6yx93UDLrZuPjkRq80pl/kt8SkG28nqh0xh1osfpE1hPk1vgqKbcWfyyV3CXXT+zny5UhOR145nrHJbnVKmLnWOdUHavUSz6NRop41Gq1WDwKcR0MPgjqDBID0vL//v/8P+jnP/8FB3nGcXi/kPRJZgWQRSWlaPI5ZjgUKZ/Ec4M3pT4I6scIAch7hjHByNqVjfcrNaFklBDVYhSNnMSrmQfNXm+gesvkXMk4ob/HNG9wos5VqvAOq+JG0ZAGwyG/G/zwvvjXBcEbsESU61g4acvHRImDOBcHlBYv4Dw1euRGbFsYJo4QSfmT41U7Gr/bvNA40obz1UzqemMvZLNOuQiBAqfZxKM4Lxez+b1MUi/ZSHDJMLGLzFNV55sAODQ3t0CBrwgPvmdjrqWWjQbVagGHSWnUG+QHQeaa/P6SWJYRCHcMxwk8A4+c/L6ULaFqF3haPpaz2KjUhgkxjfMkyNI36t8y6TeTeICKocOGTxxR+LmETDvkYN9gMODcwfwtR6oesgo9mSjgOWEjCEL82WefUaffpx9++IGvp+p7NPH+ZBKCZ4AtYRmOq8UpOz+JhnSs+4/Dvlcjrx9hr/Fj4Cj9/7hdjJfmBEqgx9nUzR90D3TdG5gjNbiuoxQYb7qB0euHJYAVkGjiY0/gZHvOrFWWui3SmwYrlcwC35HDuThwSFDSGJFUidcvSAwGjH/9r/81Xb9+gx49esQdjS6dSn8ZO7Q0ZsrEPfUUgvp2/W9T2pIn5YNESCdWIi2S4yCRBGHDM2IfjOlFOqLyqarcq7qqRdmoKdUkQtngfSAcxwF+BwdMcnHucNindreTSu0ybYDJw9iDFTaB8q5SAgjilhC8zDvUvKZNAqjvCx1Qv5AlgJN1PCW0yTv0cgkgpJBZFejktypaBwGse02WApqSPV0CqO8zj+FA24aTiIQbwk/UubqUVX8Hh4cdFcpH7AxrAX9fTEBQn09tbvDf+IEQBr5SNSPIOL+bxMEDqmVMWhXpi5L4hKSV0c3YeMqEQmwsqySCee+vqE6Pv+HYhlGPFSgT7HDkUI/XlaQa9riwCUR9h0e+KvdY6q7OVe9aCKrFmwezjuj1PTMBfAPH17cNlgCWAbI/JQB00VflhYyICuwQXmMFNSV0VbaD8ftsA4jBAJIq31cDL/7WDe+xjm+JfKTwOmw0aw5I0dzcXMyDcai8FlNyYxAZUwuhkzmGYcOnHzcpLZq0xdM9QnVHAxVZn9Kg1FBhq0FU5YQV0tbtthO1YiO1c8Q5Wy9ecAiOp0+filczL+V+8mMiHE9674Lw6YSFwrGKOOPFOlIhO/SOPq/DF6R/89Qf7StlKtmlSPxSEm5IyhMCSC4ITLUqM13Xzo9ih0b9Tpr6MTGwHP8SSVgZAdT3CekWta8i7CqgOP9cELWx1zKIX7+v3u8oDKnXH1HYHpN4XOvp8yepyhh1AM5JME1ozbWUg4urpMjclw3GUlohlBDFjTUf4/oLMV5RlAOdDJYRQ6Wnc7P9VaKTYCdj1O845MxENCSWQMq7G0C97cYsCaw3lOe95A2WVIucZs6vjYNuc388btt2MvzmwZwMFPUBY1OL11DIdwiWAFZAPInGlW68T1Q447+zsB3Mmw9dkivkRGytMMBhMIGROaR/OObhw4c8gELdyfHGRmPJlinBKr2n8BUthpxO8vK8ffOWMlgLeTBVb5LFRFLRQTUMMoAfzmHpXueAJSa7e1u0u3NAO7tbtLO9R4ftfQ4ePBz1aThQAZN9r8Z2kCqbR0SdLrwv4bQB2z84cOAdDika4R2okCScOSJUKZ+gkYaqU1k/JPFJqj9ShuApMuRSxPnMVBiVzLET6t5JaY9IAHkCh5SORdBSN2bvAbhEvmskx05ypiXPlZIknaDqfYUy4uSfTg717y8SK5HMyg8EEDaEOEY5jngUIjUfYiFyjr2QbVMPDvco2KlTre7T/NwiLS0v0OLSCjWbdVqYn1M2c0luXZHqyUQGcQpN0iomEuxkoUnS9LZkakgKtXEF5hr63zyxSryFdUKN9HVBXaUIgzkCQsGcPneOs/Jg4va73/2O+gNlw6oTPiaCSRgm6+rxeiFq3LztgB1DXy4sASyBciWCRYyjRbFPBiDNbiX5I7v+8uDMsj/HgDY+plH0Ub2H3zTwc0gAWaUOVNI/UQtjHQFnIfk7ffq0A9uibrcbgwCGYch1Qpdm6QQwTxKiL9PcnAl5MG3EdMmQYOIabPMSZCQaw+GQbwiJJgZLqLDFqxQSoEZDSURYyre1RU+ePqL9/T16/vwF7e3tUq8H9TeeB3UHhvcgBAPq9fu8VLHoEBIH9n49tvUDAWOVYTRMBHIhUWRk1nBUrmKQMTySwzaQ+KNcwpm3PZW+c37UbIBoBT1bSL4UVqDM2zRVtXEtL/CKpYEgJJDWpULJAq/EEphaAlOqxipyKa8hOeTyuYoUwgEkCHxykxAz8C6GalRl0QhpFA5o1OnzxAVEv954SkHNp6WFRa4X6+vrtLq6Qq3mHNsLwmObJzjIIJI46IxNBJSUUq/rVRMe00Yw3eY4yVwiJY2qr5VH5tUYGV0c1EcnctgmkE0OENOvVqfhYMATAiwRkuns2bNMAmGm8KfPv0gdmVRbEie+xE7ReoW8duRpQGS7LHXpOdcb6195IrAEcAo40FOYM1lJGJ8QQn0gyxNbvy7oZXgF5PStgxiSIx6dSP/Eng3k6Ve/+hWHfYHkD4CdEVTA8i712HQmASyzAUwJYIF3ry51kXNM2xhZ6jZ4OAaSHEh3sEQIDek0MfhDpfvo0UO6d+97evzkIR0eHmS8TKEOhIROnF4gIcQSKjUQYo4bgh/fXyMvGExRvgDSOZ98DnI8trXiYJp5k6Qc6VwV5NlBvBA2JJ6w/dMlsAV1PlHb1uutVPFovle+hyY5mmjXICYgxSVlrZLgFjlLCEDoTLtiNtwXCSOccMY3IwL5S0LKsMQQjiCJ44Sok/H5ev0ujUKfw/OgPoM4oa6srq6x09PS4iK12NMYsRJH1OvDyaef5u7Ns6ksU/vmSgc1tzvznPQ9JYGbZWKmstcpwL0JExPqx7SyssLtuNPr8fOA1H700Uf0Yks9G0wY1Dupp7a67GBlmcQbhTwiWFSXLI4PSwDLoBJK87SR474q//JUGqirhKVj07efsA1glS1foZeuzKyTdfb6PIH7v602gBOsHIMwHBokcC/UvrCVglchAj7jO8L5AYQQg4akmsJ7FOJlhizRJwpSLzIz3YQA8hSigATmSb0yD6LIXyyefEGtxqpdJfVTdmQAJH2PHj6k73/4gR48+IHXWfJZ82h+fo5GowFL88S7V8gfqwJh5K8RDiZ6NaVu5ucfDqnmje3XpKycSTh5n7wtx8OXc06USOfM9TxJAaLGZY/Nng8JWf61xalh7GQiS1P9aBqep+tIBxc1VY7gnP3mPfMmhGMv43GzUvZ2oq7Uy4d97I6WarkR9oX3yzdiG74BdQdd6uJ7sLrTpVqjwXVD1LxBHZJgxeXxrTmEyrNn9PjxY5YGbm6eZgcidh4BoQxqmTrupJLXCQk1S+zS3MEVRFB2I60ftwkI/zRJoN5v8TonLyGKhzHchKkTwxEqYOkfT2B8n9sqgOf47LNP6be//R1vQ7kbDeXJDA/oN2GC/r5jGhVwkQ2gisTxtgw7byYsAawAp7FPJBi85JlvKOmzUocBcwARL8eqq78K6ORUH5DQdUsJ8XwcPnPG5euGmF9BGoS/Z10qo3qVMQIDCAZI/H369Gn6q7/6Kzo42GM7KkgYoDbt9TssXYBUgYmjDCRQS2WcP7KmAkCRalOWVeTPtIvBOmzAxA5QGfnPp0Fw4eDx3//rv9CjJ495YAexk/opEr8HDx4w+QX5YyePXk+RBpAH/MAQWLIHh4FEIonQJ0l7gKSx5qksFooAJplHkvAMuvqNHQ78sQ1Xpi46CN8Q8xLaYfZsdeN0ie2wPQShw36sx3CKgBQHRcJ9EcIE7xv2XSwMhK2im6mv2K/Ws9uxZFkinFeUE4Kq38k6ezFD2ohwNmy7iPcYUoTwKfBF1rKViCNFdqKYNRGQbXj33C5xfS3nePqdjAwgWRLtUNhDvmlIWwOK/DEJFNLuNpsc5mUACe6wl75fBJNuNuf4F/g1lXOZIvbq7v34I714scXkHe2A1cMra+xBHNUQ+3E8sQ2HIKhYT5xqSvo0U0ooZ0j7TXZkybM2wc4SNsTNgW/IkCc8h+0O9QcDWlheVvEnDw+5/B/e+ZAeP35C979XoWF8eAzzxw4pGsG+8WhD4BFCKE7A1frQo/S/by/w1dPcQOOtOVUnzyEsO8kyThKHLIupYAlgBTzPdSAhgTE7Etqn9iPkURyqgSmCobsWF5AHgAhSIsyWoTIBUVQDgp/Ef0PcOc8bSycEJbNSU/Kn4m+NW43ZfJQtmJfGucrxUuFoX6xKYcVZzpK1NCXLuCLhtqnWMUlQ1Sy8aj/bkyWSHzapw7dQF2cCAJs1dJhxEnollLiHaSBllY7s8HCfBzusr64u01//9a/UAB9FTG56vV4SH5Cc/b1D7mgG/SQ9Ga6M8BkixUi8Ksts2cT5A+VAPRCJmphoyjEomwvvR9S9JBxGoEKHxKNIqbEwmLeaTVpYmCNMiJ8+e0R//vOf6bvvvqOH9+9DDEaui2sgc0ekAjN3utTrdajXPSRCMGZlFKVeKL9Yh5/Dq7UyKmkuJzJSOOoZw9GA7xlwdoom1dyaZmc19kZ18Awgf5w6A9dJbHoQTJmlhbANHC+V4B1hO3BCnK7LUkwvvABqvHxCN82S23RC+IToCfHLTHSMdf5MLAVTqvCMilYbrMSLXB+89GDXeDw+D3FEY2VLqXtL68eLRiEjaQ5U6CKVmRfkFo4psG1TUzt2ssUrHIVEfYTO7vPwOxoq1X6nN6Ravcn1p15X9oRoM+32IZsH7O7usCTwzNlzdObMOVpcWKKA3CSTy5AlzVGochKHuGeUZAhObY3H+ZmlKUi75veONNHyAEnUAkd3YgrDOKl7LFSUIJXy7Xy/RoPBSAVpdwMadOHR73NYm/2dfZ6c/MVPP6PdF8/p6+++pX63ze+52ajxhMfH+3O9jImC3veYRCslpyXd0iySRSUZH/ennK86eUmpQUNB/zzNvSr3lxowTFF+MxKhEVIpL46mejL1i9iWF1Mf0Z6hHx3/Q/uARDuo+5zyEakfMVnxQuW9Ps5rzXdL6to4OodFOSwBLIFS0I2XDHRXYoRaVMlK4oqN8ebMVNwjLoE3RRIoZdCX3Ilqqla220zUa5Ae4QBINTAQbm5uMjGC6vevfvUrJoNQG+lqr7wfkz8xWk/sQvOIn/63Tg5B/vLUnhLyAioO5aRCGSklp1Prd8hvtWh5ZZXmWshDvE1ffvE5ff75n+jJw0fsoQupoMq80aFOD0Gce9TpqmDNkAzVW3UaQO8GL192QACjBnGAHRliyoEAgohBxeuQ69fID9xUEjffqGup3xzyCSSiRrWgkdqd4V0rEg5+oLxeEcIDeV79mGV8Ex6w5nvKsx/k681Q+fIGQ6WuVvtkycd5k9/StA8UnSX3EEwWXEK8KN0GFKpWU4Kh1x9MHPR7sHRRKxu+k/rWcMIZ503mVHkjZdeJMVyRS0Ui07LhetgPAg4i3lBlYZKKustBvbep69doj79VQM1anTNsNGp1diSKoxE9f/6Ugy1DWgwSuHH6LC0uL9NivUb9Tpvvw1JZT7UlTp0YNLjucflyJnusOUmZjrKVLfo++jnyXjn4r6OIJ7Q0nhuR64yDBssPkkC8s1/+8pf8zu7d+44JLcpVRo6K9qWSyhOE3q8K6aMplm8nDAsidhTT9h5rLEl0WqkU8A0YmN5wWAI4BRJtxdSRxfPsFl4CisqSlRCOy5BfmBKNjXFergRyCpvE1wpIIgybIoYM7pxwXnP8uHTpEt24eZOJCxwmfN/n+I+6JEakNyyVSQbcvO8tA1VSjozqU37ICJIlOuNAtepYdT6kGihTv9/nzCPzCy06e+4KteYWuJx//P0/05/+9Ed68MM96nQOeQCfazZpb2ebeoM+D4QHnS5FPCArb0igvz9gaR+M42tNlU4MEjh4kfpsR4jyKa9dD57FIIK+S47nJxJXeFHXqTFX54wUvgPVckCBp7yNQdBSb10QQYygeA+J4MDjzVnnF3lf+lL7npl1Vv2WwPzmRft0Ewlzu/l9dfUT1NogvrrdnpuwBFG1m6GBPE9TBScEUO47DlisCHGj1sxMQIT8QbIoxNCUKup2g647n6qoed8oVGpwmK2grtUaHFSZ4NHd71DfgXpYEXf2HG+2mMD34z4ddg5oa/sFrT9/QhcuXqbTm5u02GwQxbChDblMEqoGz4PwQfJNx+o6+NOJfSNPn1LJnt5O5X1wEibNBlA3r9ADhaffJTFqkWMwqcOzXLt2jXMJv3jxnCV/2MeTk2R6bxL9VNL3Cru1t9EmcbLMJ/sMGZOBVxdp472BJYBTYTbip69bHA/Vjb38HVepnDGAwDgecfDgNfiXf/mX6QCLgcyU+Ok2XskANvHd8yR9Zly3MQlUas7xsWOJkBoIx56ouCfUHwhDAwIIA/1f//of6dvvvqM/f/5HltI0Ap/m51scF+3Z8ydsq8jl7o/G8gWY99Ugoaux9A2DdhNx4JoNlT0hUc8yMY6U2tkxMowwqcMA7btsRzbfmmN7RJhGyAHKYzVRo7FgEc8O2z0hSGqw1lVeahBPVGOsiU4GaOO4dDnDWDApwasO3VLkBZwek2TTyOqHlShDEeSYJwlYsrqN4/Op41j2yMeq1FZ8TT4P5DCR6LF9pwr3I5JgXSW8fwgpNepknHqywy5P6qeK/ai+MWe6STKyKAIZUdhPbD5h18fSmIgG4YC3g4sPuy2aQ/iguRY73PS7HXr04w9Mpn58sEh3b96i06c2WHKOSQabuSTpCzkVImw7M20wG4B57MNdLKHNs/2Sa45Co+1BMp3U1ZhNcmJ+dtjvXr16jdv5f/tv/42lk36txnECi+7N214R2SianFiyk8WkRN6SwePAEsBSKC9gFv3N0BJPUgKoXSP3/jkbp5XIzVo4U/L3trW8OI+cYXCAk8fGxgb9/Oc/Z9UvSBMOwYCJQS2TvqzAI01Q5tSRmwmCbdkgKZKYfzJAKlvTOHZjlFEkGxsb67S2tsbquH/4h7+n//Jf/zOnMwsHQ2oEME8IaXdnj3a3tunwoJsUim1ZWRUI1S2C57KEx69TPUBoEI9VW+EoZsLXaNWo2UIIkAbVGnXlMBIoL19Ig8YSqSHfl3MpRxF19w+ZA9VqDWoECNDrUy3x0sN5HLeZJU+SNo/YKYSdclgqpZw4dCedMhs8bC7KRiHQczGbZK+ojRZtyyWAKQlVqTJYYstSYbXEuwWZVYZt3KUoW73kPTqwIQZBZGcyj3wur1rnsEQEMhVSNIzZrliXJMZOTMtry4ndKGd5Ue81IYAq+PeQSWC3rTy7EdIFUHanRKEDL295nohzM4NQDgcjrnHhYJ/a7QOeHLTmF6k1P0eu79Dh/jbtbD2l3mGbbl6/QdeuXqW5uRbXM4SLwfVQf6Cizb4r9S74vSRi02R/pj8x1e/mdv0byrviNjZUXv2hH5LLmWoQ1kgFxEYIpzt37nAebxDBERM8jwm5Lul7lRP3Mqm0xTHCmKl6JUa6FgWwBPCEkSdReJ2oKse7Lk3PG0h0UgZjcUgH/uf/+X/meH/IJgApGyQkunrNJIFynbzupYr8ZQhgkmpLD/oskkEuX6JOW1xc4vhs+PuLL76gf/qnf6I///lzJmEYuOFNivhnO9vbnHUD5QpqCI4L56UkTyw7eSSBmDXpJNR8kOC0FlSqsOXVFbbxqjfrtLS0zM4bXI7Eg1fyHcPx6fBgj+JRSIftLksg2wfIETykYX9E3Z5Kz6VSwUHd6xEFkh5N1T0meRjQRa2X2FuIIE0kRGyzyQGBKSOBrKrfeWQvjwyWnV92rHqHQvolDI4YxnvJ+bpJPyVkTTnJQKUO4qbUmYmHcWrMjmNUoPJmq0GtOWVXh2+EmH2w1Vs7t84S3bQOxXouZuLwLoe7B/Ts+XN69uQphwBCfUeoI4RO6R20+fshUDRzabFtFgEns8CYukOVTxpqXUgE4fDTqM/T9tZz+l2ny/e5e/cunTqF3MMD6nTa7Djn0Cg3Ow6IMtelHAKfJ43V21JmXxJuS8w5wG/ZTCMckTPEsR5LIiHlF29+2Pj+L//r/0rbe3vUbM0r0wTte74uqdubMma8SSpg8x6mSca7Pn69bFgC+BJwkhJA/bJl3r7a9ipJ3bSFKjquqMm9FMngMVTApg1k5noyYGLwwMCFH/b1ej2W/IEA4pdx+DC8PPVrCtE0SV8eGdT3uVDCap0ayBkyOfi+z17HIFA4Fh6+GIBB/v7Lf/kvhKwkTKLikG2a9nf36XC/jcjI6dPDSQBhbiCJg3RJ2fVBkjOnCF9zntZX11n6ef78OVo7dYrVy815qHNrTMI4k0RK0tSSg30kZa7DucBxWdKEAXZ/Z5eJ6LMnz5lMs6pxoFTqSBMXRR7FCakF2WMJXkHoG0CPpWkSMaZeFW1MdxwokgKaKLIHyzte2f/J95uMa6ZS4Ym/2PiZsJ3rU+qZhJiSSsKnvrsK5A3HDHyrzdOn+DthErC4uMDqfy9w6btH31KEcDnMhXA9dRuozmEfuXH6FJ05c4Zu3LnJkkEQtUePHtH9+z/S9vMX9MM331H34JD29vrU63QTY2eEelQe24N+yGp+EHCYEewPdtmJiINFL61wPcE14XWOb4wMHJCiY8LS63bJ81QEBaQS1EPjiBeo9q5T28CkPaXewvp3MW1qoSaXdsxe1YkXNTyU1blKHY0fJnTIeX3x0iW6ffs2/fq3v01IZGJ2kGdv+oo4mVUBV78Xqw4/eVgCaPFOI8+WRicbUIn923/7b3mQhVQE6lUsoS4TSeA0eX7LVL/mcaYTiE4yIBkRhw/cHz+orpCvFyrff/iHf2QpDgY9hBjaev6My4rBW4UWqmVIBqQ1TDZ9jz1SITla39yg02fOsDTkyqUrtLS8zMQPal7Of9zv0Pb+DnXheRoqdaIsZaBEiBgVkiaghfl5WphfZFJy8eoluhpco85hlwnh7/7lN6x+BEnotnspmWaVM5RvtXyP6SLSlZHisRNhuce9KTGYdnKmn2cij/ybf+ddK+/akJLWAqVmFxu/VqvBsfeWV5fo1q1bbNO5sKi+I+JSfvf9txzXcWv/BTkNokGMgN2KAMGWT00kfFanM+l3QShbtDC/QEvz87R2ep1OnT1NbhjTi0fP6OmPj+jrb76ke/fu0c7WdpILGGFWMBFxaTiClDkBVNejmHa392hv74A21je57aAO/vGPf+TvDI/bS5cucz1uHyJX9ChNKVeWOi7vXeoTq2m+q+4ww+3Lc6jm1bkuou7j2bAd9r7fP3jAmUJMApi51yuQylk1sMXrgiWApVCNX5Kfp4bHo1GaNJ2PimMesEVipB9vdk7wvptlJqMdmy/JS+JnFUkCczrarJdwzgBqkqUKlEr+9Fy2+dKUrNened9pVNgFdniSsSWWdG+AODIgxAu+4b/91/+GLl68iIHLgaqo2WzGIIDI9StSwLxUb/pAlZez13T6wGCY7wii1BhBEMQge/LMtbpPy8sqT+uPPz6g//E//gf98z//M+frReDbfn/ERPBgv61izQ2hSnOUpSBsG2tNJmSu53BuVxjxr2+coitXrtAHV6/QytoaZwJhQ/9oSM/2no1V3ey0ELJdH0ghl8mLVUwu5fbCsiZO/xtGtPd0jwYPvmfv4WatyURjfW2NlleW6f/5//1/0e72Dn3z5Vf09ZffpO8dhIUdGIYO9YcDJjx4bkinQEyxDjstdkrJ1JdsnfAqnK6KyGPROeZ6VTYf7bPrdS8Fvg3qnKRmQ5/Btnhsn+arb4T6g7zNc/N07tw5unLlMkvtGnMN2tp6QT/8eI9+fPwjkxhk+FB1csQ2gP6cSyEkgFKv8A91i0J28Bn2OsrG72CLnBcOBS5C+zT4vs2gQauNZfrg9g26eOUy3X/wgL74/M/0/fffsyQXEjN4eKt+TIXvgY1p1BvQALaDQcCEb9QaMbmCihr2s//hP/wHlqh//PHHdObsWc4w0u3tJgGoa0pC1x+nLjTbTdLGOOcvS6JzggDr+bb1HLFiC8ixAGGbCvV2kuIR7TqOEe9QSVf/9m/+hv63//3f0/OtbVpfXeNvgj4Az5LmPjaqlNnJ6Vl/zG9fVR/lgkV9n1z/ODiuFqraRGJiS2atavhIv21OEHTZz22FszUh7mSDl6Ztr4y1E1le3j6t+iuFJYAW7zQwWCLuF4DBCgOfdBqQrF24cCHtQJKAzyQDjxowyqVGedI+fVAy7f/M49nBgzNCKA9OkDuo1xYWlRr266+/pt/85jf0u9/9jssjqeqgXgUhcOFVyqzPJVcjmcgBi1AttVadzl+8QFevXaPT584wKWvMN/naUPEdtncpZm9TFbRcspkgYHQUhzTqYcBN1JhItgFHhZrPkj/lFBKR04gpqPk8WHaGHdp7tkf3n/zABGRxbpHOnjlLtz66Q9du3qCvv/iSvvj8S3YswLMOopBV0iCGeAcgf+jwkXsZdlsgIToy3wBeJEYg26IBaxrVb9726gE4u98czCFRRr3D84GQ4HsL0ce3WllaZukqMrggVMkH1z5gE4AHD3+kh79/QF9/9zWHX+n22uRAmlWrkRu45Nd98gOHenE/MzmRCRXePTv3iMqU1dMu9eIedftdaoeHFLh1JtytYI4nGqun1+lvzvwruvnsGX3+xz8zad97sS1PphY+pJVK+kx9FYZGcg2z01BNpYzD98M+SNrW1tZZwrz14gXtH6jc0ziWv22STUlvX+aksQjcbo1cwZjQ6mFxIAmFlF/KKJNzfIvVtTW6ceMG7f7zr/n7oIzYjj4Dz6GHmLF4eSgyk7F4+bAE8IQhNiXp30fHrPH2Zm0xRZLDovW3ZS41UU4lCRhLHEDyMAB98skndPbsWbahE9WQBIh1XTfu9WDDpOIAFhHBIpu/KgLIfg1JqjSo0HBNSB9QLki/EJIDEjBIU+C1uLOzzYPX4WGX4/619/bYoYNTvXo1JgRyfUg3FleWaXF5gW7cuk6nz52lcxfOsUSpH/ap0+vS7v4uosMxERvFyOowYgN/9tpkOZ/yRsWMG8ep3Ll4fzAMS1K0OQ6XV6mykS82IKfhcKaSKGJZFO20d2nrqy16+OgBXb1ynT787BM6f+kiff6HP9G3335HdUepuiElhMc1wskghiHsCNsHh6VkQEkO8lWKRdIXU/pXJbWploBknRjM6+Fb4fuKrZwEGwfJbzRUyr6Pbt+i23dvU3Nujh49eUhffP0FffPd1/R8+xn0sOw17TQd8uvwmA5pMOrSsDeiYWdItTlF5L1AOfmA8HAdM2wOR0yIIgpHCACt3pkbOrTSXKduf0Db/T1qtRu0OLdEraUWffjTj+najev0P/7hf7BU7/Cgw85EyP0c9gfq/FqNevv7TORAqtiuNMmXDUIFZxO8v08/+YQ+uHI1ldANWHMSc2o/ihLHIt27WXvnVV7e+vG8dBT5k/aM74P1ViL9l/iJQlhhs3jvh/v04If7KQFEH4CJIl/jrQt28HbBVPub/WkVrPr8eLAE8CVhGjsji5cPkZih80enDqCTh9oXBFCMw0WSIR0SBgF0/nn5W/NgdlwSiwzIk/yl2+Ctm0gmQBIgMcL6F19+zs4ef/rTn5jQoewYVDEY43k4pAviFA4iqjcCajbmVDYG32cCeeXaVTp/8Rzd/PAOS+mG8ZD2+/u0195j1eth94C6ox51+gcccwVOAyKhatQb1Gg2lfcpnA085QWsUhoqaSU7dcC4P/l70FFBsQPPp2ZdqZ9BHvujmMJeSI+2n9J++5AunvuALpw5R3c+ukunTp+mP/z+T/yuT29s0GB1lXa2tqiNQNetFpOJbrudZg5FGj9FS8f+tJx+7Bgq4OMSwDL1ndQ/ED+QELwTfF9INvFsIIAff3KXVk8tc/37L//t/6R/+f2/MDmvNQKqz9eo1qxRZ9Clg84B9Xa75PjwCF+gtbPrtLi0QCvrK2wuoK5XT1M/sgQsgkpTqYxRZ1B/Dg4P+G8Q0X4/pqftp1T3Gxy4u93p0k7ngObrLVqeW6GFtSX6n/7v/4a+/POf6Y+//yPtb22TE/gU1FsqE8kAQcSJ4uEwDZeE54cKVQJgw1mJyxNFdO7cedrY3KRtmC4cHiY2emOTGL196W2lzOZSlxap7WM7QJQxjpOUhVHIXs9hOG6XSEMGxxrYWW49f8ETwXSfENKXLImyY0T1d532PWbbOv9/0p/rnYMlgCcIfYA5AQJYJIkTOCfsPVx0XKkXsZLCFON1i/LRoaNjx6AkxA52Vh99+CHP+J89ecoSvjAM40T140BCgAENtnNmLlfzmeIZVMLJNpb8eZ7nMCmtN/gejWYtPrWxxiTwy6/+TP/pP/0nDvUyPz/H3qEYvGHzNxj2cKwa4No98pst8moeE4XllUU6tblBly5fpstXLtP65jo5NZcOeoe0c7BNB+0DOuwf0OGgQ11kfYh6NPIias03aXV5lYnjCiSHS0tMUlhNnAT2xd9ijyeBhLE87PSYUOxs79A2pHh7+7TX3aHnB88oGka0uXqalteXOATM7os9+sPnv2e147Ur1+jK1au0NL9Ev//97+n502e0OD9PgePSw8eP2HGESQRSzHHKtzTUXrpUaf0mVbRlRNBc6rZEVdfIQxwrNeGYhIzrAdBozNH+/i6T6bNnT3M9xLtbX1uh23du0fXbV+g3v/tnDk587/735NZcWj+zRsOoT7uHe7S/e0BBq0Zzi01aXz1HG5un6OKl83T2wnlaXV+jZhKnUTJwgLBIXDzYcuL5cL/Dboclcts72/T8+Qva2npO7f0u/fj9Y+r0OxQODpHEj5p+k2M7Qk2Mb7a2tEY3bl+j9fVV+sPv/kiPfnyYTFYCancQ2wepDFXbAKkUdSzqD9s8DkbsXCL15eLFS+x0xM5GCBSdvP8q56qibfr34+0aGWRnIw5/qaSMKveyq3LJJtJA/BAb8OGDHzl3Nki62Goqj+y3O/Ham44qk4xpr5Hpk1V4mHFlsCiEJYAnDJmF2pndmwF05CLZAqlDRwG7nw+uXGEbOgwA4qQhdngqgG5f2biVkD9WXSWhLMp+uipYST3UgC2x+XBv2ClCioNwGv/u3/07tv3DIIrjEV8PNn8hJC6eckLi6zTh1TvPg9b6+hpd+uAyXb95jclBo1WnYTyi59uPaL/bpu2DF7TT3qLDXptCN+TUbQtwOrh8nuZX5mlj/RRLp2ALVvNVfmJW8Sb2aunzaP00D/YIXxITvy9IuhCA+sXTZ/Tk0Qva3dqhQdSlp9s9qrt19kRFZghIH7/97ls62D2gm1dv0M9++hf0u9/9lh48+JFJOQZoOCJsv9jid6AjJVpSBq1AR5EA5hGPo7bdPGkgVMDIMw1JE745tp07e5bTDV64fJ7+9//jf6Evv/uSnj5/TIsrTXJqPu3sbdFeZ58iL6azl87SuYtn6Nrta3Tx2iV25IEqH2ph1NOGHySG73gnifE78kc3AqqhzgUuNalBC7RA6+EanemcZvX61ovndHDQplNnN+n5kxf06P5j2nm+Q7vtPWo4DVqszVOr1qKn24/o7MYZunz1Mq2trdCf/vhHdhTpHrbZO/mAcwGr0Dewv9NJIMcqrDe5jcFrWTl4xGx3CxIIVbD4sJkZV6S96Ab+cl3ZnphqTJynOwQMBiqO4lgqPzbFwH5MrDZOn6GbN2+ydF3S2Vn7v1eDtG/VUinOen7ZukU5LAF8iTihylhl+1eFKslf0XGzXveN/QZi2I0OH6rfDz74AGTLAQHkUBXtNkgUP8/uzk4MyV+9XneUCqnK8WOcuzeP7MGWUJf4aR6KMafMopCWl1d42+eff86SP6h9UVbYVP3ww/dMVEMYzLMELgSrpWBujgkbPIXhzALy98Hly3T67Fke/DGQb+9t0/bBLu339mi3u0f9qEvBgk8ry0u0eeYUrWys0SU4HTTrHAxaJHzDJM0YagpLAZE+LAqT4MKJ9yVSlTnEamBWG8/5Tr21Qitri/Hpcxt0/tI+Hewc0Ldffkft3Q6F/RHHk4OqsRc51O516NHTJ7T97AX94qe/pF/98q/p18E/0/37D5jYnFrboN5cj6VW8s6TLzomgZxf+HgEsOjc6dvu2BvVrCMA4jdCeoZ4fniuCxcu0qeffspS6f/4H/8P+qff/CNFzoBac3UaRAN69vQp9UddunT1Mt3+6A7d+uQOtZabNLe0QH4TsflcGtKAAx3z5CaYZ1aOKCsRbAW5QjqsKka9gwMJD7KcicUlv+nSYrBIwUJAK/0hLawu0+bFTTp94TQ9/fEpPX/4nA5e7FNn0CEaRHR+4yw9fvaQ9rZ36PL5C/RXf/UL2txYpT/9/g/s3Sv2tcxAEzIGKbvksgbhhwkDjkH2GlX/PXYMAUGE2lm9by+X4JmaFPESlnccjyaP0Z1C8H1ASpksN5Dq0OX2zs408CwdjfhbIAc4JNOYeOlE8mXjfScs5jcu+u7TXof/Tl/r+/1up4ElgCUYSxnwPzodifBv8bZAbJEg/UOnD/IHA/xhf8Dx0ZRjxaFKDB/HtLu3R6srKyyNYy9bLfCsICPd45/LwZB5GzK8OnB/UGnNeDsIILZptoESpqJe83lgun//Pv37//gfmAS25lsUhzF9x1KyPRpB8hfH7NlZq7XImw9YMtZstZj8Xb1+hW7fvUMbZzYodIh2Dnbp+d4zenGwTU+2n1F72OYMHKunV+j85bN09uI52jyzQYsrizQIRyrLBktLeuxRjJALDdgd1uo8gLueItFCdjhEBtTmUcScFO2Dsy8kksn5xQUu32jzFJ09f44e/fCIfvj6PquA4XG6uD5Pg96I2nsdOtzv09//439lb9Fbd24RHG92dvaY/LKn89a2Kl/67pNWyZlB8McUoTam8AKenQCKNaLKBezARTrZzkVMinz29AVq1JrUas0zEUQYnsGwT7/9/W/p//z//QdaWGuS47u034Nd5iGtn1ujjz/9mG5/cofWT69TY6HJ3w7ZV/qjPnu0epAeB0gb57MzDmL9USBG8wjPo9Sf+M01F6g3gK1nj4a9LndhIIJI8SdxITv7HVpdW6WN0+v05PRTenTvR3rx6AV19zv0/bN7tDq3ShTE9HjnKZ1Z2aA7t2/TQmuOfvfbP9DTF1ssRRNJOiYGo0GfYLkp32p5ZYXDCfXabZYEIrtMq9ag5ZU16ncHnBvaA4nF+ZwCMMlkkqQIVCkBXd7OOaJZEq2uHTqhlspO6eB1iWGtpmJbSt2EBLLb7fAHmlts8ARsb2ebNjZOs2Ty22+/5WNR3/M8wCUTzbsE3aZ2ZmASBqD+y98zQMWHVJJ8Jt5qsE2WY42D5Nthb/bkp44bp4ZUKRixrHYcslCwBLAE3JGM656SOFBIUYw8meiQIp6BijenqA7ERovPkY4qVKqIaKSkKFCHiZpR7mXaMcj2MsSc90sdWnhIdn/G5s+Jk2StmeP1chR7B6PhccixkiJWx1HLdzLWx1/dls4EoqCo58i/PpwS2CYqHtKFc+fpFz/7OR876Pdiz3Wpc3jItmfddtsB0VpdXnbg6djtdBJSNMg4dsgLUMRPdVAgZq7p+Qvi5Li0vLjsQE0WDcMYMdUQPgX7a36dVWiLS/Msdfj3//Hf0+/+8Dt24kA9e7G9RTu7W1SDiydSarku1b2AojCmhdY8nbt4mZZWFununZu0trFMK6fWaQjP4Z0ndNA/oEfdp/T5D3/moL8ri6tsV3b+8gU6f+EsLSwukuvE6bOh/L4TkB8gWDQye3jkOb7jjRzy3YA7djdSHXzkRDGHGMZY7TkUxk4MW7ORM4xDh3MCsw0lBnAM7ItrC7SwdIPWz6zH97+9z+rGdv+Q4iYRnEBb9Tl68vghDf7Qo88+/ow+/ckn7HDw4Psfaa7RpHNnztH9H+/ze28ttNhrOaQRtRL1OFR85vCVx900fmAcUzVo5asY+a25SLwScjzFXndAbuyx+vxg/5Dqfo1NDdYWTlG716b5jXm6ceMWDUc9+t//w/9Gf/7yc/LnPGpTl/phj7w5j67evEGf/vQT+vCTD2l5dZkDPLfbB44zUiF+MFEIErMB3F8VD/WJ/04aB9LBIQYgrCY5GLjT9GtU81oUxiOO+TgMhyxtBIlHI4bavdVqxQtLIOeLtH5ulR5+/4iePnpC97/+gYb9IQ3dVZqP5+j+s4d0enmDTm+epblfLdHf/9M/U0yPqds5ZGFsv9dhaSeKtL/9gobhgAYh4jxu0NLKMrX3DukPv/0DOX2in/70p7Rx6hTt7O5SP0LaRUif+0xOEeJm7/AQ9Da15GJ7T0j28L0xAYGvOueWVinhlElCNjZff6gyhYwiYnvVehhToxmw6QJ7/EcO284e7O3SR3fv0OOHP3LYJUjY0TPC8ch0QlFEUnmAw+Md2XiSEmaWKEKlF3M6cTgaJEf4UcHPJ7a1OTAz7Uz0syIcSYUkRvkq5lG+g5oacTgrkHM8Dia/Dph2yNMbciKXGkGN12ETLDEBeSLtuhxGKR2oYZKO/jLCNEGlWp/xlbxXsASwCnoarFdo2GpBJ2IUrHuX/fQnP6Fmvc5qRUg+oMIS43Cx/ZNfnkei/rf84LSAbB4O59jVQ7+odfYujonq7KXZYIkbtkPiiA4MNmJ///f/nb766iuWUELK8+jpFrV39xHEkEZeQPVanTtFkIv1U5u0uLZCm5tn6MrND+j8xbO0eWademGfnu08p/3uAX398Bt6frBFF69dpPm1RbYhO3vhLM0tzFMtgAgoIgdEIvLITySTcADwHJ/85Id1EAvMeXjA5Rer/lPPngwcIEgs6VQek46nBtzYV2nOWAkXhbS+scKZLR4/eEzffP0d7W3vUmO+wdc8e/EMPX/2gn73p9/Tp3c/pYuXL9Lh3gHnFWbP6JVVer71jPZ2tqjOXskO9fpdNfsAMc35/kXbJtvmdFKLsYQJz4tHZQbAAbE7nT7FEYgiUbuvMnucPX2ONtbOsITr0sULtHFug548eUTfP7hH39//lvphh1qNJvWCiOYXF+mDqx8w+bt2/QrVWg3qjfo0GPUpaDbIYS9tZPSAJBlSP0w81HvngZLrpsT7U+UAYQdFQlgYlBGkfQg1MB8DEuVzCjmo5DG5wD2a1CSv7lFrscmOQZhYNFoN+uGL7+jF4TbNr8M+tEFb+zucDeTM5hkOo4K6/OD+99Rrd3igHo0GHOgZL4qdjRIp89ryGr/HQa9PTx49pm8Wvqbrd27QXKvFDkNog7U5TIwH1B4MaHFunno9EGtIByPywf8SaTWrtBGwnCfl+RlY5LuJSjht56MkiD/buPqcIo+iEQ37Xbp+7Ro7g0BNDHvYYa+fcRhK276UQ5shv23Qa34ieCucSFdf5agBq8eScwVkCULdjXiLkgqqH9bNn9qvXy2RZzqx4yDwpUUpLAGcEkWSuDE5mFQhvSQCWCTRK8Jx4waelM3gK4XeacMGCDY+d+7epX63y/s4sb2aRToSMkJ3AtHtjIocO9h5hPPsuopQZe0AYxU2JXKgToLNobJZGsZw2gAZ7Hbb9Ntf/5p+/S//RFvb2+zVub3Xpv0XL1R/CmnGIKTm0gKNBkrCfOr0Jq1unKIz507TjVs3aWmtRd1hhw56B/R8+wV98f2XdDDYo3OXz9GFqxdo9fQanb90gdZPrVJ/MOD8rNBjOa7roKP1AxU3zo3dmFXX2M4qbO5eWaui3JpC9Kg4Npnrqwh8WBdlDdt9cTaK8UgyGoZxDzaLbsBBnhdbiInXoPvffU/d3f8/e//ZJEmSZAmCrKqGzTEID4wyI1ElKNRV1dVdPT3VPbs3uzs3NPc/j5YOzH24m2nabTDVoKhAYhCRgaFjw1iP3mNhNTF1NXMPlBWZaRKpaW5magpEREWePGZ+jGsRGTQHzFSyX9uXjz79WK5dfZ2i0UgjB8FhMFT1Zk0ODltSAlhACrV2m8EvQxLgs5+z2ebf0YmNYBY4kBwD4CNy/kqDoXS6fTKmW+fPMdLcfBRXN9b49+fXP5Ovbn1JSZdcKSdRCZI5obzzg3flF3/5C7ny2mUec79+CCsDc1KDIqffHJz6HMAj28XLMFuY3gPbhwwZry8AcKJ+d4AFDSbUoeSCOIjplqA+dzSmgjGJw6AQFqRYycfLSBlXXZatjVOCzxAQcufL20w91wk7UgnKku/nGagCwIoCBnBn+IQAbTjU1HQkKaE72G3JQXgglWKF5nBluLcl/nIk5aWKXL56RaqLFen222TIkcdXsz1MBoJoT9OMN2AuaTpUOJ4s9NKuGr4/oAFANVfrd4WcRknjezCCiEyHn7D54dpx0v1p2tA+X/S/2HKS+kxby5Sz0fKqz1N/6jIHgE9ZsiQ+/NeXDP7m5QTFr3sb3H/2Z39GgAb2D/59eMUEi0HfQJ+9Zpl8UlIuE+LOBH4OAB4Rf440AtGPSAagwXXB9Pv3f//30qo3pFgoSP2wJvs7u7CDicDkAfeAUaymv2qepjEwl/CrO3fpoiyuLEg/6MuT2rbsH+zJ3Sd3OUlfvHpR3v/x+7K8tiynzm1JqVomQBn1+s7cG0oO0btu4qQFjWwWgj9CGYUDGQTANhFhHvs293GTr8eG8zPng4N96RHgWHOQU7kwlkVk9Oj05XD/QMrFily+fFkqxZLcg6/ZnV0J+pGcOntKdqNdSqHArHbp3GVmLrn+xVdkqXDfJvKL/LkwX/qAzC9ZrhRZ4E/v52S5hMdM8hhUwPyGGirmiwxmQPtunT1N8Aewfljbl2tvvCHdfke+vn9Prt+6Ie1uk8EcuWLISO1r770lH/z8R/QNBEDfPdiVMBdQ/gevmn3Zu35jnQiA0JZa5+6OyDZzXwZ+AF3TJkYBafWNGkrOlAoY8INIXPWfClyQT4TI4VKJLgfnL5yXM5tnGRH88b99LPV2XXKVnLRHbXm0/4SSQadOb8mlg0uUj2nVDhVgBV0J8zkGq+AEgxZyQ+/JytKqFKK8DEd92dl9QqC1tLwkG5ubUi4hYhj+d5F7NqHNmZsAcWPZGAf8nIeOH/07bUwweRw/dVyvq88r3XNGGtD0xhvX6KuIaOlCaZw5yD8+zx9PysTMI1JffGHdT1ng6XdHP5uXk5c5ADxBmeaDNgkGXzoD+LzRwNN+H78khvBllZmVmo4GhIP622+/LW+9/TaDPVBcRDCjctNmXytpJiGdycN7zx+ROUtl/CA4zCkTiAkPAGlxETInOfn66+vyr//8P+TO7ZtMA9Ye9OTho4cibc2ygDRbjMJ1eUs3N09JuVqhGfXSlYty4eplRoM+3n/ItF7XH9yUvdq2vPP+O3L5jYuytrEqFy6dJ/hDrt0hWLgoJ5W8RjsDNEBAeOB07GwwtZyc8MuhJYVONW6u1VdndnPhdjBEwuRolhgyY8lvCGBXqysyrMays7sjrXZDqpVFMpLwNWzXOpJbyUu33pb8QolA8PH+tnR7fblw+rzsbe9S/xBZRiCVA5O5ZnIp0h9IgcDY58u12NT+cPTVvk/7Uo1NUjrxO5Fwlw3ZIV4ykDBPoU8tVhfl4rnzUsjlmLptcXlZNs9syK071+XL659LrbkvcU772vrCCoH6r//D30hluQpGM4BAN1OUbaxyMQHdxlwuF0xcb1KxIQm2WJEI87R4N8rP1XwPulf5WhiN2a4ALtRWhCE4CBAUohxoIAMkZx4C2MAftCAXLpyL242udGpNVhGCQ/Ye7kq71ZYza6flwc4j2VrdovD4oNuTB3duJ8LqNI4iQhgX2u+T2YZ/7ebKhkSFIoWZ7969LUufLjMyGsEihwcHMhj22ec1m4e2kc8E+sNAwj+nBKHTLhtZTCAKGM28kzrCPaOvXb58Re7ffyC/+c1vJOczvp7uoEs3fqSPZb2fl2cv6YjgbDY2s76dRsO8zCpzAHhcmRGAMN5l0td07gP4pylZ9Y4V/c9//vOE7UN0KVKsAUxAX8+iV309ON+clGb+0uwfo35npIBDsUAfmCzBPuL8f/jDH+STTz6WarVM/6PDvV2J2x0K67LPIV2XS+uGbXV9TVbX12Xr/BmyTKWFijzafiT3du/L7Ydfy37tkLpy1959XU6f3WKACM6FCTccIopXc9DCd6vb6XDyKhTK9CFTR/KxE9AoCc6BFxkKnLRDBnWwfv3oO88ciq+H+HUqrgesEZgcXI+lKBuOYllYWpCrb74mt27ckUa/JZWlEtlJtNP+4T7ZSkQrM4UazPWsW5FClON3nVabafB4HSmmzgcDs16nrycmgaPP/iSMkAOA9XZDclFeLly4xH5VrzfIYl197RJ9F6/fvinbB09ECiPpDSDeHRL8/ewvfy7rm2vS7HVo6mbKuHKBfQqAEtG96sakuZh5T0zHpz6AbI4BmD0gcNd+wIME6A6keyZiMJ40CzM8RAOZEEMGf1VULFKz9c13EG4AQUg/TfiEnr96gdlhbpZuqTl+71CeNHalEw5ldXFVVteW5fyl8zLqdWXYVya9iajjHI6N88DPbiStw5q0CiXJwQRLMDag/yvu/Uc/+hEDlLo95AgGG4d0bJrCkSkPPRCocjAa2ZtmALNAgg8CfQA4iMbC2ZauD5H1165dky+++ELqzVamHzCZP5KAkz6Ac/D3YksWwPOfbS4PUuBw3gYnL3MA+AwlzQ6ZiQwlPUm8hPKsjN1xvoBHonxPuN83vcqadn2ZEzxU/iH9AqdugjxnNjSWYlqqt3QASBbA40QQ5lXfL1SBZ88srIxgTkWfMXdBEw7mwN/9/rf0+6PW32JJHj68L416XRhWykCKSPKVEhkyaAQC+FWXFmRta0MuXL0ohWpeHu09lAc7D+Tu9l25s3NHzp87L29/8JZsnF4j+FtfX+OkRj9HmHyDHBkcWAXzkA/B5DVAZgRMjBEiKb1ODV05ndhUaFmDHczggjpMDF80QSqgoK8ao+PHzwjYQqYJG8Y0fZfKJel2wV0ixC+QrfOn4sfb29LtViQchtJudqVQhYh1X27dvS1vXn1DFpYXGHmvLNsC6w1SHoj+AxS0dvLbSwM1Jk3EmQuzadIVSS93kwoBlMuF7E82MJv2R3L+zHk5f+Ysz4csGeun1kiLfvblp3L3wW1px20pIFgoH8j518/LD37ytly8eh5ZWuB+J8WK+oXCf45iyoGmkVNTM0NvPHMY/2bcYwwXQYLxMeAjUOeKVK8ZbTcajmKyfxLDIzAJ70dQSYwQWUixMGtGniEj2Ae+lpDlKRQLBOLo3612iykE79y+LU/ubLN/33tyX85tbnGR0m93lGmLQtne25Wg1ZHuoE+3AsWhQ2ZGiUcDpi8slhboC4vAC8gzwVcXMjG12qFrPwN91nbjzCGM0CZj7TVnygycBfz9Rd1oFJGJ7GEsqFSUea3XmRXntddek48++TST4UNdxqMhn630ueblxZWnmUdT+83w1JwXK3MA+ILMwfPypymz/H5Q3n//fQ72YJWw8u+0WmSiYOqx7B8+AEwPPCaO7DMA/vs0S+izg9gwiYO1Mj8jTIoff/wxc6RevXxBWrVd2dvfFxkIs0DEZDxCWdlcJYBb29iQU6dPS3VhQZZXFuX0+TMyzMVy9+Yd2a3vyoPd+8wQcf78eamsVuXM+bNkMgAiEGUaFopqie0PpNfvSTGXl8VShffQBtNCsDS+d0yoCWgCy2IBBmCJxpXDPKoo9qnvChHhmIjSdG1D/71Y6wZAvN3tEIDmikUGc7zzw7flq8+/kjtf3ZHqSpkM0sH2LlOgPdx5LEsLi7ym2sEBIzPRlgcH+/QxA5BQA+gkAPT7xlT2j5G8UzqO7ZLBKvjtDZkK1Pfp06d5bWCVt7Y2ZOv0ltx5eFt2D55Is3MoUhQZIe3e8oJce+s1OX/lvNR6DamUF+n/CRYOQIiBCTBJhkHir6ZSNOMFirGPvHOFeWM3FLiNGliHbA/lUobUywNoUTipN4iAkXKhJP3eUPqDIX3/4CYAjNUb9KU77BMcYaG0tLBESSGA7jgXSz8cMEK3td2Wu48g8CxyceucrK6vsE3xXAH44dhob1LJ6CwjkS78JXs9WV6KJV9Azucq6w1MIOoRwUKQYep0O16mD9z/WCDa2gCuFelnc6IZMxZ0/qIPW6fb1ahgaBaub/JakLnl/Plz8sVX15OxwR8nBsNYRsM+UzlOK3NA+PzluDr0+8O8PH2ZA8BZxVH89uD7zI8NCJAAMafriZ96Pif4GytLDDJgXywzBTNBZJir/AHNYzAyffcsKvMZinPZSpifsV+/XodGe7p7gK+bO5VGsyb0+2ynvOMu7ySDZNoE5x+339NsHRB1BtgCOEC9YhUPHTas4vGZ3Yuxf2gP6oBN8d8x862dy4I9jOWz12FvyEwfYZgLYGaFRImfm7U/6MUw4YL9Apvyd3/33+XWrZty+fIl2dvbkcPdx2OdM0xCYY7AC2AV4rRnzpxh8MfG1il58723pd1vy93796TZb8lnX38um5c3ZG1rVc5dOidbZ7ckV4iCfBhIDnIcMP/GYCkjKeVLEhQ0qARmYAKNKCd9+rhpRhJeA/33EPMLU5m1P+p/7AuVsJ9BSJaIJm4XWY1C0AyJTBzAOckDetDXEmbIXAj/vbjTa0t70JdCpSzrp9dpfuvudyRfzsvi2pIEvUAa+00KUq+tr3Cyf3jvPoNguv2uHDbqiVkUUjNH2R3LD2tmamtPa2trZ78PTPZXmPoAaErFCp9ZSJzAlI9X+v8NhEEfAAzw9YTY8/qpU1JrHMjte7fl/qO7Moj6BPCDsCsXr5yXD/7sA8kv5APIvMRBhXIvIn32oyAMAtS99PWa+v0kFzWfS8soA5dEmEAHCN6IYhn0B/FgqGLMCB4BAwhhbw3GYZuStkV/gOQLJX4gt+GEvxF4AxZxhPNSdiaMS/kifRCZUm2A6xCprlTiU6PT0kRmmmEoX9a+lFq9LvuNPYLxdy69IcNBTBB19sx5iUcRTdw0uSKwqd+j2Rnt1e21J57DJ08eyY0bX3HRhqCQu3fvULYIgSSDgRtvIzx7unDrdocS5VToHb/3s4T4Y3bWM276fI1GjwtCBN1EuRzZajy7WKi89trr8vWtO0zPqH1hnLrxsNbQOksFKTy9P+Bzjo/HjP6zfp8ZQJGyZGEx9zKLLZQtBR/Oaxp/1q5Dp4OKerd2s/nAxml75gdYEMZxDMY7xuA0Twcys8wB4CtQ0iuY+Yrm6QqT0+eV9QLYMrYNpt90PadNCr7mX5avyXEbHMhtYjjKCsLcyrRy0ut15fe/+x0zDVj2EVwvJhq4R2kwI0Jv82REVlfXaRIrVxcYyHH24lkpLpRkZ/eh3H50R+7vPpDCQl6W1ldonsMGYWkwQxxARTX+AP4Y9Rvm6eQP82BynyEGV0CDxKw4WQcAAjn4auE45vOoAzMyUiC4BKEIBTcQ+4sW5lMGuCsUEj8dcFFgoSDkDPk+Lj1GIvVuTaJSKKsbK/Ko/pA5cEuVsnT6LaY0q7c0ShogC/WF+oPPWK3ZICM14ROUWkQdNyEDiEyWoxOe3Q+rJIlCVZ2e6tIyAeDSElhKmDVhyi3Ik/0m/f9Qt4j2jcOBrJ9al2tvvyalxSIjrpHTF+LMEJAGRQaGyxg/i8zGpOczmgZocN8KzDpkQpHzFwFDMMkC4OF60VYMWSF7qJWNBa2rCEaCazOrmDLaUnlEZJ1R03FEZTWVlgHYQmAImMfVxpr0On1ZOrUio95IHte22S47tX0pVApk8Rr1FrPCLLVW5DDWQCjTrcciAP0UkdKLCyt8XrEAQA5o1OeZM+dkY2NT6rVa4nOn0i3jZ5ZAOCVclxX8McGcplQcUNEqAzXgswK3CwOIAK2XLl1klh6oBuAaTSoKi01kAqfP5bw8c3mZcx1w4Es58HeozAHgMSXdN7NYqBdhAsgCgcdd2okP/nS/f9W59ImKod+ZS6s21oYb0ocHCd79KF8b1Ln1+zEm/7ToMw6ZZv+m+QFS0DlXdL5+qgfI2EoH/vC+XC4xYhVpzX73+9/Lk+1HBC8azdpS8IcCM3FUoOzE8soaTb/w/csjAnjrlJy5eFZavaY82nskT2qP5cHuPdm6clo2tzbkzNkzsrW1FZSivAzajoWL8lIIVNwZTF3EjBE+0+z8vhi0AUhmTtUOENFJ30lnjIZk7PS4Bb1f7B7AbyzHpBRxAOE51E+kpHQEXTma27gQpxQJJlaTJGEGB9yzMDJ4oViRtVMrcrC9J+16W6KFsnQaLZol6wcNMueXLlwgkwqgUKpWpVAoSpNpvSYZW7Spn7ll1jN1FAAmLZ/8xjf9GcuEcwCAAOhArqZYRr7bSNa3NqgNuLu7Lbu7j2WYByhcYCq1K1cvytvvvgmWVjqDjixWYH4FWCfLHkDsWQEFdPlcsrm+Mn9wHyTD4cBnb9CPwaYy6AYp4gj0UK8uQIHGiwGZE0aL4JAucMfuyyXRmQSBjjGFGiR8Pfu0gATSBaAMlSlEmr+1NQC/oWxd2JJhbyA3PvmS/pmPDx7LxY3zsrKxLt2eBrZ0HIu5f7iXVC3uBWZgjfAukYXDogiuEUjJhkAM5LkmO9iNmQ4PvwG7aAEcZNg9E3DaRYMMvXu+rf3SYyx8YAHqLJVdAbqeXpDIxYuXZGvrKwJAtDc+p0l8GQFWiHT+bgLAb9KkmjWnpgG8nDxHcGDgz/kAfjcb6AWVuVL2U5RMJ/Ip+z2L/8fcZ+Tpi030ZjawARrm362trUTgWU1GGvgBh2/onw0oIzIZADIt2CPt23dEB9Dbz0zA2AD+MAndvHlTHj1+kDA6mHBwLShRLpQI5rZiQSrVRbJ/SyurUqpUaf49e/ECGZ57j+7Jg+0H0hm2pbxSYcaGjVNrBEXw3YL47mg4lGJYkHKuSNaP4A88jlr2kqLX61hCt0/SDzXlG8GCBbHkCsg/m6NzPwdpB3rh3wVWDiZ3ADO8YiKnHxhSwvF4MgH+6FXI4zOFnMQBUiuOGAG7cWpDllYWyTxavtqoEMl+7YA6eQg0sKjfpZXl5LlJB3vYs5QO8pn0/xq3/6zNPw6KLSQo2bK2IqVigf2rulRl8Ee9eSgPn9yn6RXthnuBtMsP3n+HZnqcF8AM4CUO4Z8HiSAAFWbxdaLNHks9UoBi7NMIZvQQUdw5gkmwpI445GYC1Dgv6lnTfbnIYBctnOU3p2nXYCnGX+D+kNquSL9RSNsAnJqZH4BtZWNVTl86LctbaxJWctLoN2S/eSi1dpPMX5gvSLFQlqXFFVlZXqMZPWkjRAqNRIbdLvsN2gbAEs8EWMCHDx4k/qNkNtHf0E+9QKt0dH76Oc0CMdY3/D6B9rT6NRF4E4cHe4/AFEbUu0hhk4+yuvi2l2edr76JMg30vcrX/G0qcwB4XEmZkrL89OzzrO24kt7vW9Cxn2pVNa1eXtR9mkkMTAHYP6ZeC0NG/5q8Q2oLBsNhAJk0+D86H0g1wDrxeJ1AkNkidP594wAP5wvJrBcm72I+WviT2UFyOYImTBb4Gynn/vjh7zlh4Bq3tx9Lq9UQ5B5mWlPiqRwnyKWlFVlaXpUiAjWCSNY3EQSyJQeNA3mytyN7jV05aB/K6ukVOXPhtAroFktIWRV3W+0Yk3apUJJiviTRKJSQE61uwC8JE+rYz2kO9OpyNorht4h8t7liXoqVEsBGPIj7cafXJcgrlPIxtmK5RJ3CYqkU5/L5OMrlUEeWPYRBIQSC5g8IYBIimnIo+XJOuoOWDEc92djakJX1FYKaCvyyCpGsrK3SJ7HRasjmqVOysLhIEyjAQR7mT1wwbg7+ii5tlP3NdF1ggdw2+V6ZNpjyki1JNm/HYYgJWVL4uOF1OOjx84VKle0D8NoddOinCMYXUd17B7uysAxzcJFA7fXXrsrb77xFQIu0ZohsVt9Kpfo0cnfghLUtAwWA0iCIhyNkqyENEhAZjmLE5EC2BQEz5uum/Q07wPzelU6/Q4kh5KpF2jSWEWK+g1hT/mn/9e1kYAKxwT8wikMuJpC9o1yoMJKci4w+cpmX6KKwfnZDlk8vydqZNWn0kJGmKY/g15rPsZ3gA1oqlWVpaVmWF1dECgiaCLhQsYLgHgT1oK7wfIAdv3nrFl0k0MYAX7nIBWOFseTyR4HgcYBw1ng9kSYOvqTuPYPGOh0CQFgUsNAx95LvEvj7U7KA01xvnnteJWXo/s3L1DIHgE9RnhawPK0JOP3+FQeCr0yxQZz+ZnEsZ8+e5ZZIv2Ss+tWv6Kjfnj9xTGMW/A3F/97AnwFATBQ3v/6arIYG/QwJCMn+uQAJYNAgykt1cZEMF8xmmDSjQl7OXbxAELSzt0f5jV7ck0a3LourC3LptUuyvrZClgaBHQB5yLJQiAoEfxgDOaHT1Skm4GFGEG+C0z4G1sfTUiNLpCZFABP4tuF6MSHjFYwS2c1KWQY4FnzMPCd5HDPRVyQcGSr4I+unbBT+hjcgMAgAEgMaRn0pV0uyBA3DhbIsLCljVC4XJZ+P5KBWk0K5RMZzCMCHXK6lUsLIWMCS3yemtX+ykXGbvkDxA7ns9ziXsn9oK2QoiaVYzMvq+ipz3959cBfBP9R4zBdzsry6LFffuCpLKyvSbELuJ5BSscR7B/HKKPEQdTLW7DNYBkAEUFmplHm8SqXEulDwGMjCYoX5rSHsDJNkt9Oia0E87JPdpe3XJGzg0+fMvGjvcQaR8XOUMOHYRoH0uwMmEEE/Augd9Pr0/2T0cykvyxsrsnJ6TbYunpZhPpZWvy07B7usB4BjsLioK9zH+voGmUDJFcaok8ziiKZgLCjAuKGPIRPHnovURxuDBbS2BeiH1M408Gcl/Rz795nuI7bBKmC6oBYwhnZGlD2OgWu04D1bAH7XyrRF4cssWSAwy4dzPie+2DL3AZxeqO6M/A7UeU5YEU8vLaM8T2c9xiE2rb933OcvurySvoEaGRglYAuTBRLUW2QZQI+BnbTcy+xBTp2h0pOInwGE79lDIKKLKGD4IoYJO4jt7p278vEnn3AigUzIwe6BsgfDvkQQZoZVLhfR/LWxfkrW1zalsrjodOGKcmprS5AhAvlhDxuHAjexsxdOy+rWSrC5tY5zxBrkEUlUjFTGA9p0MdKURfT9Gxc/6wfjQhUYavYPZeuUCE2C2pcXluPuqCP9PpgR+Py56GfUKUySAAQu4IDAE0LWjB4MCRJhIjZzMsEfcESSS3gkuWKOgCJXyEk+zjMHLgDPxuZmfLhzKKVykZGpqA9EmzZaTakuLkhlcYFyIhT4brUTNtM3/aaZdb8kfcC3i+sXmf3LQK0xzsVyXtY2wUwOJZ8ryMrqihTLZbl747bs7u9IvpSnubVcLMuli5eY6q0/IGsaFKtF6YJFdOdXptEmO16E+xvtVWA/pi9cMJL+CKxUi6AbQHBxeYmRwJTfAXCHSHakfrHFUj6JsKVgucoD6i170avGzGpmESfujX9hTLN7XigNg2zRCGoKLBMMF13VYrx2apXyRMgQ0nrYYNTmo+0n8vr5a9Sx7HeGMghHSSQ8fD4hM8MzgQmkBE6bkcOQgQHAg8/d7Tt35Nz582Q1zQSLYCr2wQIipmMZdMdBOb7/mLVxln+gD+yHqc+4cMlFEg0V3NlC5vKlS3L9+nUCU4wxqF8Abjx33+aiY8GfTtbsmDlvYh496Xyq8VNMeTNnUI4pcwD4FCWTqv4ed7EJnzLLDPGUr89bMPGTbSvlOWlgtY7JltIvLndsAgDhtwNTD4IEUhqC6UHInzzs+6wN9E2QM8CnrKKfE/jWzZvM+WuftVqqbTbqYWALJCrBbFeQhQX4/q3K8tISI15L+bwyX6W87O3tS6PTkMd7T6S4npc33n6T4AMmQACwQgTmMS/FXIFCzDAL4tIQCGJxEGDtUOE4pwULMM2bY4bSPmLaNgDRHYo44+tCkKfv1uFenRPh7s6OdJttglvovSFAoJAvSqVYpvmvvFCVK1cuCYJcASY0SETlWGCSxKWVcwWpMcq3JIWwJM1aR+KcyOLGojTrTeYzPgAQrJTlcO9Qmg2kkqvK+vqm7A4fSz7S4BafmfN9Ao8LBKEvmi8GnRElbKDP9wNEn1tcWCbLDFM1ACnK7s4e66O8VJHusC2rm8ty4bXzELyWeq/BekU+ZAAh+FQSCJuMlGXogKWatR/Kl19+xZy0h7v70gS711PTLvoToo3BsC0sLjAKfPP0KSlVSjT/mn4fADKbFJtDO/A0REYQmK4tgQi/JmPsDWlDkTz6c5ADRlP/1jjPyOXuaKDagYFIdXmBZvvNM6fk3l5LglEoj3Yey7nTF2jC3dveJ4MI4efFxSWNim/DnArpIwX3WBShLlHPAFgAhPfu3UtcO/AZGGgAQFuIIaI8B19K71mdZkmZtiinxEgGw2uBRFhMwad169QWWcCH9x9o4Fkk0mx0JVeergP4bSqpYOpXptBH09h495kud3TjosUbuulO84rey6tY5gBwRlEXoBHSasZc8Q1GQS4qYDajCKqZAHQw0kEJEwM0wow5GAYqU5EegDSH6dEJakbJhEvHMZLHruymZUJw8wCiD93jlsjnTijvD6OZAI/SI7MA4MkX0JmPNaUr4jDR77r62mU5tbUhBwcH0mw2mEoLOmL9YVf6o55K5GoeVBheMdBTV81zGo8dO8A3YNgc68ePzE+Q4w4BYBzDEX84GkipUFVfrFKeoACSL598+qlOThJKp92T+n5dRu2eRMUyM39gToZ0yJlzZxlFuVKt8r66rab8+Gc/FLBvh60DeVzflsaoJatLZ8nsXLxwIa4WSlKVAn21ogBBuIhSVdMe7qE/7EnfTfpq1tUAAQQgWF/M5aFPSWYrgAkSPlBo9CgMAoDLIM7FQbcvC4UF6TQ78uEfP5Lf//5DqTeaNGOWEf2sGVFkEPalIz2pBw15FEMCReTGh1/JuatnZfPsppw5f0Z6cVfaTMm3EGBCb3facSVXpc5bPxwREIPlRMvml/IS7A6lVC5I6xB5cUOp1+py9eJVuf31Xen1lOUjAwrnOGfipnnfHhdPpkPb7SjQJy1pLBDQl/ddgCjRobJVYGrbnR7Z5tW1DSqa5HMlKeQrsrF6Svr9kTx48FgK5Yq0egjUKcna6XW5cO28tEedII5GslReYtRsbpinH6MUNSVau92hj9360poc7tbk048+lgf3HkrjoBaTeZSAAR/oXzCsD2Qg/Q7YqZp8eXidpvhLVy7J+z/+AVOygYkFY5yP4gDXy0CHwUADOpCHlwEP8HlUnUemgoPJGKmDmSJO66CUK2kgyWgEiUKakMlaI4XcKJZ8GMlSpSKdjWV5vL4g4UIoTx5uy1Z1S3Ybu3Jx/bLk7jySYj5mIMliZVE2T50mOO7VGnjApNdt85xg1Ha2H9PfbnGhKvXaofzx93+QX//615QrKuTyElaWmCVEm3ZshsWghFYc2mInyeDiFm94vr1oYPj5OaddLorUPzaWCOZfHDOv0jfDXkd6USALpaJcunBOvvikIp1Wk/W3sbYqfRfIlcU2H8du6fXNVio5bvjuD81fdHLHhAWd/XMCe75OAGPvXtI57r0sPzzPMYYhX7dv4jjJPKiLKVtkoR/zc7CvIwX4YLvBclPiCIF+LniLuoAmbo7voUtKAXQK9EB9AI04h4MzyhwAnrigg5rP1LxM1Ew849VbkaVfUZ6XCfRNs2AKXn/tNSfr0E0Et5FvdLy6NxaH0PTIcfTv2fIvPsuHwcu+472FKk8BBuP+/ftkb/yoQlyPAQ7sN4pyjPhdqC7J8uIi9faYAWRlSarVktRadWl029JsNyXMQ4ctJ9WFqhRzEQV8A0xa1HBz1+7qHEVNdW6BYULOE9+JNGp1po7rxENptTt03ifIGMSSD4o8fiVfle372/LPv/lX+eSjzzkIV6tLBIS9YYcRq2CrWB+IPEb9uPyy3WZL6o1D+cPv/yA/+vkH8rNf/lRGo77s7ezKwsISYB6kZWTk9PwAhiQXSr4sTAmXK+UlCJHzVyeNdgOT71AjSh1Y8U1+Js+S9Zxmsb22ELNJL4sl4jyiqJRFGedy0vYQEEabQveu1WpzMYi2LcBMvLUqlaWqREXUqQtcwKoniCSKBwyEOWzWGPkNAPjH334on378mXTqXYiMawq/QUBQY/2402+rELXE0mt3ZGFpSeJBR373b7+VG1/fkF/88qfyzvs/kNWlVWk0agwwAugD0wwGehB3pVKuSrNeZ0AKosGZI9gtjsgEMt/w2F2A7DH2dXWAxQbuHent+mFEVq+6WCEb2K51pDvqy0GjJmdWh9Sn3Gt2ybZaPuxytSq9dkPCUQSJIfoZ4tmwDdeEtoRvIDYwvvo8d6RYLCmbjxRzLkfyEWZ+xljht6/P+mm/1+husoDwdYTUjBOSX1tZlfX1debyriBNn5OKmVayGMlXrbzqbBldRxjFru8tk426lNhOk+9fhGXp+1LmAPC4MsWZLxloXvEH6DlK+jH6ph+rE/k2mskPBVkz3nzrLZqNTBbG1/9D4AB16XSVaYxe2nfIiwQ+GuRhABAZEvCKic8xhmQKLfgDkYzwGQIAxO8xqeFv0xezqE1kR4DmGUxlCP7ARIjrXVtf14hImFl7bd4TZEbgR4jvTE6GXojI7YvMDr7On/K3Xk3Z30cZBzJffeRqpQRIDEd4RHvC1NptdOSrr76Uzz78Qr66fkPqBzXKe7SaKv8yQjo5qvO69gg0AwpX9flAKosVCRqBPHj8QHb2n9B8+MYP3pDl5VWN8iyXrV4167DLUVsoFAL4RSKquBU29H7DmMwu6gJBEebH5YszpxkH/9HN+mz859h3MGsS56PuhgK0GyNTAeDBzLm22NvfITuFhSICW2C2REo4tC2yV8ig764V14EgnbzU6wdM2ReMYvnq+nX5l//xr/GNr25IMSwF5XyJIHscrc1EfTQBwzcP7AeAf3F/XwrFHDOKIEcvfOyazZb8+Gc/ogg1JvlBtxej7/Q7/aDb6Up+YVHvDQ3H7oK/fX8w1WkcJt+P68NfEFELkuboEl0Y1tfWpbPfkdFhTFYegA1R3HuP9ylns7S8JK0+ooVXpFY/kFwfjA7Squlzav6O6NM4PsAWTMEbG6ecGbjDV5i3WRsAj+DyM57lrPZOFx/82W8wdlibhmAo+yoRAx/Gixcv8ppMcir9HM3Liy1P6/833nk8Cs7L9DIHgMcVpYOmfj0tenBevpliaZsgfnvt2rVEKNh8esz3L60HxynviC6ey4yQEeVrr74kjG0mw2GgDq9gLSBqi4kDn5lOHkqOTuSqr1eoLnDixD7YOi34OMXUjWME7VCDLMD2rC2vyPIaJtm1BNwGQZ4BGLoYUXDhXP6T/klHLzOLxSHzwhqjjSACsFa9UV/yBZglh0whB5MqIotv3rgpH//hY7l/+wF9ABerS/JkZ1cO63WtWwBA1Cuii6Fg4uqPwtORUBcvLOp14Vj/+//9UP6z/Cf5+V/+XHptDdLhP9oVAwavmEK0RVPj3iy1Xm2n5lKzlSZkbOjQn0Q1H03ll9TFDLcIfp/6Kh1YYn6GAP76GZhL+DfGjFpFXwTBh+vFPisrK2xXXYgYIxsw2ALMIup4vbouH330ofy//h//b9l7fCC5OJKDnX3Z64+kvn9A5kzNmBqYQQFotFM84CKh9bAtK6tLcvb8GYn6kdy9fY9ti77z13/77xkxi76H6wFwNZYNfZBmc3oDMgAIHqQCoRgGhZhvnOcTqnUCc1uO2UKgZQhzO0DZ4uICFzE75T3pgsEcxQT5G4sbZHBRf7heAOKV7ors7VSkh0wo6DsgRR34AgAslZAjuCKNepPP0VtvvcNAqWaznYyxANUB0985n8Bx2soJtm8aK5g226Z9AIdDpMobMssQ+hza9PLly/LHP/4xSSeZZvm+b2P/y77fZwkCmZeTl7kMzFOUNLg7afTSt6ykdf7s/VPp/72AYg5bM8+LqNdepyvVckWuvfa6tBpNBkHAnwk+bLQRYXOabk56TckU58enG62Pie5f6PT+nO9f0tCm92e/A6OI4gNATA6PHj4kW2U+SpgIO62Wms2cmKxJiYCZwd/qBzNkwANEjn3RanyHiXNtbZUTYS5XwNUFyvxhCo6cgp3zaSI/osZZBjogjDNjMMV1cDILcnE+KsQwOyJvcD4qyK0bN+UPv/2DDHpD2Vw7xTyyu092pXnQkHgQ00QJENdr9ykXgtRgeN9utKVxWJfD/Zrc/vqOfH39a6kfNigr8uThE/nH//Of5KPffRivLC27qPoRQ1MTJi9mPs8JwG2R3rjWdquVmOnS5jyL9vYjPU/c4WYABZvozcSMTd0LkOFE9fsODvel1+9YwASiwgMAGTVnat3zfgCdnM3qzMZpefLksfzu334nt65/DcY1iPtxgDp+cPu+SD/k+367L51GR9qHHek2utKD+b3ZlfpBnb54YGrv3LorO4+fCDLCoD0++fhT+eLTz+kjWyoWGUADnrVSLkq/11FtQ7gCcEGgsj8w/0KeR8V79P3R4DdeP6XFwUDjPgkuq1UpV0oMTqJOYRSQjQQbChkXu3+AwKUFBYusc6R5Q1RFGDA6GNldwNZbarsnO9uyvbtDDUXkVB5ZO7hnxmck/deTmIZT/r8TfQe3Df9hBDShrQECkaYOjL2fy93vJ/Py4suzKWq4UPp5mVnmAPCYkrgZzFcir2SBGQaDN8y/8M8B02ETP76js/cxbZfl6wen8ZNMLspEjH0C8Qr279bt24mjMsAfGEB6PLtr0PzFJea3BXtCRsmdc2VlmSCv3WtT9qTZanEixH5LyPrh2DAz1ek1YVNg4Qc2WDEGh1jQyzNRrzUSEx5ZuFFM6ZJWoyWffPip9Fo9KedKslJdknK+LPkgT9DNnKm9oQw6Axl2BxQHhr9g7DYwW6P+UNrNDuVhwGTtPNnl727dvC3/+H/+owy6/ZRf5TjXLYoxLAqa1NRKP0Do3DkwYSZfq9cjOn8ZrPysCSX9uZ8CLt3elFgR514wHLKNjQ2260db2XHImiEnczj2l4Ru4//x3/8PufHldTm3eZ5RsY/vP5R+qycAfaPeQOI+mNYB0/yxrhH8ArYVadEQUDTCYmcohzsHUjuoU+C5UqzQ1/BffvOv8uThY1mqLJFdQ19EW2tdIVWcpoiBL6D+G4NApvBz/lfUEjd21fndocBJ31whqvDtK6tvJGPKRyNpQzdyOHRm8CgxrwLMr6yscV+fSes7oIW6xe9xrWBV4U8L0AVWcOJZDbJFoNPP9XElmwHUBQau1TQBcT1gAfHq96U51ng5ZQ6wX26ZA8DpxdFGJiuEoCLNy2m40AatNMB4yYPBy2bk0qGSSaaMkzBy33TBhAYG7bXXXpuodzMPjk2/cTAajYKM9nH3o9lYPcAHHz9o/IHdy8oIkkwsPiDDuSCRAuFnAzMABpjUrGAfyoiA0VteQT7hZEJBgSRM3ukadnp96Q17lIRBqjj8BgwSZF9COO8zZRcm4Tyu1fQq3T0qG6ivR5kKsISmndjr9aXT7kq5jCjHLqNs97cPZWVpLeh3B0Gr0SYAXFtZkVyYU4ACBqw3kGF/KAO89oYEgtjAEIJYAsCpFKsSD0ZkBPn5QOTO7bvy0R8/hswImVaPUXV+eABS6vdmkh8EVkGsYtSU/1EzuM/Q+VsaDGYJQ8/a3//Mb3+0tfqAIVghZmaQfh9C2Spj4vpFnItyMXwZ0Y9idj3VWlQ1PoDDIkXCH965L7lRnhGyvVaHQE4GsRTDojT263G71orB9vVbfRl2+hL3RiL9IBh14yCKI2nXWzJod6VUKJK5bdbBNndkobRAP7w//OEP7IPVUll9PYcDiQfm54a+YMqMYP6gITkgCKS+IMzyJhUzCaTIjCNDyWg4jAEEAf6Wl5dkobrAbB3w+RsMe9Q8XFyqss+j7XBKpClcWVrWVG/whR27brFP4nnBs23PkAVUO83eTwABAABJREFUmX9p0S1YPAY/y5/3WDDogz4AeUsbaX/jO8sAgoLrQq5iuG3QD3EO/l5qeQHz6yszV72KZQ4AX2CZrwK/+YIBGWwZBGQtk4CxfxYNehJWKGuiSPv6pUGgn/3DWB9MJJiotre3k8mLTBGYKg8kYtLD5AfwZWZhcdMwxJGhyIHMGKBb8D1EhgF4yuXqBCPllwkNN6+oxp9l4tBXm9QLRWVgDus1MiwLpUXZ3d2n6RYSIL1OT4JhINKPpdloycHegbTqDfpGAXxiImc9mIkZhBxpRpjblZl6eP8RX9dXVinlgf1a9ZZ89OFHR8xviHT1s3poXasenxVOzLFGa84SfPZBX1ZGkHR+4GnfZ5mjzecMf+PaLIBhoj0cO2b3pts40ATff/XFdTm9eVpOrZ+izmG71mK9AegBBOJv1DPEmKnHx7zOaI8R6zRE2wyFAHzQHRCYg3VF8Ajkds6dOS+ff/qF3L//wLkO5JKct8heQl+IcDI7C6y7fI2Ru3kyKMbvXwhcMcCEeyILuLDA85AFRF06QKdBM8jZrbIpqEd8hsUb+n4CzowJdCDQ6h7PlPnQao7tNADMDgQ5rqQZPwOCSSabERZwel60JQA19TqXlycWdd/XsX/auPpNAOOnce+Yl+wyB4CzC2k/0A7GMLjBO/YzA9hEoRqAmjDcdxK2wd8mEXswTqIB6D1MVuy95bFNds1a7fwpHtC0ifQZz8/7sZybqE9MXvY3JhsbsK9dfU3Onj5NTS7IhAAIFaIcgQp04Uwfjp/ncnExn48LEQxlQaIBOK4vqEeN4jQT6KV4o89TevCxCQ1i1GD/TE6CWnduojDAgvNhXzXFAfwhoEGd2nE/mEAVWIw4EXb76m8E07CZxYCHwCAlpmfto8pUOv9CpgxzOl9ZoAc6W+jNcOSHA79GtY7oR9as1XmN4YDiXHG305bDvX1+TpAXa6YVTv5g/BzwgwiwbeICCaC/Bj9NABaYKGH6hRgyIla//vrrYKm8ECBgAe2Ke0dz2LOjTK6ZzRXYA1DjO7yaC4DdW6In5urfb5+JzjWjD/r910Ae28H1QXwGIIDP8ArfNzBsdr2oF5yf9ReGbH90mEqlAsaM+9G0WW/J/vY+66KUL0i/C93FkEAOPpPqLRgh+XIw7I+CAOKVyGzDiO04LuULGATo5sBgXWjzxSHbo1FrypNH29KqteJ8rhijnjFeIJVebzhgesFOD3metT/g1ThARsuTC3QBRKGZhAcWRY+zsL+xn+XGAK5YLlCvEPvDDxAmZrQt+qJfl2YGJgAslyTMI9sIk+/w0e8O+tLqdvg5rmn/8FCeICIe/rC2b+SYeM9gYdfhu2WkXTl8k3N6MWf9xM8FbLIzGp2s/evKlSuahcb1RVu02PhkwUJpa8HTjr/pVHXpbVp/Punxn2V8Pu43/jbNBO9/rrI/+mzb82HPtT3nyAVt9ewv7P1APHO50fbD6kmFBY6thO9xmQPA40oqcjDtEzYvL7eYuc0fZO1vTCSrS8ty+vRWwsRhYPAzf5gv8IkZQJf+zf/ML1ksg58YHoAAE74NSgZSmJfXycRg8rfsBul+xPcR5DUQyAFRZnWmpyN9QVNQ+edOD/g2MBqToZ8pk2MsD18Z+amvPTBCyMsbwqTe4D0w7Va7S8aJ0jT9EQEKAz1g+nXA77gBRHPOuuhR5JJlOi+V+kA9IVCmJ4jkhF/i2O/K2lHvcazxpwM9slAoi5Vm6p52gj3JBGbnTrOLxlSp/+W4f/p90NrUfqtzkgIMmBa1LpGCDKZz1fmDnySZwxjixQDQ1t9Qj/jM1SelzJnwLxFEZ6wTLMS9oXQ78PmDZuCAbXpQa7DuyKgqmHNSxHqf7Bv4JFIgaP3E9E+TV5c/GR3D9CfH96eMLUE7mUQHKnnkoxI7AFEWFGUMIEqy+Ol2k2dJZWW0r6Sfzyzfv5OW9LPjb7rg0Dq0duNibHmZAVz+82htb2NWWlJoXl5u+SZYx+9amQPA2UXHO9er0v4m6YEoazJ+geVoGoOn+/5ZS3oV9ULPE08vEytIWxUaiDKQA3PMmTNnJwZo338ny5xnjKqL5k2ifHkeRP2Gmt/XZwecn5oXNTxmGmwFi3Ps7OyQDbIJACCHANGLZAXLhQ0gEOK8FqHLayB7h4hIZWUIIsKAacPgA6irX8iIjAioXB06uytzeaisRzyg/xXTvvHAiPZ0vl5gfQS6iF1M+nGn31HVwCiSerMhdSejw1zKnjkOGybkQa8nI4jwjrTOmd0tiUHOGlTGMioAOWAD282mtBoN2X6yHfd6PTJJY8YPdeU06pxEjAECAyEdMIoDZdrSuZ4nIzmPBv9kfTarWF9LP9+Y33s91IEG4MBcaPt6fmTszINhL4a/nI0fqLt6/ZBAGHWKV2jcmRkZOnh+//e4/onnDyBQA37AugYSD8AACqOAu62u1OtNTd93UI93d3fZ7RFQRPMszL+pjBEaJOTyAzsdQGg3JttI2z2Oh2QUyah5YMuYN/RZLjyYtQFgEwuO8ZhogJai0OVyIp/EynGAjxHf7XbyLCFXMN4by5MV7esvqNJAMAsUzgJ/1q+gqYgFB4o9E4tLSww6M3BvINVSU6YDlObl5ZaJ55v9bB4FfJIyB4BPWab5mzzr5DIvs4tNvP5Aa6Z2sA/wxQEIhKnVJl0DBdoO2TmcZ21Zfn7TooBNj8+EYSHpAQBoMiV0FAdS8AAgmD9sfgSksTE8LhhAON8jSCNWIGuyMVYn6p90FODa/RHoOf8t6P7hb+P8NNJTJ3SYiOFriO/zhYgTbK2p14+sJGRhOm2yVZ2WglljNnKWR+oExWf1jNnBufb3dxNzrS6o1KyTpPiiWLHySL7wLphK31fLB4H+ZG7n9q8h67NZDGKWj6CdC0ybmavsmm2fbq/L+0QhGBx0CcztvlCnrItej/0XDJdFvyasow/Oktfx9bGfO2xvKc0ULKupnNHnLlgK4N58QIEZsaiYeDacmLj6h2qtkwWDeXhkvplofwV2WEj4DKAG7AAE4hkBwHTg2ZmZrY8jYZexmGAA8SwkLKCLwEcxFwMDVPADxP34jKr/PJseYJpVT7ODWWNBuq/6bY42BLg3cyRNkrkcF3HWn02v0heVns8B30zJrGciwHk5rsyFoF9Ceckg8Ju2O39T5/MS+4yLBXOg2IRuvjlIhYbgD2ic1Q4144b5SCGN00T4sktzgBRXFBVB5gmX4cGxMlDVo8+fmxTI1uB9Fgg0LUDnI4gJIcYku729k7AUNoEZu2Zmakx2Nqn5E6g/WSrTpSCWEzInt7E5kfMvnPfjYTAahTJCxCwnNFyj7m/Hheqwsn7O/AvwNxzEnMRDcDx9gkAAgm6/S2CCoAMsD31zba8P3yZl4TRw2ksv55ijJLMavzs6sQKEYk/4HSLFmYGgojPfEyzbvg78G9jCuW2yxvUY+As8hi4N8qY9g5NgeXaZPK6asQ2M4moRNR0vwq+vQpkXpk1zwT/dLhgsRjMjCp33CgCUh7m93dC+PAD714oh+9MfDLCrE5fOqTilM+tmFfiO0qysdJ3EWDzEgUBzutsfSq3ZktXRUPrQa4Rv4mgUI6p8SHFIe+DAvE1yAa4VqBuICGzVCWTaQcA6tFM84sOTd/qaKj8+uTBW4KibW6D45nV0UwiiFwuMesczEpjZH3EuwwHzvmJBhL4JAFtr1JJ83q4B9ZlELmg+D2O/Pj9IZFpJf59eAPj9iuDY+XgCuMJ/EQVtagE2aHPW39z8+ycEfzTwwH1/boM/pswZwKcsWQzBrP3m5enqM6t+x75gOiBjRW4BA5cuXdKO7A34BAtgyByY8stU5s+bvLKifdN/22YRvRYhCDOVmYTNGdzYP2O2fL+npA6G6m9EpsjPaEGGEH+BtZlkIJPfO98530yZmA6p84ZzONZvqAwOgBiYQYABMEKQ6qD0x2AgtUZdms06WaNmq8n7MobVZ8EGAGYzW9d8yCbb1GfTfJO9z+Ql6fs8ttOYNhRcjwkx232nGT//72mfnWTz69M37+r3gRzW6gzKQVS3AXRj+LCNGU2Y07tMjzYcDaTZbkij05DD+oEcNg4B/rQfE2IBHAEIedcdahS3bWOTqhP/hv6iQ+BWX2zDZlMazYb00e7xKDFjsl4zmLSsMYx/J/6A6NMjCc1FIXGf8OvX+er6uVt98DcaH9uypvhBE5PAX/3uUO+Hh7VkUcWEMVOY+2nPeboP+J9n9dME6LvrsGce7bm+vpawgHbeCWZ2Xl65eXleJsucATy2jHtTekBkFFJq5fwSO2LCrZzw81etHHedmZVlk4E/eFu0F8SfsVnQBQAXog3ZNjRbTfr28CQaPU2uSjN/Of8/9f3zJ5MkQthN4IlfoM8Mwn/NZCxgnjIxYDMdWQCITRCWRsyCQIyF9MGQAR7+Bim0HOvkm3mtkI0kQ4SJaiwvYpGRNKc5M7gCYjUC64QO8+9QfcIAHAKcMyb4a3dFClKQ1m5NGnt1puQicHAMnrJ+zrE/kcackkrNgCCuim6IOoniGvKFPLlD1CNNwVEhwDUOBgO+x2RvUbU2GeN3ZCThi0hfyMmIyCMdywvm8D87SUmAeBJpOAaA6rMmsr9/oCxQZUHCELltUY8Rwdf+nuZ/JqmlzDGZQAOTkAuCmPbe/n6A6Fy0hQKzUZxP3Pwsnd/4ulibKWDDOqU5mJ2Gke996C/CDBxZDmo9XhgF0kcatQAp7UIvjSCCcdwYR9AJZlHBn/qP+pkxnboBfFTBPJrvHIChuz79jbHZKYAVox7Gz4S5OOj3oyQ/MNOw5TTnNp4vW2Al/cvqAXlJ+IxqXziO/fPbOL04sWfdFnjaD7sc7w38Ly+vyMbGBgOZ0osva+N5efkl61lmH54DwWPLHAAeUxKJAadDZp3NQtD9CW++8njxxQeAHhjjoAzwV16oUrYEQAlgBuIuZEfQTJi74JgPgOQmtTAj+jftI5TlMzSNTcBkADCH0m43nb+QRRCav5ybUDlRRgzmyBfh+F6U/sCZxTDFAvjAPOdHnOLi+0OateOemtMYBOJSdakPoovk5ITM3CDMOoGCgBKY5+j35Rggdf7X7K+wBOaiAv28YGoLchHZwG6zLYW4IPXDA0663WaHgs8AGIhSzeH4rN8hcSDBXcaAa2wW65/agHiBSDCAwkBy5YKMkMWOYCCm3yHrOw6Z4WI4GMkAmTAQiTzUEJdBDDNchwBGrTxeoAtBb+zoIZd7l6/QJAEqcu+dDTFtJTryDLOtlYVN2GW0zxCASrUbGc07hFkwz9OxjYIco3AP9gBYkHEDwRHaJpRIwU+jWPb2dqTf6TNYA4E1aDdcE9kvsGy47uTi7F7c34gBRswE8jabOZ5JhtUfUPMNK4AiAARrnC9I1M2xXzCiNqf3DPcH12K6IKEFX+vNIsf1W2dWdVbn0XAkUahi5IwJx4eDQMIhYpPHkctWt2AcQwSruD6PPWA297U0FYihwVUXEtcJllDN6spE2zXEJ4wCngbG0mywjev2DNuxNBq4y7zKQU/fA7QiEjjIKZhX4O9ySrocymhxywBtThH2/kUUO+63t9j4aDXj+h367wz87Odxn5dnL3MT8HEFk1aoq758FNJRHj5UhRyi37QX2orUIsAski8NNOyz9EpxlpRF1hX5bJnpAc4yX82+vePNX7PKcMY/dTZ3QrNhHLgtti0I4jiK8lLIaQaDYr4k1fICxYUxkeA9XiGAC/kRgAL6WznNuTNnz0mr0xQphtLDxFTMy16tLn2Apigv3dFIegAQcIxHmvs4IEjEBgMoFHUTk5PRhal6yTAdUQfNvh8L66omXLvXlcpiVYJcKPV2XeJRD6KE1CwDCCqUy7K4vCwFCECHOeqmjVwwBgBYp9uV/b09KQIg5vKSiwNZLJalXatL82Df8TPw2etId9SSjnSkF/WkFw3jfjCI+0FfOqOetAcdbvVWXZq9Du+ZA2oER0JqqAVI2hpFhUDifJAvVoJWpxcgB/HaqQ15uPdY7u7el532gbRGXRnm4WcIxnMgneZQRq1Yon5OokHkIk+RESOWQR/mdwWzBJswNQLMICo0CqUX92UYiuQrJSksVmT1zHo8KoZxL+5Tb7FaqsblsBzHnVgGzaEMWjgenj/4ffakVCmyzevtmgShBq4gGliFoRUgoS0sF20S+ewYLHsPkEigiBnabZA/GTe05lCGRAvaQfNLAzKPpNWs87XXgV9kSw5qu9Lu1qW0WJKl9WWJCo4lGorsbx9Ic78tK4sbEo5y0mp3486gH++2DuJTl7biSqUcdxqtuF2vxbkwiPMYV0KRXBQEw1HfUaZO8gX+nYRVeUpDc/AeDaSYx2+QRq0tw0FHJEDUeV9yBdzvQBrNQymWNPMMsrk02h34Fki+SB1KEIJU8MY9YePfqBsZAWTHQ6RvUQdUGQYhstXFCG3pgw2MhKAIcG/UjSXs5yXs5kS6kUSjgoSjvJRLizxyE367xULC9EHWCPWcK+RlcXlJytUKFwUAyMgkgutApHQIHUIsXkZ9adQPpd1syPLi0pEArfGmjK2v0eovIi2gKg06jfnzRd1RbFFnAtoGCCkHs74i65vrclA/EKyJygtlOWwcSHfQ5XvUGfIbd+H7icVYlJcemNlhzEUgh5zR5EbdUrelv5vYz91TlNoMcnOJwEXX9O3554fZG32PZ2wYhlz+Ig2CC6H3iYWo9i1svUGXPsP427fmjJzGK+oCAWl4OqAwAPcf/E1/4jlQnFnmAHBWcZ1nvtp4ecX33wKT4qv9W8J1i5S1QRumNbBuyDpA1szbYFYy8MGxwQRtPXMR7WAzzENPa7pJgDzvxdznHYtnExQS3uPvnBOedkylmhLHTCdEbuutpkYWY5qPCsqKDYbS63YIOsCKaDaPEXO4Dukbhlfhhr99XzFf1sNe9RqVfYEGXRs2Xwkpynv+0nmptRsMTuiFQxlAF47nQc5Y5+sEcI1sFW6ZDnAyrmM9NpJUwBo56DTZHuWlipQqZR3Y86EE+UiWN5Z5D7wuTNZgREeBdOod6bZ70mn1yAIi2rbnfAB7/Q795zDJwqdOTXI6MTN4gnVpwrxe7KzzTbP3PneSXuz479Omd5yP0b2BM2+KavrhvEjZp0wPXBFEdvcOpVZryaALADGUfKko+XJBBsFQVjfX5dLli/x9uVIkwAEjiOsCqKpWy2RKNXRmHIiRLCDRvfKRtPtgntsS5WLJwaIO4DboSqOFiFlErrbktauvyeraMhcoxUJZBkP1HZxe/Hry+lJqY0S5iSDDjxXyM+0BWcB8WJAQQDXMSavZ5nOIvgNfxHEdq4SO77tngSIE86M+N+ux9At1780H1nW8qc/mSU3Bftv7vnyTLiRjjUIE7aytrlLKBii63++xTmCdKJY1yh/gj/6+eQ0KwzgA1QJ8D9H45ynfjXlp8jlM3EvoTjI9mNJkp5L3aUsNGMW5Cf7YMgeAxxS1Msyg41Is0TfgiJrW4Usvu161MvP6MJiaL5c/oKd1tExAGAWRdqdOnZLNzc0jaZwSORD6AE5M3Cb5Rz0/YzSSL53+nyP5Er0/98PklRmDXc5dzxeQGR6gFea7CHDS8MzWBmAT0VvcV29IxpMZIJxZCXIXmGAwcVAfDdkTIObbakqz3SKbR501u1i93kTPMNFyO0GHMAd7LKN7vQ4zibz73rvUOGt3uxSJhnkTW7ffIUMj+ZFIHmBzKAMCUQUoYNCwjaKhAkYNNZGlM5uSLxWk3jiE/VhK5TIB/KWLl+T0mTO6ivcc7WHHhl8VUs+B9QNTgbzD+ByAmBp37R5174yVyXoOffYn6Ywz3qdfrY39LA8o6IcAfAZYB72+7GzvEAAtLi6rHh+AwlBoPoefnwbQjOsdZlmAvh/+9IeSK+WhyigxwDKiI3ISd4bduBcP4jhSCR+msQFrGUkMbEmLtjEkyO2bCyVXKtLNAOAS2ThyRQCQLkHHD957T1ZWVshSw/d0OBjoc3DCkohzZhREkA+csLQGDtUTH0nr+wZ2TB7JD5ZBsf18Rg4V5meHwEZfPCetY8+RD+7Sf0/7Lqsv+J/5QtB2DYk+oPMDxSLgzNmz9AM0NxCcw6L8faYQ3+N60e7oOyj2m3mZ2e8yP59l5qdzgCWVmTsCzixzAPiCiz/xzMvxxXT0LD2aMX9mdrFoT7xiErEE7AAo9tssPby0WT3p8Cltv3SZFjU4dbBx0bimvWZMhs8a2H7pSc7Aqu0PJq6UL0mtphG4pWpFcgU1meEeLK2cgWUwK+6uZJQKRkp8xVwOYPJHiaklIe6StHqQtDBm69y5c/Krv/yVlMpFAx0SR2AABzKIwAiOZJQfSVCIZRD0ZUj2ceBYQnuF2VfdANY21yUqgZocyOLKIt3xcsVIfvGLXxCUmFM97oc+TXD2r9WkXW9Itw2zZiytZkf6XY1epbh2pzsBzqytvSCdVIq/2RIxWSDQTIK+Q7+1NYAUTFAAf8iIsvtkV7rtrlRKSGVnGWliAtXbX9/mpG/BBH5083sfvC+vvfEa/cgA2ta2Vgnc+nFX6p2aBDBjIxokN0q2IBpJGI0kzgXSHfUkLEZSWihLVMzRxI62LS6UZGFxkeDwtdevyOXXrrDl8SwZcKKV9zlKoimILDIAO/FA6s2aZuygj6SyYagLMPu2+LF6nfVsJAspV0/WnhwbXBRz1vNrxzvOp/e4RUF6LPGj0vlcp3wGseF7E0y38QrtjXv3o8FNS9Dyf8/L05VZbO7kd/MgnOPKPAjkOYvvz2dmvJfMAqajaTP1816BcqLrgZ8WTF2oK0SfYoDFythWxxgw4buEARWDJv4eDs/KxQvnkihE2nrdpo7mY9+ZZPIG8wetPEeUMTg1uUQCB9P/m4j2Pc6Z3AAg/M4MzBlI8CeKNCgxdsHMYAALmCxw3wweOKjJ6ullZRPgq9WOpN3pSaPVkZXhSHLFnPrz0RqmwUhg/lwsrguCOYF7eIDr6ElUyGsO635Hgq7IX/71X8qXX30pX37+BYMu6D5YyfFvmOC6w4F0kcItFx3t62An4feJIIZCTnYPtwki185sSaFckGFvIJcvXZZ333+H+Yx7mByHozgXadwr/Hi6rba0mi3pIPtIqytNRn8OGDDRqrfom8dcxxnp8HzmyRePnjb5Z7+6W0ll+7G25cKkC99N5E9GCsCWNJptKebyzO3bHXVoFoT5+ssvr8v7jz6Q19evyrA7lCgXUj4EvpHry8vy7//D38qT7W15eP+RFIoFaQ/bsrC6QPDIsAnnhzxRz4xziaUb96VcKosUEbzTkRHkG+GDiL436Mvm1in5i7/8FYMVXFq1eIR85VHO6WCqqSwJ5PYe3Ni7cWP/Jphl9jFNIYffApxh8dLuNCVwYtHFSl66bQU8ZRf1nhzWGyctQv6IWdeZYa09LSo80yw4JXVjGsTPWgSkP7Pczz4T6N8DmdxymXqkPstrZmKwwCbwrQLwlSSHMABiuZg/EuwQP8Ug+l2HOOk2yQLyL9ni9p0ucwD4gsq8Qz5bYT7f1VUOkjCXgdm7du0aM3xYvS4tLfEBt1UzJoKV1VW+p/BzFgvowN+0gcE3P2Ulk59mAk6/2sRlYrcm8GzsgG+B8P2c9DpxbjV1W9CAHfvhgweysrXCYJAyWaWQ5tBGvc77rpYW6Ts1bYqwSYWRkqHPBk7+BJMR6h7O+WBgB40htQwvnr8gP/3ZT+XevTuy1+nQpywHlqqseYGHCPooKJghGGG0tTswhI9hnkRWiHIg7UFLltdXySbuHuzIT/7sp/K//F//V/pwDhBcQaNNKHkE1LQHcrBfk163L/XDmgy6PWkDbHX6kkO0K3whO11NOYa6dA6Nfnum29nqPm3a9b/3/9bXyWOZS4IBEWN5FhaWJALjNxzJ4d6hLCxXGKCwe9inPAqCGQ73a3L31m05f+UMo6dHkHsphNJpd2S3dyA//tmP5avrX8rf/5//IDXce9CTjfVNadYb0mvD9A2Bc8c8Oed/5upFvRdCGeZFev02o6JLi2UJCqH0GRSTl5/82U/kx3/2EymUCsyeUiiqCRbgmaLUCYv89CWJPHZsNp5f+DCif6oUkUipUJTD2j6ZPAAggNDJhfK4PZI0ctaOBk49gIioY5NE8k3DPOYJnuWstj7OJSDNAA7dmIO4ItwP2PPLly+7536coo7uCQPtl3BpuHv3rjQaTT5z2Oag5fkKx9EMZt8L2XvOM3z3yxwAPmfJeohf8oMdHMME/qnLU928Da54Bfh79913Ke+Cz4rFAgdM1Gc+D3ag6nzj8rKzsy2dXpfgMPH7c1tMQdwj6dHIeKhcilEX8XjCcTt6TOBME7CRIthZI4F1/7SYrf97P2JRB62RRNAV6451/7ABCN29e18uvXFV8wY3ypQHQa7Yw0OYhztSWqw6KRD4SVLygycbQeeNJ3SagE6GRS/iaNNo+i3o8HXIxILwQjQtfMd+8O7bcv/+n8knH30it76+KcPBUIIiAlpEIFJXKFBUTkEuggqcyRsCxpCTCXOhFCoFWShVaZ7s9Nty+cJV+fXf/Fp+8O67FECG2RDR3gz4iSOpQ0x7Z0d6nZ7UG01ptzvSrNWl1+6QWSMDBADo9Nj8tH9+myX+hOPGmmjHpG2C2Uygfwzte6pXZ75c5XJVGH8Yh7K/uydRIZKF8oLs7u8hyNyZg/vy1Zdfy+W3rsjZS6elwfSAKmXS6rTZ73/+q1+wsX7/uz/IvTt3aUqPigElU0jnIssH+vVgvLBhkyN6uQBTc0ekEDDQpi9DqS5W5K133pI//8tfCiK7TTsT7evuCdHsmkXEK+ZHai5/9v64ZxhA6GB/X/Z3d2kWrxYWKA+DBdGTB4+5XzFfkGazwc8QCMJngCLWLprVMwFrRwrp/+oDwB4ivj3/vJOagLPKrMWhbZaJyE87aL7IwSBQn8e2+vQpezk5BkSlvJze2uL3YAo//fRz12/KBI7dZuO46p2XGe2V5dqhf4x7w7wCp5c5AHzBZU5JP10Bo2dBIK+99pq8/fbbUq/XuFqGfxi+x4CJFTMGWAy4+Ayv1erCRLaANAvo++BlrfKTjAsZ13XSqEGf1UM5MolNyTWcXAc8qLx8xygAezs7e9JpdqS0VJZSoUTmqNVpSbsO86j6nYWldDzQZEn0EHkd2ZMdTLqYiOrQsnOmNQAS1Pn65pr8x//t/0IzPeQ4Dvb2lYmCXyBjEvIMgmDkrkvDxRyyuUiiPKR4QslX81KpVqXeqsm5i+flv/yX/yLv/OAHsrO3rSxIT1lIZMYAmwdzb/2gzvvD341aneZwpqeDXmGvz7anr2i/oxIwnv+f71+Z5SeWxRSmJxafAUxnLbFjmr/kqD+QEJIxuRx9vSBnAh8+MD8g15r1lkhxJHdu3aWJ97VrV6TTb1IKZGGxKr2oL/VWQ956520CNZjOIXOz82SX8etRGdoXqOORqrsQ82vKPPadXCxSgP5eKLl8TnUVB13ZOn9afv0//1quvfm61GqHbEPUM5jcVErDZy+4b3CRQ2FgRr3ekEZNI9jzxZzkoRcZhtJutNlf8GyYpp/lOaa7QMqNhhv77/ga0wE+1h5wkZxVTgIEM28tldHDfBcTth7f9+G20mT6xHEWEA1Yw7nQPw4PNK/22bNn5c033uAa6YsvviBbigUFdRyfsfq/D+U4864/36YX3XP+7/gyB4AzivanUdzv96niPxwi76o64OPhZfQkzFJemip8BqFQ2w9CxL7fF/6pT8qkvMRJTFRZzN9xg9pxbORz/F6JJhcR6+/vr8Z8c6iZeMyEw4lg1Je/+ou/lN/97neydXqTrNN//a//lRGSyyuLUuBEj2wFWnL5RYGe7tJyVfb2dxiRF6EdECnaBRgYnxtt4bMECWvi4mcZWMk8osi4oZk+/Pr1Wbv0ZGmZQuzejKGwgcj+9iONDRwmYsIxZEMUAJtZGKLMMMXWt2ucKP7ir38pxago1VKVbCiAwdbOoWxubVFiQ+k4RIq6VGXx0DE76ujovLuOjIYx1KAVfAaI1i0U8wFAGDS4mPEgF8b9YV+WV5flV3/9KwKbf/u3f5E7N29pIEEQkuGiNmNHzZTI5wtIzewi+ZCSL81ui3rJH/zoh/Lv//av5Z133iGr0+vp9ZaiokRDof5jbRtahw0JhyKPHz2RXrNL0DTqaqQyzItoq+pCOckOQjFjV/cofsBAlhk/3a/T/Tv5DdlVfUYt2AQLD2s7MDgAfKtLq7K4CCmdHiU/Hj16JOun1uXUxim5v/OAItcAgtCv/Pj3n8qZc6fk4mvnpTfsEqErkO3LYaMmW1un5D//3/6znD9/Xv7uv/03+fDDD2VheU1qB4fS6ytwKpSLynrCv4xYEJHYAykvVzTSvJyXD979QP7dv/9ref9H70u9UaO/qAVpWJ8FkMZrFIWJtLT69Snzl2TMiePYl2OC36L15ZHzecMCoHZQk1s3btFkjUAmvF6+dEUa+01pN1uysbbBwJ0E0CGgA5l7iuN0iPbc4D7J5luuZxdNi8+b9WYS/GXtk7D/GF+dDJPvi5sel/y29mWopgWO4bwWvTwOwAql0+9oasewqNfMcSBK/sZzXK0syv3797n/Bx98INs70Pgs8v3f//3fSy5UFxcASSxs4OOMugHDDJM57mtW/4Ww/aziL4KzynFrgJNas7Lq9iTFxkP72w9MYhuGWu8oaINuX4Xy4WBAFwC3gPDn0bGouV7ZiS7ke1rmAPA5y9yPY3YxGQSwTOb4jL/B7mEV/B//l/8oFy5c4CCJiWZnZ4cPMQZP7GNA0eqawM5NEFDmb7Vbkot0goMMy4RcwwvOx5kVAOKvPgGebKK0bfY14DoxsWFBoRORsgIKDB49eCSPHz6hP9hGbYcCz5j4H919ImfPnZPFyoIU8liEjLM4MC8sIzPVJDsRbRk/fV+GhAkCCf6n//k/yNXXL8lv/+238tmnn8rjx4+l02xJtbwoBUi/uEG820cuY/jrIcPHSK5euyw///kv5C/+4pdyamsryaXLybc/YhALQGS/0ZXDnQM52D5QDUAwgYc1Mmxgvyj66jJJQHsPgAuBN+n2SDM+PjOQFQTwXI4TwYhacIVBSXKiExX6cLvVpWZiISowGCQcRdJqN+Tuzdvy5cdfyfLykiyvLVAkZzAayNLiIuuv1lSJFgDucxfPyccffSz/9I//KFE+IMBin0Y+53AgQQEEayghAEkpJ6e2Tsm1N16X9977QK5euyJrGxvS63dVQsYJWI+FMVKLzlQgzZHbnOEOAfDXarRl9+Ge1PbrZDwLg6JU80X9/MkO+x38N60NsOgDkDQwmj7m+OC6gDQAZgut9HXO8v086efTyqS/4qREjFkuFpYWZHFhwd2fjgFJ/vJqkIx7N65f5ysY9o31dfre3vjqS9nd3aWrBwJJ4H+LMRPjn89sZzHX34cyn19fbpkDwNkFMaGJoqRJrmWZjNLP5ixTsG9i+haVtM/htO+PFLAlGOxw39DMwiCHweyv//qv5Yc//CFNJVgFAxA+uH8/AYwIDvEZPGMDMEnieAeHyArQTkCXv4o3IJj4NDnhWt6Ai/ZN+LHJyW3C7Wma6SgLDOZz+UT/K/FZconrp/0evneoHxUyht5dh99VKxV59PCR3Lt9Wz74+Y9kZXFN9mqH0hjUZef+thw8rsnK0qrkVwB+3f2NQ1e1rxIGMiaY9zWx2LdUaEkKMQVDygy6XJoibBcTWr546ZKcO39e/vJXv5TPPv1MvvrqK2r1DXtDskusqyiUcqkoG6c2qdP49jtvy7kLF2S5uiwHhwf0XyQzUq5IHAXKcAwi6TZ6UtutS2O/Ie1mh1uj1mAGjtFABYGR7YPXNoIodJdBDzAk+veV9t+c5aM707x0QqAAzbt8scA2hEB3pxOo5EcRIt55zQgBpnQQyOOHO/Lxh5/J2XOnZWnxDZpJBzIIABBgZWDkKHQSCyW5dPUSmcSNjTV58uSJPHrwWA5rh9KqK1MEthvm08W1Fdk6fYbM6pvvvClnzp1jGzSaDdk72GVdWxIy7RHj1ISuDmKITWfUlVpoU36rBmxYIEcpOWnXuvLg9gOyfXFnJMVcQZYry9KutXjdlXwpMZsb0039yYIyZem2S67FgR4DgLaYTFwl0M8zGLJsk/7011n9w67Xzp1E945GGoQWx3J++RwXN3ov46hjsoujQHb39ji2IcsPQCN0PvFs/NVf/ZUUcpF89tlnKm3kFkbpa3uZ4O9VAVhZCzT/u6e4zql6lfNytMwB4AlK2vdkcpMTl/RD/X0oxoJh0sIACjMaVrsXL16UX/7yl7J/sJsAQmpm1esEfzCFIBJ46DEFpmGGSc1AlrFAaZmHtFlgVjkp65G1TZiv8goAbVI7ztdM77krUR/spcvQMIAfXiAL5Qon2Du37snrb74p1eKClIKSDKQn7WFHtu9vUwx7YbHCqFtlcTQ7iJq0wfkgaGDMQOKvxMTCNYgfpTypmZekwPa00DDvwjT/2rXX5eLlC/JX7V/RtJnIY7h8uQiEAHBcrC7xRI1WQx48ecCoZbQt2rDZbMmwM5LV0qp0DtpyuFOTTq0tg/ZQOo2ONA4bBPkM8BkomGfWDbCkwx43CBDr9U5KtWTV+xH/oBf0/OHekD0F0b6AogNE1rZbUooL1PbDPSN4A2ZRsJnbDx/Ll5/dkFOb63Lm4hkmdINmHuRjIMWD9j883Ke8ztLKovzsL39OUzPY0G4Xvp8wiyJNGNixQKqLC7KwvCALEKCOhP5+AJ3IPKHgHQELk0yogSvmcs6QrcpiUv2F1dgfLpZoEEh9tyYP7z4ic5uXgpRzJW4Pdx9Kp96S1a0lRkmDoUemmxGkhBClzGwpOGeYeW5rJ1vgmWi5mfu534xnO+2OkvWa3j/9tz3L9hzQxceNVfDJZTq41VUubHXRObYIYB9ksAHja/qPKBgLAeoxjr3//vsc637zm9/QCgK5HgsyYoaRZzStfpvKNALFf53126kA+Xsyxz5PmQPA6cW0xH0R/CTnrpXkvccuTXye8fcsduIlMnTPW9LHPZH+IO4Rq19GvHW7NHf86le/kp/+9Kc09967f0daLUTFlbjBjIqJiwBiceEIAMTgiIGxDdMv2QD1ZTIAyLr2pGEwkTIFlQ3oNmfA+TrD9OWtHhMfyymmxSRK0toU4M+ErJN29sxG6b7DhCSMuMX+I4IIMDvwJSuVVmlWun/3vty6flMuXbskG8urEjREwl4oj+88lnPnTsvaxrLkKlHi98L7phIL8rZavxyZbFwClkIVRYQRGrZiKgkCeCYkosvQiUyx0G9DPYKtNF8lpDxDGxUKyoKQKYI5mmZgMFo9eXzwGHpz1MuLIrTbAgMmOi3I94iUCxUZtPuy82hXtu8/kW6jK4M2mMBDOdjZpxmYko7O9ElAGw+kP8KmdQYZnSxQ/k0U6vAhLV0X8ip5ifIFAj7zS8S1FcAC9rp0U1ioLEmv2ZIvPvlcTm+s0cUhLoykVCmxT0LgGD59ZO2Qwq3X1gXPAiJGIZJe1DzZxO56r8jQAjeCvgGsEEE1eRdc4aVcY8JfvtORzYt+VocBY4vHqYYI/OAn6vzq6F+HFNJ5ZeHieCC7j3bl4a0n8uTutvQbfakGFZq8wf7tPd6VfJSTMhY28NmMh1J0fQQFqRvHgoLTi4EuFPpBIjuOsZLHmICzF+3T856nx2QDvja2mByQ+Z/CGoF2xPimz/3Y7YUR69FAtrZOUx8RgW0A8XB5AXv4hz/8Qd577wdy+eoVOazX6N+GZ5/RxGEgfWR4UY3SpFHsPe/7O4BvMufSie+m6+pqPRwF9mrCYfLs7x5afsFlDgCPKZPupLPTRqXLNOpaP/t+9E0za+CeYSa7cuUKV734+/MvPnUBEEJW0PKpYoDHwGpZBPyVuKVHw0RQLOSlmxtnVkDB/pRrcPlG4V92nAl3FgM4zffJ9zFTiQ01+eLazNTFgTzDd8h3TIf/nwJbTKjO1Ilk8f2+LFWX5MHDh3Lj+g258tpl2Tp1hqAjrsWyffBYdh7uytrZDVkINS8y0oDFQ5hVB5xswfCZCyCYP1p9p1o8LThm7JSPgnawoAMwTosLy4z8BEMBUxZYWkh6IGo3GOhkjesIcqFEELceDaWyuECJF7B+COzI5wuyUFmUaq4sOw92CRTqe3UZdIbSaXeldlCXdqOZ5PscJHU4VPDn2D8M/jmXRzaLlTUQnmYGj7Bh2RUiJy3ItVvP5ejwn8+X2Bc7/Z7kwIcVoRHYZfq6ItwUBrE8vvdQPvv4K5p4P/j5B9IZtKTb6TJATPsBBKThJzeQVlc19ciAMb1hm+kDwSyNhpCl0WAjBoBAzLuc5wIAYAILLjwnE/dpTJtbDEFXz3eNSPdzv7/65lhm52m05M7NuzT/tmsdyY9yUiqV6ReIvgEpn+XqEmWN2jCXukjxoQzYzSzfdRYYM3YvDfiooedl0Jg1xx/H/k1re/97P0DBWD1bXNqYhoWQmYfhaGFMJd1AogIZXOxL073z9UX9Ybtx44asr63RFQZj4D/8wz9wPxwTz9iEMHYqWHDW83zS8oJJiGcu04iR4wD6tGPNy8nKHAA+ZZnKAKYA3czJ5cV20mnMX/oEz4s4n+mCzWwCEAGZl1//+tcc1D/66KMEtGEQNb8ZqzfsY4PfOFXYGMzRORxgMNejHxAyH/hAy/axa/AvyR0jsz7SPoDus0yQMZknVp3VbYK0aEaZEmFoZg8d0IeSyxfICqj+YZFRmtBNw+Tw+OFjuXX9lly4dlGWFpdpMkSd7O8eyoO792Qz2JACIguhy2dZHY5ZaCjTCYSlSsq4MtaZYzSNCYXPHiREdEJTnz1cL66RmQ3KJQZ9AAQBdBD8AvwhCCafkyEihN21oD3AlAAAwnfz8aNH0nrUluZ+U3qtPmVv9nf2GfWK3L+QEOkj+CPx6YTeIwB/j36A1ETR7C6ZpkPrA9NMwy+iIMIWrA30C4MwJ9UwT1AaI9KdGTy0/zOncgeRoWXpjUQe3n8gv/u338v5K2djBHQUyyUp5AHyBgGiS8F5kk0eqq9f7BgzsLTQWSzlihJIUSollXZB32k0amTsYEoulkqytLRAEJGk/5sQyfXqaUq0dNYzZyAIAO/Rvcdy88YtefJoW0KB5EtecmFOBs2+7D3ZI/OHPmKLsnxJwSiYStQbA57cM+4vkJLiAB/GBwNUfMYKheTZSxwXpizonhb8Zf3OByaebzGvCddn0eH22fiS8F5Tv6EwB/OwzfcAf2B6EUyF38KMfPXqVb6/fv16EvzmB4L4JXn/HQA7NhamP0v/PY1Myaof9+VLuNrvVplLED1FORloQ2aE7GrVzmoDHF5PkKrrW14wIILZA1P0gx+8Qx8XrIjh3zXojxKRZ/jOWJQfpRWKygBiRa0TA1KL4YiQOlFna2Q6wACblmgh+xbocYxFsg1ZJyj/gu05MHGWqd8CP7hFylKqTobPbjjpH+fPppI4UHPJcWLABA75FNwrrv/8mbPUUfvyi6+k1+rKYnFRVsrLcm7jnAzrA9l5sCON3YaMOgPJDSPJcxIGCFHnfTsvpF4A3OzfKICMiB+hbFkd7DNlBNX0qLptlF5BFhAwe70hU9bt7xxIt9Fh1C/y4GKyBsBj/Yxi9WMaDGnODYcALgXJDUPp1zvSOmjIzt1tskfw/Wsc1GV3e0/qh4c8F8AerxzmX5dphZn/IDqNyxzRAJxp+k1PDFlM7rMBQmNKtcB3Dy4H3U6HYsxg5Wh6HQ74N8zm9O9DWwxG9ItcX9mUdrMnX3x2Xf6f//v/Rx4/3JNiVJbGYVO2H+/QTI6UYZY+jIFFEOsedNW8jmAY5FMuuChzpAaMCowm3lhbl6XqAoE6fWu9+vDb2iVQmUgXCJcEFYa2sUkZZHueAPLA8vaafTl8fCCPbj9h+zW3G5Ib5CU/zPF7yALhGQfgg+QPgkwAXumO4XJeUzvRt9I5+SYw9vrM4JmO6BdbyMM1RJ9ze7Z0yZItkXL0fk/YslN+4y8wDKgaw295lU3ayveXNMCIz3DtJh22ublB4Aiwl8upxeDevQdc9Lz77g8ohG9i0ccB1m//DJKh0+lula9u0WJb8vmUMq6n74eF7XnLnAGcXhAkGoTQyXLicr5swVjiQx/uXg9+W4Uk1RGFYEMMeIYB1EwTUg4BAwR827CittOlmUWZNrhN+N7NGOe433Fir+YTNvUg4/Nn+vwFnoo/HZ37/UTnCiAPZo24WJS//fW/lzeuvSGff/oJTYGlQoH7SwBn9RWp1xrM+rC6tkkABDYFDup4jfJ5abWbEuWhCyV0hI9yBX6HGQrnzlt70G/JHMRD6ASqpWSo3m6oceBHOOhrRETiHIikpmoy9ja1k+kGfS60H6I6R4M4GI3IYMQH9QPZqmzJ0uoKqwkAaGVllX1A4LPV7UlhMc+BC8LG8eYp1huYkEKxRKas0xtKubLoTH3IphEx0wnuD6Bh98mufPHHL+WNt9+QU9UtOagdylZ1KPdv36FOXr4fydU3X5OFpYrUew2yclExkgFDNdV8CuBMqRrUC1Kqoc/mC6yVpA/y7GOf1m6/66KoE8qSE3ME5g06dngdQVcO/mHCCR9+ejBfMjAE7kyjWIJRKOEwll67LZ16V3YePJK9e/uyff9AVstrzJF7/+5DefTgAc+bL+bJBGqyvLGIMIJOBKRipNprEM3GIkH9F30mS69/TChNsgQWEx2lfIjGz8V0/TXHh5GAhNQJ/NzCfCQD+EjWa1JdjBkZjDoulBdkMFQWtT+MZXf7QMrVkhSiEiOfb335QCqlz6UULsiZi6clnyvGCAKRlkh5sUhNRqTyA8NNfUVIHuUCpovrdWPJx8xDQt9DmHO7cCHAvY5imkrxrBjHq93cHuGRpgnEuKTPgfSdLyp8ORP2HQwkgEw/oHNA0A+k/qgudz69J7c+viW9nb5UhmWKdAPoHuwdypOHjyQsRBLnAukGfekhm0Ypkh7A8Qj+qTmaxPNhjtfQ60AoOmRdon3xPa4jnyvSVQDAswhZmbglqyvryVjDsY3tphlN7K02mUosoR118YD+iOhdZZL9BUV6rEubwNOuA742KAA6CscyEWm39xNASMA4CpyvYEWWl1flzp07MnCSRlgclasVaXd70mxtS66Qk1OntuT1N96U3f0D2T84kOXlRUoxARRibgGoxyKaddCF+4z5UY7752Q5GdP5/CX9nJzkN1jUIDAG46oCZww/eK4oXATxczyhA4z5WPTp+IzFA24LEkpwewADjoUMxmfsPxqOkJkyDrBqmgPBmWUOAJ+izKSbWWwidabHZJntFa64aXpzUZiTPh7ftjKR99ZSi7n6wWoXLAb8W+AIDQ0saPeZb9LS0iIzImCFHwRN1peKf6qju7rxIeuBOqOjujgJSugEnY+aZ/0VMwI/Iu87DDKRt+H90zpS2/HVz9iBCE8Y3PKd4nVpaZlBL7gNcxzHhAo/P9yMmos4fWsdmp6LiXXAHzKfp5M5TG7Xv7xBdg/p8k6vnpbwMJDD9oG0d5ty69NbBGSX37zCNGD10UBqh4dSqiIaVR0AcY3d7pCBGWBXYY7EZDQWX3V5UTxWKMu1QdvXOeWHSGaPCVWkCx3Gfo/SMhDnhqkO/mCIgCWAq/fkcHtfth/uyu79J7L/pCa5uCxf37gpDx48oAnTzGnIrgCGCzmAsRCAHAyZP9R5iLbLSxjnMjNB+P3gRZaJY8K/Evp2IUAoFgq6qENUd6+flygXMx1evbYnxUpZKtWSRKUSg2Pqhw0plIpSqhSlUWvLh7/7UGr7h/KjX/xIrr55iSCn1W1QUy/OjSRfijQHNnxEERXNoBiYxmPJhWUZUQNIGTvmZAbDi30klnyI59HJwDCWwHMLcGsgbGCFAWSjfER2sdeDpE2Hae4q+SrNyu3Dtuzc35XbX92R+9fvy+GjQyn1ipIPCzwv7qt+cKisfqkgkBjHqXWMAKjToY/AbYRnx6URdOMH2tjSreEYal4tysLCYgK41IVAGWltE+ePZ24WjmHPCrqyNswyL6bdM2zzRfx9cXG/j+F6zZxt14mvyP4BkKTGRizC0J6UkcEcAVATiuxs73O/S5cu8Zh/93d/x0U0nn+Y8nEcLKjNx1DHIPkWl+ksnfVL3CJaINnS95ukOnq648+LljkAPFHR8EjnF2Whwdl7vny/g+M47qflwE/qK5h5Y+a755tFbPA0Pb9f/OIXfL1x4zoHShtYy+WKYP2MlfDe3m4ysJnvi2XISGRGvEHZTC68YC/F2mjkOI4ME2C26c9C7GSm47F/PP/zSKIATEWn04kxYcEMh8TvGKghDfHgwX1ptduJADLAodN9k3yhNDGI++Yl32wE8zm+g0zEJ598wmjpa9fekM31TTno7cphJ6b5EBMzAPLZS2elvFKkdmB30HYDKTT6AonDIVlUYD1EGWJYdUm57CImOwM8AkmreILSJAJVf685hA5jSManMIpkMCqQaQGojchORRL1I+m1BrJ3/0Ae3n4kuw93pbUPLbtYGo1DuXX7NmUxliBnUq5IrQ69wJaTHYHP30iGPQSiYEIFOxoqsEdKOjCyU/wzX6QPbhaQQAHAQtALgAeDPzodAj/6TYZF7od+XCzl6S+Jy+u1W+wHYLS73Y7s7u/I3sG+tPst6Q078vpbV6SyUJFwGDJABMwHQR+ZLphBAToD6iginmKs5YiWZHI21YWkqVeBH4qTeJwA+zAVE9g4X0oyrnFAP0ZEMIdDbcNheyi7j/bkxhc35db127L7eI/mXlQDnvluqy0Hu6p3Z0FaZgLVZ8dF0XKxg3XvWFeQiyO6Foyze6BgEYXnyETjUSCpgmPDxGzm1jRoS4O/9POcbsdZv/V9k1HM7GvXadHAaE+CdKQpYpYKBYUwV5uEEqKzDUTivsznd+iynGDB1mk35dyZc/LOW2/LF599LrdufS2ryytUTMA++B3AYJwfOALh2fv0t7nMmn/VxYbCB9+fCnnGMgeAz1G0sx0f8PFdLv6ka4ObJUuHD8vPfvYz5sGE6WNnZ5eDOoAS2Ceu6JeWOKihMIeoi/rDwGo5X31hZ0v1leTj9EzQsybq9EA/rUz7vX+M5D2EnN3g3e2qbtfyyopEDx7wHmCqwf22nOM89sMrBnBMGCEm2CgV2ecxjD5QRV1CLwy+QV988SUB1tnLZ2VzdUtKnbLsHe7K/pN9abe7rLcrb12V9dNrNEUORl0yUzD30x8t59jATkcKMGElycDCpxpoAS6GcVdGo0jCgcsvCwARFWiqQeQv04Tt1WX7LqRedqS23ZBuYyCjbiTSjwlomdd5oSzVaoUBHpjccZ/GrCICGSbDEbXvcgw0QEAKU9GdQP7leYI/poEGvzgLqjJZiODudKWTC6UUBlJeKJMZBZMzwvtyif2k1WlzoSD5mAEbcFH4/NPP5aC+L7t7P5R3f/iWbJzZYGANjQUg5kINjFKXE2XoysVx+4ExVus97he+Z1iMjc2+ZAAtGtz5UiVm80AXG4N2l+egXmdhQYJRTlqHLXl0+5F8/fktuf3VbfYz6QZSzpWZyQW/Q3uhXzMww7FgJoysxRZrYQpwafYb+JMai2aLSPR5iMFj8QgGHMdE/m98B385Msz+c51yo/Hbato4kN4/KwjGX+BOpIUc6iIVz7JplKoJerxohf0SIBu+yqbrhw1C75oPWC0D5vuMOnz8+JGcPn1Gfv7zn8vBwV5Sr6Z/amLUHG+n+Ah+F+ejrIX51H3ZF77d/Og3UeYA8Jji97GTgoeTAI3nKMfp7x032z2rl2zmebOU/DE4GQD6yU9+wokKOVKNDQAQWlxcIhAEqDFnZ8u3ig0TCiZNf9BLq/Preyf5JFEAR/sR6Q9zvNTBm/vTgw1sSBDTpAwyieyFGsXoSeRGDLza5r/HYAtTk/r2qO0BmWGY+mkQc7W/vLQqpSLysgbu3io8+LDXkz5MV4MSAyiwlcrjSN00CLS6RF3YBGPR0pgQvr55U/YO9+Tt99+WYliSxcKidNo9aR105NHtbdbJ/u6BXH3zCs2lMB9CqqU3UKkR5BEuwdxHHTgrWf6gk5HUdp2AepRhQRRqvyvDbp97FsIcU6Dl4pwEw0hNvvd35fGtx9LY70rcDWXYCWT3cV12d7fl0cMnsrqxLItLi4wk3tvZZbsjSAZVzHRbnEzhswbTL6RfaAVONNGyGEC/Dqc+CE+ZYSHzeXZ9xMABmDpKH3XUbQE5kdElkfpsUFM3SpiEmde23ZB+ty8LiG4t5aTTaslXX1wX+JTu7+/JtR+8LtfeeYOMJ/i/ZqctrV6L5ykUSsyf3B92Jvz70AZgJK1PgYmyqyY4SZwn1BwMEEVPSDorq2wJ2i/EMwKB8lZX7l6/J5/9/jO5e/O+tA+6EvRDAn78JBeH0qw3EoYOzyulgCAvgzM4FxELwjKQlrD5o1iGPUSAt2TQ7ZFRhess2h6LlTOntvgKX8ZqqSzlYpELArqk+qLWqZIVET6L0c/qB1mRt/aZnw4OEftgpwcRGHW1TBh47HTaXBSATY0qoYwGWMx0ZXV5VSqlsrQEDHrFLZpHfN6xUK6US/LOO2+RAUSe9FK5QBF2jAXQC7WxctDvHt9Hv8XluLk0AxCaBYiS3Mc6QX7PyxwAnqAYyzf52Z/MBPxKFRNqTk+20LG6du0aX7/44gsnHlxOpBIAjsD8lSuVxO8Lm8kqYMWP36CYjIydzwZtA5QotlL301b5YMBej2MCp+0zbeVpvn0olgAevo3tjmp5wXx1H9HATiLF9vdN2irMe/Ra8RnqAPWBuksmnMGA7BEmXdTN2qk1WVlfl2KxIk/2HjOrRq8zkP2dQ2aMWN1ckfX1VamUdaIxs1+Yi6UXw2cPbFqoAMIxRvaKYAKmW0PgC6JEgRPoPwlgDCAMRgQmv5CTdx4+T90h04IhM8ST+9tS321I97An0g8EiSn2d+py6+Z9uX//tly4fF7KC5jY2vL4yRM53NvXoB4I4SISGC4DDvyhihDAQtOvF7VqAR0nBXPP8oxOf/65GOB14NqAwABWwQJSty8YsY/nitAAHGpKxBBpA3OyvLgiB7V9AvVSpSAr6ytSCPqss39q/kZu37vDVHtbF87ImXNnZXVhNUkZVggRBJNjVPAoHJso6UfK2DSXwUOXKerFQjFoz2+MoCwkeMHvSw5UYnlQP6jzuq5/el3uXocY+S3pHPZkIbeoWU1GMc3X3W5P05yBTS4U+Pzac5GOnPXbaNxWCphxXyagbos2jBFbLn80PkcOXQBnnAvBRrPYoJM+89N+b9dtz6ExdD4AZDR84tbRTa7TWFA8m61mR3r9HpnLglsc4/qZDrFaoRsG7gn9AhvGDNQD0schvdzbb79FWRg8hRZ4aAxpVoDS96XMBIRzzHfiMgeAz1leMtv3LOVpGb7n8iVUEWTtRjYoYUBDmrL33nuPvivYzKyEV5h1zKQJ5xgTUTXtK1PRB/jBMTGpYKA00wovKghowuTEogGqsQN/muU3CBK9v5RvmH04jSXQLLpezucpbZv82CL+MHDjHpeXVxhRiUEe5u/bt29LY2+Pk6b5AmJfmrxyhbFZyfNpIsCBTAyYP2juATzDnwz+g2AEnQnoxudfM3qyEOSlurooyyU4jHel3xhIK2jLF7//Uk6f35Te5b6sra3y+oDuAKjiIUxPGjzgSy34GwIbNFhGQ28YHe1ABD4fdnEsBGOEBIetdkdquwey+2BXGnsNaR5oyrdOcyDNWke2wQg+2WPWi7WNddk6c1oOazuMdITp1ybPHmRm2l0gCXeu8QQMJgnXMkr5/1m7ZjE7z/p8HmcCtswQBC2M6tfz0ber6wAqokWjIoHzoI0sJkMufhDtvrq8JvHBLtsVOoiFal6KuaK0G135+votefDgobz1ztvyk5/9lAuqxcUVGeaH0mi1pNE4kFw15ya8sUlV68HyOSvwSwIuJm4kUL9KBKLBrNoeyEHjQBq1pjy8+0Ae39+Wzz76XFr7benXe1IJK1IOi2QAh52BhP1ADg8bBEDGeFHuBs+PMdqONYcI9ERGDRL0sXSQ0xkmfreZeRVm3/PnzxMQIUAIv9nYWFdWrd2m7iWef9Qv75vKCqpm+awLPP97/7M0APTT4uE5rtcb0qjXE31CsqluoYuc1gDJy8sqD2UmY2TSAQBkdhtv4Yro5G53JIeHQp1MRgW//rp8df2LRCjf9rfI46x+6l/7926uTWjmb+rKvr1lDgCfo5j57vtc0gOnAUCYf5H1A+YLDFzG8iG9GYIjAOoI/JJJ2wVVOB8gOld3dVXN5OvO3GcAEAXZBSJkgnDv/bEuyzQ4zVx40vvMGnjgPG/BK+bLg8l9/yCinw8YDARxYIIwdsBYA8pDFJH2a3r+WmMEcGzUGeoV9YiIajjOV8uRZmJod+XK1UuytLEkp1fPyH5jn3lYG7UuRZYPd+uyubUhW2e3ZHNznX5nA+rrIcbAaf95zJC90kfMvacsjvucfpdxJPk4L/1OnzI+zcOa1Hb3pbFfl9ZhQ3qtHvX9UG2NRk/u3b8vt24+oP/axYuX5OrVK3Lv7pdy7949efjwISdOZnmgrl4XGiQuVkEBMrUNpzxvTxMA8jwlfVxcE4IvkK0EN4rgFPRQgh6wpKMR277ba6u+YwipkDbNnWjTzc1NmuS3d5/IowePyIZunjklS5WiNPtNmtFvfH5THj94ImfPnJU333xDXnv9dVndWJfqclnao4YMPFBiUbDWRrqYcEELQTTB8BLMDwMp5vBsiuzt7suDO3cp7nz35j3Ze7wv3WZPSlKUam6BPn+jlkirVpNuC5IuA5p/h5S0GgdGpJk/Y+f9544B3XFMNswYcV9MGc8MACBN5c2mi4Bd4DnAqBEA9pA/eyyWbOdLB4ZktZvfnlkg0H9N+/7ZefDKjCjNphwcHnKMmxSCFul19Xm3+zILgGU7KhbLclg7JOBVUNdl/8D+jWaTLODly5fls88/IdOKerGUmL1OlxH9J7VOfdfKrPv8ftTA85c5AJxVMEiNVDsND7yBE3Pop9+G52fGaL9ikeY5H6gkg57L0zqWCohpjvP3O0GZYOa836QZu8RHLfX7tOb6TN0/7yGLs64TLJdF/uGeMFgD4CH4A1GrkEEx6QJ8D+CBOgILyLp0zs0W1GHHBEBqNBtSyENPTVO72UCKCaffh+kkJ8M+bZLju4GpkvljNQ4yivJkAseDeBSoyVC14/qjQawgMnQC0wAZCHBQXyoI2JJkhE+UZ6q1eshRh04zZqBPYGVPM/DCMnXZzp+7IOfOXpD7d+4wYwkiOFUKp6cCv34OXzdZ2iTiJsbAmXxiYxjBrmL/+3cfSLveIpOK92DQLlw6LxeuXJCV6oo8eIx8yXmJ27HUntQp4wEH/p3NDZqESwsFyS3lKbdik5fPcNAsGGkmh3QmiE67I612V5p7+9JvDahvCADYrje5gaUc9AdS2z+QwUjkzp17cuv2XVnb3JSfffBnzJv79Y2v5NaNL6TXapI5gtwLnxv4j6EpEOiYh3amBj6g3RIpDjAyaCsCj6N+imNGZdJHNd1/pzElfruk9/UnHugdEgxD89MRD+xnQQ7BuxrJnoNGYF/aAIi4n3yOepmQTIFvG0D9xbMX+Zxs723Lg3sPZWllkTmAIaeDvr7b3ieIv3Xjjqyt/U4unL8gW+c25Mxrp6WypGw6tBPJ+Ll61EwZYyYUepM5+NiNwK52pNftS689lIePbsutm3fk7u07sru9SwZw2BlK3BMpxSWCfDCXjV6DbC6EoHvtHvXXIE6NzCTsO57pN/JYM54fkjVOtN2AqsrBxLL9+IlGow8G0m02ZWl1Vc6cPi1ntrakdnBAv1BkySgVirK/u0dNQJjYy4WSywltwO+oy4apBWS5c/jBHdbmiSnd/cau3xg/v59wTpBIbt+8oykTuzrmW6COBq311DyeuygBFgo9CIY3ZW1lSXr9Dv12kR95oVKmfyBYeQT2wNf1yeOHsry0IJcunpelhUW6QhQxZriFJOoTnm7pktW/X1Y57vjHfT/BoHsLB6t7FX7XSHEUe6bN1Ms5OBoDctVRZf3M/f9OUOYA8IQly+diXjQCUDN3FBOTxLlz5zghGBA2wFssqi+bCUXbA4ti/jP+Shu+VJ0RokyRSUBBnw0YHIzpPoffH52Y/cHEb0NfrZ/XkJFMPP2bWf3AfHLo+O4GZgBAmGx3drYZzYcUeDDh7G9vJ1HNAGtYwS9UVzjJ+3XgB7xYsQnI6gxMABic619cp5m4urgoCzKiViAirk9fOCOXLl+QWrNOnT6IToNV6zeRuaMvjb0688aWlgsSlQBcNW2XSXjgfhAtjLRzTDXW7nHCwoALhgLm+UFzKLlRSToHbTk8rEmn1WQeYvi6qXN8Rx48eCT3HjwgOHrvh+/Rl213f08++/ILeXL/oZQhMdJTPz/8jq7btErDjAbT79Fcv1lA7k/1DJvUJ9uK7ndqvtegITWh814iXQBGyNYCn0YCopx0pSUPOx1ZWVuWs1tn5czWabn/5IHs7D+hH+z65oYUytBs1GCi2m6NuZMf3nkoC6sLUv5tgWARiy4sqpaW4Xe6RjDJNnS5ac30iHaDr1m9VpdOsy33btyjnyF8L+sE7n1mbIlGObKvgeQ0XzByD3fVTAzGF/qMADdIP4iI7FmFbYbwEy+S1iJZIWyM69zfP3Sp9dQyAGZ0fWND/vD7P7Jf2qIQwthYFBr4VtPvGAD4aRf95+ikLNmsoJCs32PBa/Vrv5lkC8c+vzbuWD5hBrcgDWCpxOhwswowGhvsN9hOyAWtrNCSANbf9zMk0P6eJPP6vrCa33SZA8DpJVG7tbyo6pY126TwJyjPGtV70uPMvFEDeCZsCnBy7drrHJwAgPC9afshIhamDsvtad+hLm1Q9BkwHQgH0sO+zAOr3ydRdsiGynRrtsIftxV8/QwsJjcymZLNWfATHcDkp/ifTSC+2ccmhjQw40AcRYGK2I7iSmWBAA3adrjvt99+W27fuSn/fHg4IQeDyWNxSf2eyDRIwGjRJKoUemL9QWwp7QCSBqO+hIWAEYTFzQIZkf2dXdnd26GYL8Bkd1fFtsGuAByU6G9UVYFgyuqLdGtdpnDb30PuXpjt1UeJ7IUDtJCoAX4BAIQMC0WshwpECfb7gUgTGT6wIyI6c9SD297dlcdPHlHCAjp+SyvLcvrcWVlYqsrtOzfk088+k/rhgeQLRem0uxJi3UC1bKhmmLZZKAEyfVDIGEEnCLCArRxBICZWnR25OWvyftHPLYAej2vi3d57tiNZ/piZPGSA7AbwvQRFHUuQj6XRbRMAdOo5qRUPZGl1SS6cPcfnZO9gTzqNHn086xHEo1UiCaCuBfN+oy7Duz0pVjRfrpkV0f+qxXLCRClgULYE/nPodwTwYKxwWb0hQfhoQF1LulVEEGoeBRL3RzLoDbjPoN0nM4i/kd4PKfogBG45rV2F0C0ikWQZuoWWF7TFRdBwmCwkWFwWH+wDv1mkjYRlAb6hCP4gAES6va7KraCQ3WPGjzFj7UtGTRN3Pq4vZPWfrN/RBIw6jNWcb8WeZxSYdG0cUkZr5HRAlc1Hdhhtsyoz8+A7FX1WgAfT8sbmply+fEmuX/8qGQNtsfxtt3WetE2m7ZvlOuO1z1wL8JgyB4DHFPLIad9pP1JTvt/FF2W2KNizZ88RgNRqdY+a17RJACJgAG0wtFfzc3Ngir/BMSh74ACg709E0JnLi2jSkCMD/NP4+Pm/TTMIPmvhg0C/WBYQFJNrge8eGJm93V05feaM/PjHP6ZJHHI4ljEEE9zCYoPnsJRSvrlVZSTg6D42YdtEioLfXbx4npIzyCtaqx3wvBVoDzaa8vEfP5ZzF8/xOtbWV6i9WCjkJZ+PJMiH1JZrd9tC3Q3keKXoMnyyehNSFpYfeFynoLZiRhjDP6zbH1DI+PH2I0q7NDtNWmXLlQVZ21yjhAUkXq7/4SvZfvyYbQlQGsWhdHoDTfUE9IQ0UEyx5jIqBDkNQHG5aJmnFtdD5kPr2/xH0+Vp2v55SiKizRgLb3HolhW2wAFLBRAIi91I4NMK94KYgRDYj8Ds9l05OKjK1tkzsrWxSVP/vQf3yeKCtQNjjL4FOZAcnxG4IISS68GkPJTusCG1GJHh+0zNZoWLqgjAURkogohRJEWYdjt9+gGCmQSjhqbWICVk5oB8SUHi3ogR2dRiRMo/po8LaU7WPnHU7MggFI+pgiuNLwJvCyDUD56DqFCgVBLAITIHnTt3Xv7hH/6Bx8NiCmMCJVXcWMG6BzMZTGb+yHp+s0BgVrunP5tmQUAZn0/Zv6GX9cl3QUC/x3hnfn/4DQCeRQIHLV004/kvW95nphLVZw4BdLCoABSj7fFbLs5s0YgF03ekpMkVW9TP2vfoZwklP/cEPEGZA8DjihstXiGwl9bjC16QHuBx+oKZhVkAuuq4jALTDQY2AB0/PRIGLQyEGOD8lEm2Oja2jxfiJiozW9GE4lg+fzU9LKp/Gh3u4yODQ8IEOuBivoCJTyDPAxOS+vy5OQzZcJFqC2Y6mO8CelEGcAg0X0PLrAEDWQgRaEQjaxQyrhWDO5y7L1y4JF9+8Rnv4/XX3pBf/PyX8t//+3+n+Q11gQkQG37HvLZu0rA6SKfaM4bSTWwxgFqUi2Rja5VgDv6W+/u7PDdyjGLCuXfzrhzu7snukyUCMaTogr/Y0uKCFMt5CkUrscYEnBJHIxnIpGO9dQkT7e10Www6wX0hwKR22JCdvV1KmvTioZSqJVleXdY80PFQbt66JdtPHjHwIYdcxHHIv4f9WLNJDMCSuXRZFDvOaw5QtreT3mAmE0tDgqhP1/9mgL1pbgAvqtBP1Dt1OoYGBSBJFxHq7wbAEMfozyokXKgiHdyhMuTVCoMqbnz5lSyvr8mp05uytrgsK8saCITcsDALH+7v6/OUL8hSdUlHcQZ2wH81lPxInzHcK9m6MJZhiDy4ygT6EkQM7AHzigvqu5R7Pc2+ApM8GGewdfgcrB/25/ObQ3sAjLtJFw2CF0gGmfafb061xYPze7Znm9lTMHa4YJ/333+fjDkiYBEYdOXyVS5cNCBMF35gAZNnIwUAs7as76wv+P0jy0zsL/oStxEPaMIHGf6c4zFl0g8VTB+YfPh6cv0SiHQ7bWlD/Lxa5X7IYz7KR1LII6c5gq4cIxsMZACzfb0mZ86clY3VNbnbvM26iijJ9N0JdE0vrGc9s8ewhCwj/vedqZ6XVuYA8ClKevCYl3Expg4rVQzq8FfxB8J8Lp+AHH9QtYHVcoAmK2tPLkUdexUgGHtgUjHmC5g1uPsBAFmFi3bXjMcxgNN0zBCK4LNy+BtmLZO72Tp9moAQZiwo+2NF/5vf/IasB0CO6fyZ/50d167Fjxy0CciAIlmRLgBkIBubq0w3BibwYP+Q7QHmpNODKXhEcx9MveqvmZdSqcigAPMVGweBTA7E8PvTSVKvAfeCawZw7fU6cv/RQzJ6AAPlxQVZXVrg34hgfPDksTRqBwyAgBA18hpL10WOdgfM4xsQbOpkFjDDB1g/zZEcM1BAA1MUcGMRRg+7cXozQB7vUTwJ8+s/u8/rE8i6cQorltOZn1kf84NQLPsGg1wgBzOgTiCALRhBLqKQVg6MYB9s6i6ZW+gIMrc0Aj1cfu1+p02QdrhbI0vH+yZBCncLdcsAwETkrD0fEKnmmmaoz5eaaMd+p/TBHIygwS2qDhSwrXhPDnED0GpYuAuycRHHWEj5z7PJswDAWz2RJXeBGfbsUkDaMTdnzp6Vv/mbv2Ff/Od//mdqaCJABr9Ff9LjR0kULK/fycvMYvFPwgBO+zyRZfLYUzuHPpfjAAZ9LsfHUGuFtgUilquefAvNvDTnYk8NLjRmz/wE8QrGHv61yKWOsfXe/TuJq01/2JUoHDO932UTcFb7ZFljJo85n6OPK3MAeKz1l8uIiV42uYKUb4vP3zTGL/39UxXL+oFBGYPXmTOnE2dzH+jlXIo3Y/DSA7YFdvgaW5Znk2ZiJwPjg81eqayswBQTfQoA0n9zvE3m4E2/eiYlMoh+FFpyQER+D3Uysmu2OgFAAuCFlMXdu3d5H3Dk/uWf/zkDQG7cuOHM5LVEI9EmST/9lAFmOx+Yv/F7TRE2HKLuc7KKyF74E5V35fCwThCOjBGY2MHggHYCx4pctIfu+GDbMKkbKwvfOp8hBYOhdaJtk4DReCD9eMAsFfGoJ4O4L8PuSDqHXerc1RsN1gEinyNEW/cH0u33pRhEUo1K0hk2pduKpVAB6+fyq0aM0naMkf3tfDBVLduBD69RHav0tH5cWe+fqdDfTcWxeWlmEXYIlVkrGLXsJGNABAIwADQhyKnVktIC+vFQGgctyRXyUl1e4uOJ3LAASPlijuY/MOuLSwDZyzIoVaTdbMvu4YGEAXIvI1o6kDCvwSesuziU3fv7yrqZryp99qhP44CGyyThNCoRiWvPIfs/mCvkfabJUfVjwLrB/4+AkefxMn4YEIJPqJPBoa9vqPmLAUIBYLCxP/X6UixAFWBd/vpXfyWXzl+Qr776Spq1OvXvCnD/gG8c6gkp85xfIbJhIMUewXMK5M3yAUy3v5+aLh0t7O9n3xtjaOfwI1QT8y3ZbHNXUXWDVrslS8Ml9/0wYT+1n47HlnSuYfwWrC9cAE6fPp0ASJwL9cq83t+R8rwmYL+oY8KrYrR7dcscAL7QMpp8TZJ1z+qsnt/Cn/SaQ/c3Bh+VQznJKxyX4bBu/ntLS8uJSdcfNG1gSydXPzJAOykHRoXSxKLMF6/QTTKYEPA99OQUmBzV9UuzgT7zmGyOqQgygjymmZLSDCDMP+bjo8ykjshY4cPXDqAPJtda/UAGw4pce/N1efTkoewf7JLhgd8eflMqgYED6NHUd2wZL+en7/hubCCuPe8iqu1znGuhusToyu3tXQLxTkf11sZJ6YuUfgGbQud+TEAwTyJIxPP9Y8YNarYp6IPJOYk+xPXkYToHCIzIGmGSaja3ZUjQGEkARhFiw72BBADqQwg8w4Tcl3wQytIigGCfoAQRkQATquttgEPZT59Rs76KdteGeLrensXgg4XTTChHX3H9075Pnh8ymWDuILui12ZtCOaacjXon2hfZk5RlwUEtsDNoFVrS5AHyCuKhHlm4YBUTLVcIYMLE3mz1pS97R1eN8AghaTzJVmuLGqwxkDN871BT9leknuxVIol59vnUsA5wXED8gD4yq6OI825QOtj4av3ATAJ8IeN/cIxnWwn3C+qAsdnfmY1cyZ1ayw6wb0u/gwAMoAsX2Dk75tvvil//pd/QWB0885tRjVTLocSUPocRABYuEakIMzlmBrPZG6mMYBZY0G6/dP9Y9pCIes8YMEVAOp4iGcKgU/JMwR3hZSPM8cw9wz7C19tHnWXoRYqXFEcS4qAH/j3gh2nZSAqSN8Bx+9aMXdKvCqUHs9Sfhk/gy94Ufc9KnMAOL1wBYEVIjSFSLnDLwamDkhXIGIuzJMJIUnhHL3RAY3ONx8zFA4afGAthRFYsKOLlPQAZRN/RomndPiJA4Zhwo9l+g6OqXLGMLqJNT6ymX8czW8aRcv3AC0Y5JrNurz22hWu0g/296Xd6mrWidg58ycp2jCpaFAILyIeSjEfSR/BCKOBlOAoDfA3HEi72aLkBCYWlZlxWoGjQPrwFwRo6Q+cQr+aDHUQ1usznyEUMGc6SI+BLqAfWTB3f2FG5hDfL8/VV+JbaO3j/B/5kZltcXGYzADyzl84K48eBXJwsE8zzo9+9EN58PCu/O53NZpY9/Z32DfAaqjOpJ7Ll5cxJhK6hmDtdIIbOP+jiEEBKOij2H9haZEb2APLq8ysHiHEtxERCqYH7I+1w4gzt7VRH6zhUH0vAXiSPgvCDX5sg1gjRAeYhnSS4wQH7b4hAOFQ4g7aiJQXAcWArFAkOaQMi/IEjvlRgcdEambmdAaIcIEFaENonY2L86XjBY8Hf81963duL/hPn+KkyxvYT0A/AZyb9DNe1XcN9xwfeXUHGTPQrt8BOFsBo6c5cPWSXOfh9eO+c0FBgkjP12q6cGgsHMO+dGtt+mgOXbvkUGfojwORTr0tg6Av+ag4Zv+QiQSR4zDJu2wch43DycFhpL66VvpDNcVSa9NpcWrQjQs0cOMYjkWJG6bkwzNhadGUgef5EbwD4A9Qhoj1IYKbKhq4UFLWzLK9RCGkX3Zl6+xZOX/xgvzH//V/k+rCovy3/+//j33vtauvs3729/b5iqATgGEKgYeB1Jo1dl0bc332zo8E9oGWD97sGQcrPQHwUst180tWzUL4C7uFGeoMTGCskfkYy2OORXk3tuN+xwvFLv0qhzKkq4OTuOr2Evmj5PrAKENcXmJmP8KiqDccyn4NTHCJslJw8wiWwDi/PMFzK56ObPpEaYWMab8/7vh8ZQp35iWPJQ/fUoBkN165dO9a92YIsIU4tFqdPJguMDCPDFnHOh/My6wyB4AnLgYcJosNJuPisX+6R+r97JJ2Wn/5JX6uV9UA09Wu6fvB38UCQBQIT+a6VfZKjzIajXX9khUx00IN+EoGCAxHNJSRm6AY9AGmCCAkY8V+Uj+wI9Hdniagb07KYg2SScRbhSpb4oNqoZQKnNmR9gm6evcf3CV78+/+3a/4/f/4zb9Iu93iby1KkFqJhbITGx/LS+g50vdpjG12gdkIABCajJh8wbwoGDT/RhO61fNg8sJgDPCHARgSI+rj5sAfGFf3imJMr5kUEdGbyJxwvaB5hLEIoA+iYzNDDD0AM1Abdjfmm571I1uYvKwy9iWEWfNZXtMm6azn/GigiGVUAZuociuYAkPJu35HXktNrUjV5kAoqbUIZldNuYbJshv3FXR59ca+aYtRZ+JMLi/Vhw30qU+gMvs8DlFdehxS8XR1nwAoHDk/Tid7AzCTakMsgkwjFH3PzJ8Qoa4uLUmxXJL/9J/+k2xunZJ/+Zd/kVanrX7EWMAxCMUxwGDqycYq8EnuxxcGnsIA+vfr/53FDGbtm7W/fYbnxsaIgL6rk9YEK2Rn+2MGHbqc9IPEOAeLyUCD4JJ7cWMmRbv7qg0IeSYssCnu/h1lurw4O+daMf7McdgnPdJLub7vWpkDwGOKew6PNTRlDS5PU9K+Zc9R0gxf8DKfEJ8pA7DBa6ulid0BYHSQHKdAM5PmcOhYDTeY+QOmmacMgKFYerjxAK+r8yxT7bRLPbqvP7ArQzMaDllhoyhitK2ZclxdJsyfXa/Bv7HZ1vzz9BX3C/AFALi0uMIgEOwLcWg68dcacv/+A35usjhkNMWc3QupyT1b3DZr4YD31g5wpocPGcAggCBeWX9Dr04dw6sAT8/TabacScb73us60AbUGzcTvvPJA2hnVK+mcAOjxHvDSt39nKZUysxMpu7z6/O7VtLtFHrs4HDivp2QNHw3fUMBo6HBqmuKN2ZHAcvu+qgVgvDEu8x95sSp/fPToOqigXUBM7mpKrdJ7aBNLapZLxxMvvZFl+M3HAdE8PwuYh+uCFwUhjnpdnrJM/C3/9N/4OvXX39NZgsLlpUVaGhuJ/5yrCfLAJORsSX97B+nAzgN/J0EFPoA08Yn34SbZhntGlXfT83e+l79pA0AAuhB5NqCY+zcOC4AswV+wN3GxtVv6BmJXwWElW6jqc6B8/JUZQ4AX0B5ntXYtAf5m2cCn72YbxwABgZqFTIdD5CW1xeDGPziyEzAXEXWS/3n/ChaA4q+g7UPCvXY46i8LP8/lFkDpM8ATrAHmHiR9s2LADaWwY45cS6PNfQZQJoCg4CDvEm+YABHUAh8evb2DuTixYtkP/71X/9N/umf/okg0MrykqbKq1TG5nM7z9iH0syNwdQ+Y1prmDTQPmAZsYFlxMSCNFtJZCMmMjj3O9MofK9wfJ371fyl7ITHrJCqcP5LNM85gEd2T+jbR/Og0/RTwOPuASZ6mHhToM9/PS6S+1Uvfrv5n2Wx1lHsaQviP7KDMFFPso1gwEeOHYVZOPb7Z6pP+9JK/vfJZy4PNfwR/QjzpM95+nY8pjPVJQse97Xvt2puK3o89eOzYhHy77zzjvzt3/6N/PDHP5aPPvxQrt+4Qb8/gD9bQNrx7NzHAcCJ60xpA54UCE4DgHYcu6aszR/D/IUjXi2Dju2Lv5njGD7ONCMDAKrqgc8EWtAHxk4UE9FPp6X7Phb2iXmcx3OVOQB8gSVrIHraMmHGeTFMYHJoeQnFV6anz58TQ/ZzsRIA9jUnJnwGsS8yT6i4q6YXs6g47GsrXhsI7TyTfjyTADALMPhA8MgK0vvanzDCMAwAgPxgh6x2TCaj+CiodAwJL6rX68cIzIBWIJg3BIXge4A9gLI33niDvkG439///veys73HtGvnzmnUsAdwqTOovoDmgzmZCzrrOi1Ax+pXwbcyCQCEMBEiqIai2zA1IesHADlMwmBvcuP+mGiuJZUwDuYhaKDLnGYtQaEVkUEDGhVL8OdYKAOLgccApu7nRP3/uGfsVZkk00BQ3zvHpoSz134K/pf9yDGoSqoCejlGjhS1Gl7hf4YInISJT9eLCSZafzVwR5DuTL1w4XCstTLXY1Yc5mW/0DXSE9+GB61+Ad/ocU5kcOM4KqJ+CXRoBRjRJ/L9dz6g3Av0/j7++GO5d/8+F0noj9vbOwlrbVIoWYu7kwDAaazdtOjgrPfpMSV9HN0Pn6EN+M7b10AgFrUY4zrJvq1WU+r1GhuZ41isgS54Dm3xa/7EOJcBQ/V3VmbU2PPvckm37QlK8qBBDvBlXdd3pcwB4HMWGySmDUB/IjPwxLXMPueLOb4/WGqi8tzEZ1jdYtVrUXHIC4zBLJ9XCRnfnOszf9MGcExN/qpb72XM3Pmf+WB6coCfvI/0Kt8Ht1MnogwzkgI28wEMOKjDVIf7h5kLmoBnThcplt3r78iZM2fkb//2b2n++h//9M9y69YtefDgAevl3LkLnBx9ncAJRtB80lL36F9nWq7C6hjO5wuVqgwKg8RPCwwgAz+Qei9WyQ4LAtHfDtUEDJNvkv3Cq2/nE2lmXgQXMJbCQCFgggvaiJyzexar86f0632ZJWus0MAWF6Di+TqhDiH0DRMvgoRQVwBkFFsmBmT0jP7Knp1U/bnApol+o4yfBlOYb6ddi8908/dOx8+/fv/v9HORgKKRmjrR57HwAdOPzCbvvfee/PrXv6ZLwod//KPcun2b0a3o29jX2H+TfzpaV9muDun3x21pE3H6d/75/O/8MQa1nT6mX/ysRbbItQUxrACUfKJfpT5LFiHtA0CrXwvUMZYWz64B+u9DOQLYvyXWsVe9zAHgCyjPAvZmlVkr3lk/S72f9sNpUV3PVGxCsQfTgBzzfXpgCgMgVr2YGFTfr8B94ANojJ+fDSTLBDxNP9CfiHyJGXd9Rvf5VBm/GrMZ/uACygTHDunuN+j3Y5jcjCkcRzNP+gBa5N+4KPUC4IagC0v1tru7x3uGSHOxWGIKNZh7Nze25Mc/KlHC5ZNPPiEIxMSZzz8iM7K0tGKizWQCrd5NIBsXa8ym3z44tzGZFNT2fDHpfwQfMwOIuKcQWQYwySASNJawBHkTi1p3dU4zuYMkKQBswQcJqnBElwXq+j5oxvylO6I/8X4z5SRianH265FIohRDlXzs9ckj7ycXLMTXic+evoe/n6bs0BzYqEekdkNgwDQ3X/YR3+RLBtEJVrtrJZjwacjkUMYYumtzPoJk+hJQOeEbqwB0oP2ChmwuNEayurrGdGYffPAB07xhAXTz5m357PMv5ezZ0zyG+aRq4JOaS7EoSS/gJqv6KFiz/bNMstO29D7p9vLf+2PPLPCXbgfmYXZWDeyPZxslF7op2D0gFkBnYx1zensLUgPy0GH8vptAZ82N6cD7eckucwD4ioHBV8VkddJiK1IUf2CE6QqDnrFNY58eBXKIMlW9K81sgAkAgz42cxrH5xaocXTFPhZLts3X+ntaE+J4hT85GSQMo2cOnpiUvOCMyQlEf6f+jxis2/TfwTWC+cN9IlMIlGwxGUAuBgAPqbDgJ/iHP/xBPvroI0YQw4QM0yp+CyDpayoe5ytqwtLYx0xM5oiOYw0jBYDmh4l/ST0PHeB15kcoBpqvGqU54kjiyLFIyb1PMjaWI1nNmp6+IwHniFpvs9rlu1LS7TTND1An9XGZACRONoqSPSjQv6RJMNs0yteMa/FNl9DWo+ne+17N9gb4jh7XN9cfYdFTGTgWFhZp6v3pT38i7777Hn/z29/+Vu7deyAXLlygT/CTJ09UE5ABZCogj2cBY4YP6rIWxv6CLw0As8DccezhkTqf4dqTZhOzio1LtugyAGjjXD7SZOamk4hoYH+ha+ZwO58BwOS9fLdLuu7n5cWWOQA8ptAhfsYggWJAwP/MBD3hSM9IOE+s2AYNVdhnNtNn7uy+D1jW997xjmUEswDTNBA1NhGFBGrGdGGQQ7HVrgUg4DaVfXIDG3JkEjyqjh42fwIwswmlMtxgjmP7E9AE8+CZTPzB30+v5mkCKluo4DIGEMnlcoEDVXy1Nooi8GAZ7W2AF7onXl27VJRgR7gTgK0yiaO4Nepov4gK0mp2pN16JGsbm7K2VmDdaR10ZX19U37yk5/I6dNb8uGHH3GCfPLkkRwc7NFRHsAxlwOYFAldFDV0Dm2C8QNjLGOAmdmtHpjWrdd3ci3wJVPDo/3O7jEKIpqA+XeiYekmwECkTYYCfmtOCiTJCDE5QYFY5W+drIOCV2jhTZqt08+AH92aNQkHGf6D/rHSJsoj50oB1vR5pv0ueX02tj65XgQAgHm135rJFiwsulBikp3gesZ/mcxLPMU1AWLCdq5kS1wIzJwJIfDxNakVXz9gBg/LE41+wiTGGpUPidEBnlWIE1OYvZekaVteXuHC5Ze//KX87Gc/k9NbZ+Xzzz+XL774QoOhLl5kINjOk8dJO5mJFO8xfvggOQv8caHp6aRmmXR9txGzIviZTow9ncYApmWgbKzhc8a8zuPrs8Wwfyx8bgsvLPTwO4xJuD8sCEcDkxVy9Uv3i3HGEf8+jMG3Y/g+0uk6+gZ0ACfqaZpl6bhrwhhg9+DX3bgOpv1urBjh6ph75sZtwGzA33WA/LxlDgBPWKYN7rM6+Pdh5ZI2oSY+KiMFayj2QCsAMb8YHTCbjQYHUnNuBggywKIm3aOg2JgmG9RnrerTkbz+RDghIDzFHOQPRr6/4fjeJ+sjzQT4TIV/bGPvwAbCB8py8pr5C38j/+ff/M0p+g3evn2bfoHwHQKoxG+QK9WYA8sWYtkW/MjqdKaBpD5cAIgBP15fRh1Sfy0RAPc2BiOoy78ulLx7TORw3IKHsiaT4JET3oBquck1+cwmNot+PHJud5xKuZzZL/3JOl2yGdxJZvckTJECuKMLg7RP3DT2CAUMuH+9ntoLizGo04ofYXukDoLx79MASkEjHM/cosB8AyeEz0OCFCvILBIHvuRJIP0eAhO0jwHkoP0Q3f7zn/9CfvCDH1DTD6kQP/rwE/ZbZqHJ5ch4oy9DBD4NztL1mf7brz+/fmf59M1aXE9r6+MWBHpOL22e94wf3e+oyZhMvAFQDwAaO+5bNZIsSA70ATz7OdLnJbst52V2mQPAY4pqAB5FeckEkvJjOsmA8ycu6ZVa/KIAoGl+gXVqxbqCT3xXnGjzYGDgR38LHyHLoYkCQNjudCZ8X9J1qe8tl6nqCtpgmb62NOjzTSgAl/xs4rhHQd+EBhkWlvpeM4YkhEv2ZGEgUWVhcD69ziRKWpBFpZnch5lsVaqlKp1OS65cucKJFBlWHjy6T7MwpWT2dyTKaX5lyyds+ZYNUFv0b2YQCKIMC1p3CN4wRgTptgAsk8mY2S7GzLXJtHJighC1y5xBs2ECDo2hcw7bZMu8vxG5il+M0lGmk6DNgonSdWx/G+PsLzaynr2pLGDyftpr1uPhAZNUn/N/q+dNm2gnXQ00EMPLQJGcV88x6Ls8sZJdxrmTj4JPe2+iwgmwTRzph8wVzf28+x0/cyOp1RpeflrN8YtnVr/vS3+oZkosSN5991354IMfsr8COAKs/OM//A+y+jg39sHvkKaw1VJFACx2Zo2ZNs76rLRfZvn5+Z+nAZh//Kx+Ne2zrMWhSidBmR6mc+QVsufBs/gguAoZQ1RmnX8TMJsQu/uNZdVJAoHc2GbPgT3Plr976BjEl1Ce1lf8Tz7ZsZ00EtvZYY48vH/ya3zVyhwAPmVJDx4+CEyzPK8oAHzhxQZCA20AIb7JwtgGpettYNPBERk/wApYXQH8GSCaNWDjI1tF+6vk9GSRDcjcZxmg4WgUpEuV5sloAOTYxJ9OBGETrD8h89i+qcYBQAK9UlEzIzjTGcCwbagX000EQ4gJdG1jVc6dPSu7e3s0G+/uHSSmN4uiNNbHGANjA31zqN2P+WlmTZhpR/ojLAbM8jAfeqzsBMvHCU2zgqTrGeCDpuBAJ7bjJmq/Tfy/81MYMqv3I+2XfoYznun0+1kFQHkWgMgyXfp/2zPjf2d9yhhR/j3l/Emb+gDPriUYf89nxOXqTWRl0AwdZJhQuRe6FITaBxM2mbm4jUXu05cT/auQR0aKnKyf2uTi5Nq1a2T+yuWKHB4eyldffUWWD0EhdAEJQ0ofWR/FGdG1kDIwHYmdNcZOA4GzwNnJPp9s93T7TWvXrPNP9Avf0pAxtjAwrt+RSNS/zweAPJ53m/jcAmLMTJ51zlexHPv8vAAb7fdprn3RZQ4AZxfNnOQ95OkOawNU1srxFS0v9ML8+8dKXyVeisl3BtCYOtXJo+irmSOVmTLNLwASH/zNOq8Nqj749lm+lCnPfBwnVrbwcbGoTLfF7pi6s5EmEIfGB1EUwFxmgC4NAF1AbtIBEvNQnETpkmELA5wYK303oRbgy6c+gyiIEoZfJUAf6hD6fMNhJKXyBr87tbXFyfTwsC4Nl+oNrKBFU/s+fz77Z8zgWE/sKGOkNw5mzwRHXDsTPYzbRc26uAfknk1PouP2USWRFJNrKfQyErrbddi1zyrIhTytb/B7Twg5i0HyAeBJnt30d4O+y4QypaRdAtLXkC+NFz/2PUCW/W0ZPZLvM65/4r0n6YKCvqX5U50GoFvAuJ2YpYUBSyP0BeSW1kCfXE796xgxzDTROSlXirK2vEI5l83NU7KwUJXTZ89IZXGBEe21el2+MOA3HLrghVB6AxUyhg8cqgP9Gv6DvU5XCi5VZFY9n2QMPQ7o+QuKtH9w+jxZQC/r1d/S4DS9SPFlpOzcCQBEgIdzQzHGL9Hddp+bpBYWgCjmI5307Zfn5PbKTmB+yewjOk07/YGJMncJTJU5ADxhyVr5ZQG/k/gGfpeKr5VnQSAY4G2QM9PsOK2oMRLmNB0lEXIGGH2zK/abteKdxbBktZm1W9bnCWBxZhcUOz9/w6xYqWAfk8tIF7dPwqA5va/kfAZKhqH0PO1Eu2/zhSwUcjSnlcpq3rXfQ8gZv9nYHE+udWyNBv9GW+BzC8bxtcXINDhQqKLSkzIW+v6o3xKvf+RpJcKYBQBIc1eauRsfFzXAzLUTz4oeo989CqAm6tf1rXQ72XswgGnfu/RzOcuEmMUAZvUl/1j+e99nLn0ef2HiF/86ugOXS9krIw8EputnIkI4ZSI3EJEwT2DZXVecYKD9eghFckEkUQ5AXPsfjqnsc5E6kXiesehYX9+QzbV1WUYOX4C4vGb5QJDSo0ePJ7LOGFh59PAJ+y2kjNCPYdpOnvEkjdxRBjBZLGXoJqb3PSkAzPp+Vt9KX0vWNWS1vf+ZjSVmrfDHMgVwbqHqQDrbLHXPBgAHwwGfazs2haGnRNF/H4u2leWmzgSA85Iq895zTCEh4p5o51YQnNRcxAdZvtvFABPulQCw1yObZVG8CbBKBtRxcnv1VctNmBotkjUxf031CxoHPmSZ9zJW6RODAXXz4IM29uGyTBrMAWyT93AYBLrPiGSVAbfxgXyneW/CSlb6SU0p42heKk6pKopzZLG6oxEnyupCJXCizDGA3OJildfR6erKH/eLyQC5hSGivX8ArcA8J1dEBwM4UkKnrem0Dmu1JJWUsYI+Q9gdqEnJZyh0snLSFs7fy9oIEcHEwipUlwD6mGLFGiSQgGTWu8fw2f6UhNFFgYFav239v9NRvGkQh/R19nkWAJw2MY9bZTbjk+XW4V+jH4Xq75ccf8bv8VoolxKlgWSzdHDQkayUJwS202U47CcBBNQTwH3mXD5pC/Yx4OoWXUm+aXw/ECkXFeihXwGoYXGBrVQqy/IiRJrzUipCiLxMPrjdasnOzp7UW3V95ocatIVrgIkSQLDb0T4GzT+8B1NtguYo+A7XXi3i/XSW1Afd09w60s/8NFecWeDuJH9ntXPWd+l7sQWXr++XjHnmtuKCuTTv8jiqG5/h+Ua9dbs9svw2Dhx37ucsJwVP8TP6DL7Qks55r3jahbrPy9QyB4DHFJIeTp//SIGJzPNvmsiIcCwDeBLx2Ve/mK8fioGKXJSjuRCOz+oUPaQZSQdMHQDNB1CPMQZqY2bKrZ4JOLIGfguqcBMbOCjq1sZ81UwJmCEB3KBdp9/nwGzhlYycM5l5QDHN8hzH4OA+0myFMwG7gXxSrHXi2AgAaTU5uWJyxH1jgEcd4j0mYRxKo3pxpCF9r8xnkPuVKjwmgJSf89cAtaWWSnKMOhbQWJhmtyOjEf7GJAUzvJqWEl1ARAl7jGHyOSJCGbU4mDSjJtkRJn0pTew4/ZyUC+WkrQ2Y+JHAkDmBOYyyKFFI53c/iMbYpolAnVT/TK7D9RO8wmSN+jeTWxY4AEA1E7JN2v6rfZ447qc2fNfvdCeAycQWqFwSASAAAX6TDnpKTMBjn1OyRe5VGUCtc95jpIBBNTa1LnEkq198x75SLEg+jKRcrEipUJBSoTgBGvnbMKJ7QbvekcePdjRdoOt7pieJVIEaDa5ssGWIKeTUh3V3e0eqiwuyulxmqsF2syVhLpB8VJBcCBZrzHBOY1LTz6T/mv48DQCtTAODmfs5zlrHdzfOe+diMsQkP/NRn9VkPAAkx8II5nUIZOfGEjQGAMNYrR3JOJKY57V/or/nIzzXOWk0VCs1a+HxqpaTAGSU0OvXL/oc8zK9zAHgrBUNAyIBXiwH6pATiP6tO6imWi8xBXKFJxoNax2Tk3GsenSD/ojgaGzamt1505GtL7McB3ayQK1GIeqkA/BSb2i+22q1LPX6Ic1IGMowYVh0K1gDmi831pneCABlZXmJE8v240eysLDEVEfV8oI0hg3JuYkLgyPqOhngZSj9UT+5BgXqzgwA4eTAubJZFQKUuqwH1EdDZCsX4dyBN+czgm7AJyNo9z9mPLXhhhjdk1/wf65BzYcQO3oTQzz5fSGfi6Hqb6mdwiCMoZGI5PA4T7FYTI4PwNsfdOJWRycBXm9DZVJ8EKUTippGq9XCBPjwWdFxu08CwITt8/TIjkhs2PGcbX88eU+ax6Bld2RiD8fnNwBn1++/uiYjgM8FObIleQ8goqmiQp47+b+b6Kcec8aFgTsehalh3kcfMB857jQGsmbu5n0PXCS1F1ADwIZ+5gOPtM6cmXCnsVa9nkbBYuGCPonzQFuP3RMDtJvok17DDCzqmTnRrzKOjQJBdoZZeKDD7wuDbl963b60muM0bLYAmNg/dV9WX52mAmTUJ+rX6jVGnw5EquWijIZ9mrq58GL+2pGMCPw0ujVdfOA3TQdy3HcnXRfS+8zyATTARZrIeY1pBC+aXsd9ZlxxOas14ncs1YMFLoK0ej0sglXvD8eslBe4LwJidCGmage7O/tcwOVzKoXD8weB1JsNvqeJ3OmkEqiXiuyv8LtcXliSm9e/1rqOIo4P6icYv2hw9KyMWeaJ/MWx/9l4HIl1EeEWnvpsB9QlpboA22zAnNccJwX+08iABIJhpLmnHQmhKfJ63/i8+W0ucwB4wl5tZpajg23KSd1WhjMPitVlmjn/9hawGGCdYHqEPxBkIPDeWC2sWpH7E6YgSJjAVAlBYzzo62trsrS0IFevXiVILBXL9GEDIMHx/BzB/oMOINjvI8fuWEcrJFuk12RRuhqooJO/vRLEe8yfv/lgz977g4kBdxvPMPBPlkkAdNwATNDqcGHaROmfewxsJpm1OB4zTFlmqSyfJJ9hAyCn9Asm7wjRn5NMiv2dFsRV9gKsz7h99DcKHMYD/5Qbd8/JwEzMTv/MQIctukzmxQdyvA9+5M4/wxHf8EFaEdb8rkZggj0AaMEsgXuuEYQx4fvoMpmobyMAyngI9UGGpcRLdPiM2En1hwJ977L6xVi0XH9zlOli/fXGUcRZm8+GZfnDmYzINIYTQCRrAcB7cj6wBNX2nPF1nNyO+Ypdr1WQhboZt/80gJDl0pEuWYzgtP2nPYdptwFH3ifPsclVMQAKUk581Wh3LsgImOH2UpJSqSBhoALNMNfaQpSm9OVFjocY8/gaKTvfanY5FkLnE9HTyAKkaTNbDgSWOF7i2ixADM+vieJ/u4urY5evbewnfjwTmG7zNFs8LycrcwB4tPi9h34ETsFs0vfP29nen2TC/xOWl+ajgQnbIn8xkP35n/+5rKwsU/YBbJ+xPACK+BsDHsybMBPiFYLG1eoiB756TU2gAIwY6PAbAEgzPwJwBZmiteO0dImpJuUH6KdQGvN1MaNzTTnK8wG0zzOPNY4SngRkVs/jQOBJxu9o9Y9/qEBjxOuw++imgGGiP+j9LDEpeixNmqlJ98u0iS1trqahKzFXHmUQE0DoAOOYYepP7NubBlDISyH3ae8I+PB/D/YlC7wkfc8DgHpfxpg59t2l6MuqAzAoo3SdpCcW+8mE3I3vI3jUdOVfZzGnfd/7cvK9M/Em/noGOOjR5ws9Z5tAC7nJ+03Xjy8UnTUxmhBxGkDb5kdZp3+vwAgM6Pi+J2/1aJRsOmjG39c/blabTRtb0/c+6/2R+58iK5O2fBgQnPxMwVy73RwvDkcKCjGWmV8uoqa3tjZ13KtW2Od397Y5NtYONVMQFs52rQCGWDjYuIrfwe8S0dUoJhiv4Pyl6QAex1B8475/x4F67z3GSHWonJeZZQ4AjynTBhP/e372aoO/l1rgoMzJrljkQIaV7NraupTLmrkCEYT4HAMdct1iPwxylUpVlhYWyEJB7gSAb6G6KKdObcnFiz3+BtkvIByL46j/ka58AQT9qFgUfI7B0Uy1xh5O8yXyWT77jQ+M0uanIwxISn7Gfx2f9+iE4pes401cY4Z23wSrl/J98u/NjpcGc36uUdvH/ywrKMR3XjcAiL9hgvfrBwzg5KQ7JQrT+Qr6mTTSZZpOYdJ2ZAEnGb8skDT92XWvahcmKxVSEFt9wBiwRObxqORPwtLiu5Qnh38ey4Gd9In0PTqTs32f+CS6P8b3lg3kjQHM7BsZ7htH9vEAoP+9lfQz4e/L+wHTOYV98xcyBv785zHrfp520vc/nwX2poG/NMBMHydZODpf5PT1A4Tp4rSt+okhWL6QC1joIl68eJkpHVdXV1zGn4qOkbV9/h6BNxjbwPzh+3v37vH9uXPnEssKUuohGxAW1ChMMToYEGD2j5Eh+i6WrLZMtwvLRATavGSVOQA8vhyJJNIJLHmTfJa1Qn6FIOFLuRQMRBi4YJ6wfMB37tyRH/3oRwR+AG8YIDGYITXU5cuX5f79+9yXfjCYanORLC0vc6DrOKf5ZqMrA6SXwgTq8pfi72arzkhjAMDEPJxiG9Lpk1DSkxjnPueD6QZ2fpkGjLlcLk4zb/6xsgBgCgROOpfpkSaYwYnJFTYiLzoVZtYJVoLChWM6YjQaTTCVSXFvkGZvfB6Yf+PYnYK7AFDbbw3k+X5sdo/TAKBl/LDi17n2jzGAmLjOBNdMspBpn60EW2XUL32BUgA7AQDu+AmjSRevyQnfIBy0DA2swz9NpXFw7xTA088zmSiVTPE/53fOZMziXATMvJWevMLIxg+1PSbtHeprGOZnBo9BGiSrpEFg1gJF/5i8rvT12SLL/72/TzrgYtqrXz9Ps1Cedl1Zx846R5pNnAYMsxYYKAljmcWYu5zFMNdau+TLZY5jp0+fkbfffpsAEAxesajKCLlc5CR29H2Y1/f6m9M8BgAgFg74HOwhxkqMo7CEAPSZtMzT1OMzlGnMXvBNMn8nAfbpMZuP0tHrnJeMMgeAJyjZDEby5eT771mxaFMMgjB3YGC7ceMGB7+N9XX6/O3v73NwAwCEVh0YwosXL2gk4RCO1BoxqJOpAkAzr5gMgq2EsRLH7zHw1ltNqS4uMzoUxQcOaQZvFitiJT2xzdKgs9/7ANBnCKYxfuN9Js+bBo7+OSeuL2VRnpYKy4AtMq2kS3oCSzN+VofTzLI+WAzgwD1x7knGz3z4jtyHM537MixZmzG6PCd87mKVSLGMFmkAzmOmAZsjYuE4rjtDikaFrpGOAn5d/IrXhCAF3Ju1hZcJxW8PAjwEeznwlu5/zgdw7HaQ3c/6A6ufbIbPZxDdxU+8i6Y411vxs8JkHd8YwKcJDDvu92kWMv08PAsAnPV+2jNq9X8c6MwCfz4A5DG8Ed5/JjCG4T2lckrwAywRpBnIg4sLxi7oeZrYPVg/gEI8Q3u7h1xAm3zTW2+9xWN++umnZAHPnj3D3xj7Z+fH9R0nkv5dK1mLiWnfozgxiHmZUeYAcLZvQyb7l/nZFF+r73rBIIdJygZMDHxI/o4NJhAzcbzxxhscCMEOqhPzgJPT0tIyB0AzpYxNRvq9ZQbBZ/g9JmmVIhlHK0aIEHV170vImEl45iCRAdRsgHXHI0M3zi4ZO11AH8zNBn5Z+1kZjYbK6GkkQnJB/so2NcHp9wnzoj6DtMZlOOrj+lOTVmAMX9YEOWPitqjo5LpwvE6vM+FDmTYBg/GwarD9eDA7aArAjWOqx7mYx22iUYPOy5I2WbCak+DeAIsnt+PYP9NmVHFPAMBARgiCUEVIdePAW0T2eriH5zZ9NqsngnGVEvIiPNw5zDaP/0w02+t7XhfJEvJVoO+AY2RRLFPmsimSJyct0xZE9rcvg+N/Z88Xoluz2G/725cryVrgZOXvnnb9WZ9nMZDTFlCz6sB/fv37Gz+v42v3I6oxPuEeMTYB/BljChCH7DwAdRgDy2XN+AKTrbF9AH0H+6rrh+NhnEQwHEDgrVu3eKzl5RU5PDyg2diYPxON1/HypRNc35iP30nLCdrU+QB6DTcvmWUOAE9Q/JXlPMBosqhAaTfJ/4uBaXt7m74sr7/+Or/HahcDHswY2Af+MRgcT2+dSvKOWg5bvMffYPkePXqY+PKZODSOh8G219OAEjj5m9nMBlJ/8kkzD2lAdRwINECZZqZ8hiAN6vzfj//O+szPSzw5xE5b4aZZDqTvUtyR7evmMzhpEzk2k/tIB1n4MjBZ8hn2/qif5OQkDxmlrGtPgFFKtBfsnv49FnhOZ7igsI5F8Q5hLo1UB9IFliQgkhpt2NtknBwQJHBUfzyVBcJ9uutwYG7CW8/hSmMS9RbdcRkFO14QJD9xum6zGDQCAjDNWfUzGpu5deejQImvGcDdbxM/CCR9jcm9zShZz0riYuGB4nS0ehbzl8UCpp+drGfpuJIGfNOem6xy1EQ+GUyWZtn8cQavcH0ZOBbXlzHCd4zmhSj20lKSYQX7YpEMUIjxCWwhLCRc3DpGH7mVAQTtmHt7+wwAsefSjvV9IxtmlWfpN/MyB4DHlcT1y/tAX917n6HwJ0XfT8P/uxDlkonbtALTq+ssc+CrULKuRYM5KkkaOCaIX1+XL774Qt55+23Z3NyQM6dP0xTy6NGjxG8P5mICoNBlLkD2kAiaTjE1w7BBDw3aaMiWgH1yEC5u1lUDKhA6RpfKOpCayr6lobOB0gqCek3vL814+X97dR/7HcDXA/T39wFnFgM4znQxGe2rUcZ6XfY9ySS3T6gq14kcirsQ/pjX407kCMrker1iuYctStgYwnHUsN6PwpkxyOX3/v2lgat959/PeGKcTC7sB5e43/K6KKfhmemxF/4DX2RgzWqF4s1JqjOAP5NmDyWXd7luE2Cm4tzcn7l0NdqXmp3elQFoQuolKiobmFyfq0WkKfMBFCd1Sg0pIFVZgBAHciDS1YP7Zzp9Yc65EcAknArSIRb1GD9H1XJLiLMYWaMJRx3KmfSxzNI7S48nswqPHWfva2wp/3aVl+7nR2WKss3Ns4BhFmDLKhls+BEXDH8/W+AcuacZ78cpKhXMJT6vozFrjs8A7tptlakyfz4Au2JhnAcdYyIy8WyeOpUwdzimiWhjIdxu9ZKUjfg9Fs7vvPOO/OhHP5SDg0Me6/e//z1/bwLvdk/Y38Bn1gL0JMVrsyxL18Su9lX2x9NP4Y438bvkek2hATquKZcTf98EWFswjrsMfGZzMPtiGHL8ikcYFY5a6+ZlsswZwBOWkw5S37diA1I6LRsGv6+uX2fUL0welkHCwAQG2lK5zBUwQJINtjANm9nXdP+wmdnSzokBE+eAicVyl6YnFft9VpnVfj47N2kGmgRAx7EKKNOihJPjudnXfuIzEfw+yTRj12ZgY/I+0sxEFity3D3P+vwIQ3VCp/x0fYzr8ujvk4nbTLauHhJgZ3mL7TtwcC6IwqVp1qzDDiASYDmNb40WViFfXoeL3iWDbKyjUoTu2tUfUKM3Qu6nOpKUfE/AqJmPjwDjKUFhU+uMLOOM/pSqzxc1/szSWzspqzLtPmf91o59rI/hCXxj/e/Sf5+0jIHp5DH9QCjf9Gvj3ng8G2ey8cEjxikAPp+5oyxWoCAyirbJBuJz6gK2WhzXoIQA9xi4zIAhHMu+aBo4lDS4nZd5edoyB4DTi+cDqGvhWRNf1pCjK5VXvjyXj4exbVYvZgaGmPOXX34pP/zhD8kIQh+QaeLcAIh0cWAFAQ4t2APf68q6zYHTfP+ymAPsB/MLNvzeBt6s9sli5rxJ1Mg0Y8zS9fJcJb2STb9Cg1m/Haa+twlyMvd0+jq9eufnI6cj6G1ByoQ70d5en058HNMgL3W8ZD9XS77P7MQ1Tatn94W7CAA2porT+3Jp2jR5nB/L53g2MqPjU0LCxeqNVlN3DF4daToV8XVKnWNJF+cTqCm3cI14i9Q/bj9jA3ntziDM71y98FCuX6l6tI/Kx1k63D2YydlEv8f1a0EiaH/zJ0b0tt5T5HRiEpDpTNWeZ528qJIF+LIWQf7n08CeD9pmAdZnAWvpvumfcxZInFYMwPkAML3YMdDngz8uUrkoVTcWG9vs3plqsdkkqDNdQEvRh0Uvxj/4P5sbBsY9gEC4ypw5c4b7wpICdxm7JuxnuqpqcXlhKeGOWBBe0DxyokZ4lsWp/73PZOr60aOv52VqmQPAE5QJnQ4P8DnTTNb+8n0pNhjZIIlXmCowoMKpGYMaPoMjMwYvgDVEzBlrZ3IwNnhjUFMAqKmpbHBEsRW07Y/zmTnFBsfJQJLZDIy+zzadTJv4TlKyTF9Zx0zYrszv7TjHnzsLqFmd+WarrOvLYvbSAHDa/U+biP2SBRqSV344uS/FqNXE7XAezP3u2p0ki2FmAsfQTMP42wG0xASsJlgFYHosTd1mfl3OZyvJ0Bd6mT8cmEjwHdpRfRztcgA+1Qdw0vSo1zIZNOKLkE+2hVefHjGaBZpeJPPH46Uy0BwHAtPvtX5O1j/T4Oxp7iU1wWe++vvaq23T+q8PXg0EGsD3zZH2mmYBycB5Y1PaCmLjE8YyZjly7inmNgIQCJkXgESAPFvAwocaC2h8DrcZgEcslDHWWi7gF90XXoWi7TWb6UUxbPeiFxbfxzIHgNMLRocQ0URpVoQDgr/a9wbC9KDyXWX+rPhBEPZAmoQKBjgbtJrN1oQ5NDIm0GkBYhLH1h8OpN3tSBuiz8gfKo4ViuhyzlfoBuIVE6aZii1YBO8NKE5MyEY/pQYOjMX+/aTBkQ9YprGRs0oWQzExGXq7us+dz6Fd11Gwlrq+NAM30a4eM5i+rnSfzsx8klGCSdPk2NfQjuPftx8DkHmwlDk4qVPLRDGR6cC1mWPUyJSF4yhUy0schw4SYj5HCmnXh4w5BJuWEJcAdXZ06spodo4AAJARxyFPGzpZwABpvR041+APa0vXtppEhpVBoGom/LFlWLlI5345Mt86L9iXl+kkJMcmZb1M5Nr13r6Q59rEqBOGdhL4j2ljtzDhdSUnOdp2JwGuaQZxWskCerMAQtZ3WSDQf5++Dn8R5YO/NCNIAJhxvoSRpktLX1ottWgAxOVcZhgDgGAAi4VCsiAG2AMDuLOzLYV8IVnQ2liJYlHAWXmU/wTluSa5cb1lL8T9fWaBuon25lA6zwRykvJK9KBvU0kPSK80xPsGigV+ENS5oBasdlG2trZo/kVErx8Mg4LVMAI/zJ/FTCs4nu83Y8e1fWz1zeM4X0ALAME58Letwu16bAKyVfq0ksUuHLe/D4CnZTo4wnz5jMYUZtCfRGaxHj6zlLXftMEzPaFN29KTd9Z5ptVj+hqOXJsDiBNMbAJj1VxrEb/G7LGeCaiQlxV1ju/ddSZ5oC2t2kiQGS7JFoKFAdlFBJto2jW7HmJHpryD399I4oF+HhEA0k6sWS9wvcYS8kYmFxTwbZ0A/ZPpB92tmakRKF+Zxwl84nBYOvNI+hh6XHlhJavv+ueeygLOOMZxLM00H10rxpalfzetD2YBwPT1TzNb6/7ZbJ8vneR/bg1nC1Abs+x4+EwXwE0GvpVK6quMfkGZq+5QFhYXZaFe5z4Yz/AbBIBANH9zc5PsoB+MZX+rFMx3ww9wFrjLKlmWlfRx/ODNeckucwB4bBmPEtmT2PRV5iteXsjUgQHPTxhv4qhY3UIMGqta+ALaipf+L3ld+QIEqpSLDpzmA9h1oA7FAkxs1W0BIhx84zgxM5vZ2Wf/UsAvdoAw0fHTctS0NIthOFKJGczESX0AWcahqUZSTvjKZeicJYzfNKDnttn9NiO/bta9e1vaR1BpP6cEnI4inFY/4/djAJhVDBQiOtBJJMZq2h25cN4oZi7fSE3E2t5Ouw2sXghwAbZYAzn4vcsjrUyhHjcBCc70FA1jGQ2GMnJK08HAjzBx9YVjuWBnBafe/Tr3wYTRG6sWTtYF7wHHUdAhYLTJKjqwopEpnqbNyJGlJx5jpu2Y7qRpBtz6n//ZseDPPsualGexg8cFgWQ9U1kAMG1izrq2iZtOB2Mlv50EfwbqIFhvQWgJKAQDONYL5bhkFgjDtebbBz9AfOfXk41VyJgEFxkAQBQwhQj8gHn4zTffpNqB5VT3F8MveL4JnnG/+Bl/f6Rhtd1mM7zZoD3rJFRNwEA/F4OeUeYA8IRlOguD/uVpRUHO4SQmQtAV08Rdv0XF/O0sIs2AHFa7EH/G4Hfn/j05c2pL8qWCFKO8FCplqSwiB7Bm/+CEOxoDwH5/HPGL96Z5NRg48DfSgRSl32olLCCP5ckt+NeYZhr0+5OxgSlT8pHPsz47cRCIF/l5HEORdX1ZmUD877Pux99/1rHt+uEzB3w3RKDKKJWRA0jlGJCs2YjdYsn0EO07RvlO1pG+HymwQ/8y9o9sH/qb+vLhe83T6gAa2Dcb8vF4AdXlHNiCCwH8Bcka4hwqu6JMoQJAZv3txxIOQxEIRPeHMpAhzb8h1htObZCPu1lmmUXEORk6FjG5j8TXUe3GVo9kL10YB/0WE+e/sVi1feJikRUE+3gwaSt9fdaRhAuBI+Bo/LdlXJnG02UBsPT9+/vZd+nfH3eNWeeYWEzocsSgtvseC4Mw9bn/evQc6Sj6I1YH/9nB+xQDOBj2pBCb9NOYBex7C1e6yPBRiCTM56RYKUsAKasRMstEUl1alEf3HzAP+pUrVygDA59AFBOAHssTfatIh1Q5eu2sF9eszssj2TNpOU8GZvJwk3JM8yCQ48scAE4tBuA0ntDZkDATucHB6V9hSsCqkf1xHA2rJWtwS3fpdDe1ifwErQeGhGzWsw7/o+fyHUIBq5fLFSQMu9Jud6WIBOXDjrz7/g+Zpu23v/2tnDl7ng9zq92T0nJFNk+dlkp1kRM0AB60/0gkQZkDbjVDnWphfstHOYnCiOBvCImYTpcb/uaUXCpIo1WXhU6V5mb4B3Z6XcmNhlKi6Q/mYLBAETeL+CTucBpzKXAUpCawpD4caxakzb1psGi/RzEwml4UJMf3BkGXFSMYZU+WRrpN9BZk453G2Nkh0ppmWWB2bGrWXLgDgBU6vyW9ghXnwp8Ynaysli1+9HOXhzM5D8GWAyrJ6p4DuH6eL0BiBeZO7K/nBNB0F0ZDKEEPnPICx5QByBFzqf4jmJF8sUB/wMFoIAM46uWRZSMvwwh+oyK5Yp7MM8AoJukQC5FSXlqdNidf6vthEu/1ZNjpS5ALJV8uSL4zlGAQS9wdyrDd52IFfbWQU7+tRrujdYk+rK1D/Mpq88jbIVlIN17gXEPVZQxp/vWfeQdEXORxgKTX7Btj4DLRvo6BncajWao4vz/oCRKbdTrNmblHuuMrU8o0enxuDPnqoXIJyTIe1/xuijZKKiGD5ZkBYPhFhOTVCWM97rd4pmH+pw4eKhwLb4JpLAjwlCvgx9jBJQtZXKfzE+ix7FrseXZdjtlNLPjMXsMgJ7l8KP1BN3FRcarRE5IwBvgijFu0OOC7nnS63SRtHPrrKB5Ip9+TEL58+SLHymJpX5qNthwc1qVYrsq9B49kffOUXH39Dbn/8DF1L/VabVw73h3juJLxu2kHmsbwW8a1NBMY++3vncvrimOheQ2ychvaeRRLDm03VP1MPHdWuL/zB+fiKtJxCWQ6ZuAwUiM7xupnqpTvUZkDwBMXk2GY/JSTKGkHl0f0BD5SdrznL2Mg+uxlvGJ+ljIAUyIq1wI9q2a7Tb+VK5cvc9WKgI5SoNHC+Vyeos40/Rah/adMkh5HTSgAhDaY+oLa+A4DaK+vbJ9mmAgmgj9UlHUsCZMGYLxbM78EMBOPV42szRm+dv5vpzF1WczdNLZjPAEe9RGb1W+OMHueC0J6Q0mbebOyekz7rQJa9ztDM07yhGZWighnm/Z0X2XXNCVaMiOMjx+OVNSbEjhuyW9wgkygS/OGc9GXTyTGiEVAr/deLS0Q8DfbLQnyoRQXEWVekl7ck96wK0VEXiLrGwSZCyoIHY0KXCiExUgqhapO6P2e5HM5WVhZFGRfazWa0m11pNNvSzlXkspiWcrVigzafem3+zIESz0aiORc+8J3kFIuuOYhA0TiAGARbYD+hvpykjdxICH1C0MC38AyiTA9cSo7jMoVJvWZrkcLCknaK90Wx5gJLYI62d2CUtzHSZR6ank47tcnG3+m+bhOYwb9e5pWkuO4PqIHGR19jSffK5ZV0JHg4TS754ov1j+2UOhYYwyg/2ylfz8ZDdxJ9Px0AannzhXylIjBhtSAvXZfev0et0ajycwgMBNjPF1eXKRVBcfVzCK6EP7TlRdnxfJbH/OCzQ0+I+iPUdkWkqPs7rxML3MAOLuYlSitETe5k5l/XJlkVL415ZkuFvdoUWlgA/cPD5kC7vyFC3L79i0OemaChWaV+QE6dnXCV89Anu8rg9/a56aYb5G/TiuFWlw9/K7Xk2Je/Qo58Q5gSnZZGzA3jhRUKpnrMmukxi+vzdw8m4wy9I3y/HcmfPWMKfSjjafU1wSTd1wf8b73qcDx954fW2oCYp9NZ+KYBgB9BtD/PBGeTpjp6aZmf4FEIsarSKuPEdi55Ibc6t/p9TnFzdj58hGLgPcLna8fGJ4RkBS9J5QFAuuXK+UlF+T4N8AkGZtCIGXkZi0XZQBamdc/5CS7vrkhFy6cl1NbW9Ks1aXdacnu7h59rRCB2en2JB9GUl5dlkG5Ir0OpIl6ZCPyhZyEuaKMumCj4Z6gAMFFlChROUAmAtxRRDqXLJdlBYKoNOBHPIrBYFkqNwBI1itnvUBCZ5f18nToeVx0sD0fiVjOGFwlGWXYriBJdPKctDM4Kg+ppP1+7Je0G4uZpqf10+P8BNP95ZhjHNkx65nSz2YEkgCIs+4NhNp47fVtArGjci9JHTsQZ0yfLVDdj5Mx0Db/tzaumcCzZU6KHADseSku0V/NjcV8D+ELCF9q5FWHNWVlaSm571kBas9RvjXoKYuQSYqu9eZagMeUOQCcWXR56Y9Z6QnPVszTvv+uF1shA9hhdYugj3feeZufPX78JFHHp0hqTqUMxhPDWE/RWD6AuMTs4rF4DA5x4HACADoTAr5nOqVCOfH301W9mmgSAOKOi8E3AYMzypEJcEI0Nngq/72poOkpSnr/0XMygOn3CQA0wWNP0DgL/MGHMWFzDPy5KFdrW2tvMH4+hKC+n9uccTOZfwDwmPMjCmUEZgxmXxfEYa/Ypx8PJQ+5oWKO4IkAMBLJF0OJijkJcoF0Wh2aAM+d3WJmmtevXWMQEj4E2wc3gMN6Ta5fvy6ff/a53H1wX/odmOu6ZP1imPlGWGAMaGIOkXs4ykm+FMmwM4AFivqBMlSwAWCK11AVrmm+NaZUPb8cmzfFwT0LPCX9aQqT9jz9yvadYMlPCr5Sp0mze8cFeRx7/Bnf6+dj7b6scmS8TuX1dh6WtCiktf9Q0hIwE89KiOlz/BsNDIlllB//xoJDwNohdRzGKf7UjUE6NkUcN8uVCoEggkEwTmIfptjs9eS1116Tjz76iGMg9vV9Er/LJc2ozsuLLXMAOK3oGOhWEUe14nzTm//5t6jTPpPP39SDBQEjcs9fvCiXL1+RRw8fctBbWFpMxJ8xUdvAZn488OXDSjwxr0D7LyXD4JuGbeDj4Occy8zEgvOVS1WCUTMdm68eMmRMmm81mtX3K/JfjczzJrSUb4tjEP2dM5hAKz5DY+/916ySnkzT302ArpNH8x4BiP6kZi6P8GtNQDpNviQvj14/MYCxIe5//qII4M6xlAkJ5cxxnLz5t+Z2VqbQbnmIHCYS5UJG5IIGhBkYgJCIy+0IPz8wfMMhfAELUq6WJSxEMpRB0B10pd1ox2fPn5G33noneO31K7KxfiouRAX+ZtDtSRQoM72xsizLH7wvVy5flJu3bsmHH38s12/elMZhW0qFspTXqlIYxNJuwf+rLyF8uaKCSNzTQJ5RIKNBLMEA2n6xyEDd9nT4UHMjCQvTtHbVMzTHdet/LlhmSG0bupi5HTUKOE6ig9Wn0CsTTLUxwBmMTtpX60i3y/zQtbsvTuP3o2km3qwgqGl/p900sr7zzz3tFk4CBsd93oCdWnTVN3BcDb7vKkHeIJZB38kEYVWBKHMvMtgYwnHqSnUP0gVql6+qYFDguKc6qKrzRxawXOZ4aefDsR48fEgzMFxrth8/ZnQwxrp+v3vsEH7cAvc4xs+rs3S/Oa4fvdCSNXZNKUF2Yr95ySpzAHhcSZh+1/FSXSr5/NUHfC+lqMOzOuOjwPyLAWxndzfxdbFij6WBDgMbxvApyJtMK2craB8A+qnnMGr7+oHYLOVSmh2Z1BSzY0yffPzfTmcgjvcHnGYOs2On//ZfjzOj+SZgn6VIHycLGGa9jie+tAn4eB9Jp208/t6JNDPegPXhzL8GakNMfQr+AJTUFKyfo28Q+AHsgQ1ELARGK7B/3BAMolG++RxSCerv28OuSA9BH5EUKkW5cu2yXHvrTXnnnXekGlSl3j+U3cNDKeRLslRZkBEyzvSGjDYGi3hu44ysrC3LwuqinD5/Vj7//HNptrvS7LSIvnKVguQqJQY8NVstqZRATcYKCCKwknBYV6MkmgHBJfHQoocV0QWuHzoTrtYPzcTMUKy/SSKBNUDGvk/6VsbyLc0gnrRkgqvEZDrJQs4CVycxAc8Cd1nf2fiRDQCzF0aznpmji/Rpz0aqb6d8jdX/Ty0g43EsngIAVc1A5WA0wxHGSEIViTSI0C1W6SudzycBIyg7Ozty/vx5gsCdJ0+Se/StJN+3Ml54/Kmv5Ntd5gDwZCXb/8oxgWkA6PuKvcKw8IVdGsAWBre1tTW5dOmi7O7uchC0HL00AcNkdkTHKqavFerPBkgDkj6DYD6AZgJO0sNR202Pj+KLSBvLCC24bGA0Dr5IT0AT7Xd0ApsYcmYwGanMHtmTcprhS+fancUUOmZu/PeUVbJ///7rLEB6ZFJMGKXs3yHt2uSNeeapxAHfAfsk3Rt89nAPAEQRzbwSqY9fEAZBiLbLhTH9/yJQbmPwhyAO9QWMpVQpSbGUD3rDnnT7Hb4/fe60bJ3elJ/97GcB+ku9cRjX4gOplsrB+soqfziI+5qKUEIZjHrSaLdkGLQYHXz1tSty9tIFOXVuS+7cvic3btyUw4OahDkI8CKaPEdgxyAJdMVcQAkZBbCK9XjbGtGSMEEmqwJfQNYKnAWdeLS6xcJ8rL6AfGuBq6CmiCrN98mBDmsLN9QwvtqIVnf8VPsYPZikwrOm97/3+sIE4+dJVrsZeBKK+v3cZwft1Xe7SD8X6Wcv/Vm6n2YtlI4Df/736f589Dt/HIKlYQzUQgjZo82B9lnU4mAAUDfsa+4tQ/oBwrzbbusiNUBGI08KCuPl4sICxzCMj/R3HvW4D8ZUMH/QCMRxTuK+8oJL8Jzvn2m+OQHjNy/PUeYA8DmLddDv60IE4AvADubfjY0NWV1dk+1t9f1DqVTKlN+AfwucnzHwjaPgVPcKhQOmra7dyj/tRzMhAu0GZx9k+mDRIojL5bFI9eSAqQygasplp3mbxYBkMRvTXtMTzzRT2FF2YrJkTWwJbzfDBOx/n/YJzCqZv51yDSgG9ewbC/QAvINOIKN4Ge3rCnPoqsQM9tG0bpBzCBkJS7MagB4mT7znZ2AAQ25hDkBCJUyiUk5G0VB6sUi+nJeN0+ty7uI5ufr6FTm9dUpanZaa1gplmn3jwVBgGo6iPJk2RKmXi2UJw7xERUzwPRlAkzIeSX/Yl/fefk9OnTktGxvrcv36TXn48KG04KMV5mV9fVXqtQO9l74iNRWo0MACagc6sk4FfxTc4ZWuB07XUOvUMXxODsNyxrFOmZLOMYEZfdEvs1i6owV1PzkFJL9N4/kpUbvHsY2zni1jsabtl/X55DVg8TiY+owdt8BJAmsyrtnMvnacsdVCBe0xhmHsOaztHwmcQtuqOXn8rGFcg+sA8gKbGRgLCYroBwr+FhYWEusGzgOwuLu9w3ETABDgDxv0AaG4YO4t35fyfbrXb6rMAeD04nz/4iCXU60HdMAoFyW+HozYgvO3lxPXzJZZA6OBGf3b+cCRCXMnfIYV3XEPxXHH1AF4tg9JegXuD2wwvWFAw98wU+C7lZVVeffd97gv8vkCkMGZefvJE7l586YOfoW8FAs5WVlaljykD3p9aTuZBI0CHgd3UE6mrQMn6pwgsN+XP/+Lv+C57t69SzMJBuZKqSyDXl+6EuiA2tdMImwfawMC15iZQQAm0vfp7jVIJXlPoneNBUjXbWrSmvDJ8pnANEuSnrTS36X3se84KSln6PcD7uBHIvrvj8v+Mc52YffhGNTEtDu+Bx7Xd/ejadKBPnclMG8a4wdAp8yf7qtafiqaBxMsWKpRMGS8BFNwQ/olB197mHsDKZSh3VeSgRMCL1WLEuaDACCvXFqUd957R95+501ZWlnk951hl5GVKJ1+i68LhQUCwetffhV88skn7FOvv3FN3njjdVlYWAIgi5l/GOx0PieNbi3YWF2TUz9dj6/8/9n78ydJrjM7FPx8iz1yz6ysfQMKAAEQAJdmi+xudatfj6Q3I9PYmL33B8zf9szmR9mbGRtJT1Lrib2QIAgCJNba96qsqtxj9XD38LFzvns9bnhGZhUWEgCZFxaIylg8fLl+77nnO9/5LlyUq59+Klc/vyH7e3sS+LnUm1XWraapuR/IoNeXYT8WHwAWNGCq5tTKboqMR2ofg3Ek8iuGQTJ6NLB79MA25tAF0QdQqVpKAl97/rODoAjKSZ56p8OUF6j2empnnu43M+7/wzRfWhHG9D/3Hip9VW+a0r1i76sjGPTic7aVpQ3FsTj3lJsUYvu73W23/0/udV/gKEWvOTCvRSk4qwdU03FrwIz9AfgCG7e4uCD7nV354IP3pb+/L7W1NX5eK3roAnYUayQE30VJt+3ttiwsbEm322Hi0e5+T7r9nsSDIffH1vzFd7DoOHViXfb29824Os/FDP6N8RSnRusBH2RabXMXy6XrWpzCQ67/Ya+/6PxzgBE++D19qBekKSZg7G3s9cZ3XeNr+zoeDL87xzO1SNB+aZdQx+2QdgwAj252RDm0E39RyPbFVujfjlYGH+65wM2KWr8AXxApnz59miEKFjR/9kxu3b1DwIZBEZ/DA2AuywGiROqVqpw6dVLOnDnL1S2yM/H5TqfH71jQhwERgx4y6TAgtObmyDiurZ0wTF+dQJP2gGa/1CdLX7CTzSQ0rEatKENXbrMYCncbsxi0WaxF+VyVJ67y+/Y33O3PmvRmff+oPjWLtTyMyTzqu0eykoa1oj+gxiwZ2iWYsz6x1i/YgHEAwhQsIW1eTPUOfDLUkCpGJxhSLy7M87z0R31er3qrriGy0UDqUU3+7Cc/kldffVVqzRpZZbxXAcMXeDKMh5xU61FdhnFffvfJ7+STjz6WnZ099o/OoC9Pt7fk488/k4sXz7P01vriGverF+/LfG1BBmmfNjDtek1+9M4P5fyZc3Lt46ty7fZ1Scee1BpVAgj0a4l8WTmxKlmcyubGMwkERuaeKUnnSRhUaEo9NtVuNPxr6g0bY1wypopBNTyICRJ2Rk5f4/VAiRJ+7mgdWMEolr6vzcapv1iz/a4A+zMm4cPuhzLAO4wRP4wdLz/PYrzdBDJrQ1U2ROez8V2cAJWDi12r6UN/ARsHw3nUOZ+fn4P0gNKXx3Eig34so2BSGhMPjFsAjI1mjf/u94fUlWIcfLL5TB49fkIPyiRWVhDfwVi6sLDAxysvX+HvYxG8s9PmohYPjLHNZqOou/6n2r5rc+m3rR0DwKOb50OMpM0v6p+6q84vcLK/DMP3TbejQjzu6xAoY7CEVxUYOYSE8ffm9tbEBiaKCNqwim20mlKtRjLfaku9rt59umDzpVqtSKPRZDk5gjoO5DFX0FhxA1wCKgAwYnDFYIxBE4Nqt6M1N20I2TWFnp4ozMpyrCbWFhzakDQYPzzPCpmaz+YGrCnjQv86+8/DJ7xZ57AEKm2t3anJrFx5xHm2PzpzMET2szn2A9s9EtAV1/7w94tzegRNwP0my2fKtBkmkN81lRrU9dXL8xDvKfCDthPGzovNOYkRlk1Sr1KvSKPd4PYQPptfXpWf/OTHsrKyJKsrq1KTKquIjCSRJE9yWHs0qw0P1i2PNx56mHhvXL2Z72ztSpppTeGwWs1ReWFza0f2dvf4uPTSBbDZ3nx9XjrDPanAILpZZ2Wailfx5hp1Waw18/MXz8qvP3pfnu1uG4PfJkHAfn+fRtDtpTnp7ffUADrNJRslkvuBBL5mfibjREJjo6SaVg0R26JzrC5iTCyLxBlbSs+VI1CEWLAqer2Nd2nBkRBjOiCwQOQvnNWp/br0uXKShtPfi5rCZWbd/Jvvl5MYyvfKrISm8vOsBVk5CmO34/r06UGUwCoUoQHuf/3+xJS+QgAHQ2aMSzZTF89nz56V5eVVmWsvSLs9R4DWaLQk8COOS/gMxjTVDKJWui5Kas2GnDp9VpIsJQAEqMO4iXHM6gUfPXjI8Q0N+3Lm9GlGOwAIMc59DXPKoQzvIa9/IYbwD9XKTLC5tMc+gM9pxwDwOW2W3cusv49qs1bF35WFS5nlcp/xHgYqDExYrUK0vPH0KQcoDF4AeidPnuSgiZDJ0uKiVKpVDY1g1ZvEkjNEoQJrTKLIitMMXoSI9LwRMDZqsrS0yHJMvR5MVTtk/cC6YDDFKhwDbaOuXluTCWAywboDP014MQGVQsB4f5LBpxVMytU6XMDmtqMYkMOejwjNHGAi3d8vNI2HiN5nMYizHrOus/t38TwjlELrFobNTGNJJuyvZf9MJoQte+27Wb7KdMGyhWFeAEV832T8IskDr6Osmx/5UoOWtBKS9cP3rrzyivz0X/xEFubaGk6UXEYSSyoJ2eVAfKn5TdnqPJMHDx7Ibz/8ndy8fos7vdhelGwMk91davmalTr3p7vfkw9/81u5c/u2vPn9N+V733tVFufmJQxgV5RJMhpKHo2lVW1wwYNM4ZUzq/LLX/9Krl27rmXpKihbmFIaAhBbbdb4G2AEMdHHSSIVAFzuM/omTpGvpehYM9jULjZRYC13pUbG5vTZKzRz8neBoTJ/s9/7om0Wo31Yfy6/Povlc++3o9qsBUt5TDqs/6Pv2zriVppj7wfVDUe0dHG/U5w700cx9mh2bkD2DwtOvIZtYYxrtupy8eJlMrsK/JoShhGZxcTIT9B4v2bwMUL5zKrUalVZDdfE80P2C1xgJMqhIbv82bNnXPB+/LuPikgItnHyxIlCd43FMQBm+Xr8qbUySXHMCr54OwaAL9COmihftLmD4ouG335Prbyy+0oNA5xNxHj69CkHLqyQr1y5ImfPnJHW/NwUsIqHQ+kP+tRNEQCmSAQB2FPgh4QRPADcVPuhQA4eWtTHRFVNLKlEqgUcpVKJQoaS8VhoLxR2DSwdF2tGnjWQLoAhhNosF3KAgeNx2YnCDcmawTyfJWC3zy4D4p7vwxjC5/Uxl510+419TaHB5HfK4G8G6zczy9j9N5/N7hXvl+xm3MbzVzJ55mulvsJjNqbOxCZI+qh4OfIQ+HlYveAfAIKYt40GEOxJlqN2xlhOnz3tXXnlJbl48WJ+srUm3WTPq8PXT1Lp9Dqs/LHgz8veeM+7evcz+fzTz+Xu3buy8fgpGbxqWPV2d3bYrwAA+ntd1R1FvodycagTvPXkqfz2Nx/Iw3t35Sd/9mdkYJbai944jFgVpNvvor+zxvLJxZP5X/zsZ3Lu7Dm5dvWa3Lx1R+DwgfshjVMCOGj9yHAjU32IkJ3Gu8PIk3yonn6aHOKEfY0+ilVRTIS4iDjw+qmrjrsYK8YWDfkqEwhk6Wj9is+bGiM27Ol2xaIzFZfNYfSK70wYPncCLi+SbNUfp79PaQLLZsZHjYmzgKCpGlPYFdmf0LUR7lF7NJq/PGEs9Vm1Ze4CT9l2sHcYj+bmWyohMP58kwWhaqfxGYBCLFx1nIKWLzErHjSfvwEml9o2Txe60H5S11pF7fSU1wIAc35ujosLLJzxuddeeZULmFu3bpEZ/Oyzz1ixBvvDbXx9c8ihzG9xUl/s83/QduTxf0dIlm+yHQPA5zQyHEdpvr7gDTgZDL8bvbO8qkcrh0MxiCMsixUwEkFefeUVWVpe5sAIfQtYul63K91el8keaEwCqYaSDMHWqcaGNi6DUbE61xV4lRVE4pFm+logBwCI9zEQWkG5rtQnE4sarvqOE/+gqMcJWwaECLu7XU7SbsUSPOzEhcHbhobtROeCsllZjPZve66OYv6eN4Af9rnnMR+HlXx73uKjDAgnDODsZpNrwGjpCwpACnsXhn4x86pPHrJ8ob9E+BVfIetnmD9mAPNZwSBCZgjRRxJQAH/5pQvy9jvvyHp7XYZ5X7bjbZmDKF4wgeYy12xLIIFsDTflt7/9rfzu449kf3ef1zwKQoZlAeDieETfvsBDIldFrYX6GX0Ao2rE/djf3uXj6ZMn8uabb8oP3n6HYeZKTQX9QGWVMJDdwa60G235was/YLmu9Y8/lZs3b8n29q50045kTOhIGOqOGhVqG7ORKVeHPhQhW9jUtObpM9eJZ9Xq87SerXpmO9eHCdZ4b6JNPax/zPqbiOg5xSSO6rsuwzjFOj5HOuK+7wLAWX2y3P9n9d/yeOS2ci1wm1Bg2cAwQPk1vwB3YJnB8OFBA/uqjgVuTWBsCywfPp+m6umH2uI6VkRmp3yzSDVemAVY04Ukk9zMohIZ6lic4H2MkdhOrY5FbkUuXLhA2czFixfk4cNH8vmnnxIIQv4SmIo4R52/P5VWDgH/KZ+LL9KOAeDhzSzIKWu3SXXF6vVFgdysEOp3qT1vEAegw0AFIPb222/Jm2+9zXAwdIB379yR3nBAhg8DaLWiYG4EQEYgNpRahNrAGCyVRcR8hnAwPLQwSEMTg21jpmq1mvxdDNzVClhCTKY6sNqQrbVfwMBK/U2lpgNqraaA1NQUhpHvMEH2csaQoQWgNvzrehZa9s0Fms4kOMVoOH3De5EkGluhxD3l5c+4oVyXOTFAYUrbh+25IND9/VnMn91/p58eYAbtbpjXp3a2yK4uvP4c6tPeIwA6gZ8D2NHCJYQu09MQb5DC6w/hUjqSgBXEZ7wo9AiOfJFLL1+W119/PT935oxUvapsjjapp1tszkueJQw7I3w2TGL59NpVef/DD+TxxoaGk9OMzPBwPJLOXpeVHGpRVcAuDnpDqdarUvFRTcTjYiROEwLBoAJtoifbm1vy3ru/kvv37uevvvqKvPbK67K2tEaFUT/tSave8nY629INevlSY0n+4s/+Ui5cvCiffvIZw8Kw/uh3+6xVHWBhAf0fcjoSOApUBPaGBIAmWQksJxk+q6zUVGkTStdaw3pyHe7X7TwH7YYmF3b2xPi8mXLq+/xvBgA8bAF0YGMltvAoFtH992HPLstdjq64940bBkazRvHzc0vF2IBnAECMG9bqZQzrIKcqh7J56Jda0QhjEzNzsdYk4xlyjKFVEDOHdT9QqUYXDmPDIupiB2AO8oZqhMogucTxmNGOoNvl70B/urS0LCsrq3LixLq0Gg0CTrCA3e4+WcMy61o+dy94fZ83OX13Ji/S5RRR/OlWaHjBdgwAn9ecUkCH3lCF4+t0GGLqI24B96+NAfSc37S/X3427rEz3zf7if0/IpPwMAYQpwMD0A9//GP5yY9/LCtrawwB/+pXv+Jgt7y0RCsN/Bvmp67HH8BVs95iyA1aGQx6BC0mrBVFuiKHfhC/1e8re6ifTyRjYkhKLRcaDaUx4SPMnCQSAqiFIfWCeB1/11sNgsgRwN5QAeDqiTWJ4wGzjjGg2moiYAntAD+ZVBA+1vqfipsm1UbsOZq+xua6q9ytsN6QfFIhwHfw1GEygVkMRzG5mbJrZXav3F/5edNjYB7s9o4XacWEW54GCE4ME2xCi6zxSyZQQ3RSePmhApYvY5xCWLvAFgWgP8SErJY8YDX8CAlDAbV/f/VXf0EWpF6tSmfQkdjvSavWFIlERuNEWkFVhslA7jy4L59fuyp3b9+R7V2EeI3dR+7LXqdL26BqWJXUG8v+dpch0UatKZ2dXalXa6oFBVvH/qf2NTCHXlpepFfgg3sPpdcdyNbmrly8dFHOnj8nS+0FAQhcai+x1u9uvMe+s7K8LH/xFz+Vly6/JL9699f0DtyGLtUbE1iksO+oRgwNJ+MB7WJQ3xgJImrYjJNl+oiptWyvJOsd4z7h8nQsYxqp6+kurrb599EzttGmGXL2i7aiHxbZwHr9bZ1j+zd/wx6R6Xd4BmPLesh2XJnyOZyMoy5DmJl7Zapfl1hu9/7AQy2ldIFIQFWpEOzBbQD3dqPe0jq89Sb7Hj5rjeYB5KA5tsdrq3RgXNAoAZg9jDeZxP2BxGkq7QaSnvSzlXpNunv7fG74NS4uxulIj3sMX8ARJS2wquonOjbahaetjpQi+hE/lp2dHdYDfv311ylJ+Id/+AeGg+2+/TEwXuU+e2CsOex7X7DyzXGbtGMAeGRDDVIdZCzzYwcH+kfh2UeYcCxBFEiWavF69FwIdwEYIArHKhI+F+iiEB0zhADmBB6CThT5qBDIYfs3eZ79sGEHq1lR8OJ8h+BV92NWCzFppikHTtiwWEsWCOjx/KM/+6H8zd/+K1leXJKPP/2Ekx3r/Qa+PNvemulDVfg7GYd9XbCpMAz11RU0wYh3xNmJoZpKRE9BrLBr9Uh6fS2VVKnA+sOa5uYSRL7Uo5CAC8wekxGgvQJQTGHBq4AsqkUS1qvG525elpfGMowHPEZk2HU6e7qS73cL01eGNsFMjsHaQLgfShjVywwd/QURvmR/SWIPBsdaMMqeA5zvQEt+IXyn4HtKJjVh+mggSI2kPXfmt1hPIk0yZeaYkYEsUgPmmUCjFVYUkKLumsfkBPwHDRwsVapRBemmxiZNJ2h91uNJC1G8JZ/MfhWxP032wH3AXbBA12QQ55LkAOso14YQaBqJ9PJYpBpKtVGVEQAOzlVFkx2yNJEFsMlvviFvff8NqdXglTeWPIm9FsDTWCQGqxxVvEpQlevP7sqNGzfk6tVrsru9xzCvH9Qkx33KiTkWHz+aeJIOxzyIZqCZxHmcSSShR63eCCwljsPnosILYEydy2B3IH4lBED0dnf25Dc7v5Fbd2/LlddelZeuXJbzZ89KKpjUc68aoPxcQ0KCD19Or67K//L/+L/nH33ysfz6/Q/l/uNHEksmXrMiSQaAMZL6fF36nb6giklYCVkdIs1gWD2WCvSDPOljLmJYjYLJu7DPUaANRp1V5qhrNZMhLr/1CCxC+EbnVnjkmSzj3C8AmWXT7AKNQMQAEyt5yEsLFbD1YHQ9ZjdrpWD0BYS8kTxDZtNWsaPljXYh/GY+Vh2m/m7G76IQjOvjZ8ENjhunAkOmLmaQRKOUv70n7BjNfmv8RG3ZtaWFRYI+hE4B/FgvnEy09nRkZCeuHtGshwlmqQmcJHNwf7APGMBg9QgrFupIqzKEJyqTd+CBGnMRg+o0w2ys4xHvP9VfYts4v8a5Ss9nksrIj4tFZMf4A+Ja3Lx5k0Dw4sWL8ld//ddSrdflk49+y/3BsWHsstEOzD/2GpbnkOnF/PhIJvAFgFXxvVnz1yziZPK3YbrZFyYL6BEkQbgH7UKaZR51zCm+SqmI+ug6FLUuiOkxmucaCzluR7VjAPgF2sEwn/uus94tl8X6vbb8SzwbBtIt1zXFJE4aGA27IrVWLhhcwPz9+c9+Kv+Xv/s30ul15YMPP5Ct7e1CQwfwBM2dhm+nmzuozLJoOUoj5zJsU6yXOSStvKCslKnAOm2CW0pQsBMe9Ijw9AJDCJ8vJKjgmO/fv8tz0OmqbxzYg0qkmczUNw5TCSoVqZmVu2UbEmsfEWmG6pgMB/Y5M0bIGYXjAQCLw8MdpmEqZyKXPc1s6Npqm2BmrABZQ0ucfNLJd1E1AwDRFpQvyMlZ4beimoV5nfboLttpxfhg/nC0E+Nn2LZgcRRLLN24A/GnNBfbIvVA4iyVVnOO5yfLRlKNqvLa5cvy9vfflNXFBYkHA0lHMfsarmMfAvsgkmqtJk82N+XmnZvy6Y3PaKiLMCvgfcUPZRRnMuyPJB1APxiJpBkBO4hXAOSAMgEQsTqhTEKZPhlZvQQ+w7O93R6rjVQbdWYsY2KC3hUaw9t3b8k7b70l6yfX5PT6SYaWAXYB3qDlQ1h6d3tX3n7j+/LS5Svyq9/8Wt774APZ6XSoJaw2mhLvx7K4tiLjLKMFzbDTk6gRMVveH2InE60gYhNzcB2Z0IB+5EvGBZ0vXjrN5hUg/MDdZ42SjbE02DmANac/2QfrfM+waZk8fC64rHbWfp/sVZpInpjEB8tOznhG1RUeGxaFfNHwyAyDZ/QZVNCq4BzSAfRtLmCSVPIE/UZDthppGPC7YIytRRTlJ5GGdO1+2n2dmAkbtrp0D1obKdfuxh2DsiJpxxhNm8Wo3rzCBA83HF24ShjWvBzSLo9/tsIRz8x4zAU2ZDHrJ07IX/3VX8lcqyE///nPmTGM47U103HP2LKas6IH39amdcEnbVpwcty+7nYMAA9vJj1OTQBng8DpEMVhobfDVkbfhjZhCJ2QcOl9DKxkwESk2+1xFf3GG2/IT37yEw4yG48fy7PNzamJA+0oiwL7dxnYTO/X4efPBUXP+41Z29WmoXBMhmAsMblA3A1/wjxXZnFhYY6MIELbKMe0vbXLQRkDbLVeK0YorFolU3bYMmgEaamXg6lhwoMNxfIrY492KRJ4niln5e7z9PnBOcg8V+On5ISnbFGROABGOlcmhpwj2GkTAjOA0HPr0qq2cWoFT2YM+587mj8LtkvnlNdAxszxYFDS+pRoNm+ORI7OsCfNqCEhqnhkORmwJI0lyutepRKIh7DYOJUz6yflnbffkksXzksUeKyW0Wi3qInrDgdkIsECp+Ox3L1/R377u4/l+vWr0o/7/CxwdSARWGMvHY0lHwGEgfHMjDBUq2wABCJxguw7rFpMv9cQtvYHhGQ9hvtziYKIzD5CfEFGvxrJ0ky6SUf6na78x0ePBdrAd956Kz9z6jRArAdmDbwukgtOrZ7wdvtgJiX/lz/9qbz+6ivywYcfyfWbN2TQH9ILbpyMCXaBGObm21LxQhnud6W735FGWONCRqkmNX3G/jMMyYumrJpGKmaMKY60w8o2yvcT2CyCKYd1s8CH52lyxTVki35tTdGN9s0ycLP68Ox7z9yB5netg7tlAItqJ4FqgsHOqal4SDaUoAzh2ChQD729vgK/ep0uBFjEYZyqGa2wfTACYPd3Kit4dhk6u9B63jEdVmLRTcSaeW6OkG3YZrXJNjkNTN92pSJz8/Pyox/9iOMSMt1dX0Cb6OIygLP240toAl9UM/i1tsm5eX7SS3mdcdwOb8cA8PfUDmOuitWYrUP5TWoXEDJkJQwLAg+2wqAZ/lS9Hlfef/7nfy5/+Zd/yffef/99Dsx2xYmVKEIQyNpEyMo61R8GzsrPswC0fb88ELur8eltub8xPQG6z9qUI0QmssXy7tu1aiRrq6vUdXVRmxMgcHub56K/AwF3i+FGG7a1bAhYFUwetnzUwd824X/DRs46LvdcuQ93snBtaqZ1h/pZGwK2zIed/KyUATqm6fMz0XdaDY6CVgMebOIoGU2VD2g/hvYJtXuhZ0NYEJYvudSqDdkb7Mk4EWkvz8tiu023Pugu/VRkbXlNvv/G61xQzDVaDKdm+DCqeKQjhnm8WkRsiYodH33ymXz88cfS6fal2WhIkAaA0IWPZDbMaLpc8arM8B0nAJiMkRLMUHsGrGFw4aRfarUNXAyATpanCoSWRCMYUcc6oYK5q1VQZSQk6OoOe/K7D34rd27clleuXJF3fvCOXDh3nvuL/tId99WfshKS572wclrW/mpRzq+tyaefXpWHT57I/qgn2TiWRrMikvkEljiXS+srMtjrMfQFkGbLixFrmxCvVl1RfraISrxgIoCaoU9qZHsO6CnKJzr2MXzPhBWLyhqRst7ub1nQYSUz9r0ya8+7wLosGKa7iESYBQuYdDZbajNJzfnQ/UlHQ6mEEasQwQsU4A9jkYans4LBLI7LMX4uTLVn3GPlhU75XLr3oMvwzarcUx6nprY7w9jbbWA00X9wHtG/AWrR6BH48cfy+muvcCwG8H3vvfcKnSJYQltSrcwAutfjq7cvV0nmi7Ryn9F+f4Qm/7i9cDsGgIc3XXbPWDEXHzgEtBx2k5VXMF9He95N4JKXh3/KP5Q5wIAGexdo/pCogYn67bff5oBz78F9DVGY+pm2AgfZsUqVE6AdhGbsz6H7704o7grcPAofvSlATZ+9yW9MwJC7/dngCqFwdxLgRGH8xZIUiSewdwhlYX5RFheWpHeyJ5ubW0w22NrZ0zBWpqazAL9o0Koh8QCMBn4PNg96TBrq0v2lBUr5unDnLOs8HA49M+Gy8kj5HAKslEPAyvhN+iS/54St3HOKkDR/lGyk0SZpvWQTJ3cYCv3F4tbgfmQZiicAk1CGmPljQUUPmjtHnoyrEN43mV0Z1gIZJAMPyRDrp9blwvlz8v2Xr8j66oq0620ZyoA+kSinBq0nmB6wenvxvly9fkN++9HvWDoL/TWq1mQYx6i0Qas7wECE023NXS/NZZTEEuZKTAJoQP+H6mk5bVcAYKE7NX1dz7piJz4UEA5GfZEIljSheDhVsda3zvMRTaeb8y3pjfqyvbUjv/vdx2CI8ytXXkYCiAf7jnE6ypuwKvLE66CmazCS5WZbfvj6a/n60pJcvX1brt66rQxOFksUVKXSjPhbgRdJBmKQ5fWwS4iZmmQJXjvbf1/EVLnM8CuzDEYVQJnhUaNrpl/nSBcIlUjtlvCf3hMIyeoD5y2qBkWfce9bTehCCNf+qqtHNv/GeacH4qQ0G4+V2zIAEAld0BSbvk/LHrCFJgsXwG95aYFG8xh3sD1r3QRJRwX9aNbCD79L8GVkIjNsbuzfh0UnbEjXBX9lJu+oyAa3b0P2M0Cafd2OKQB1FthZbTV0gd/73vfk5Zdfpl8gFqg4flrTmAXoi0RG3LePenP258cu4Vb6/qw++eLA7eAce/Sca3bAqpWPA8jPaccA8Mg2WWlMwmzlVWD2nQ4BHz4Y6OvQvyETFwMPJrR/9Td/w1U2hPf7va60mm3p9vvqtYbyRrUaQWHPvAbwOPmtg79tKpVNJoAZ5svlcK8LZCbJF7MH8XKY+MAxUwcJHZAL/nRysYwe7R8yJIkMjddgJOvrJ2RtfU3uP9ygBnJvZ5erdazSLUOCVoevHEXJln2AfL3YYU5AdpacxUK4IXLL2rmMn4KR6TASJyNnkuL3TD8+wPC4gmybTOP2TR9kmdkus5kVfOj+afJAwTwhzonDjkTyqifjMJfBOJbWHEx0I4rhERY9e+6svP2Dd+SVl1+S+bAq3c6OPNvZkFqrwf4zzBNm+MKM9+bGHfns88/lo08+kb3djrRamr3Z7fZlZ3tXIptZarRkQW6tVsaS0nZDAQqMxTHVc38NgB2rmNHgXC1azMNTJxad/MGS+timJocA1NOOhRpHkc52R5oLTVmcW2L/uHrtujx4+EA2njyR1157Tb732itkCbEAwH7Dj3CUDsXPxnJqfVVWTq3J+rlT8vFH83Ljxi3Z292XMUB0JjIYxuLVQzKqqojLqC1knbexSAgGzFyqSZ8/ivFzxzI9ZiRRoY+g75KtM4ygm0BQXjigP3joYzKWUXfIY7PaX3tP2v5qK3HMfqA/T1hp7XcWDE6qdiBbPxsOCfz8ADrdliwur8rCXEtOnzzF0m1kA9HPafAdGC+/Km2i7LG75wDXjolMyDo7otnjKdswWQB2+LFN7j/3e2VwaBnJ8nxgP4/jQBSFVWZMBjI+a82p4VyAxQMMpBEOhh4QlZjAhqJK06wkkPL+fHPtxX7bPad2oW7HqePk36/WjgHgcxpCIGBZHN81ff05RguzVn7uTedWTfgDtZl324HBwWqGzMvQxO3u7nGw+eEPfygnT52iHg5Gt7BZ2d/vMJtOwZ81bdYMPHwH9h4zf8eEwcHWUL3GQVYBYRlAK1jR71vAeDBcY1+3nIMFgFBJzQZYZP5mXAbFZspU2NV0u6rZvtBtDaBJQ5KHiJw+vS69wUCazTpDw9ALjkYxBfAY3H3RUlKYJPk3y9461T2ClBjQmWSnKoVEUUSZnpvgYUO6+H6zWinAnFv32Cq3AMKtKN8KxK0ZLhr87rCIcTR/DlNjgZHZoq6ri3wRPb9g3RD6FWbzSiUXqSJs6/HvuVZbBsOOJKPYO3V6Xd548025fOVlac21ZZwm8mx7J19ZXJY5L/T2ki6Nn6t+TTY6T+Xzm9flw9/+Tva7HdKLYHuG/Vju370HyjFHmTZJRh7Y12yU5SksP7wxElIRh1Q/QePBA/inGZ0AJCgVh16BzEx7fBTRWW6zyJWq+KrBo1IC1jKSS6VWkbBayb0ol1GeyHB/IMPO0IsaVZlvLzAD9Mat23L77h25duOq9/0335SXLl1i8kLc7+aQFVTCwBsNh5LXqvkr5y/L2TOnaOvxq1+9L7du35IEera5hsSDEcPhOYdqBegsqYx+YOoFG4pzctVt/eB8GuC7zF8R6uehKqMHcBVWFDwhoYC6XwMIXe9LbpMZxJkMB70Ja2zYZ3uvuQs0O36WWTKUe5lKPAG85LYmix3ruoD9ml9YItu3unpC2u2mpDSW14ojzO6N1IgZOk3arFD6QMOmA+ye9urJYvMAQC4tLKeGSSep43mMn7swLctBXAA4CwRiXIXmzzKBdmGJvwHw8P7GxgZfO336NC2T4C1oz92sY56OSh04tOIt+/HS6943oQmcLHqnXzsGgF+tHQPAF2iMbRVhMGdk+BLtWwAEv1DDavvevXv0oPr+979PJhADDmwHmJXpedJqt6gNxIDL1XcV+quA+qlyqafyYORmzmbIjJ3KTFYBOMCfHTjLYV53cJ31GzaUeyD8CaDkQQM38UWc3qY+1+sBgdOgryJzAIh6rc5axgC68DdEePP06VOytLQgW1s78uzZE9nf73Ll7o98ZliGsMkACDQAEOG2FExPYdkyyUwsZxzasBwZLmQ0QlNmDGHnFuZ5fgj+irJYxjaD7JVmrsIbESwPJhPoF/FgKb4Sg+1enSL71wIF4yVIpwV+Qq8NKnmwigcsfFDwPhxTGwavv37Wl3q7IZdfuig//uE7rBSj+9KTKPSlPocQao8eeDCBhu7v6v2brOJx/eYtagAtaOvudWnsvNhs09A5HQwJIuEBCWYtqGoWL0NfyViSPIXNi15PgiSnr5gsVg1puuBIDZYNJ0ztX5AbzRsrDGt4OctRPQQm1iAZc/FhHo0FTAKgnktUqUgQhfLptevy6MkGdY4/+sEPZa25KL0EfQMJIHWk0MjucJu//sYbrzM0/pv3P5APPvpYnj3bkkqtrtgU+kQYCEYK9mBZgx31YWJ+2BhS+JMe3rBAqNeaZPVxT0NXaUs78l4xPoTumMWFCOxdxqhhm0k8GBKMoL+797ut3GO/54ZJC60cFtgWABrT5SzPGD6GTVGvp04CK8tLcvLUaWb1Npttfh6/6Xu5NKoNqddrvF5WMwjzb0Qu7IKJ1/OAHEdkGCcl5nw6lIsFZ7mqjv2bLCCtbQ6iKHsfuox7OZLBzznh81kgkKb3pkoJFm24f1mhpKIVbNCnsR8owznXbstLL73E8RkLUYB4e/6Lfl/ax2+8vUAfPW6/v3YMAJ/TbMCrvIIrlj2FdcL0JF7c/IckL9iQow3VHXZzlgFUuVlm7ND9P0QAPLUKnQq5qnUD3rbVMTCQv/rq92RtbV0+/fRTllFLkn2pGRd6aAPxHQ7C5ne0nq+uYMu/bQEYw0nGWZ+sloQHJggQiLrKVlpGI0qYhMae0bcY7Z8yZ2D8LBBCg4aPZbhM+ISfsYkaYKxYmkkrAyiLFhn5ndbuhfkvVt5hqBrHBOxmiqw8zbiFUz9YK1QWQTbrwvKCtBeasrOzJ7tb22QF+4OYIKXVaErk+dLvDwkA66ayCQytJ+fKz23iCNjXwaDPz2jmcZ2TGoTg+DdsRmgKYtg/2/c0VAwvrTF99PIRtidkKVutRlHIHoCw0+9wIh30evwujLtxLsaFlor1ZPU+MOXaABrVjBj6MZ+hOYCdZDxiHkVUq0siMOOGl+NY/qe//Gt56eXLeaNepd8azlutXvFYq3kUe812i9ccmtKPP/+cC44Ofcy04D2qKAC/RUGFEyayPv1s7FFfGgY5ADr0XvFI+yE0bbvdPWnUm5L0RwXDrBZ6qqFjEpYhwxDyLxYeCEnCXIUMGzKqkQmbqb2Lvb/TXLxsbLhmj1o9Pwtz1PVNg8SDZjDOY4nHI/pN7vd78s/vvyfXbt2U77/5uveDt96WuWgh7+UA4QMP4WqaUXsCPVv+L//6r2T5xIr89//xc3n8dIv9IKhHlCEgBI3zp4lL6P/kJyd2Jdg/hidNjWHTd3BOlDUaSjwcsa9hcXdh/aQxQlZvPAtIlGUOCLh1bJgAIFzzgEktNclGsTQBtlqtYoGB/kSGXAcRe+PL2NTknrD6gSSo5MKFBSItGQEppAL0BIx8WT91ghm9AH6N1hyPZ7+3X4zFkKAEIWtiSxQG0qioHRPucWgmMSbZqh52/MmsEfwwZsk13i+GXbdjj73HLdCz7LsL1PD7rON7iH7QGka74547jxAkOgyr/Zz9TbsYtPc1GhZ+2F/cvxwnRBO9cJ/cvXdPzp49Iz/96U/lf/vf/jdKdtw5wN3/gxKQyRAtX6CNMfF94e/PkkgdjNLYhuuJPkXQO5ou7QepgDsv85yRJYUNAfXV3wKU++1txwDwue3opIVZq7Y/pobBBqE31KJE6NdqUWylDDdEazNf3RWvBXplgOuGLdFcQKqTtZ7XYuC1n+FkoYPm5Dv8/yREbCZ2V9dn98X+JoFCpPU6kQlrASDYJpcBnGsvcFJS1gyhpdSwtsoUIVQMFjHysK+Ig4IRCqU11yRYgtnx/u6ubD59JnuPd5jssLQwxwQErNLBegE8YRJ2AZy1fLA1SbGat6yf+jJikkAlgZCTFRIisNuWCQQ4DPxcdvf2CrNULY1XEZ+MAgB7XeaX5jl59DodZhb2espc4hrj92BQbNm/BOwIjIFxLsHwwojV/EcQgqoJ0P+BVfTHUqk35NUrL8nZC2dlbr5VJArBkobHhRJansj9x4/l2o3r1DLBZkftLEy5uBT2J2NlirwRgSATO3zV9lXrjamQFxhZMibVkOHM0chETgOrb9R+Yf3arF9eISFgV6KqULV2RHlchTj+nqoVhODRh4xAT4lJjzGZnUhm8FFeLpEc7KDny8bmM9n551/I7fv3KNy/fPG8tCptmGXTwqc36DBRpdWYY0YxgPV/+W//Q/ZRySQV8auB5MNMPPgaok5yrObCqJqDrGD003Gsma8RtW25RNUKJ09UusHn2q05OXVyTtk+eFrW6kXmKPrJsD8oWCMyyE6I0t7HvH+gERSwby2tQpLnBJTYLvo1khEQLXBDw/gu+qDtB9hf9CPIEzS5w2RsB0JghgXLhUsXaP+D5KL97h73pV5t8HfwewDnCPvyvsA97Qf8DXvfAAS7ZR0LAGhq+cbGmJ+BZMv6GbB72MNtbmShDPJmMn6lSMSYUY9pADjLPN9uu/wbdry0iSH9/oD37alTpzQC4YC8siXNH/O8ZRiBY2rxOe0YAH7RVoQoJ6wZ2qwBgv/+NtDs2qa0WwfeLACVyYQ0DWzfK6+8JhcuXKRGCYMKgMMI1RMY95sMYG64Q7VhE13arIFxVoJGebAF0HRDNBDlK0NW6IasMs1kz/omT0FfAFDAitD3fa3QYcAfWYFKIM1mY2LdoiwamT87dtAIO/RYFN7zkKRQIUCjMDtNpDfs6nGZhCACC9+jTswPfVlcXJCFpQWpNmry5NFjVn3IdhNpVfV38Xn7+zgee7wW9IH9wD622zphu4wqS9U11X7HavusGS4SU/omKYWAqKIMCGowW08xiuRlzHq4rXZTmnMt2d/ZJaBCiLbXizlB26oiLO1mk4ONfxw8B8GO4VWUcPOqSBIACPFkZXEJ1Ty81ZWlwn/NQwm4DBm6OHcDuXXvLvVyN6/f0PAWKobAYmWc5wgBeqOxB+NmsX8juzPUc4DQ9igdeq12Q86cPcvzgyxceFUOBwNvkA7NCGcyfmkECOWfZjtr6RI8mcQcZ5FhTZI1KF4GfvZW0tKFDCJ7MMrR2r1mE/q/WiBxH7Y2qBIkstfpyLOtTXmyueXdfXhfXnv5tXxlYV6WGvNSr8DWJPZg8tyuNfJLFy/JhQu35bOr18g8V+sVSQYp/QDBZDIpxMd1tXWBx+yrIcDfWBdvaaaAAczx0tKKrK6sETwBDOL14bDPMDp8LNEnYCycphWz4OlIo1Yv+mK71SK4gEk1GG2wjai4gbrMlrVGQyb39s4O+xGTxfb3C5DORBgTzuzHQ2lETSgxCf7Yb6JA6s0aQ9LthbZmlY8TSSHCtPpkOEt1NUMYtXEte143Zd64UGKNcWXFubgz/c+OIyN6CIbiDVQba7OWJwzcRJdYzvB1xynX8sYdSw8b46YWpACAqDhTivi4kSQXDM4CbG7tcoxViDicO3uWWcEffvihVjxxwOWsMPgh7dszcX0B5wjnKwdZh+N2oB0DwC/Qpm5+47s1a3X4XWIFj7pH7AD3yiuv8HNY0dtBvFzB48Dxmu1a/zl30HMTFmb9vrs9yxi4upvyw3xpCnDb7xe/4YQWLOCKaH+BiUIze90kCtWHeZz8LCPm1hWNh4kMk74Ew1zi0UCyfsIyUAh5Flmz0CnFCgxX1pZpKr35+Jk8efxYdrp7TJBoz89Lt9Nn5h5+A6EuCLnPnj3LTD78jW1hwnTrFNuQEICezUy22sCFhQVZhTYsy8jqwX4EwMMmtNRranKNTNsEXnv4fhjK4sKitBtNTqJPn27I9t6uZPBxhAYTCRWhyQyFuJ8m6HBfDiQz4Apgm/IBP5dqrcLEBpgjY/IFs6ihuIr0Bn15/OSp3Ll3V67dui27O/syGiYy11yQRlST0TCmnhSg2mdtXthN46IqyEDyEf0IE1SqCOTtd96hPhUhdWihbty8LTdv3GCWMNghsnE0TDaLELCK9DA0oDTH9jWjubB/L/ChlVBM/u0aLgPoclOp0QfzS1oSjSUkxZMYJcGqvjRadUGiSG/Qlfv3H9BK6NnjLbl86YK89cr35MT8kkQVX+JBXzLPJxi78spL8uDRY+n1NqmvxLnPwRpBA+gD+ISSINM1VaarUo2oz0tjBTNgfNEf1tfPsD+hz6u0Q5l1akprFWY6o+oKWTlPzHdOyMrSChMyRjGq3gyY3Yz9QxgZZfskmdyD1KSacmtLi4v0zrxw/jzBIML6YHjRzwEIwdBhHMG5YEm7WiRzzTa/25pvcV/b821drFSQ8dqQRqWp44nxAAw96HGbWkXEsIt2u1hE4Pgts4/r4boMqNwhkjEtgfQ8gAUsgz4bgXDZs6lQrlMpxA1fuq+5Q2JZDsQKQcU8clDL7Mph3PHRNjehCws/XD8AwPPnz8sHH3xQmEG746r9Df33ocP/gd/6Jtph0iX7ni62ZgPbb3rfvwvtGAA+p2llMRMTdAGP44+mg8M0I/gtbIfumL2RZrmsgzmAcP/xo0f6+tgj+8fBc0aCxyw20IIu99+uVUo5pGE3h//ZAdgZiKn9c7NZed6LLO1pUOp70ARO+aTZLNvcZT0BMsgWlthK6KCYQ8BarDrRKFOXSJxUZfS0L8N4LKNkyAcYFwBAhO/wOViXYGAmwJqbl+X1FVqUPNnYkGc7W7TQsQzNlStX6LOIbD58F4zYe79+l8+oAaohWujGlHHBZxAqs4AWkx8mYHqjra6wUgBA5/x8W9bShNvpdjoMF/NYDHCEXYqtIgB9WXOuKSfCkzK/tCgPH97XDOIkYfHTSqXiIakFjUwaEjQCnxmutGRhxrMn882mnDt9UtqVusTjIUOJYO66/X5++84duXbzpvf5tRtSqzVoeVJBBmruy6g/krg3QCUPD4kUBDfIk6EWEVnTvqSIyPpjD4kjZ8+el5/89Ceyvr7O0nzzy/NeVK9Kp78vw3Qo4xHK0+XiW6NC41ZGQEgfQ/xtsjnBYpI2nrB8jklOYY7tOjcGHnSYsJeBnkuzOllyDz6QqGc9GkqtEkgwDvN8MGa/iLwQoVmvElbkzr37Xqfbkaw/kre/97qcWFqk304lQs3iRbl4/oIsLv6OCSHYCzBiCK+P80Czrm1JM0+vJaqKoL+hTjLY47XlkwRV7fYi+wjOJ5JU0GeQvNRuIKEJwG8kYeDJ0tqazC/OSRhUWLHl3u27rIv99OkmFwW7uwDrKLem93fFQw3gyf1uyyWCwUOIFkzUqZMn5eKFC2SnEEX4/PPPCdQ3dzelUq+wRvTC3LycgN5vdVna8y1pNVssv1etArBqogAYvqhSlVpU50KnUWtKNaiQGbQ1rNHYB42W1dYy5hXWhPApoOaGRydJINPefmXw57J6CDuXF7Q2aQ1SDHdsnNUgm5iKcBhw6yaCuYCtrEN0w8/WLBoWXEvm/GPRbrdTzgwus2aHzBPlLN/nZf0eGWn6utssSZY+f3sYzG9zOwaAX7IdFvr9FgPAL8UAQkuCFfWtW7eKwQ1gAWAjYShxEvI9LPRbft/1DCuHhsvNXYG7q3JbI9MCQFek7fp2+Q77NzMbEQAgmFw/d3LAw2odbXUB/L2zs8UJcW9/S+4/vCP7AyN8R5IKQq1kwRgUJZuBibqztyd37u9JLYikVqnK8uqSdCpdaTfa8vLllwn8cK61/vB9uX37NrP5MGmCgcTKHsdqAbQdwBHSdc9VET6eQ6JIg0ziyfV1OXX2DEFSr92W7a0tgkGU17Kg1n4fCRd2Gwz1pzFB5+7+ngzAEMWxhOY4Yf+TejmfAXqRgVkZo0qGx1qsJ5ZWAIXFH+fMLg2DSDY378vNm7fk8ZMnBJZtP5Ikhyh/KINexs9m0LGxJOyY2rYxqngwwxjn1ZcRAFfosybzxZcvyomT6wSxg3goi+1lOXPhrDx4/EDuP7qvNjAI0kYIJRpgh38EhsmjeM9DUgdnLBbnMxQgzzFeN92SNe8MACxCdqyD59NgmmpBW7uWCRrIUQEwC2U8goVQj30EIXdkQGfDVFAuD+bWeT+RhVpTVucWpFmpyTAZShL1ZbW9IIvzC7zPAISgV00RdoffHQGOSRhipjQSsjTEj/DpmdNnZKG9rOFys1gK/Io0GlVj8AyJRUy96NpKS5qtFq85+vK1658zfPvJ7z6aul8s0ISvIxY1CEeDZcT9TPDR63Gxgpq1YOSuXr1KIIp+iIUNMp3Bal+/fl3uPLwrfs2XSlPB6uqJVdXOhp70R33pp4MiAQAAVRMmAqmGFbLnc815WV5YldXlNTl54gT33WoLLdCxLgMFYHJKwREwYeE2mkgoyqHeWYta11uP90EpC79syVQeU6fmC/QvoztkfzJZ17PGxGmgOEnmcI2h0TBmKIO7zkVjUdbPAY1lPeG3tT2PAXTfO25fvB0DwC/YJp1wuqzRtxAEvuBKzOrdyplZOnFi4Ka4PBMyf7boOgYUhIyQqTkrDFwGUu7A6D7KK11b6cNuK8uy3Ax4rFVr/wYTaMTkzAp2WEJm0drPWyDohuvLYNJPffrYwbYEbIKGf3VwxCpas+46nNgePXok9+7fkXt3H8jW7lNJ01igNWNGZiUUD7oiTMbIlAwjTt5M5mhq2DVPobmryJmzpwj+Lp65JO2mlne6dvWqXL9xg7+BSQ+fx6SmpraaYV2WHQBl2PNoxfV2EsQDiTuYIBaXl8jG4AG9HOuJ7uxIf4AyZBOtEcLVNvsb2wMzSd0h7Fi6ZA95flF1A0bNCbLwAAQCJ1SGesTwbatWGY7Eg8AYGZz7He/Z9hZD5e3WvHT3u+KNPAkz1ODV8CySPDAT5jEYx8gbphB9IQwdyjjyvCzIGUptzc/L+pnThYYMYUT8u16py+mzpyT6AGXcYJUBtlPtWlAFhODP1LjleUOfgM7RViGzef8mW18Bn6kagsl+ykgcYECTVIgPIQEl0NT7KIRGbwiOMPUij2Aph61M1ovzThJLdW3eS8a57He7+fbWtqTxyJurtmU4yPJ+ryPV5oK0GnWWOxshKzvCwimTNIfuy5dkpAkAsGtJk4z9pbW8IqtLWhnD3qu4zeiVV6tJow79KRj8VJDGc/r0SVloz8mTJ0/kvV/+gpn+Dx8+ZKh2YX6eAI+VQhh+VW0h+gcyipkKMtaIADWp9SrBoT230BjeuLEl1659Tmb60qVLHFN+9KMfyNs/fksebz+WjIlUASvHQBfY2d4nkEToHL+j9jK4bIH2p7HavOC+mW8syNrKCTl/7pycPnNGlgiWNQEmTUdO7V8jGTELncGwT4sZZAJjXIPGEhV/yokS7iLVHb8A+hghMMddJLTNAICzmMYCyBnfQ8050pDsrMVwGfzZ7WCcwu+4JR9xz585fVpOnjxJAG73r5xcYuexQ+aJ/IXmFWQtHf35Gc356At+qzynPg+4FqWftTbQcTukHQPAr6HNAnzfEhD4hdosofHy8hIHY0wsAEAAgPazMInlIIRBCf9mBQMAAC0ib9z1dCXOEKsxRDa+eKwritsTIROMK+ZZQzX6jLAUMh0x8eAZSA3PNP/NdfKzDGC5HBp1bkwDnb4eLoDScNhkUOVKmVmtWDErS7D1bFNu3b5BFvTBg3tcVVOHJ2CdesyURWgv7YnEWcJJjMnIYH4ykaWFBer6Xr78krTqLeqTkCBxav00Q5P379yTTz79lMwffq9Rb0mz0VbfL2ZvRmrREejkWzAAZlIqG/CSYbUaNkyYnsju9o785tfvy41rN+XcuTPy8suvyEuXL8uz7U3Z3dmSnd1dSVMtu4Xf6w8HNF2uBpFU6zVpo8YvEE6nw4lZRXkAjilMkU1lBVO9ocjk9qUW1qTH/dNzj+QP2r9YD7NRJs2wLlFYl2SQSDockPEjcwumEeAzT1AiVypRyLJsQIpgKBHaBssBDV89akgkgXSSDvcfjNDK6pI8fPyEu5pE6ulGzT0TI1TvR6BvsB0tdeycaN5nmBv3hfVHpxGgMwER6OFEI50GmfAw+9bSe2SZ+jGTgZBxTsYuy2UcI2EGmreqdONEalFForBKBrPT6zMcWkeNadRDlozgT+USmqgxDmGXnGombphLOIYdCZKHRBaWl+T8mfMSBRF9EyuhL7WoUdgyMa0F4BHb9CK58voPZPPZY/nVu+/Kb37zG2r1KC2AnvTEiYJhh/UOtJmTphnzSLYASBt0lYm2GcVkHXF/ViJZbNRVDtHZl1/+6l35/NpV+oqeOX9GXr58RQbxQLq9rnT6XRns99lXkTSCCiAAoVav16jWGHJHQ35yXhvz3oSu9vYN9OtzrL6Cew3JK1bbqZZGuJe1fzIBZRAbu5qMwHkC/qbHQzeLVqUWZvFKt3HhecTiCH9zkYTxLtDxzf7NlQGy2I01jy0dCe0jwL8mkCkL6C6YZ41X5cU2FmAYCTAeWR0zz10ckwV0GctZoPJ57bmf+RYQiNNM5vNKIh43tx0DwMOboY5UPW7DA2A9xKHsyxqNcuigHFJQQ7XZpsVue9FO/Dwn91lhCPd3kQBhw0NqBTEuBhEIsWu1umGLNum1ZicEgELuI4vTazkuzawcE3SIEazD+wsTDbITMUhCP8a6osR9Of3wwLhEfsC1pPXrDWDjRAsO1TfZ11GFC0Oe/Xs0Ssj0pWlaMH9uCDhNqwXTZ8ETBf3j1EtGvC75eBwWRrRVqUqE/fV04ETVic8//Vg+QSkyWqokMqJ/3YhZi0+ePaH+DecD6AB6qwzJIL0BMli4sj9x7iV568r3eX6fbTzjwBx4VXl0/7H84h//kWXkkPQAkAfwV63qhDkaDSWsVLmcBWOmVRks8zfROxX6R/ZLE+JBINP3KJIfjmIO1Dj/vf2eXPvsmuxtd2Tj4bqcvXhKzp09Ke1WQz67elX29gZyYn1dFpcWJc5Q7RZ1YWPqFpdXFtkHoAVLRgMJUR1F4EsH9hGfTMQLm8yUz4iAPenSniaAcXOuWrHAg4kzzi1AIK59fzgSAahEOJOZuvy+1mIBuxrmElQjVt1o1+dzL+5L2ut5b7z0FwI3urrXkHjYlUotlHm/qpnY9aacWF2VB08fS5ynkiHjNR5JPYhyaPKS/shrRFWGoZndDJ2grUOr7n66cKmFGh40CSgegBjK49n6z8wwVt0g+gHBK+4HSPWMRhB9gD0TixYwmKyqQitpVqLDNgGidjv7EjZqEntjicFeBZH4gizOgPYuYDbZzwAwmnWWYWs3GjLc6SroPXta5uaWpAdZQIrs74ZkY5gjA9ApKB32O7LQqsuZ9TWpRIG8+w//Q65f+1yuXr3O+7zegKkyqt6o1IPAllQKpB3OWIfVCJhPLDiqFYlq1fIAo/cfx0xP4iSVWqspa6dO8hg+u35NNnfBQGuCFXSL2OTFExdkrbUq77//vty4ekOTkBRr6ThjKn7gsRk+leXFJWk0WpKlI7l/74509zuyvbklly5cluXVVeoROS6MfRnB5makOrn+YCTDGNn8yrRjuQrmGhcTEgYuPMzQzH5AcG8SPhxARbYRYX4YmRP8q1QgIuWqRtrID8efmvCh50Z1hhmDDvQUzTPzwHiaSp5pSJpm2+aRZwkztmFFhQfAn55jFI72JU61+lKlXmMCF8YiaDHBCNIyB9IOA9g59h9NjhXet0e9LwJ/JffvaU5v5jzmvBbCON4woTjv6GMuC4v5ieM1rXnUe5Xji5mHAPJpvcQ6lWYu8nFkhlT4w0gRv7PtGAC+SCtVp/hjam6IVNmk6b+tfgiDhg5++h23FqZdwWLipjjc/m1d+G32rQ2P2FCKfZ1EPcCgCbWY+QNhlhS6IzIvChr1fQNekXhDPK5hkLJA2u6f3X9rl2I/x9fTAQdHCN5H+1r3GKGz7v4+GbkP3n+PLES/26OgHBUc8DeyGXf3d8SvQ5dm/eVy2d/eEwGgQfZlc17+9m//Ti5fuiTVSl0eb2xI4AUy6A3kg/c/lMcP7hfgDRMVzgWyM7MMNTwxAZmZz3jQ6aSDawL2wJz3UsiqYBDMfzTypm5Lqwng2BEafvJ4Q3Z2nsnGk/ty9vxZOXP+rLz5+uty5949efjooUTVmiyvrEp30DFMZyzpaMDScUsnVmR/f1f2B3uSBpnkNYS/gwK0RvWIoACAiIsgACt10yuuiS2hRX1eqWo7GTfq6xA4hfGfxzAhE3JyTOapLM0tynyrXTBCCKsSjI3Vm7AeVAhYg0qkSR7oPNhHlRZOpXeQFXN2QDV/OnHDggTHFnlq2ZMkKHOoYJBWKCbDVPu/6gpzLmrwXejPzDFhbiLA5N6aX8XrE7W6KU1MoADGEy3JhgUzjd+zYf4QRZcDjxVqaq2aLLaXWBUGWb4AoaxzTBsnVEoJtWxYGMrZ06fl3OlT8vTZhvzmV7+Wjz/8gDYuuGcXYMgNc2ZYEY0n9z+vm13oUiJh6yfDgNnGzaczZN1JnouSQK8zFiP0LgRr7Hly7859fgYAkFq2OGci05mTZ1iF5fr1q5L21AzdQ11tZJQ/25OeqCfg3vwO71eUhkOIGRnvVz//XPrdAa2r5uYXjZE77JuQIKPMH6xqYOOE19g/psK+GrHAb1kXAxu5KPuclv1M3bGTfp2IJpjsco6LpvJ4XvIOPCzkO0sDXQ4jM3HFJJ7R+seMcXoss50Wpq7Vd6gdSYxYmv64vXA7BoAv0ExpiJngYjLeHUHFfYn0+z9Us0kA7kDhiottOSeABurQzIrNaosmWjpMUhOgbE2XZ3lolcMcmGzozOZoAH2P/5E9MPtkGc2plSkTA3TbZALL1wGvWwCIlb8FgpPsYhWC+9CgIcljGBMc3bh+TT76+GN5eP8ujxvbRSLE043HzKzjKhphnN6I5sdY4oPhqbba8taf/Zn82Y//nBqcixcvc1W+t9eRtdVVZmEilPz4wWOu0JGQEZksXoavkbVInZGG0QDw9EJpqFLthyYVXa0FhCscd459KkRugYS11onjRO7ff0i2YDCM5dLll+X0+mkK7nGsnf09hqkC6L/yVIajRMJaqPYc1Uw6T3vUWZF5qCH8FLIyAkAuEh9YPQOskSETAIqgO8Nqn9QXQVPhrlzsuIZc0Qf0GGjYS81bhMmOcHJ9bY2ZjgpGpsXsOLYwqPL849r1Uxgtq6VQkBlm0YR3qWCy544ZHo5UAB7UOB5gUHgTer5Uo1peQ8gvCD2AgmQwMEbINsFIy7ZplrFhZE3asdFcKXZyst1pd2NCy/ZETJi2SSJUHqodD8AD9IACcFcJZR6WKyvrUgurkiYw5A61NJ4ETKpA+BYVaE6vrZMRun7tmvzi3X+W61evSTqIqfGjtRNY2RgMWaLbQNgYbL6REygVM/GB1Ht3smDUbnrQKoWaUYDicc6ycbYP4vX9gYZ4sQhDOB9RB1xX1NhGYtT9+2+SwUJo+sGDBzLYU+AnFfXyHCDLfhf63D0yi8vLq5qwJTABT2RhcUkWF5dkfn5RbZH2dqWHBCj0CSMlweLTjoEs2xhokhrGMITnXQ1z8bDmECbjtwziCqPnA7WPp8dB9161gM6COCtncf+eAoFGosIMZ5MFHIvqJu247ibjub9f2HgdzpCV3/i9ZP0elOYc/plZc+ws2ZJ958vsz59aOwaAz2t2dX/UR44wgz7wOScEbMNNX6V9Vb2D9cAqD2B28NCqEwqgbDklCwDtAOeCQPtdTAx2MLOhEpu5O6H4MTloPVn7vbK/oLs/7vvFBDOjnJF7LLaUnV2RWz+/YoAdQAyuOjuwfwB3yFD89NNPtL5mq0HNGnR/EMnvbm0qsxmGUm02WZ1h0N2nUfP33nhdvv/GW3L55ZfITD189Ege3n8ktUZdFuYW5fTZM1JbqMnW5iZ1Xd14wIxggFAK3el5p96DKP81CVlrKIOe176W5dIDnV5YlK+r+wx9H7aHSROTrYb7ExnEfdnb7clvP/xEdne68vJLL8nFc+dZv/bu/Ts8vvpcQ2qNmmQorOCnklU9qUZNWa6sytb2MxmOhuKPRxLWI2r0yOiRtlULFsoCCNucSbCoTKDhVvfa0YTZsmCmNCEyzgFqcK5wHdfW1qinJLhFiAzhSEJLTJqoRTymzhIs4R7kCgCJmNSRrALWEoyUsXtxZzD7+7ovqEhR037M0HSuth+oWZyNWE6sVWtY9Kf1erkfxhuQ4SyElvX4J3OlVcfaZpiLzISTuTPKQNV849mYgfWrEZj54VjSUcbs6ZOrqzK3siSNdkPS4VjSBFKOUII8lDwhGpX5Zkvmmi2pVSpy89p1+fu//3u5ffumwKB7bXGZjJ9dHPFqQGtp7h1lcJ8v9SruwZIPp12A2PvWVrnBdnHf4TgA2FDDFjZIkFlcvXZN9ju7PO+wMQI7juQRXHPU2cZ9uAcdbrdvQGku4+FQ7t++zYonsK2qVbVMJTwnUR2mD0mGiPSGyCg2NkherqbjLDGJ8ckXWPPAfsgmtVjTcXf80eyCCQB0wa57Px6W/FEwd+7YSfZuEqkom7u75ejc7TC8bRZKHKehdzUA0AWs5etUzEHfghBpmSBxX7OIsAwUi2cnaaZ43fDr3/yRffvbMQA8vKn3H0uHsr3wqmRWB571/h+ivajQ96hwgB1cyoMQWcBAGYoJcNPJnJYIJkGhDPzKD06SBgXOGAh4AGVwWgyy+u7Ue1NhD3imYVILqTOU1A9yPI+8kYz8VPzYrN5zkV6nKw8fPiD4wyRDsDjK5OGDx/J44yHrsPqR1lQFc4BJEyBk7eRp+fEPfyQ/+OEPJIkzee/dX8vGoycswwaPO0wSc622hxDd4vxiPr+4ILVqJNeuPuTkRkPjQMXzFgzwXAEcm1Cuzjc62SEczvOSA6RPW+kU15vZDCK9fseUj7PbRggRLIHqGBGaa1S1Huqdm7dl2BvIhYvnpVGpyNrKqmx1dyRFlmcYsKxdwnM4Fj+syPz8iqTRWAYbj6SfoAQVGBOtT5x5uQfmEJOshlJxHaDeRD/ApOX0N6OHYjatmVzZnRBWQ3eCxgo1mgGoknE+327LytIylJrcNwxjRQgOn8mQLpFS/7i8vCKPkXWcImM9lMxP1c6FFU6gLdVzYsPQtIc2kiKyb17GsLePbAtsPgw8JjrkFUmrEfE4wd94TMeZcYq+pCFntfTQY5oQnS6WQgKVyTdR/FqaDJGQ5PRpXyRGwkU8lIofSmO+JYunVqXebDJhBL8XZaFEeSR+rIkBcZrK2Qsn6E3461+9x2xcMGpzcwt8jChrADtuE4AqDFVSJ2d0qXpjar1du/dFPyuF3SZw2lwOCVQvad7Fwgi6rSROWbYMzCMaEsw+/vhj2h/hAXN13ANkbYNATpxYZXIH7GKg+QMjCM0ijqtYpA4GsvvkqcT9gQz6MQEjzglYdXxW+8gEFKEv+pHKWsDCA/yhPCEr55iEikowmSKngJ+zWJiOCE0z0bMYqgPh3Bnm9mUWcFaCmwWSutAw20KZw0PCv7MWyl8AJR3GCObf1JzFnXDO73cxpP1Nt2MA+AXaH2MIuAjdlExC7Wt2MEFjGDUYTfllaWF6bS7IcwfJwzQsmjB60PeqHCI+qpVZQvc1/G1DTXaf7XbtfsJPTObmpLO3z9Ds1atqUmtDq3fu3eLkhKL3FG9D+4gawXNztFYBQ/HGW28woxZVEn75y1/Rv29xcZmaJLBb8OUCs4HnG+kN+v2BbUQyyNPHG9yXdnueEw/ACyYwMZUMdBAH1nP8yElRaWiunOQz+XuaVXV9wNxar/gcfrdSacig1yVjCbPoM+fOyMr6soyDVPp5LImMpIIKC62aJP5YRvD380WWg2UZZgPZ6e5KnI1oQIxKZAqcoMfDlDSbHTdHc7CBVQkQ7oTxs+4nGEgFiZ6snzjB85cKrC/AXmsSEhgx7BQYLDB2CEXjXKP27nCgTDTPIYibiq3+wR80ANXo8BDWozDVk+6gL625ttTrNbKL6huJcHJd6q26DDs9kwmvOlaFkwiNInkCdjiwScF+K+OIZBoPJs4AH7Y2sZY5IRjl8QBmkJn0aDEEOjVCrWh44iE7e9iX+eUTcnL9pLRW58SDNhB1kX1kinsEf3mSMfP47KkzXGBcu3qDWeB7+zsyv7BADR4qsCDxBe8XbFKO5CZdZNQiZR8Z1jV6+vLCl8xqKapRvhdtGNiy8FaOgdcAAPE+7j3UD4Y+D9cWGdy2kg3AGDS3eMBDENm+eODzt67r9+AjGeD+GY9l0OnInbu3qCvE72ObtUZXKlFNE60aLUoDsCAgWxp4ZORR4g73ggsAsVic6pqlHktngtL4aYGZO56Wxx27gEYyA2QGWtt7OsRr71XX+N5dfOO37T1cfMdJ7JgVdv62tS8aAv5Cx/EtPeZvUzsGgIc3Mz9NqoAc1r5IBy0DwW8aCboDlpsQUoQUTBgIjf8WtXuwg5GgEkJpUHMHwnLoxAXDqJ4SBAE10u6q1T2HeN/d1yn2b8a5K59/G4Kyvwmm0WgT+UH4tOlEsyPXrl1luSo78AL47Ww8IajwQpPl6I0J/mBjAUbi8uWL/Busymcff0Zbk4vnLvI4unv7TP6AZ5n18+v3B94ebC62d3JMNBChq6ZQ6/NqaBYow1rcAOip7kr/XfQzGtch6mhf13MT5G7op95UhiVFBqFJymDWNcx8gxoTFVDWy5NEKmGVkznAMHzgAPray20CglE4Fr8WSmWuIWENeRmwyhkL6tg2GjW5/eCePNvdJFigXx+t9tS/0QZnme6A9GDYsFgzPST+TVIJmIlJwGsMxcHQQNzeqtckTlhRxTt56iTDmghrR2A/IIBHBRZmsqu9EJI3wOKhFB1C3jt7PQKsDOwpyDyUy0WiAxIyaF1kQmr0C0QGJ5492suEtQigz2PmP5jtEMkZI2bb1qoVD2bViLZ6uBhFFBSGeZpxXsgUGC4sKBOrBZwIEJ1wlj7wW1Hhc6n92ZdasyFrYMRePifjYEyNnyQokRcx3J5A1xcFsrQ0z+zu3/zqN/Lb334kw7jPcCu2BVAEvSvq+0o0kV0g1I7rprWyK5QmKMuldiMMb7sLYIuhzYsWINnPWOmIHSMAqBCSxXahgXXveQVnDQIwaGXxGfyN6wcGD+bSo1EqCwtaIhF6v1rYkGvXrsnDR/cnFkb9vmTDIVl7ZPYvLa5Q+whHgzCqFlEJgHhUoGH9ZGNfY03qsZ+0dpmKNBw+fpaJgcNCvhbM0XcQzwbYlTXKFvDZso9WDjIVNs6tmb0DGs2C3B2P3azaw8bJF2hlxq+s3c2/7hDwrOfy9w6fB9Tg9gXUC3/S7RgAPrd98X49S68w+ff0APm8G/F5LNhXXdm5DF15XzmAGCYMTW0hJskdGJTsAtkOhG52HJ4TT9mmMgBEg/0KnFLsHGh/192PA5q/Q55nDQYHGCdnv6xXWb/fYxIEAA+YP0w6mIgwiew8eaJfNOcG3m0rqxqKgs4IwA9htEePHlA3iPOzsrJCbRNAHSa4/b19MhqYwMBmzM8v8HWbSILJDcwGvoOJDyJ4ACgFABONT/mY+CC/BmAwAe4I9bol9iz7gn5nj9kCXIDPVnNBushwBphqtxjS7sUd2d/dk95oX15bekPCaih+E75roeSRJ2EjlADVLDxflvy6LC60pZcO5dn+pqR5Sv2fu+9u7Vy3IRfWZquSDbPHCKAEoAYwSO9DgIhQhiMkOPiysrhAUD2E36KHiREeLJnE8UCaPiZ1ZQAxBywtLLFkGEJ8wMk8foBGVLTJM6mgA7OMG61aNFxravwi9Nys12UM4yFvzHD9+olTzC5Ok7F09nbkwb371BMGSPzwUOrNEA8GDiEjF2yen0NLp+E6fI6s46H3rmbMojWkwf1C2Be2MAB/c3MVWTmxLIsrC9KHTY6viQAghZN8xKSmdnVeVtdW5LP3P5WPPvqI1j1IhGDFDgPK0N8AAnk/APigbrLpG2TS4kmVGd4G9OfUDHQmbhkHAJcBJMx3/sa2rHeoHWdwj9lqQrgXmJWLCjOhJnaALcfYAgYdoWAsxHDf4p4Dq4dScgBGqP8cnAiK+r8AfMr6gQkWyZNYNh4+5G9bphFZyNiHeh01r+tqT1UypndBeDFOO314anyClMBpZdatXKnImmiPEgBABXgWANr37L9nhYCnwKQFgKbutxutmQVCv60s4GGN/WsGfiuP6d+14/o2tWMAeLC5KxuPiwibxmjAEm9qFmJHQkFcPNskA1RXKMKNTuiNYMZsw3tOiv6XbeXtvQjAtOEOHayEgzEGVYCWza0tWV1ZYXUATIAY+JERjJU5S0shK9EZYGw2qw2hlgdDMguG5VKGS8tIofCD1QL6ZIE09DnGDGqyf91BzA7Q1svKgrsiycYcNvQ/FHSLp/sE3z9kNo6VcQC4uH/3tvz2g/dl0OswcQCVODbu3pv0ArQwYG3clbV1WVpZk9Nnz8u5M6e47939nuzvdnQQTpVVqlcbHqwoUHIrxSQIhgGT7zDmfrYaTQ8Zs8PhMEcocffpU3n89DFLeNWroU6c9QbM5SwTkMPcNU1Tk01K6TsTOUzVEmoErZbQnudKxVQgwcSN8mF2otOUYl5jfs5o9+AtBvNefLYfD+T+gweyfG5FlhbWxZ8PZRCmas2CcGeA0niJvPbqKzIOfbmzcZ+vwQAbAAZ+ZDTihsYvzfJQfDXeTcEywYA3lUAqrMnsBUYlZwoLIHIK5hVhOQDBLMu8Qa8vZ1+6xNJ2w35fQ+YI8weRXL17S7aePpO33npL8kogzaAtW8muBFFNvvfKq3Ljxi0Cq2qlmsPdcJRmTDNG7VyCGNS0xf6B2USXijxmvPdGfVk/uUaQ/s7r78i//Ku/liQdUS82GPTln//hH+XTq59LpVaTzta21Ko1veex+yCvR5l6wWVaB5iMLazjPN/zwkDC6iQBy94jOtz4eRc1fWuaODE/N8/KFbh2586ekUuXzqvuL1Vw2lpoSzDMZbQ3kPVTJ6SVV+Xza5/JL371C8oWsFhBBjaMqBEaRt/h/Yts7Qxej5rNPSkbNjalHg2DjuUGAAdD5VpC0YT289RoBS37hn3CwgZjBMaSDGc8jbW0YDaS3e4uk1LqjSr7hw3V2t/GvmqlEdghBaxLjPeHg5F0O31znyNbtyK1qMqqFzxjXi73HtyXfi9WFI7rmKXybOMx9+PSxZdkbe0EF1vPnmzI8uKCjhEondds0Sx7OBjSxzRsNrlvCA27oJCbtGCONZgPgj43BOyCPrJ4GBuZ9KUMIH7Dgj0XBFrwZ8F4udQlx9hcLZ2gLQZoxmdxHHYcBnCGZRXuEzve2nG5AIv+F55Ppl74MgTGtE5yYmJvt+dGomZp/Ox5sNpPS0jo+Ae9ee7BrknngGMC8Kh2DAC/KE1tVx0z3rP//i41e7NNjmG6ZBoGSwBACxBRsQDN1sjlJGKyiG1VCvfG1ZWrNVrWCcSuZrVOp9p7YAKxAxeaXTkfpgUsh4IPCwtjGxj8Xf0R9oW1iAOPyR4I++J4AHoxkAIUeWBDjFbOq1YZQoJNBTRleEaJrKha5+SODEa8Bi3S7dt3+YzJDiJ0DMBTYSKAAZN5TYF9GEi92ZBuo0HN23A4kIDVLsDrYYIYcOKNk1gGYAuw/1CJgfAZA1Dr+Zpcs8mEoVVQJvWXLZtaZBYjiQQAHqFQDp5qM+J5IQ3PwyyVuw/uSlxLRRYiadYWJGpEUm1VZBSMZTQcyck5BcyPH28oe2QmM2wf53Gx3eZ5hjbJ1ojWBQci2AFL48FUw9TAUr85esbps11sxclImq06GVaY2eKo4SeJ+sTjisijjcc875eGPQnrFenkXWPX4ctcuy3LC4vUYAIgZwjxRggTa4KGrYRIhg5sINg/w0A2GqiHPJLlVa1n2663pB93jH6sRf3ndkdLBM4vzjPbdIyLg3J1CH2mNrxtqonQE0+3zSQQDyCwQiAB4Kwl8zRM36g1eK2tDZOtvAK5wd6JdTn30jnZf9aREKXXEN4PA1k9sSxLtUXpb+zJs51tspw5QC1YWcbbfYJ3lv/D/WbvE3Y57GlAFtfqyzSxAJO0Zyx87LOytzhGJH7htwGYwVDmMCvOx8zk9T0wi2qeDIa22+1zwdKan+NxA6TgxOhijAuiA/0VbDneQ9j3zTff5H2F+7HVbJH59ZptJof0eidpQ7S5GUi3u09/QxKjaSqDQY/6RzWGVuCEkHKzeZGLDDvm2HHMjYiUw5NTDCErHh0Ef/ZRADowe8zE1/vShnvLDKALBl3Gb1atc/r/mXC+HdPwPgAfxjKcN5cV/FNp37U5+JtsxwDw8FZo/6zH1xftaBYwPu8zR7Xfd2ZTAQZKzQ40YD4uXrjAUA3AkV2NY9DBYIqBygVq7iBodWi6moWtSSZplEqIgTCJOCmk6Si3iRrmOXdDMmEYktmCZq9cK/h5iSL2MzasawvW25UiwNbNGzfk9s1bPA6ANtiadLp7UqlUmXEJQILjxAQD8AEGgRYkpkZu6PnexUsvYULihbxz546HbEbU4Lx77x6/V9hrACgD8wDUjEWqXijVelUaeUNqnZoMRwM+EMYkgBp0ZTREMTANyzF8xSQUcFWel41h4KsKwcl5sKF71OsNJO2ONUQW1CVCFZsCLGqYleFjk2SCB0tsAXxCE+cJ9YEwsO56A1mJ1+VM7bysrC6iooX00z3p7Xfkt+9/II+ePWENWC+sMIkFzCvCtEZqSeDLerVp7iVgABGuHCUSgcZSo3VeX9XeUYenDB0MoCtq3bO2uiRnT5+hNUcAtgy1bH2P1h53H97XijX7e7K4tCJxMpRapU7Qg3rMZ06eYtmwoBZ4wThjKHk0GjM0zKxf3gymbFeoWkQkgsBnb7+3L6+/+pqcPXtayCWDoc4zaUQ1eeXCy/Lg0X158PiBtOG5B+A9iGUMRAdwzZp8mrMDk2oiksLpXC1W2C9MOI8MezKS/nDo1VoNBlRh4m0XYOi/j7uPmKUNLeLSqUUZjWLp72gYdaG1JIEfyuNnz+TqrWsSZyjbpyFtVN0h8cvSd0hYgf0Irrna1GiVGbDkmqmN86sm1woAAQwJBPlsFsToR3ACwPd4D9ckqALsoTzcgBrYLA90cTOIaZ4OnSbqYWBwUtcAAQAASURBVPf7Xe4zky5CDRO7kQP0493dPWZyQ3P7ve+9JqdOneZ9DHDT6/QJRCuViKyhgsCexAOci4ECQHbxjIwxFgiotNNqtXkeAdrX11ZkeVl9Ma1lFBcysY4TmW8WtEx4wxmbXvC7Pnz24WbxkuFD+cMS6AMAdZm+w3z/LBh1s3/dELDWWx4WkRx8DpITjHdMXnMW5AfC2oeEWA8fTr/dwGp6vnXc8I/boe0YAL5gKwa8kh6r/JlZr383jmuSZeqyaVglYxAB+AGDgsELn8czQwumHJE7uBQWMWYl754Xfd+wYMhezCamzNYjzGUE0cqu+2iTpJHpUnzlY3N/1668ab0yHnMCgC0GwCzYJjwDRIwhvDZgqdZuc3IBAMZDs3cXGeKyrCK2ie9hAgJDYVnCDz/8kAAaAzSO2QrM7TlKYK9SrUiYoV6sJ+lgROACJgVtf3+HlR7gPYfDBTBAaT1YsLCEXp6T2XCLz6M+q5txSAbRTB4AgtbfDCF2PY9mwiVwRAhUmYXMSxjqbcy3Zbu7I7v392Vc92Xp5JLsb1WYnYpqKVv3HsvdO/eYFDG/vMQJ3yN7a66XyVDEEYE9JmOktf5YnQQsK7NgSUGVssHhAlMNpVJDuHVATdiJ9VVlu7DHacbs2NsbD+XpzhaP8cGTx3L6wjmCRoz9sINpN5pyev0ky/lZGw8mihAAAw2plk2TMMbU9DGbluXddCI+ffq0LLTbMpQ+tYsIomqgN5fzl87L/Ke/Y5WYerOmkzfLx+m2EJrEsWnCaKY1lVkrDgkRfYZhq/hcGJBBQ+1ennuvIZvxjlRRai2KpNfrcj8BTm7fviVbO8/ktbdfIxum5GImnU5XHj15KL/95EN58OSR1P2ahARtAPbISgbGRj/Rez2lPtSKFnVBADAHdhDbQ6IMlKbTIc4JOwYfSWuXhHJsyGafazak4qECS51ayV6vw0ocBInjVKpVVObwZXt3i4lHuiAyRszwfDQ6OPx9/vx5av1+8IMf8PrjHqVmtqPVPBBuhj60ElWZ3VuvV6VWh51LJGkWspoIDytLWb1md6/N0HQYVnlfImO/2WzwGLAfTEDB74+VSbORDiQlWW2tC8Rw/lwAaIFkwehR76cMLmtgI9Qex4UOkj2iZLE1y3KrrOWzDCD3DfW4jW4Y76E/oME42y7wZ1nCfBEAeNjY+m1thH/H8d/ntmMA+AJtSkRbFII/mPlV/s53obkrQwVXkxJFGDwQbur2erK0tKgVGUw41QIq66LvrlIt++cCwintigF6DIPmyBDEShpgRV/HwMtKCvrIMe6CCVThvAWp+u8ygHWvCRr+bbN+MQhbIISEjDt37hAEIosV720+e1YwEKh161dDAj48lpaWyf6dOLkuK2ur3AZ1SkiggIYKYSZohsDMeJ6snTwpb4rIBx98QMMWMBajLBUvZJ0pZMvmsAcZjIYMyUEHiNJq3eG+9GO1hEE92P6wL1UK2H1JYceSpjnq5WY+sqfhR5jkIWqXjtUvDdVY9DxYLRd0egCgYBVGnCRVlK8TjD1HbGT9kCCB7aMM21jGobIcUVAj4zXY7zNZZmP7CRmcwXaHYBfZurvdDkEGmMA8y71+fyhho5WnIz2nIHmydJzHw4TACNo9nBxOZIQmKuSiRyD6FU4VJAEog1atEmCzpuk4Z/gXDdPvrXu3pD9STeC9hw/k5Z0rcnLxpIzyWMZpTjuTlaVlmW+0pJ+g/wJ7WYBqfjlPCQ5Z45aVPrTUGs7l6uqynDlziiW8BsOe1OGrqJ+WvWRPzqyflosXL8qv3nuf9j9g9pBQQW8WhPNBsgLvZfgGY7EaBgYTHUUs8eIFEc1shsNRDrA0HI68UbDHKiyo7sHM1iyTWq0iPvpNpyebT/vyX/7jXXn1lVfl7MnTUg8aMhwM5Pat23J/44F4VfyWL2OAfYJsI73QfGzj7WechaxxLnNJTKIH6tSqq6ORJGg+t82YRmPf8CNJxiNJBz0ZVCJpNKpc2NTq89Lt9Gg0ng1R6i0QL/Kl0WqQAUw2Y4kC1KYdSRiODQjThSAWaUiI+rv/6e9kbn6e+3rn9j2WerMJFCnYtVEm1TCUFpJ1Fhal212Wbm+fC6MclUaSrsIAEJTDWDq7exLPL0t1ocH7AH0ZvxNB6wdNWZISVOK6cxHKRCbStNPjign9EqQZ1t0N+TLL12j9LONnAaAbAp41dh6WQVxe0Nq/XSN/3AMYr7BgwrGhz36V9gLz2u/ND/BFmnsuCnaTVXeOAeCLtGMA+Jx2GLv0Iq+VtSPfxhDwrNR7+7oNL2Al+corVziwbD7b5uesni6q6MBowUQ5C9iCQcsIWrbKPsbjmvg+Qi/6OsowWV2M9eSyejmrC7IrcVu7+LCMYDt4apKJDs42IxEsAgAgjq/ZXCQgRIiIMTKAjkyF7AB6YACt/xiYIPxtW5Hsw4xiBUd2sAcriHCx1ePpgO8krHi57OxsydxCm49Ob1f63X3Z3ttWVidA7E6k2qho+TYK97sq5gdrBVYtgl0FSuYp4HOvpV4nFX4rC6m1mm3YXsH4qDBCBiPGDNkgZ9kxPCP5Bfou+CWGQSCbTzbl4ZOHDItCxM+wIiRvEkgDDGNQkV6vz/OJyTmajxhmRYkxnJ9Op08tlCeRDNMhUkAK1pnXj4yuasYQcrNZzPSGW1mRCHHP8YjbTMJQNgcdebDxWDxUyKhEsrW/SzZwffGkw3LksmCu4d3790zfRIm7QDwWEQGYCwTAmudBaTIDoDO5cPYcq2ZkeUINZlRDqTGcNSS4pNKWprz88kvy8aef6Pn0c6nUqzIm8M0Fl5El0wJ4D+J+0MLI9BskGoX2MuACYWdvVyo11XAhbNgI6jxvA2hDaVYMDaPqVRGyHe725MHdu7K18VSW51ZkubXKbTbn2hL5NRkPM/EiES/JdH8AnLAQofcSmNAqmUld3CLRw0m08qHzwzGUdW4aEiZpC81oGBAw4vggaQD7isiAL6Esriwx4QRaWIT8sUBQtgouOQgzQwuszLi9n3BsyPhF9Q8AaSyenvSekt3E79tkBoR1YSrdbtSlXm9JtVaVTBBu7VED2O12GMK3OlKUbsR+IDRarbdMKHmfi1yMM7DEsRnMNpkNANBdyBYgg25GmiiD5yKUazJ8bZIH7jvL+tmED5chtMc8i+Erj2PluQWNi2nUuzY2OvAWxb7Txgl9FUlJM6QyX2Ze+S6FgFlN1IY5jtuh7RgAHt04V9P94AivovLf3/IbZWrFVh5klFmbMGpYld+4cYPgByvlXhdGtEMna3iStWW/5/rQ2SQRZHGalSp96uDvZ5k5N4SJ1ysqms7hQ1atVll5Qc2KCQJzEybm95VQM4dU0rfwGceEfYW+B8cTBLK3syN3bt2U+3fumtBaj5NCGscSQMMEAFJTXZHVFp06c0rOnDtbhFeyNPcQ7kSxeYTGt3c2ZRTH1PDZ32YI0BOp1mt8QKDOWrnmWAEGkNyAzFskc1DM39VBHVnlCAcDTIBRazSaMkoylrYC+yE+AntaCQQJHDTkZhLDNAh0DWRt+D5JtCoIgCR+R78LwOdp+LOC6wQEhIkwkBpBvic7mzvM4gSTMl9vy/xcmzorsDKsoNCq8XehU+zudfKrn38uvrzGjM/BIJZn21vyZOMpJ/z2/KIMuj3xM2Xe6I5CzzywRCjZRhGeXrssQfjPw3VQJ7pJe/z4oezs7zChgAyrBLK1sy3drCf1oCohQGyeI+tazpw6Jffv35eQpdzUCsXHAgXs1lgTJAB1bN/VetYekz/qtToZJ+gPsb9ZGhNUoF92pUsW9PXXX5fffvSJShj8iiS8H3JGe72xARSSaok7qOcCTwajgYfzHwVh3u105QlNxBdlvbGe9+ux3Hx8i/0L4BtZqsgiZ83pSJMq1tdOECAiA7qz3ZXh8lCqXk3q8Psb9SVJwK4yFYiokykd2aTSDFjHzDDpFmSwP5hazFbiYYGfAkEt4acZ95GkSDzKU4ladVldX+U5wkJobzjkeZlbxIJprAss2ARBGwlwCbNsAj51IbCegQj1rqyssioJ3AdUI6gmz5RCDHUxhezjmslwxffnWk0JKp6Mkr56eO5sU9pBWQekCDieOOb5bLXmCykIAWCERBxNRkGfR8N55bkr1QAuWDnJZYjF6jjjogYZ8ZbdA+CzGkDsq/3blbuUdX3ufVseV8ssF983JtR2LIZExeogUU3Fuju4rbzIf9F22FyH8Vy+XS0v+fceawCPaMcA8Et0ft6EhyRPfBebO+CQhHHq8WI1jjApBlEMMGB9YCirE+TBgarsyzQrHMvfI/swSed3fbh0kMwk5EpabXawH3hggCYbZjJpg2pFUmxXswjIbNAbH+J2D9UWYCRsQixm356S/bsrG88Q/pnjxARmAM2u8lFGDIJxCNBXV9cY/sXgismImkHPMyyMR4bCHh8GYoRfsN94toM9y4cZnZH+DpIYMJFXWIlhZHNFq6FEVViyZNLpdQimkmzeZGJmDFHlCFMZw2OU1GIFCqvxMT6NVg8IkEdHPPbZjFm30GLhPWahmlJrmCj5UohzGolXC8WLApPIQKAivd0OxfzUcFVCCv2xDYRpwVrtdzsyTBNZXQMLFch//W//TR49eiznzpxheP/Bo0fy8WefSn8US3sBZchGUoMPHxYdJkuYqAPRV/QFVGhAKa5xJksLczLfbMsY1UCgs2J93FQePt6QXn/Ia4GJr1lvkX0EAKivrKOEHAFLtRLJ0tICj9MDw4l+DlUBEkWNBBEAAZmtzEsxmcC4ZmAe61KRgZdKo15jX0OfA1hFJdkne5ssi/f669+T3378EcEofaBjtdQhVhrjMPBDoP4QRtXtN6owZsbCYCT3NrbF+7XIVmdHzp0/L91+T65dvyFPnm0wKQlAH958sBMCMN3b3BTf+E2urKzJoDuSR48fi5cFEozBsuUS54lEyDQOYWGC0nc4n7nuP6QOLNPmO4AwU99CZCs5Bu1l7R+PASxepotAGSVSb8/xXOF4Rg+Hsrv9jP0DgK7aqIts6SKtWoUpOnR3FSyktHSf0cmBwYLGFtsEWKfVDzwJIX9gBr/2DXdRyP5L1rUmK42IYXpolzc3n/EcwnhabbdgBTViPwFDyKx332dyW7Pe4Hm0kQcw6ghN0wyaC82J/tgFy/CiBAtY1vdZts9KXuzfdqx1ffvcMfSwKMaBhS2uH6QQyBxHhAPWO40moxbQNaq0pTFVAeirzA9H/f11NpYOd/5+EXg5a3+ONYAv1o4B4FHNqfNompZgdXyJrL8cioob/QH/bS0FCm0ISlOxsLAFQrai19E9HEDI/tbUrhWsl7zQzel8f4r5U8ZPNwRmRn9zcguCfXr6tCcbG4/kjTdeZ+kzaMqsJ5lNBpkANw252u2An4MHWpbmuQ29mfJmOdkRU5kDzJ4BgTn0QGDYggCaQDwSAJ0cYcR6ve5ltVzGVZGowoLuzB4NvJC1WOk5xxyDUFkt5ArAew/VLNJEmq2G7HX25Lcf/44TAA2fd7cmg/E4k2oDpb9QgaBN5gH+YadOnBY/R9WMhOAVInN4m3V63RzbTbLUgyUJKlLgAbYOYKI/iHMKvlNQTGp9jNAeKn8wXJiJzLXm5dnWBoHk0jK8ycby4PE9LcHVR6UQeHnVpY5wdGtOuntdyRP0JfY+gl2yMQQVYO8ApDRNASDRZNkaZkczXDNf9UcARLSSAaBEzdtqIIPxSIZZl5MLE1AI7NWTD6ApkVTyFLo8X0Z5wlGkM+pLUIukHdRkmI4kzFDFoiLXb9/hw7bmfFvq0mYGdr1WZUgSYUeAdVyPIMTX+Ex2M4uHUg19WV9akapE1EzWqzXygLvdnty7/5DsJPoXGFkwyAAOF06flbMrp6Q/7Eq71mLSytrJNVlaXZKbD25LUKtLMhhKI5Acurmw0eDNCdCLcmvLrSXp7OzKlcuX5Nyp0zKMe5L0B9JeXJRH3Uey1FqWngxlmAxpBj4Y9eXUiZPy+quvykeffqpJJnUA6CDH8RHoIAsYQLDQE9NHLqfO0RNp1dqyE+/JLz/6tbz78Qe8PswahbkzNHZgj+sRv99LEmkuL4lPa0uREWrignms+2RlGW5FkNqLZWFxWbJ+Ir2dvtSCikQoq8d7RfWJavGiAHAMax4uNpixTU9LHTRsyQ9nwWgq7aCv4wAgd8A13N3bVZub/lh2h8+oFb14/hIjCBs3H3DMg54UcgHJ4Fe3ywz88+cvEEBiEQO/Pxqy96x0YbqCUmGj5LdkLC0upqBVxn25urYuZ86elzv37koHi4Jmk9sZdvvkQhHGf/z4kczPz9EHFPcnxoTeoMeFzThGaHfiiahhIK3iouPaBJT1+v2JubPj6Wcrd1jphbJ9bqiX+cSSmDJ8h4E0bNdKX9zP2c/WwArHI8oUTqysco4BGwx2Hcy7XXAe1qyP6lFavtLcM/U52Bwd1YyydHYzMhZ4kvIeNnKeEGO3pJJwkY/a0bDbUWTIBDKraeXsYvquIQTIzitoVse2I/fuuB0DwK+4AipuyD/SvgRQghX8Z599xtUlMlwZGvH9KRuDcojcrnIZP3cSNMA86eestmZiBFoe4GxYSDV8ah5s9XQM1UQ+V+0A0/B3swwYgbefFoa2sPOwYaJOt0t9TH/YE9iojGMdvCegl9YzzFCFpcXS0goneE2eqJKpsYO7a9aKgd7qfSwTYEM/rqeXnh/slw78+A2cT1sKDgxPf68j0hkTWM2fXVaPNITOxhNPPxhOs6IsrUsOak11oASwMj5GvBBaK5SWH5rvo1q3aiSZNyZIwriaABxWA6m2gLI9reuL8D3zMdQtjnYiBGl4UVlj/YyW0LITp2oXp9kLDNBo3AVfr5tKB2xFCp+hemwDDCkyO1FyDqXgeOyENrk82dyUvqlW4bLYCMvRO471in0+W8CwuLwg0ZNIPf+ow4MxckC9I5JuPKlKrQU7F83QRvYwTkroB5JHocQS8/WbT2/JMjSJ0Kj1BjLfXJCBxHLyxLo8ePxI9jtdlmED2Ofpx/lA0D4PaGGDRtOdQr1gzqujg9TjMhYyYGhzvXbIfrZ6TYBHW4IOtYo95JTk4CU1/NyutGS3syvx/lCqqBKDjN2hlsmDfUoSAyiaPlNM7Vg8TCcIab1im0yCV2CgrYbSSC7BdlmGL/SoA1w+sYo6izKALcujjlzd/URaKwtSX5rThKvNbVZoefpkh9VVrLYWx2/vLzDoB++dCQBkJSIuUqvSbNTITmtVkEgWUS5u7WRRVWSqZnauZebQR/B5bB/7hL9djbJbhajscmCf7f6VwZ9dDM8ycnb7KsDkLGDntrJG0NpY2eQPmNfjvgDjB+YPvqYA0paE+HY3Y400I1brlJl/LvM4870/1kn5a2zHAPA5bRY4cd9zO+23XPv3pRoGSgzMYFVQguncubMU01uLAdg5qH/YdEZ0YfZsbFom1iSIqEwsCQwL6FrHUCuYpikZQWT/msHPwwoRK2YbToWJMVZ6jBz6yiDCeNaAJG4H+wJWAAM8gATCvSjbhr/BbiKLl9o4k8TC6hOVShFyhh4LIBOvUcuYQ1usiQkc3NPMgy3HsD/gtgqfr/5AgSB8/EzRd06esDNUvb0hLDPZ2Hgive6eSDgWpEdILZSVc9AdnqQWb297Xwa9mEkKSFzg+RJ73kp9E7V39SQrW80EC4SLJsthK2xlnAQTLsAstGleRtF9AIPriidhRYGR1qT1JQiNNg6nCcAxGIuPMDFDyWqbAkgQEpBTS1DYzLBfmBHZVWYDAKsE0dqAIBHIakKFOkhUtkDd196wI9UQQv+c149Avt9XXWOaqF9kFuSD/kC2tra9wXAo7Ypma8MmBNfw5MmTcv3OLemOVMeah+g/AITwuRtLJRdpN5uyv70ra0vLcuniRTJjzEgOAullQ4LO93/zG3njre/LhZMXJB0Npdr0pZ8m/Dw0ZZ989iktbioeQohT3lHmOinIUibIaLmMLQ2BoMvQAHyGqL2MtNwxtZqA/3mmlXAYxkdDFzb/pvVMEFKLGPeGZLaqsGJJtXwgbpoRAIIBdOWRy7J9Cvwc7zvzN1kZehoyo12immb+5ugjtYqszK/JmcvnWFP35vVbsvFoQ3p7Pck7sWFuYPei3p/IoIaZOq4lzp0NldoFlcsAWuBkw8C4ARTca1ic9229Ic1WiwtXgKFBX8vdGZ2IouoUtjD7BE22ogRCw7YesA4FEz305PIdrPJR9u5zrVzs5+y/3XOpj+nFS3kOsWOYBYH2NVs2D88Im2NMxv7inoBcB2yrrbByVDvi/TIj6H2bsn+PaFqdUB1ujjWAz2nHAPAF2swbd8p89/DPf9cbVte2ri20Jbdu3ZZXrlwpBmoOwloutxjA3JWnq23Rx3TmrJZ708HNTSCxK3AMcja8bO1jMCnQRgbhSJq3TmrgsoKF8RK0g2eaVTgohuEiASAGScukYZKBrs4OY/Z1qzVEJQh7jO4gbgd/q+9xvb3KLKDr6WUbj1ECGfZ60tvbE8E+tAOY5cmps6flh3/+I7ny6hX54MMPZJCMpNsfKJuHGrbjRPIEDKGG6zDOOQBQfwC/hfOL62LC7u6ChdfHhIDBao7SWLx6JLVGXfKqyDAdMNMXekSv4kuEz4fKKil6hKwhF5+lyHhy+DoACcTpQabXj9UwbJ1iJNfYrFezJxUuILR8HhcDFkiyOIiaeAOE16QqcUXNc6uVGjV+0HAi3Ildg+0GrxMTuDO+D7H/wqmz1JdR/+b5auLdakl3UyUM+nnVxBVeigisj0Zy/tQZggicayw+wLgBJN59cF8+ufY5mdNTJ04xJN3Pegxnr82tyIXz57lAAvsUVaoFcMGpm4Ra1bcPzCuvT8GMTuoAsyE8i3OLc20uL0EhNobIMWsN2z5lyF52V/gcwjMwZi3nBkoCDlPpdbr06IsqkfT3uxKKZsUfxj6VF3YWwFrehucQtZpNP8mQ3FH1pb7YkvVTp+QSfPz+7Idy98Ydeffn/ywPPr4ug35XdugrE8hbb/yQCWbIwAUgw32qkQIYdU/Y9jIAtK9pkgYWErCVgixBGWR8FqFfhJZxHfQEhea+oL8N+xa2wT5qKmow4cTURD7Aqs+wZTkK8LmsnXVJOLitgwygex1cH9WiH5lx0i5UcYyo1nT12jWO0RirAWZtJvN3vc0iXg79nGUTOSj+wXbxO9uOAeBRjf1Oe5t5mgjpnAnXDQF/C8Df17oyw4CIgRmTMJ5hbozwAgZthBswyeq5yIpSVfgbXmZaIznRCh4Qv/PGLMAf9w+MnxnYuN92cEPWsAV+bpIINIKWGQQAxCAOABiGFY+g0AupqbKaQk4kyZATCxg/m/BhB1aasVJOosyAG17BA9mfRT1UfWgAbDz2GPqN+9w+9ID6SHLUisW/GWLOUw8l26DfKqquqFSPSQR4brab4tcrEjZDSaOxtFbmpTrflBih12aVE2oGmR7ORwwgnKg/2ThS2wrnqnugY0xc0fZB4LXD+6NmKiN0S33fOKF9CyogNFp1OXv+DJNCKvUKGR7WPsWDIGYywdkfYkYvwsBFTVkFjC4LTJ89u8OGUaLWzFTfUIbSz6FZXF1b9k6fOQm1HRNLRuNYWhLJ4yePZXt7C8kV7DjJcOQhHI3TgWdcb5T5A4hjdjjVl2OZb8+xLz/Z3KSrexqIB60RQ6LIRuU5HkotCOTSxfNShcedxJr9ygQVT27cuS37w75cv31LXnvpilw+e0l2e7vUSHp5mp9cXZE3Xn3FQyYsdKsFkDCTPUAIEkLAxUFPCd9Fq121DKA9p7iPWEvYAEdSGvxbbVzACB4AJwDlrDySy/aTTdnaeCbDvSFBLa4vgZIxuyYecrpGEWYEQ2mzYwjWLE1oPFDN/lqdc4ASdliQoIYy/t2MpLE6L9XltsR+LvPrK/Ljv/wXcubkGXl466H4cSYLc4vy5ptvEJD3Bl1W4MF9Y499lIAtVJ9Igj2zuNCSkloOMY4hJcl5vRHSBttvTeSbTTV91r44MUpWOhxrLk3UsmFgLHStD6m1rSqflzJT5+q8D4Z3p0u3uaByFgM4C4SXmT8Lji0Dir6M5LSd3V3KdHAMOJ+WOS1nATutzF4cxvSV2x90YisDvzIZM0vlh7nErLe+7fHvb7wdA8AXaIet0FxGxf79x9ZwTBggMVBiYMSkBmuGf/2v/zXBF1bN5ZV6eSBEc5kn15fKXdnb5touuAOoXVkXRcDh4WZq2AbBqGAAMcFZ4TQMXhEiQ5WG7W2t/UsGMVKPw4KVcwCgW3EEVjQWiHJfRJlIgDwcO8Ckew4sA1gUf3f222U+bUP2IZIpwmZNsspYehIzhNZPR7LZ25cMliy1UPx6KH6CkCxnduquCAjs9pxtkilSnFmcY2uR4048ZNjShAxRrV5HbTpq3+Dpdv7SBXnzB2/Iv/irn0lYjwiOAFZ1e9bQmy7OU9Yz9vpZ0OeK0C2zVUyezEkp1XQ2AJDMpkmCgAl3d9TTjE/fk6GM5OHjR7LX2dekF1NjGqASjKDVjoINQZYmMomhj7MZnifXTpDJRlVlxquhG4UkEMwvagXHiawtr8jZk6dUQ8qEGq3hu9fvybPdbak2G7LT3ZfPr1+Ts2fO6IQcRjKIBxTfv/X97/P+QCa5Mpyl0Cp99HIZIrnDc1maaQYQ/bn4jgF/mkg2rZFCWJz3kgGL9Pgb53Lt48/l5//9H+TjX/+OVi0wYYbuFRU8APrzGOziQZBwFMviNt7zgmxnsNeg4pDFHojXrEowV5c4GMujnWfS6+3L2voJuXj6ogzf6MioM5CqX2Xpum5Py7RZeymrnXVN522/smyalZGkYGappQXwA7MZSBXsfVWzhJE8ZQGTrTJiz6bV7oJBs2wzHmhWezwz+jODkSr/7d7vZSNn9ztY1BwG/tBsONzVJVq9H5g+MNSodf3Pv/gFx2a8j/EI7+H5ee2Pdc4qyJlveme+5e0YAB7VNGmXHoCmFWzgi4aAv4ElSHkl95XuARt2RUgBQBADD8JbAIFaG3dNTX+d2pXuADgJe5qalEakZM+dFTIX7Ngk07o47y6YBF1YAMRgklFtk0B8T2sHgym0IUjq1Zi0ss1B0hoiY7AvAKqj93EfCC1aLQ0fnvrpDYa9HKGlnZ0dD+yDE/71rBF0Gfy5gy0YRCS2RGGQh7BrUUUYmRR48aVBLkEjYjJG2KhJVIc/4VjySsAwVxobyw5PmQ2VY00DQdsUUJl/q/6wGCD1ymCCQUgpEsljiVoVee21V+Tf/l//Z9UCVlVfBRClHUv7/9iY/Wpo0oTGSz9fQe3ooiOa6+l0yZA1NfCaAYEG7tjEEdqRQPMnA7WzCQK5/+QBLWV4PchE5qx7DF3ZcKi1ZZF1u7m9Q5CIKiD2Ole9iIka1WrFSxMwe5749UgkgR0JqkoEZNAunTsvS+35AmSjk8VZIjdu38r7cSxeJfTibkwW8OK583LhwgUZjWE4nDMZYS6cy6O6sod6XCahwF4HE6EC8wkmUM+L2/Tz6t+nn9PzhE9p6LPoS+UxhyyjGlz/5Gc/le2nO3L3xm3ZfbrNaxxnYxkOEqkW4kGmV+rj0BHLJOpMRTxU7oE+R/YT0eBgLF6twoVLVvOk7yUyDMYyzDPppgNZas3JpVdfFn+Qyd7TXdnZ7Mre3j4XUu49Y+UV5bCnuyDkXo1NnWyTxJHCp9KYuCPLXkOzurcEl85Zs7ISGwJ2k7qsZ+YsAOg2VxZim7uProZvFgCcuOpMb8OV0GhEZVIiE+MwWD88AF5v37lDrSMzaMOwAM42lP2C7fALP/vvr3WeOaodBo4P+2xpf45ZwCPaMQD8PXXEP6aGwRCDCZ4hLgbg+fu//3v5d//u38na6mqhn7HsnOrilA2zNSrRLFBxgXMZcJWbu9p3t2N9CBUMYn5WpskCTAsSrVYQeiAY5wK02QllGqBOmrs/yBrG5IRj53ZDzwDAvvTpJ9YlQHQLvdt/uyGgEvgzExNqoCIBI2EYEObTQcUnkOgM+9KCFQXCrnwE4kH0H2k2q0RaZUIj6QfPHUGZk3zgAgZdmOjEypJzuZkIcy3Ph9cgLD85vy4Pu48YZgQ2SJnQoSW7iuxuA2YKRneqYkQuI1TLcNi/qb6AJCNYmxiT3mLSM2M3otk2QShEEg7AUjDmZLe9u0Mfubg/Uotjaio9GiWjWsY4VCaEno3LKwxZomEbODbqBZMh9Xch7Ggko50GtoPtgiWEnVOh3fQ82gjdunNHRnkmwzim0ffW3o5cvXVDzlw8TyPwVq3Fc2AZy6oAAFvY5mg0zTnRhB0Lp8zrzqwF0K3QD6kbxtgcCywwgcwc1uod9rry3BIEAkojO7cmK2srPOatxxPdbhJFBE+zlqjuwtUFYG4f1mtlFmWF1jPn9QwB671MUl9ku9dhwg2yyf0olL1eT/L+WKKRSG+/K5vbuzLsawa9XURZ5twmW7mhU3v/2H6Ba4738T0sUuEBaP+tNiyqxS22YcC8Xocxw8D2eCwIRHMB4IGw43MqKLkRC8siHvZ51wvQft895/Y1C+gA+DCW4XquLKPsXU/effddEwJXf1Q8Y5zDYv2PQQNYbi8yB1uS5rgd3Y4B4OGNTgpUqM0SAxf1H3WwAoNS/pxmJRrmq6hTOBk8CG6+YjFuhMwO+4r7ucNumhexCbA6EjxjoEHDwPYf/+N/lP/1f/1fWKx+eVmBYb+vbJnnIfkBABADNf5Wpi+AXd8U+ArtfhZzjgvMbPjVVhCxDCCPx0wEyoGk3C5Qj3tMnOg9tWOA+SueMTAybGVKSkW1CovWs+ZsFBWCbkwceN7a3JR5U2IJJsqYHPY7u97u3p70u12dvAYD1mG1GcV4IPlgct2NGHwSJufynzqsDCGnVEAWZQEqnSHbGL5uVak1Ui05Nc6kTt2Wan9y7GcMcKzbRti2YEmKiLbpIxYQO5m/7HecCGEvkrGkG0E+POXilH6HgBwIpwGg8lwGYAInoGBWf7QA8LC+Ve6PqHABAAnjEvslNRdhlkQRpq4HdYmkInce3ctv37qD8LOHBJJxmnq0IkNVjR4yu+usJwuboVGSyNXrN+Wlcy9LSg2hWsIAIL504WL+3u8+FL8OXjWTeITQbZ3Lh1q1Qv0fwATYlmESSz1qyfb+njx6uuHFqVZ1wLlEDeib9+9K64P35Qc/+IGEUpfddBfsqFdDpis5RguUcfLMYZpzFfgwhaEmDYnhhOrq3GNFx6Zebw7gZ4A8K78YZpAfg75RE0VsI4BKx9Ks12Vna0d6nY4CdwBlL2AFjSHCsGFDEIFGFrReV+07ljMG8Mfek4nk7TWdDcwlV00NztE3URMax9yq13gNWb7QgydmJimSfDxfhoNYep1Y4g78RDuyv9shYLOLJcg1Jj6qE4YNC6aJdARjBErJ6SIBps2WIcO9vL/X5cIPCwBYOO3t7RitIjKhdSGDMcku2mwYGIs9/NstH/llwYgdu9x2UCaj84Adq9yQN/YH+4bxymYmY9+QyQ5nBvTv//yf/zO/bxM+7PlBvz1gfzPpelNHUHr9C/096/gPLhQOa88vlera8dhmwT+am2FNvTfdHarsD8ft+e0YAD6nfdcZv+ft/4sAwKPaf/gP/0H+/b//93Lu7Fn5BAa4vs8BCzcmBiGEh/U3prN8XRA8pQGbUdfXDYe4N79lTuxgztesD4ZpOlEroHSZOrxW9smyCSB2wCH429pSny9TFQBgAWWfupi49veLbdr6xYexBoczCVbXA0dgralafB4aO0df54aTy9du6tyZ1yyzNmuJYEOFAKphGDGzFMkfuT8mALx27ar8f/7T/1f+4q9/ZmxnUDJNM2Qt40fAkuliqOhnpe7EusOOF2T5AVbNAlL7OQIBew5gMzIey14HIOGR3Ltzn+UIkQQAllm1bobFhWUNgAmTYHQiZZm/7i594pgwgYoRsM6Ym6MONEZShFdhaTWAUfgOnl0/Je1mS+qVqpodAxhLIk83n7HU3zCZWJOg/uyznW358ONPxA8ROn9N5ittGUdgdq3h7+Qa6WJAK9awf6Lcn5r6mGOY3B9cNJkTqsDPAEcncQPXBBpIfsLRWGrujS//8Iufyycff0RAVK/UxR+H0kFFlySjD9+4f1TY92CfcY8FlksodKwmvrpoYp+yQM6UX+T9A9+9tINabBLFnni9XMaDCVteLotmx4UyQ++OB9wfowF037eRCJdBtP1Bzz/uK1OfeUazv4/2PAbteePnYeOAfd0urssJI3a71s4FIW08APSWlhaZlf6f/tN/OqC/PiLp47gdtwPtGAAe3nThq0G2KT3arPY8rcgfsB2myZj5+lcFiCi59I//+I/y53/+53Llysty79592dzcLMIRbptl98LBeDrsqkweX5r6be8AQDQZxQoAjfqMlvGTfVcwodoeW6KNk4s/XdzdriCt2NqGlXAsVl+E1wEACSaHPYILZFa6NT9nZQS6fcMJB7NPZeNxngMEIsNR19Raxi5F9QgNEZP5IVPg1PY17K8evwmtm6s865rZ1+i5x9+3pwuJLgFtMZJ+LH6VUEzu3LxDYLO59UxQwIJZy0ZLWQbxU6Wb7ORsdsGCbD4ccDMpq6UTPQK4BIAwOHbOF8q94bNgJHf3tmVne8/DeY/jJM+SsVTgeKckGJlUZpcriCb0RagYySAvv3RJPfAQFvVpB+PB7293b4O1acGA5ilC7iIXz5/X0B2SSqCzDELZG+zT/oVlvpIRxfswJs9zP0+yXDaebnrvvvdruXHrttdA5rhx2sa/3ab9wRwjyh1CuAk7GOIUY9xt7wfxkT3OV1DSmK8zk9gTLzUGBU640W7fXldc0zs3b8v9W/cIlCthVUa9kaRxqpVaHIlAoQ21fxvAZJ/d7GCCThZv1vsHHBn6Jh4BKp6gussI2eQjnjssZOJRLLsjlEn0JRyIRLEmoAz6k9Cv3X8LJqeOp8QqF89Ihhpr0tA418WhZb64b8n0/cjzZPoLTpIbrnV/32WYjmrPA1yzAKz777L8xb5m5Ss27IvFNFg/1FZGabuPP/5Ybt26xSxgN0w+K1xfXNLpln9Bzd9hf5df/4NPfKXjtXcKQkHW7v64HdKOAeBzW8kHa9YnzIT6DQO/b4QBxIAEaxi0v/3bf8XEEAAmDFLqvRcWbMYscIRJ9DB2qHw+D+wr9FsMjTiD7IzjhQ0Lvuvq8kyYbep7LgOIzzGc62lIG/9WzZVx+E81Y3DsGMGWkz5mTsylY0K4coxkFnwnQ0hTAaAPfzdMpoMEBVup/8NvIVRsJ0eyHPiyq6+boQXke66wzJ4+yqByhgAT7L+fShhUqNUaDRNJnu3If/k//qsCP2MCbc8PJz48RwCuNlHChpYn13ASkja6TVxX+AXifkHlD7CqLP9rJnTXNFl8skhq6+GpZ6PRhIYezO4SZSBxTSGFoFUKgIlJRJKcwB1+ga++9LJ4oZYDxKS6vLAoSwuL8mDnMepZMSyKHQXrd2r9BMOLIyQ5UAcSyi7CvxuP9XpmY4bDASD2dvY5OWOb0F3BHxM8KbbDOs/F9TeMt2udA4/K4UD324Tssc+wiCkAVwHcjW7N2u9kY/EzlMBLCfRcnSm/mxk2Kc4kklDmm3My6sWS9EfSiOq02+l1+1ILoX8s9QtHq3soSuD1DVUXysxkn/0VoHwMGyH0p1HKZCbIYPJRKsN+KvFeKl4vk0oSiDfyBGUaLQNo972cNTtrDLPnJTBUaDGujKfHEG7XVAcqxg+zZmK9ZpO5b61j7Lbc3ziqPQ8glhnE8jbLx+rq/aghrVaLjF8k3OH9999/n0l40AG6SShTUqM/gujVi7RyFKQcXj9uR7djAPicZgfq591Msxifb6gd9uOHZUV9pZ3FALp+ck0ePX4g/8d/+c/y5htvMSMSzBkm0U5HNYPKsOl3VBM47bHltEJbUl7JHjivUG9xgNU8SPOhqY84GsIDRs5lloGbNL9pswHDimpp7GfScUKNIjz+CPo4AasNCR6Y7Phg5Q+6Yx8EmuaftoQvGQzMXRCzgY3KfQkyDwVeZdTtyXg4oskwmBV6vNETjV55Tv2ug9m+BRtoPkKyyVrk08cNM+BYxtAfSkb9lo99GY0lqHpSq9SlO+wx8YW3gfGNAy8ejNU3kMa/BoNqaBjskD64H6QOJ1Y1+p4JI7OKhHZAJe+mk4SwaKhUjE1GOpaQYX6YGye4Nh7ARgNZ0Djv+ELmI4StSbBmYgXgYxgfmk8/knw0lMz3yaqsr63J9Ue3GKYNco+gbXlpSRbnF2lxw5J5CI1LJps722R86SeHsnzpOB/HMJjWet7jUcYr0ao2vGpU47oxpUm1vT6WSdNzCeNpWM9Q64nQOs+N5goDGGfG764I9UJ8R/YP1x8wUW+VSKBx1VrK9MfjKTT1sOGThxAzmGuA/CG0qfAAhJ+jL8Px0NQDnoxZk8Jck5tRRboGgFKSoHWo+bu89QB5mZIvORYouC/7CTJ81LR8mLFfse4zat/GGc218To+bxdP9r5075fDgOAEzGkyh5VSWNNx9kPe8xMtcQGQTAIL72engofLEpaZuS8LAN1wrsvQuX/bf1vwZ8sWAvxhQY3XUSoP7/3qV78i+LPsoF2Yzlo4P2ceOmwe+KKMwAtFmn7f7asSGX+q7RgAPqdNz93TffqoFfK3pb2oRuXLfV/LNS0tL5ANQ0gC+rGf/vSncvr0KQ5Qd+/eK0KkBfvmhjtm7Is7KB7JACLwMwGABqxPK97I/ME42VQoKVbc0PIZRtAlnVwWzw1F2QkiHStbgbAyB3+CJzezd/KwQPLws4fQaihj0nSq9oowlQI3xokM9/rS2enIqB8TlFGsz9wIhFPBmSFj5OD10vChgikScodcYrBKWYoKF1pijpMmKiRkCStMhMg+5sQPnV2oxtUZrEAwmeK37YbV7FmteSa1gHWinSShmNTh6fAx7UeMubQJd1vGGLAQps7UOcXaf8CYWr1lyMJzY5tOq0AcRCAKPTiaNFYF2d2R9QUwe2NAJp4f2MG0Gg3Z6yIz3JNWqyan108w6zbOE/E9XI1QesM9efxkgyXzinA8QOgwYaUPC3xQlzkBks1inj9NLmgq0Ac40wPW8nwE/WOpVRtM82BfwXXlPULbab1GqF5hmFzAXNZ4pkmz2t/geoF5K2LHZlWhRuEewV5vtyMSjyXymJ9LrSeOv1lrmoSIg22KLdMX7D8m96+WptFEDQBm7McIi6ORjAYDVhrhQmo4FJwYZCYjCxv9HYA0xb1jFleHMX+zZBTF/sEWydxfjPyz31vwNtHx6jjjhGotADRlFN379Ysu4L/o+DkLVLo+hdbgGQsUPAAEAf4wVn3wwQccY+3nrW9iOYRcDpf/Mbcy6zlpNs5/3I5qxwDwBdpRg0L5xvsWMIBfdAX2lVZsCH+hGggGK2hUoLfCKvWNN97g36dOnSJzgvCYa0xq2RDnbyUaJuduar9ADx0c2GxlDqIgfX9SrKP4HWi27EB/gAF09XBOfc8w1M9aT61CUzROcgMA+XseJj7WdJ1MJJzIjPgfQNHuitU2TvaNTJkWB2Z9VM0YRRi4v9eTLdHElaQ/JPMHY18aARuABwYQLBXBgXO23F/R3zxatwq9GrAc2BkAUpRjS5NMBl1474n4FQAOn2xhCjAIVhVl4VAH2Me5AEBUJohAjuyT7iO1oDaj1JS+Sty6qMZbEBhCdxuniQwT/yb/NgbzaRIDxr5XDWu0xQFrNu5pLWDL1ENSOdZ6uWRqQ89jIhK0qmsLqzwfURBJkmdkV5YXF2Q47Ik3GstCe05OnzolcaY60SCqMCQL9u/+w4cmxGhAKmpQZzl8IvMor0nAbHNPvCTPacURRtJuwkBdbUa0Ayjjl5kkF2RzpHlK7WEyzjxo6GzpIVshx0TQDdE15jUCO8kSeEkm4dATz5SWw7ZwDbgwYZhYpIJMZFQjGWmCAEAaQCNhKNGysopWwmKTTtxWsLeYaK3UFjpVyZhQMwDTOhwJamJHdWVp4/2edKrbLL827PSZ4V5FijuPKaR+ECwnAK86Uao+U3WV9FjQgtlqca0y1ylrD0f36o7RVvIwBQCnq6W4q3p3MVLIUozMwM3I/bLtgGbxwLP+Du4TC/jA/CHhA3Yv2BcAvd/97nfy0UcfcUzFZ9Cn6WZwSDa+PbYvwOh9Webva40oHbc/bDsGgM9p6t11aLhyxhdeVHdqVyjet5oBfF7DAAUQ2O8N+QxR8s2bN2m4/Dd/8zcsGbe9vVPo5Ky/lq701V+tYO6woqch3Lj4myt3vq6+f/Z1Pc+auFEkoBY2FpMVoQVlk8FctWfUziHgxQlIJyY0y+zB3gcTY5JoIXmrfcOkpQDQMoPphMFxmITy+S2He6beZ/zUhPuwHVjWdDqSjGBdIjrZk1nSsB4YQtimEAAVEd4SO21LvBFk4rOY3DDZGYYFNFlg/PNYWSWVZJTQCBm1bZN8JMkglbASUn/oI3Ha+M7ZUiM87pFm4aIaC7JRkTZhTU9gLUIvsqJyiIbbcnueDGtLHzuje5tkMBtmI1cvSVSrgP5xPLYVGqB/G0mFIFj7g53ArdE1r2EUyX6vK8+2tlh2DXtdkYqkWV8W6nOyvnySNiS5N5L5+XlZWVqlvQaOMZBQYollZ2+H2j4rI1B2UxkbMHgAwOgOCFHTDgogd5jIKJ+UNbNXR7k9tQOyAJdhwnFOIO5XsM2a1FGDulKRR482NEPaVPnAofoIn8LqBrtZmKuPJcw1XA7wjVAvMBRAWatSIzM76g0lHY4Y2gfLCR9LZELTbtqAJ4JPa1Jtl1ZunzWrDQJ3Y1Aswz4TPqA3RKEaVrYbpNLf6UlUq0vaS1m1B+cJzCcrtlibIkdiM0sj7N4nClTV9okLEmSmI6xfYgcnn8XtbWQeZpEGveckrj0NAN1tuPtxVOM9YVj2Wc+TTPyDz7a5ABCgDw8APZbI6/Xkn/7pn+TatWt8H/cqxlB83lZEcls5pPztb9NZ6EfGm553OLg5jtsXascA8IjGicyseNVHDafLeNhxBBnT5kCbTq5oCgRUl8Ic1Wxid4JBnjoobNpkcz4vZHBUc20m7EuHfH/mSs14+brv58/Z/lSj7iaDoXCN7E6v15dWq81x/e///r/LD3/4Qzl79iwzhJ88eSr37t0jE2hDHhiwVNyPouyo+oDqG2DdwrwGf74Uqn6cS7svKirXUCjMM9SnEX54FqBMACa0UKr5AeuE8CEm7iwfcQKOqnWCLLBrjAjBGmYUwwhO/ADav0TGnhrnAq6wbHCuDBUAh9UB6nlS0TH2yDVDHuseKkhxTj2ZnhxWHC3Z3t2V5kKDfnfoEXOttoY4Ufs2GUo2HEmAEOw4l6wfUxtIM2hoBjGpol85LCYAlxEAKnjm76nODH0YrCEnJuBvJAMMB+qRhjAwNIHIBiaLl7NaRBxjv1IJKoEEYcCkkJBV1Hzpbe5Jo92QSs1jAgDCfLVKJFu7O/K911+Xv/xXf0UWGAzwtatX5Zf/9C69IleXVmXj2RN6HSoQz5XhNCVxbbZyAOZ3lPC8InyZedB0TlirmJgeiUaKXuAEw3NiKkSgLnHmj+XO/Qfy+s6unFxc4eQbxJ7UmnV588qb8vHHn0qr0pBzZy/xOuM7w34sUWUkSRbLrRvXpV6NeLoTZJEbD9Ac4dkcmkA1cUH/Z3UWJmHo3EZXQ2b5gt1SrRm8JNlrA5F+mkhrrglAnm9t7aDEovfjH/+YzHBUq8ov/vldhv52nm1KE8A8ySTp9qUCIAgInsEDT8sCMrEmHXMfwZgygE3mNiVziOsZ1ioEe6hCXGtWmZzBPgsdJB0Y1R4I9weYVPRvLXNXdXS0Ru6A7PpUpFoJmUQEJnLUSyQej2R+dVGybi697R1ZnF+S3t6+pP5Y6nkog+FAIl+ry6RZwuvOUC7GTJSy428YwOY8eHdzLJiE90bpiIlLyk6ir0+snZSJx7mH1x+qjBg23q67TeUMF+zZykfW0P55Wb6pWcTigV8Hs0sDc3P/gcGv1KoSVWs65lNbKmSMcQ+zn0P6EQbSqNdkZXnJVDFJZWd7i4b72K+lxQWNSCBpyHw+H0MicVDyUhpnpsb7L8o4HDH/mInxIOPnsshHAWjOjZDg2AU8tTi4/uhfOl5iDOZ5M3XmUa4RYymkOCjbqP0V9xz6P30UucvjcT7OdCPHjOQR7RgAvmBToX55Rap6rILFsV5eBWN41L2GvmnYp+9wM44mB8Ib9t+ff/45MzEvXbrE0kVgCR89ekQPPdz81sEeETQ1NIWP4DxXufgewiHKntmyUBPNkIaE9PwV16Z0yg+ESDjGgEUsCttO3gRoSGMZxn0JIr01AFBY8gy2FxiGDI4j0EJokjq4gx5fZd2SO466+9TZ2yeziWOrRaEkYJ6CQNqtplTqFek96ShwxUA4Uj+1fAS6KZdapSKJDcm5JbKmwr8KytzfhobPkI0EvfazAA0jMG6ZT+87hDEBCKlJxD4C1OC400yG6UDCLJCFuXkChmSQ0PDXRzURVCpoz8nZs6eZaNGoNfgbFy5elI2HT+gxaCsWDOE9aAAbzj8YTteSpEgWYtwSb9CZyYQCJ1nPrH7B8mdgIXG/wkMQCdSJAEihbu/O3q6cWjzBzOJGtUY/vWalKSdXTkqrXpd2e17ZMOjJkOAimTx58lg63T2Cc+1eholG6UHaGOm+YtKnczzOrZZq1uQQ2195bZAghDAtbIgQdlfWGCABrOv506fltSuvyOn1k9KPh1Kt1eSv/+avZWdzSx7ffyCDTleaflUatZqEaS6jAQypoYfUvquegMoAguGLPJ9MJK43Fgh4FdIEDSMjgSmXGhJWnEx1krsm5JxbI3VXS2cSRgDCoPUE81up1aW3uy07W7uy1qxLLahywbKwMC9xMmLFDySJRADwCaoGdaW325U5VE3heZmV7e9k8erN6Txrv1b94Zh92DL8kxCxOd8wi2aSh+p9iwxgdpJpX9JZi++jAAw9KokxbGLJxAjdsnz1pnqiDrmoNZWJmKyi8hLUjT6xtkZ2D5/DeAcG8Pbt2/Lee+8d+P0yW/n75vh+n3ImyzLbNiVlOeI7z6FEvqa9+9NoxwDwa27fsP7vqHbYjn2lHdbJ4HCdCwAehMt4fumll+hij7AwtILIzkSowwqaAfjA2lgBNN4bDAZWA2h/crpGsC0bNh5TY1cOE8wK45jB3voMTr0JJgNlvoJwqFmoZCrAoqi2T9k1LghyBYDIOj3o+zclROQO2pOimRPu2wAjmLgrFYT9UD83pDkzQDJCQJgEI79CLz4AswRCe+jHyEqmJsnANWP2aPNB30JjMcL5zjCibmYifNJQfxjZtmgZy8IlkmLCR6m9qvrz5chOZth4mlmk2TF0iJY1YVWNkTTmWnL6zGmyGXmeSLUWyZmzp+TM+dNy9dpn0hv0OIFaBpWnBZMpCR4AJ4AZ0gJFSTvuR2ltpdnGAD/mnGKhBitIvAymMM0krNWk09mTx48fyisXLiOmLtXavPSSvtRrFblw5py0mw2Zb89pjVgC/5Bg+P7DB7KPGrMOG2RBEgBWhswP3AMZCF0wTkjh1YUC/iaAQXh/nOdgLVAhRCUMerXCMPSSUSbVSLzVtRNy5swZqft1GXkjGJlh/3Pa5VQr4oWou+wzC7oXD6Tf6UmrOc9qMrwWCHnzN1PxYMdiPssqLxJOgOkYmeaM/xeJPDz/psavG0a0FSaoq7QenoGCS16/cSoVMMeBAlqE/PtZIptbT6U76MrKypq06g1pL7fl6cMNSXqxLM0vMAPY1uO1oHJaInE0+Crf3wTaBnxxMeMkc2FMoSE5r4VFf+MpaYcLAN1kNfdeKY8hs/R39ntucoL9t/UYnVRk8Wn0jH2EzQv0p+hrv/zlLzlmun2unOzg/PbvS+NX/p0vxSB+3W3G8c/81B9sh77j7RgAPqfN6mgHmcBvPPHj0PYiGpav0g6sSEsDI4AcBt8HDx5QuHz58mW5ePEigSDAAYAgQsIYaK2pKf4GGLTlj8q/5W6fVhnugGt2Z1oPdLDkkLVcKHw27Nvw+DMTRqWSMMzrQ09V8nkEa6GTzMRKZhb7554b/Z3pCYVlpyqB7Pd74kUAbaFWF8lGcufeHTICYeBJWImkVovEH/vS9aEPzCSLh9TGEfAZHz73WAnRHPBHrsI1v9bKeeZ4jHyBILeQWDIZBCEX4BzUDPZQ4BXJH2TbROK9kdTbVYKnWr0m/WFP4tFQKmlF6gAt+Vj6gwFZuIbfkFa7ITFDcXgYHRdZM4ctNWAE4CTD9VGPGKPdRMUUZCIboGt8v5XZNQwBRGhGGwpGDhpKME0PHz6U/qAr7WqdoXYwfPAhPLN+UlqNujKqSUxghIxnmH0/fLIhg1FMoKkZuAhXQvsI30QkYJhQI1haAFjDklpvPsoL7PnnQkEzlW3ms8+EFJhLJzw+sEaJjPR7COsGgRoBNxuSDGMZDmOGv4JqKLXFOdnd71GjieNDhrYkyMSFTQ20mWmRVJRkAEC4Zkg2goVIldu2dXLLc+YsOxEXMGE/9bbwpBcPJaxXZW5xTuqtpnhpLLtdTbzZ3NyWteUVqXqRpDDRHvbFq9ZlrtWSzvbugd8uAN1z7FXKY8KsMWLKlxMLDV16Td3vAGOzxkB3LCuPHwWwAxGMxJoZQ6gdjxDJQNTDRjLscYHlazWa6u+3usrP3Lh5U65fvy5PnjyZkpaUIyvlse27PH88rx21fY28fRd0jt/edgwAn9e0RqeTuTl9R7iD5CyA8gdsz8vm/UrZvi/a3IHbnheE+gDmwAJ+9tlnZLUABFdXVzkAY8CDVYed7PBZfAaDp6vBMdue1jhSF2Sig7MAIJMFTcIB9FkIZeKBwKMdPNy1LeZuYw5LDVk0qSqgk5XJ5jXJFM6AXF4he+UVdNFHSrYNZCkY8k4l7WaShWNpthuFQa3KBDyyf62FORmj1uluh6xMpaITC/Vb1L7opJea8BeNuN2oF4Gg2SdMYKHWPk4ShNHEAM0aAZtfCWSQQPOWMYECeqeRjxCrnnCAxSr0kWks3rAvDYTxjXYrzVTvph53uUQgxgSaPAC5nEkJ0I7yWlAvq1UtbAKHD2DN0Kk59wYxgcFESNte6wKcYDtU/BhNFo4y0pBmPBgReG5ub8mzrU1ZOfOS9McDRpOhh1uZm1dRvfgyRCa0j7CnL7udfdnc3ZME4VVUtAAYJkCFpx3qOAPgGU1qknkAbaziYpg2zcYt+ojJ8VE/Pabl5B5DvbiuY3o6IqQJQtWXZr3lYTGQVVVrPEpj6Y/6hp0dUTeXwGgZ9bY9sK+T6hEIyYbjQCJU+8g8VufI4lyyUSbwJgTCzwBgmVk0uZf0XBr2jX43CMFqWghOJLPOSayOQYhTA1hbbMqznWcyv7Iky6srPI+NuSZ1lI+fPJLHj59IMujL5sPH0qo2ZdQZSGdrRxYb8wSfTPYpjRduMsjzAAbvTSOhKMYEVwNoZRHuqGHMJ71QdchobjUNd7w5GJqebpqRbzfrZCEbaQBkFLgH2A98j+bgWPhCDoMIx8riEksQIuQL9wRERTAuIiEJC+YjWjmCMVPj7dRYP2wjR7099dFvOgvYXSwU4PfQ3Z/SAxy3Q9oxAHzBVl5t6d/HbPOssET5GUAGQA8DHtg9rHJhHQN/q+9973s0jkYoBIwBkgWwTQBBrJotQ/E86r+YPEr3/IHwqLOS5gPMjtUZ2Y8YDzeyA9DBmaQPG5qabOcItH3ISp3gxpokG5F4tV7jpDDMBtLZ2xO4ZbTbTbl88TKBMFkXk18bhZH41YghShg3w2YEyRhuDWPCZLI0k3NTnCcnA5JALY55nsFE4NFoQnsY8fsweU5gyxHCY3ksiYd/e+IhMzgQav7GUUYfvc5oKEkH4Mlj3V3NCkYVCgATMFu+JICRTKDSWq3Qg2myh/HHI+un/6bHnVXIWtYVgJFifyXaVB9o6Eofmj9NYFB5l/ksgJiMeS3R9x4gDHzmsoyyhOwf4HGrVlcQzX3VJC34AD56+kT2ux0CX8Bw2K+oDyLALxJUEE3WrGaAQyYvwIyayQyGlTMhasPhKEA12kUc7yjJpNqoSxiEulCChyLnNQ2vgglnxRkTnsW+ZIEnQa0i1XpVzpxdob8fc3kTn/rNKA8lSjxm3gapTw/JfIjM5JEMBwMZ9obS7/aoS6tUQs3CnuEfR8bKKU3mAiqAVOhCaVgdD2VuYUFOnVpn38AiAkAfZ/7Vl16V7c1NufbJVXmyvad2O615VrGIYeFD4DWdyOACwaOTMPT8zmLnrJ2TW9atyP41ONdNRLPVSOyxHsaulWUu5TnBvme9+rCYskbyGNNoPbS8XNT13drcpE4aumj8jWofWCjjvsd4iWvvbr+sVfymEc43xRC+IPv5TZ+eb307BoCHN7MUPvjGYdqPAxv4w9LT+QtqOKaaU3D3S90ss1bIrvYFE68t4QV9ECY5DGoI/WKFC50bNIEY+M6fP88KIngdkzUZAlOXt8wsFr+Xl67DdOYbw2rla2MHUbVfqEk87hP0uRwpWEC67BsAaD+PLFoaJpsQ0FgpoYJrNCmLCBdSq+g8HKLDVkJB5mwiWZjKiZU16Y36sgsAmCJUlsjJ0wsy35rnxAA7D4bwEBYMKyIhtERVGm9rZrNla1jy46CPmTUtd8Affh8MYrs1x0kJkzLAKLPscuSJptIIfQnrkfj1UKQaSFCvSAh2MPSgU5P9uCOtwYLECP0O+hJDs2gNkw34gV2LMEs8kyD0tXwYEgLyVAKEoMHIUFinyTKaMT2ZYC0rqF5wVsuosApl2jSFWxMTFKhrhBkgEKCsXq8WEzwm2r1kT5pRjWHBkLmyqLmbIK1ZNW8inICRsW7ryhYLmcwjyEKolXsIjR6AhqnSIimYPV5/XmcI+PTKW+cAE0Zm4/n30MewUsH1jKLIQ9/LsixP8rEszy8yXMhMdF+kvTQnrbk5hlXr1YZkQxxDwMSgUX8k3jCXYCQig5wVN8KRx6ob4zCTrDqWRq0t/WqfWb1Rvy/DuCs++k5Brth7xYAyhNN5P1PvyD6GOsgI94e1SIbeSIJ2i2bwWEBgH1F9pOIH8vLll+Tk2pp88JvfkgXrdrqyurQm33/jdakFFXl4V2sUPw9kPb+5li2TSj5FhQ+OHSw0bQA4+psB3CYLuFyn3I45ZYDpjh/u2UKzpswWWOKBxZXVNEPiggfex0IXQO+D936tkQbD3uLZgkYsDi0AdqINtiY6IxHUoM5uv+/J5xuLvb5ghM1SNMfeMEe0YwD4Au2o/nao1utPpJU1Ku4zGkCczSTEpIqG1S8GX3wOoQ+EgCF+hzYQQBCDpuu7NtHdHQwLlbVKZQB4WI1mG0JEqJOZlGOaqumbZja0k4gVbzNc5Kfi5cZ7jIkQaiFTAnsToFJiLsuTCZmKUcJBHwxWvVZjvdadzR2GgV668nLBhMaDoYwGAKV7qu0LfFlZW1WNlwlZo/SZa2thwUv5mtnnE6urUjVsq90GzgM0XRVMRLB/CZAkUhO/FkmARwPnAaAhl3rUlPmVBQl9T/a3t+Tu3dsyGnYZAmZihigTg/MEpjJESNuAUzCYKOeLcKbuj8bOaJOk8V3VBtpzWUoWwFtIgFBiVr9HQ2payoD9g29LLvWFhgwGfRpcA2Dv7e/LwnJL+vlQKp5eS4AuVD7BfoH1RF9Fv0QLEBJGFBHhXvjZgVUaQR+qv2EfWhLQ6hjN/pt0WjwXEamC4VL7JDQsNpCsUQUYRCYv+psfwSVQ4v5ASy6ur8vlK5dlcXmJ4ODpxjOUjlETbzCdyFXKkYmtWk9U30hi1BtOJUM5tszj8dbqTZoxV+o12XjUnzlHlhMYrOYVDfduGz518y3ZHuyKX1fZABdsUchzgXv8x+/8QD5473355T/8k/QfPpXG0pJceellOX/2nNz47Jrs7+7JXHOO+VFlZuvLLJ7d+896clJLVzCAk21awKWZ0fo5fM8maJRDwlNRg6nXpt+z44QFl/gb9zHGNTB6+B1EOpDk8eTRY4kMSMS5tfZYAIvYD5f9c+/bcpLJ77M97zr8oec7V3bzpzbX/j7aMQA8olnWwVaDsKECZjtmGDB0GUSA4Kspp1tI3A1l4JmrOVOn1GahzXLeP7APv8d2IFv1y21j6tltNnSEZlez1hAYDQMdVsIIC2NVDDYQ4WAMmJiEMSjaB7ZvgSMBURxLrVoxlQJwnmHQPD1IwnNMWUT9u1YDmBKykvRxxIBdrTBzksCPO82jkWQ4UBCFECCyakOEYgECtCyZ/R34i4GxURahCAHlCH1is3r9JyWf7DnBOZhvtaXRbhHcUSwewpttLMuri9LZ2ZeN+4/lzPlzNO/debrNkBG/Nz9P5grZnLVWg+cRoMCyp9gHVuFwmFOAjGF/QEbp5ZdflssvvyQZync5WkRsGwAIryNUWJ9ryAhgZ5BLsx5xUkPCQm80lHg8lMF4KK0c4erzEnkiuzvb8nTQKbaHWrXNWp0az9XFdUlHQ2k1YDSt3o64BlEl4n4iyQEZIBoyFi8dpRL6xqeNxS009Mjgoj2noWMDw+QLw66amrgwZ+51u0y0wXaxsHj0ZENWl5cIoIeDodrdmHsxTRLxQl8e3Hso+zv7Um+1GSod9gYapk7HcOTBfnlpDB/IkVaEARVsLVL4bDWg2i9swg3YTRx3EEVepVGRcSXKEUoPK4EHU+bt7e181dR/VcZNmXN7Ly0tLcv58xfko999xLGoVq8TxIReRuNqOKP14w7DvVW/Qh9JWOuEUVXCKCATBzsWlKiD197Cwpz0Onu8Pqq7VSCEc4VrHcPQGiUTPZFmq0mmGH0vDCtkcE+vtuXhk0fy8MFj7gv6FliuSxfPy+1rN+R//w//O2tZwxoIIfaVhUV5/OCR3Ltzn9nvavOifXCWJYsNy9o+asdTF5hMVeoxzD2zftEf3FJ3zr9txQ2bJOICC3vPcDFg2LnyvtnfR6UZ7iPrS9cKAIl7GefixIkTBHT4/MbDR1zwIvpBwG8YPxdY2/vUji2WaZsK+05HFL4SgHvRZJvDtH/O9p8XgZq9MWe81gX87MRKXAdeX9MfcE9gIWaPwb2O0+04SeSodgwAX6C9aCf+U2xfNcxNM1Tf58CN8C/AICYZK4S2+jQANoSL8b4F4Rhg00TBmJ0UIKimts2Ef9DK7Jzdb670DWATgFPQO1PkoWbtucko2B+dDKYHz8kEMQlZ64Bkw7EaHkJzJxwMZNCiYTADEwi/NDA/eaLhy87Onuy1trmNzWfPCGCw05hgWo0WVIHFcWFbeB3nipnEoxHPESZ3TEKsQpBm8rOf/Uz+7b/9t2YCCtXSnGXGFJQigYRmx/5Ynuw8kyzMZBx6kgaZxMhRTUfi0d0cIcoFAoGnD5/Kg/t3ZevZM5oop40RQQiqz+I4sR/9vK+aRoQD+31ZWVyRXtaXva09humQSVxpRdLb3ZfROJNWq8kEDrCBtG4k7cmsrEJ8Dw2ZVjex4WFD9DAM7rHyBTKlcc7nFprSHQzk/v378sZr34NJIH3YEApGZiwWC9VaVR4/fSKfffIpAR+AOWrWgv2j/o+1dzULGH56sA1ifnVRp1kXe8hstlnXAKmsqxyFzOAdJkMZjAZwgpMgqMncfFvi7oD7CPCEBo0swB6SJLA99OvdnR25+fl16g7nG2058/ZJ2drdJUhLuyMZjcEQJ1Kv1aXWjiTrp3LixDqruOQjlQ+gWpzauuD6ibQWF2VlaYGMHVipfn84xdg3G21KA5pz7SIUraFOLHpD6jqXFha4eHt8/5E0221el2ufxvLJRx9L1h/KqD+gfAElBcdJJqNhbACaVu6ZVO2YhFxdayVzKx5gCHXxNVm82EUVts37H4APrL0t+WiZuxBZ0FjM6ALJ/k4ZaFrdnr2fi/KRTsP7uO9sGTer+8MiFtcSi1RURQLrh3sX96XdLokEMO7H7dD2B5ZR/cm1YwD4ldiu4875VRtZIg7GIQdLgDwwWAB6mHiYmNBoEAzi3xDFY7KhMN4RidsB3IY8CzbWaADtwA3vPjcEhNAvJubKuCJcd1u7CEUZZPdGI2wLJbvAIKiBMW1X3AJfBXCcTBCavQpygJMayVbLuMHnD4wPJguCzBgZneqJFhgDX8CwgT8g6JiHJ+LCEpmo7n6HtiM8fkRRkd2ZaKJDrVqVxfmGLM7rhIpJfHHe4/kDwwaQDWbr1+/+Wp5sPpO59kLhTVaLqgS42AbCg341lAtnz0kW5NIZ9eTJ3jMCIlZHAXhkKWBP+r2BbNx/IPfv3eFkDpYUEzCYNwAE2KeAeYX1yumTp+SVl6/I+x98KHs7e1IPa7KwvEAtJFh12M54ytblfZjnGkDP8wvbFYAGqP/UJa+o7kBekPWHUSEB4VqVl42H0IChCkYg47QhYBVv3Lgh+3/+L2Su0ZTdXofnPKoEsru3K2u1ddnb2WV4rjnXkp1Ol1UJxqOxljMDS4yED9jwIJM2x1Hpzqn8QDsFzInxD5RzG41RJzclW+tVAq/SrNHwPKhG0kkH3mDQlUsXLspbb77BUDmSTRaW5iXJE+n1B7Kzs8eDgXny7dEt2Xz8TM6ePidnz52WKAgZBq63KrLXz2Rre1OyXiJRGki8N2D/xmKCiSDIBk50YUQj6CyRva1NWVtZKkCdBWBhpSaNsCLnzp8vwBIa2EDU1mYLREb5UOYXFyQKUJ92W3Y3txgeh5flzrNt6hLH3ZiaO7+mgLq732P/nlVybaK5m50FXI420KAdiShT4G9UhH59ZFjb5CIw8CY8C0kDjhmZ1EdFMGykwu6b3T/7DOBsw764lxHmxb2G38B37969y3sOIBALM8s8FqzW5KdeVIt9WPbtH6q9qObwa2NFVOtdTsD80yVdvs52DACf16ZE89P/5vMhg0dZ0/LH2r7qMWIQxOBtB1A7cCKUaY2i8QAjaJlBAEGbQIKycXYSUVNZZRHsShwebm4Y3paKs2ydsmCT2pyc2uwqH8cGtgf76frroYwc9EM20cKAQVcCAGbNm3rd1HyVgMdovcGgrSJbMVYrFkzQwJBxd8jSa6fXT8va4ip94AbNnuzVGjLqD7WugxdKq9HgNpUNmTAU2D7942o1GQ3UZBsTOUK/OOcfvP8bWnVc71w3yS0o96XCdU6QYDqjUMYRvCx82Y/35UlnU7Igk6WTy7KwukgNH8Oow4E823xCgDI/35awSjsTebq5I71kwO0MkVVdCeXKyZcl/GlIAPD5teu0manXmvw9MHCoJ+vXgCwyGaHaCNKNMclT8DdJ+rGhIjvt2PARdXhki1DWDv53qCCDMD+Mtbs8T9BX3rl1V374zjsyDsYsSwYTmF5tQL88aP/yJJXBfpcMovr5wWMPElCAKJRJQ5+irsEYPdsar77WZ2Y+ylhyxF8JWJE9HUhUi5hBrYk2I1mYa8vS8qL89F/8RN587XXp92GGnsmJ6ITspvtkAjefPpM0HhF0DpKe7G1sSbLTl+1HGxK1m7zG84152by/IR/95gMZbg9lvtKSZH/Eai1+hnNhFknuBJqlMhz0ZNDTijtkGg07tmTuNZuMBWYQ598u1niq4aPoVVjpY9Dry0JTtW7xsC+P7j+QYacnYQ4vPCBh9Ursd2Fg3VeLIFRToXRjEr6bsOoT2cxRIJDJMQ77VzD/jm5YtQIoY6h9G8dq6+i6Vi9lPbEOBRpydHXAVttnQSDGIzB+GKewfbB8qN2LJCKcOwLqMOTnbMjXahTB7B634/ZNtWMAeHg7gOAOW3XMAn/H7QU7IDJck4QDpQWBNguOmrXhkO+DyUIoE2EVhKIwmOJ589lTDqT4PgZeVKGw28XkUA7/WpsYyxSqybNPFjBAliprtlJwNll1msvJsBUG7zTlPsK/jQAywm9p7VDUzVUNjwJRuKjopKaTQK2qoIxJFb4QoLKShe/ze5kBgRDGt5p1hhtZR3WUSCOqy8Vz51lmDeGkfqfLiR3bomE0JibTbVEBIxnHei4JFn3WGF5aWCQjMej3yU7hNcuwITycDFM+Bv5Q/MijEfM4GsvecE/2BrsStkIZJ20Zj2KBFm7Q7el57Y6kkodSCyMCMJSvsyX/Ti2flqfxM058qH18ZvW0/Ju/+zs5tX5KPvjkE9nc2mKt1ma9LbVqKP1ejwkN7cUF6e0PtNIF7QeNsbUFgU5lEFtTlefSZg3TSgYGyT6BJGrtrq4usr7vp59+Ku+8844keSoxmMZcpN5o8Nxc/fxz2rEga5U/AOCeQl+Wi5/kHoBlALzJlUPu5dQcqgZR3f508QAlIwy9K/WqNFp18So+M2T7oyF3GNfsje+9Iu+8/bacO31OUkkkDLUfdbMu++RDGKjv7bJfBKjgwczxXPJ+IknQI8uKbGBpJLL76Jl0HzwV2Y2l00xF+hmriuQwiCY0BUJ1WTVcD2X2cL5wP6G/UGObJAyVW10asq3t/TQCU2vAFgAc2NN2c06W5uekVW3I3rMt2drYZDJIo1KXvtfhr4OF7O0DcA61Gglqf8NKx9FylcfTSTLTwUQR3pNpbHw0JxU/dHumYg3+7TB/9j4BK43QeTlJytUYWuDm7o86B+gCDucDek0L/BCZuHP7NheuWKAiioHP2LA5NeQjXVAw2cOMc6XmfUuZvxdtXys1d9hceiQLqEn2LM18dArncTsGgC/SDmP/nlOu6E8BCD6Pin/eOXBLHWFbAHx2de0mMdhEEAyuCLGsmIEXImt8xoaPkeUJsIi/mdHqMERWjO/ulzup2FAoGvVDDCGbydwUm08c1iBi7eJQqr7qf6ymDp+FmF4/p+xBFFXUDqLWNNYTmJsSlrCKoknxeS1ZhczTnJNqGqey8egJz8fi8oKcOXNKzpw+zfOwt9shqAFjhGPG7yKL1Goqsa2drW2G0l955RVpt1rUIsXDIZka2vOA4dSIG/VmCKyS8WCZW1/qtUhSP5NRHks7b5Cdg5ass7vH76PuKxqYsWoQSopwOSddkYePN+Ta9ZuysrwmrUabWsHdeIfA4PLSRWn8WVNWTp2QqzdvkzHZ29mRAbGAR3ZyhPBuoObDTKwowupa75duMSDgmPWq7KD6SduKHMZvD+4so0zD1wBvfiR37tyVew/uy9kzZ6Uz6kg6jGV9cY3sH9grivlJkqlWDto1zQLWDF86M4YBcpy1f9k+ZaqyaJY5ElxqEkQ+y8qB1YX/4NxCm9m8MEN/7eUrsrq0SsA5Gg0ki1X7WPFq8nB7Q37zmw9kb69DqxZo7uCjVx0HMoZmUAJpzDdkPIyl29uS0X5PmtWWeHMNaUVzPE8VqbBayiQR1jBbrFHM6sUFe4wFCFh2PDa3d5mwAFDIhQVqI2eZdAeTBCOCGz+QlaVFAiLUTb59/ZZsbz4jMF1dXaEOlDWD84Bh8F6nbxIrMPWAQZv2xbT3KvG7o+216/HyeDLoDjSBCDII6DGLhZvWjEbDQg3Z1i4YgxRDa4+HBxJM3GQPm3xAiUStxoWnlaNwERgEvPcQ6sW9BeBna/rivrPZxTi3bnIJ2gzwd9wOmUOelyx53L5cOwaAh7fJigvSoxlAx4ZU/lTB39fRbIKFDUFZZsHqf+yAbUENQKBlBjE5ra4sk32Doe3S0oJUapHs7UWFgS7Cs2rAgWwPd9U48fYjA2hCTWQOswoZN+qkkABAC5JJggjCucCWmES9OJA4VeaBCR2RToxgwOghxyoNCgArkeqOtNEjzlBYKHGWM1TLTFgWmA9YQxWVAlDHFqHAzt6upKNYTp4+JWdPnZY3X1uUra1d6fUGRd1gy4CARcTv/+VPf8bzhPP74O492X62qbrL+fkiK5ooGTiH3zOeaEhCGWey3dtn8sdwPJRxgKxe1KNVxg0OetlwRCF7msTihZ7E/ViCmi9e3edk+MtfvitBxZfvvf66zFXnqGtDKDARZHBX5XsvvyHr58/K6bOn5ZOPPpEN1IuFHnI4IoioBjVNpqBbsQ3VI9wKwZ+ScDaJgLV/kSXMeVZL2iGRBRUwRvuJ1Cs1GmdHFU+SQSLvv/++rJ1Zpw0Ojn1jc4OmvOhbAItka1CmjjQVEk4Mq5jRlFuxlEoP1brGekXy3yjo4cGsOY/TmNU76q2GnF1fzl+6cllef/M1uXTqIoFkv9+TMRghZMWafrc7eCo//x8/l2vXr/E1xI1RBjDpDCUci+xt70jSjaWVxATqXuJJ2hlIO6yztNy4D0aWKSTUadIWhpjYhjyRWZ3KwtIi+8zu/h7vGfRX6ELPnj3LxdXVazemjqtaibiQabXmpAHbHM+Tzu4OM1yRBITzU29UJYtHMtiHibl6HHJRlI7I0jM8D+9F3B+oDGPuSXsPKhibSBpc6YUN29pFmNUCk/VTcwVd9DmZuxpV0KQL9fFEUtEktOtKRMp6RJuwYbV91ssUDf3k1s2bvO/wb3wen8O2bG1z/LbdZ6M7po+fXaBVKpXDVtDftXTW3wvTNmsePUqz+fvenz+2dgwAn9MK7y6dVQ52PAyotorBV2g2peAP/fxNM4AWsFjdnn1MQj8TV34LCjF4akZwRzY2HsvcfEtWl1c4mWGQtjolhGA6ffUePKxpsXsNkYXhpOJBGmood5APqAcjxsChovyDp9nDYOeQySlxnzVwR2lbFheXpdls6zGw0papneqp1QnDZtA2CUBhTeJsUOgEmblrJrTc9yms397cMmzCkgyHfXn2ZFt2d/epzzpz5pycWj8tJ1ZPFbVGCVpNiAn2Jtgmwr3Q/IHRwfcwgQGc4fO9XrfQQ7IZTz4cJ8BVo9WQYT5k8sTYh5eckKUCEAvGPkEamUTowZpVJkWEVdjZRNKPB/L5p5+rXUm1RhayWq1IpdaQYTaUURLLyB9Js1KTH73+trxy6SX5+KOP5De//lCebjyVubm2jAYxQQZslCXzCOgQvsM958jFtK+QzzK1hPkvaPNg3ZLKcDiSlXXVtMlY+8fnn12XOPt/y6VLF2HoLDevXpP3332PYWwYbyMZQ3svApjwJsTv6J1D0IA+GaE2scaffdYQ1nAjQpZgL1EaD6d2eX5ZXnvzVXnrB9+X9dPr3Ont7jYBNayAup0ez+lCc0nuP74v//1//Fx+8Yt3xc8DhlHjfZg2jyTrxNJszUmMpI5wLP2dIRMRakFNKvWKRM1Qdjs7XMCgWgj6KM6BjUzbSicMV/uBPHn8VKJqyDBytVJnpRCwsQB/6Cs/eOcd3gfWDxOyARw7Fh1I5oB+8NmTp8qU5b5UsIDyquLlkAbAVgd6SQPEAfwTJH1NGDCWSSuZs+u44tS+NZ6TYMzBrI9GQy6w8HeR+m38ncnYB5FWVCHgQthXGXpNJpiUdaQPoFv1pBSCxmuQnADUQeOH84z7FIsxJHXwHjJep/iONbm3oBXfw7mzQNTdtjvO/am28sxgLa1tlGaWxbV96fBZ5duOk79d7fhsTZ+LCTbyvKVavfG3P/ubv/l/Xn7p1b+8eftOs9/vp+3WfNDrdvOgWmF2J8weyFhlmoW5v68+bFjxQ0OTwKsOK1BUUMCAUxiqamgj8IzGBq+rREdF5OZvmMO6r5efsZY+6v3ydsvPX7WY9qTg2JcEiP5BA2l3hXcUgLRbhmUJzkNQiQorFDu481oYPSE1dk65Jy3kPqkCYIXo9nft96mXM6BSGQx9L+7uideuUN81N7eg7ECoVhDw8wOAy0zYEH6A1JLZ2qf0NRlLb7Avnj8moMXDMgNgYS5dulRUoigmQ6PBsiJyMBs2SxoTjtVwWfYSfbBc5cBOdnwts7WDtVKFTriacYtOguok/dGAIcxasyLN+RYBA2rY9gY9GcUDneDgxwcjwNCn1i2oIunBl/ZSWwZxX1bXV+Vnf/EzefvHb8v8/IKkY5hvi1TDOnVyBAOwpMlzebjxRH774W9ZNxrhT5vgA/CgxxAYljJl5Q0YZwPA1cMK2TGCH8/LwQonY6gYRbIQZniB5BUv9ysspefB78/a+cBOhgk4CPXivBA0aVk39geCTMcEGBZzyMCuwi5HRUd4vV7VUKE1Ex6PUw9awx/9+Ic5jJyZ/Wvq9uL+A3jG77cbbYZKr356Vf7P//r38tmnnxG8RUGN4Dsf4HpCzwg2ckxzZwDUeq1NgIMMbiw4kHgR94Y0fgZTiWxcaO8QlsfxMJEBNX3JekFrqmFYGzKlGsC5/yC1sGDF9iuAHOw3geFocj+p8c0kdGtBETP3d3YJAButFkOj2B6+X4kmSR4aNp/c03YfrPdbpRrKGPWT+13pIpyfjCSDnyeOyUo3WPnDk4bxJAyDyfhqZTu8lywgDvU62YUo7nHcTwB7YP5Y3STLiqiDfVhQjGz+L9hKA1r+e9X6PRdgfv0WZ1/oC/BYReNcZfoBbKhGiKCM1QPzypUr7E8YH5mRn2opSbxWi2rWFmycZUnA2uO+111aWvz0wf17/7+b16/+v7Isu+YQXhPjyeN2zAC+UHPYv6+72VLoGPjIwZjn4m8jcD/02Tv6fQ7th7xvfu4bvxss4JqVaf0iTScOBTU2HGPDxjaE7GYY28GbWiSAgoJhtFqjYstk8/CwlQ66PWiOYKC7IHOLc1KfrzJbl3WDjWcbJxSEOjHUIDvUVoeA5srY0Ixhz8EKBKoDtKFvGxK35rEuINVj9aUSRDKG32CgGal723uy/Wx7KmPRHjcmMFc7Zb3XuE8cCiceZ8jo9SNk3SJ7diRxOpKd/R2OElGtwvJhOB74/MFQejjos7QbEx/GPhNSGJaFX16q4F5GYwm9UDafbMp/+6//Te49uidv//AtuXT5srRqLRnEPamEEOZXOOBjn8+dPiUriwvywx+9Iz//+T9RX/VsZ0uaCw2G0Tu9LplB7FN/ry/Lq0tSDSrS2dmWfmcojVpE4IPQabFQQl4PEOcI4CcDXuTxgtAFa8nsYbzIBCCW7lD2P4NmENnO9hz6rNiisoFcUj9hIglMkufacyzjhz640J6XC2cuyL/48z+TU6dOyfLiMreXjIZkL2GuHScjZne3opY82X0i//h//qO898t3pbO7LzW/wnJrcScWHwAOpedwTjkBWsNpj75/KB4Nyx6wrrVaQ2QcyDDtyygdGj2pyUo3VVVQ5o8LJvQj9kfDwhW9ftKebGwcSKRy+1Pkod8rwNILblO0tW8BjAGEofoISysa4+Siso5TuYfbN7W7AQDJ0lFnqElatE8JfKm3mrKE34Yp+UA9L225SbColvnDPcDyfM44UQBA87ctN2mrb9iHTf4Ay8dIgPkNq9sjw0429Plj23F78Ybr7zJ/ZfNtXF+M9Ux2O4CRjyYjjtvBdhwCPrzpaMHkvsOzfw+WHvtyNjBl9utFv/unPsAQuITT1TWs3sYmktjJxgIjqyfkyj5Vkfe0AH0yIWnFEL0e2BYmcxuaHo4AgjBBezL0MLGDOINYP5J6tSpRaFgkytUMgDOJQ/C8s8ALvmpu+KnlsCSzit27+9ts1qdsJewE7dYCLh+Tq3kC4EHWM4/JfG9ML7pUhqj2EcesKAGxPxoYbVi6DIZgVhOGtska2bJYGZIuUBdXGc7drR2JGlWpNKrMAH33H9+V659flx//5Cfyo5/8UC6tX5ZO0pFBrKAdYXgwUDjXSFT5n/9v/8a7evWqfPjBh/n9hw9lGPelWa9JtRZ5yOJEGbo+vOX6PfGDXCrzDcnSBPYyFOn5Hn1YNIQLbAe+ixUiAAzg66JVRKxdyCRcqicMKTK8TtT6ccWl2wMAx9UMPW+pySxQbxSjrJrkFy9clLe//3258soVhFJzZrknWhIRoBPawrASyXxzQTa2N+SDz38j7737nty6eYsaUDDHANlIcEDNXJqCmyQUZPRyPUo9IqqFpBJnQ5a8y5GZGijwyfCANnOE0K1WnGBpPgMemaxC+nPa2LjcALrcurq2D9q+aXJgilYev2yolUbkjkenfR0I1e2brl0TmtXWBblh6E02MHV4YUjWG8drE8bA2OpiShPDwAixbxfJ2SYUawZ46xaA47QJYLhelpkF+HPvIfd+VFb9hUFH2efv9+ab98fUyvOoO/65C2S3qSOU49F23A5txwDwOc060j//c5PPfBHgd1hyyZfZ1ne5uSzXi4Jau4p3B4EymMNAbics92EnDT8GgzXZhzKYAhjD6p8CeVs/FCXmBgPpdfeludgUzze1W83kWwFbZPhbm0WICh+cLPzJBGhKyE0ylk1pPJtliNf+/+29Z5MkR7Yd6CEys7JUKzS0VjMABsBg1Jt55BNG47PlmpG7+5X/b/cj14zG5e6HffaW88g3AmqgtWgAjdayqlJEhlo71/1GeniGSFHVJfoeIDsrM0OHh/vxc1XHpN7g43M7PJhFmOASwbDKWVWV0XL/TtG+yX8tINMvAltAipGeBhUbUMYN6heRgBGqVcS0DkgTlDuQPVZNdSSsonx1ej9IULymBrtald3Y3iCl7vb1m+oP//w/1NdffKWefeE5Mg2/8MCL6ra6rW7e0VVL4DOI9CxIU/PXv/pr9fzzz6t33n5Hvfvuu7QMFJ71jTXlBz01ntxUo3ys1ruo0hKqeIgqEHDJCIiAU4oY3AMEr+DASP3kiExdr9g3pt5CjTYmKSyF+rqUGgjko4O0P75SSMAc5GpzY42UPLgKwF/sF2/8Qv3Vb/9KPX7+UfJbRNWPjc4GJXjeG+1RsNKZ/hl1Y++G+ujDj9Xbb75DgQTITbjRh/vCNplLo71I9Ttd8rekABQifxQMQ6oayB+dj4/oceQHHJHfIu4JyHqAAJ9uj8z303YzW1JsHvBEyg2WICWvsFPUp8NiJb5E8Mwkzc6javcBOtG6Dq6hW2baM5cq5OccSq9dI5wJIFUqIdOwNjHbBNAmEEihxM8MnkNW4u0JmV0Kzu4nNAGc6xIK9gFV/Z8N3Xa4PQn9mwdCAOtBU31qa06js82VRZBIhc/aPOStzex50glgE/Fr8wEE2BcEJjwMGuyTwx10UUkixQACbUuXkaPOHE77xqxA95R84MydR143mA5N/jwoATDtIeEtyBby6T377NOUA41HFyZ9OlegHiSSRCeC5XQXRCqgZoBUELHQUZ/s60cl3kx1AQSxgAzxtXCJLrC1tVGcKyog8G960A1UHGuzmwsurUWRyDD9moopCMwA8WJCSmbzPNFBEdqmTSoMEWldFEOnXKOAF52xX/vkw5zqqfFupDpIeJ2kavfmrupv9tXm9rZKx5n64pPP1Y9XL6tbd+6o3/zVdfX000+rs2fOkEKXZmnOqXFSL1XnT5/z/uHf/lv1wovP5+++8676/Isv1O3dHTVO9tTW2VPqzNkz+c7du2p3OPK6awEFmiASNU6MuROpW3T0cm78+zyqWoIKgGSax33RZFB7AugoXviIgQogqAA+hMFa14O/Ywa5MU8pghf367Wf/Uz96le/otQua13kXkxIdURQxCDapWu53l8n5fejrz4hMvvF51+oH775Xq2vbaittU0VDSdqd7hHF3Ut6CsfCh8CUcj069M1JikyRU5AHfJCBBc1jFO4DyQqRpUWP1BdVN4w5lDt45mQ7x9eFKCC1DgwZ7Z0L+zzalfBKD+k02e1jvyxcqjTH039BImomYTPBYzCF8BurZTa3Nqa9Q+0Jk1wReC6v7rCh063BPM2pXuBX6fdX6gyAbQJre0ryyUqbeJpm395woU+pQXuFW7r0I9rh38gapt7bzjgsmoyWz4WTQGNF5SgBkIAW1CnLrnLuFjWhLuoSbdt+eNAIKuI3iLqhK0slCMJyz5LtlpIgTvwqwq1QmDfWztYAsofIiJh+uUAE3yPzh/mp2gyovqu8MWbJBEll4UahPVc85FtOipSQxjfJru0FJM+e/CcomwC4fxidlUD+3d23nejEIuSVlC06BoixyHMvpFOrQGVz9OO+iBKUP30lAh57iCLIe5Xk2UP/n/EKM3xodyduSdQEXv5mlpb76nAC1QymqjdOFPrG311ZvuM6qytqbfefkt98vHH6le//rX6zV/9hq435VSEb5bfUXtjVKMYq1Mbp9RrT7yqHnvsMfX0+x+oDz/7RH38xVeUXHmUpBTQ011HchrkeUMwQKBT9ZCHufHnQKk9OhVzjERBtPmX2pF2/CAiQqsR7+uoPPBVFuQqRlptYz9EbryfvPBT9fJLSOb8S3V+6zxFTO8N93St6l6fzhlAe7u2c42CO/70pz+pixd/VF2/q7b7p1THC9V4MKQayKghjJyJUPtQWQX+nuRfR5HPxoUdWbIpyTXKAELt8jRBBRGMMxXj3HMdYQvyqydAqUr9nIJ1aL7C+RIN0aqDWwvXbj/UnsyA7D6/VUojT7zsbTEBtH1cadumzWIyFVhm2l5fB3hxYAbOm1V2PDtYBu331q07lJg5tup1m4MpPR9wY6iatDNRZXLJx8/LTK/F0e9fTwrsvtQmgA3LCflrgRDAZnCBqYYF6n+fh3zV+f5J250P9nVjs5SdcNWOfuXveD0igsZM6pJEBkyxGFSgCDzyyCPq6aeeou+vXrtGiuB6f1NN4jHlONOqT0YEhIbeXJu+SEHItBnRLlsHVbLX7RKx5FQSGHA5sTX7NZXbUdmkyylfOOiDf6sihO6sWX8PwUmnvNHkD2belGrZkp9jBB8sPfjB+VoPflgfhAv8waf8dJTOgwRAnfya6vLmuTp76qy6uXNL7d3do5q/CJSACQ8mzkkUq70b19XZR86TavXff/8/1Feff53/3d/9rXrt5696/Y11tTsYqLNb5xRqnNyJ76jdyV21tr6ufv2LN9SLP/2JevStt9Rnn3+JQBEPpuput5dTqpAk9TyUqvM7OoEzhDQvV2Hi4ci1GViTvBz+i6QZgLxqR0jKaUgl6HAdelB5fZWkEaUjQVDQo48/7j384IPq3/zt36gzW9u4LvnN3at0Hx5YP01BDEjHQoE461vqh5sX1T/+v/+oPvjwA61WhT21d3tX9fKeJqV5qDZ7W1QlY+fmrgr9UG2uratoNKHrCxKLPIRQUulvMudCvoTCq0k8adCwqiZ873UADrUaSJ/k22kmshz4O+czZk8y+Hkj4mmGELf/sp9J22eQyR//jrx89vKURgcmbBDawKca2T0o65Q6Bu0sJMWUEzhvbq4XeUQ5Sh8VaJDHcbink6Pbx4fEPvZEz3OeD/v4AE5/wz7EWM5WBCuigL0lJ+DHnUkeiE+jOzHXBV6qfbZ5GfOZfhLfymYIAWxDi9/BqjgOCt1BovDdqTAFz3PN7TQpTHx4wOFIPrdjt8lexwtKUWfuLBPLIO8XKkQgIhDbRWoMUiNCTe4w4E6UHqhhYgMJYKd3qIKkNlJhkan/E58bFIaw2yuZxUAs4ZDHVRjsY9Pka1ozlXOJ2SaqUodpqX3u+aWkvug8ZoPRkPIM8vVDpCsP+r7fmUbgQYaCXxQiaE09VRbNQHh1Dmbtwo/ld27epcoWGMNRCQOJonFenW6H1FKY+O7evEPXE6k7Lv94Wf0f//v/rv7y7svqN7/7jXr99dfV7lj7OXaRTJuihROqErLe7aj/6e/+jXrhmWfVW++8oz78+CN1dwd+dl21tt4nv0MM0B5SwCCIAooPBbsYMz/ujw+qZqJDoZAhfxxS2VCaIKSkiCmdDdTIIAlVd61Lpuq/+t1v1WsvvaJSJMA27W1rc0vFSazuDEH8OurU1jZFMP/XP/5X9e5f3lXj0YSObRLrhOYBrtcwVikCFVCGL0qUPyGaQ2bfEY7fx0QCPn8mahv+gHSRdZ5DECK65FQHW5ej8w0ZB2XCJIOCKNicSepgTtudJiWvB0fusurtWkHIR7EB3E51lRx/RlFDJY2ShcWYmpkwBqY0JAV9GDcFgCvv4PjwO/aD5/TixYv0Qs1hSlxtEsxz22eeUjwjFaTVDr6iSGLzHPCxszlc/3b8LTBHGW4UsHbTMeqwcTepsaThiTm49B0nBEIAZ0EtSWcjoAE3T9I0Z+UoiiIvTdO8t6aj4zhyEu3NdrxnM8GMOdJKR8DfV2G/lMCmDoiEjxaNs60DazNht63v1uK013HVuMrjMz53tC3cC4sw0aBoUj5gAJw5duNPVLddsnRGE60Chh117fIV9eboT+qll16iSglhr6fiKFZZmKl8DYEgIQ3sUaSTv1LqmF345ZXVR02wtC+XZwgY/471WRnB31xzlAvY8+XkAVWn8Zi97lNSzKocm7bRNo1fWIw8hEMyobIDvB7gdDYUAMmkKRsKfiMlyQzUmd4GyAbILaJRMUCT9Q71ZpEuhZSurspAEgKkr+kqDz6bE6ifOSWbTka6/m0WZWoUD4lY9jp99cN3F9XlHy+p7766oH7+i9fViy/9lO5IFI89Hckd5IisjYa73k+efFY9/fjj+csvvqj++NZb3lfffK3iJMk3trZI5AIZQL66Xkfni0Ni7zhJc0T1Jp3QizLyncwRUEBtL89UJ0TqIFRv6avBYJeu8xNPPaF+9Ve/UT977RW11d+i69ZBWh6q35upcRSpfn9DbaxvqO9//EF9/vGn6vf//HvKX4icfiBvyNGH646o3TTSaWmQOoauO8WZhBSYi3QvFEE+gT+k9nFl+7RWAMsTCd1jYX1dKwUnDlNvnEx04mxTNNlUqyMfzSzNVa+z1vj8lZ6XismwnYpjRq2xwD6lAEfbch9pEz8mf2jf3Mbt9k/kvtujdqkJJGpm6xQz165eVZcvXaJk6nhu8Dvvl/0HrZPRc4Cayb2bFNoOAnGfM3fL0xvSjjoT5ryoGyfm3caq9LTa/65hf015XZ2xiNsHE32aLFMJQbvfZiKul4ujsVpf7+cYt/ESBbAZQgAboSNAmnz/3DQwJfNCS2OX2eHBYj+UW6zPpAx/w8T0448/UocDH8DN9U2KuOQox7TX02pcnmoFyqRPCbOy2hLAnMd1Y00bso+VP2PfbArWEcjTQbJpwOVt2I7s9jtHU0KhRNQvRz5yUmD4jnEyXkZdaybjo3G71pFTYJBGggLRM98XUVX4HuXBMp3Wg9wLwX7gj4k8dznoI5IX5+rtP79N1/vixUvqlddeIfWV/L9Qzi4M1PnuGXV977oajSfqp8+/oJ544kn13kcfqr+894G6fPWKGsYJ+R9mYUeNByOKVkH9XCSLvn33jko7oVo7tU4Mgaqi5J46tb1JhD+ajNXezbsKCZx/+etfql//+tfq3LkzlAQbya1P97bVKNpRe9GYciSeXj9F/orvf/AulcD7+qtvdCmwKFHZBKlntBM7EX/wEphj4S+J5M7k12eShYMAUqSvVlVJUTUyNXwEaZjkdDUc3ZqXiY3rg1e0rdJvuppGUQWG77O1rj2BdZV6asfWuq6LQdX37vZZzbGVPw6w4L9xL0AAmdQxMcDf8PtDJDzMvmgnmMjonJx+oV7WwRR1ERwDVE1GmsdPUQDngRDAWXC3YF4eEUD6wTGjaYWPY43KJBD/uY73goNFVaew6rXn5NFsDsLfKPqOgQZ56h59+NEiYpAHM86dFseJLkFFZUBIBqEBPQG1Ih85KGjaJGm3KdvEi1kvEzfthxSWfJI4WtJVTO312TzMudwKHyZKAQPChTrHOJZpqTAkm9Npet2LbLRRypNiSAglpuNnQ0cC4ysyUsJuSWQPu9A1jzUB1CQGkdDYPZRbSnWCCFsQ1DTJc1TM6ATq+6+/o2v++Wefql/9+lfeT195CeTbQyWQS7cvqgfOnVPnNjveIBtTbdW//d1fU9DOhx99pD79/As1HI4psfXaliF+wx067vVzp9ROGuW3Rzsq9Dve1ulNSiWDChNRNsmRq+9v/u5vqZLHc888Q9dsb3dXrcOE7XfyPUT3prk6tX6GrtOnX36u3vzDn9Wnn3yidncH5H83GSBAKFEJygmaVC4ggR6pgAiY0Wlp6HpxkAfVNNaBH6RQFcpfbvdKejtcrM66UfQNK1fF93YpS/5L58PUpH82xxp/Z7+7IAXYcZtwg0WqnsFie0aS5BRLTP44GTOeH1IAQQJDncOTJjYQkJWnhrt7VIf4+wsXiAgiqIlcP7jyB9n7FwKvcFCdtqsQLqQYHkHkB3n9FhVJqA0a9U+CQNohBLAJliJdTwJNR2PNbnV+q2kiXnt5GhabQ9hLOOkq4X6QY1ftWOSatS3L5gWAfd5A/uAPCPQ6PcrbB9LHBIvzpq0na2R+Zaf7khLi5QpFyorgWadt0ViPmsHGT2vqgB+XfaRMKhte3x2MbdJnl7rT6rVW4EDIKIiDTLiWvyCs1K33h7Irc2U7etcqFcqpgUggbYw202svQpADk4DYkEBSvFJEZOvPRJJQlQ0VSCgSdZ0exS8+/1Jd/OFH9eInn6g3fvVL9fwzz6hz586rcTRSUbSjUl9R+pdO2FXPPfU0RRO/9PJL6s9/fkt98MEHdC2gIqFWLKK2UTcOrgH9To8CC9b7PRUNR1Q7+Plnn1M/f+1n6uevv656HSQT189ymIdkYoy9Cfl74ti++f6Ceu+dv6iPPvhQ3bx+g4jfxtqGjuTdHegkzVxP2ih7lNA5wbl7lO6FJpNc39hUIqHyZcbcS6SQbsq0nRfVflzzn/23e/9KHxEcoytjFUqcQwDrwNuFP2bV5IW/I9+9GvB+7DrgTADZx4//Bljd46h5KOzfXvha3b59m5R5MhmHofaFNQFYOnVRQ+u1KikJjibciUndmFH+vjV+UyAEsBEmkLzavNvaUK1os/JGpVXuN1zTUsmpfEUCDd83koRzlPHSJiWQhiSO1e1bt2gZRACfO3eu8LEDpSsqDCQoQg/yAFXOFK0nBcykUCFWUA7Y0BMKvX87slcPrDrwZepnOvU55eXsF5vLqlLEkKpk5i5UH9a0W3adKXWnRbkwozAaC6/+khVAKFaGhBbr6Rx7GGUp9QpIIfuf4lpSTImpKI2VsKnAUzn8KiGSpboG69rWure5sUkpVv74xz+q7374IX/55ZfUb3/zGw8EHKZA7CaKJx5M2p1eV53pb6ntZ19QZ7dPqccfeST/8MMP1ZWrV6j8W3djjdTPhzZOecifOB5P8slwoB598CHv5z97Tb36yivew+cfpJyIOXLsxZrI97omuMfUhn3/3ffVn6D6ffyxyQ95TqWTVO3d2VPpBJE/WuUD4aMAjhS+fuY6gLFymyheuIbTNkD3ovD/K8l3RhGkLJbFvUB0tv1cuJMj+12XYZv6Ahf+eKU0KU6pD9632W5KiSCn23f7S/fZdIkmBd2YF9RtBO3g1eloAggXCkyysCyuOYKJYHYeDUfq+o1rZPqlko7G55aJIiYuVT57JR+zxRS6RVGn7LV9Pm440ONfpg834p8OEcFMVFALUQCbYKbcVSRwEdQ5+p50de9eo2rAW5kAVgT1sE8eOZ5fu6ZJoam7y1G7SBDLy3pxdckiOrYUatlUmePvNZGcmnJn1nPIXtVAP93WdCC0/6beMUumyXFJaDLqDUgdFEFTDcMGkz/jJq+jTUvERKuHpAqaKiGsgNKxGoJICY7h02goDJk0Td1kvQGl+usb6s7grrp145bairfU1qlNygV3++Zt9d9+/3v16Refq7/5m39NSZjZR6xnoqr3Rrt0Xk888Ih6+O8eVM8/87R67/331edffal2d/aI+cSDAam0D2xsI8m0+tUvfqmee+oZ1VMdNUgGlO+wv75O1wX+mFxz+qsvv1TvvPOu+uTDj8jES8m7vZDS3VAEaqrUWrev4rEOwiBTL1ROSudiUoZzahcwXc6nx+fP0aWmQonFqM09no68fg3Bs9tF8bdTd5vTx7jtym5fdW2vKgjEJV2V/n7Wu638sVuD/Q4CaFe4AUC8b9y4QdG++krGhcLN66ISDNXV7sgQd5xR5ZbA0G26vDxb40RnmQ/ydNRgmkocAeVFrL9X1xjriMbsrHuxNCeCZsyYb1zS13aNWxLhAny/7bQZ7BOIesA3796k76BEQI3iActennz+jLqDF0poocJF6k20CGSpdOwqMF13OhC7UeXk76RTMlvHNo02ZtXQMxUW+Nro2rea9FHFCCqyjr2C1mlZCL6AbhvNKMoU22AKCD9CjkRgfVCrgXrVgIgdDfim2obZfEF0qbwZFVLWChkOhFb1fPK529rcUKmf5bvDAQVfbJ6h3Iwknt64czv/P/+v/6Leef9973e/+5169ZWXi1rPSPEDAr432EFD8Z5/6in15OOPqm++e0l98vFn6sdLP6hb127lTz/9pPrlL37l/eQnL6i1cF0NxwOqMNLv9lR/fVPt7O5AUcq7vZ66dvOGeuvNt9Sb77ylrly6TOXaUMIN/n0wRUL94zx1k+GEvocqSsEwxr9PB3ho/z2aYOB6aJs/mYBtAljc+2kPVLRrchEoAnB0hgHtg0l3qpTipBAQ2WeZCD/UbKRhmZ082CmTqt7t56Dp3c5jaZt87TQrNgEsanZDDURFk263NAkDqYOv3zXOw7m+rrI0oCTmnKaFl9Wl6pbGvJ1zm1J43H386lB3vvt6nksJLmb4Fh/AdggBbIHugGf9DtgJmYwvcGIqfjeEwqRdKJ4HNuvYM2aO6GvAvVIJOfJlkff9wKokmNObLLN9DIptA4Tt/8cRtTAxYZ8gBDAJjoaRuhZdKxRCKIEwaVHON1MNhDJ5WMmZAX3cIADs6K+jPfXP1cqLrYSANOlSvOVyWrYS4yqIrg+NBx9CvDAoWz6E9B0UMgSweJpMYC0y8RbXm77R/n0m5QyblvkUkE9Q513W14bO0jI1Qv/DMlC+yNxJhYlNkmL4Saa5uh3tqLAbqPXNdarDG+/FapSNVR4o1d1aV5N0or766ht15+Yt9c2XX6nXXv0Z5erb3tpQe3u7antzm45pb7xD+fx+9uzL6tlnn1U3rl5Tu3fuUsAIElQj6fUw3VVbayg/5qud0Y6ajBLy87t157Z6889vqj//6S31w8UflB8G6uFzD6lod6SGtwaUZibwQ9X1O2qyG6lxPFJBHpDPICUbTnWEMwih9vEzaXrg/5hb971QMAxRNI3cbsY24bO/Q/ZF+o3XMemP9H3jdfS9sScUTABtRZk/u5Me+52WAaFtTDVVJn/Tlz5/V/XjF5NETu7MzxZIH9Q/VNpBhRaO9OUyc9O8oCZS3jSp4l0dTSzT/55U+aDKJ5P7FQbS7QOhY6EwOejNsyTm3zYIAayByQOYp2meB50O5QFEfVevYwYt+PIYxSOh6D0MmrqOKAZPpAYpas4afx3K6O/l2uGe0/BnqxEkO4lxFdIWJ2gelPHQsUO0/U6O6HYHar3TebV4tJCy03Ls+SpRX4VXWunL0gHVqRba72xaY7QKfmAqHVD1M5PUttMtzLxQHRAkgG3evHlLjccRBR+cOXOmiBrWhIzyDqter0P55WBO3NkZ6vaRmfqs2B/S7llO9UzYbCJnm6PNKepjrEgj45rk3GTYGPwpNoGyJnBOF3yvi/wGAYxsRnWkY2TFT+dX0ylEpiRBr8UqFKzI5jdj5qRM/tz0KaG0NXeyzgPBETgmHD5KpcGMHu9MDGEln8U8QyWPfOKhHnOn08l3b+yqP934g/fF55+pX/7yDfXGL39Ovpl3R7oiB5I4o73sprvUrs+fP6cePPcA1R6OJlFOyZ7DrhehYgZytHQ7KouT/L0PPlR/+sOf1NdffUU5DM+sbZHZd+/yHdVJA9VJfeUnmsyB6XfSUAdtgOyTiVerf1zSjQZvfq7gJkhRreaalV4m0tf4+enLaNK8GNN6kWYH33v2u0/PF8odTvsIQ8Zswy3atHkA8C+Vjps2NEpQXTw/7jv9ndPkoaiDPeMHWDb5Ts2+UP40casy81HlnDgjEy7uOWpa79zeoeArkECQ3UINN+dD1UMMqFVC3XT6r5mJVUux2CoXjNL602vhLaX88WTQ6lexybr+2H3nHKgzx6UOHHXnWw4zaslPiImh7mtM8JlJ9k3nZ6LdN/obam9nTyVRqsL1LmVED8KOiuNIJXjG9KySOljqo2DVMaW9xRjcDCGA86JQ9MwAZTroaQIuexlKgDarAh7x2Rb/Pe/7SfANbCJ/84Kd0CkRaRxTRQIMHFACATvKkYkbIhlREYPrmLKzvU3+qnKwNWGeZVwQycd6nAqk+IU8+6b9OUqioVc1auAUjgld225NYIgdkGMdp5Ew2HdQr6KVdvqPDspKcVIcF8znMF0aMhHkKh2DXCGpMe5lriaTSF2OLqs301hdvPSDevXVV9VPfvqCevTco2qYj9V4OFBrvXW13tkg9V4rZKma5AmpnZN4omIq3adN8r//p39WX33+hfrx+x9VkCvV9QJSDfNJpjbIxy9RfupTRC+pu5TTTyu+Oshjmt6FLoXh2TqtiyFsZPsunE5MGhczcXRup/vs6WTGrM7OvletU94ArqVqDd6oXb0iO0Lz8sjjxwofEmjrVEn84jx/DPyOyRLq+kL1g/8fwMQx5RRLDWi6DofthrNK/4v35un9UUczucb5Fe2qmMXoogv6viFwzajVpGIUlgn2qpUAkBYIAWyBPUGscoquDfBo27DgnqI2UGLF/p+UYZNehUymiA6+fbvIv4fgACaHIAhcmQADHUctMtFz6/faKmDVuRQm14oBu25gmzEB8wButqVbrkXenIYM/0Wat9vfWxMhJmsZT37Yl81ERxciEsd5GH80EiBp3qTTxejgK2PLoWTRfGSkv2vCSBHGSPqldxP2QtXzu/loMlZXL15Vt27cVjev3fS+u3BBvfbaa/mzzz2nTq2fVpMkUTfvQq2dqK2NTcon6IWB2t48pTqql18cXFJvvfmOQtTw9avXKXcgfPuQyy9KdKJmleRqd7Snul6PRmHU6CW1yJA6Lt1GQR88FJXMuqWOxbqW2lXEThukr/vBkpW6dlEVxWu/z/O36/tnm3phEbH9/1zFGorf3t4evYP8sbl3mclOFRq2oXn47AKlJ6KCIJ9Un79lFcGVYbfBKmvOzC3S1Rngtsux9YIaCAHcR7j+M4c9uxQcfOS1XZED22cSB78l3ideqA1s+ymxacmNcOR1XFNt27nUKZxVhLBa4bH3wQEelgpIIb28DShW07WaWrlNtGdIhjJqGeVD1IESFHhC7EmXZMutd5iKyF/Sn1YTwTvIV5pp1wqkDPG7UAawh0zduHJT3bhyQ33z5Xfq1Z+9ql5+5WXy+TuzfU6tb6+r2IvoHKJkoi5fvay++vor9eknX6ivL3yjbt26o9bCrup3+yrvBWp3uKOSUaR6cAsAx5vEyGBNRA/59Ei1JbMtAlsMseMhiMif+WwuCPntWSY820e4baI5/TyfQjcPqgbTOkJnL09t1Dpudx0mf5r0TckeVfno6eTOvC07CAWv69evk88tl0tktxpOZm4nQhecPFT1X4WfMv1mJsPl1fKMIjdFAWyDEMB6FDNAk1a89GPRWbGKcUBkr5VESiqZua5fnaKxKjiSkdU9Cg7pdmk/iFa060Ozict2tmdHezs4xK2kwN+5+7UVwLZzqz3/Yll9XAhIoOUspa5w6WNVj8zBUy6jHxQ2qU+VQGUvQ+bPIvxXkzja1FQVRFUU9tumShdGMctRJo5MvvDxQfJqkEDjT8bRpkj7kUzIRxfJBclXsEtBLPnGRl/t3Nzx/vv/99/V5x99nr/++uvq+ReeJ3U2SZJ8NBqoq1euK9QQ/vbCt+rWnR26J2e2zqh8kqjBnV2qCd1RIC09Fe0N6Zy3+1tqPIhNZK/2W9KWbyNvpvoekXpnqnsYy3ghARb3A6Xg9EUukerp8nxBp358+0F96tpFpUpcEwmsB+Pysvy3zvFXTvTMOTK50odbd5fNvlD8oP7xYM9E0VbJ27DCJLyOYbcx77rvT4oyuOh5FHbZ/VQAi4nH1IpgW+qoI4ELv7NfUWQcCAFcAG6UHH9Xtdxxf8pPGg7KBMzkjtU/u1YpVAs7vQt8Am0/JwyAGOTsaEvt15S2qoAlp/mKGq3zmoDd3+xKNRpUxqPc3RsiSPqge1xTEUsvY5zV3ePyjPKnq+ZYTvqs+hkWZARArfTlusoKSCCfN5FAkEEoQRRQgcojucqDVKlEK5hZB8E3XRVnibr64zX1367/Xv35X95UYairn+AesHmx0+urU+vbajQaq51rt+jgkQwcPn95Ghk/wJ7K00xNBpGu5wutISEnxCIVCxE3K68fCC0tV7hU6uCEaTucWg7qoPsV756agN3PbWle7OW5jVcRQH6hrdvrgvxBPWefPzs5Ol7ToCpd6WMeH8BVr4vg8GArw7alxV3GBRRAiQJuhxDAelge8PNBTMD3nwkY4AAO9k3i+r2s7EHNYIUQqhMnLGafKIatcthqoDvzrUKbwllnAkbUJ+3HDQQwvn76Z99EnmrSwovQL1YeI030dH45csQhjoa6DZrYmRyNoGiWYM4+iCaCnoI8tIkX0bGa6GlSSP6FtB1WDbUCDwJIhxpgNZ2ciarNJUp1uh01uDNS42CcI+hmLYCCF6l4b6zW1vvq1t07an29T8mlcf6DuzrQAOeP+zm8O1DbG5vKCzy1t3uXTmNrY5vqJ9+9dVv1e2s6kJYUvmmcLY0/pAiaOsgcAGIUPSqJN71oRextcXlZUTXfk1m5VPGDnQgPzwTMx6EFl3KVmToC6CZ9RhUWJniYMOHaI8oXyh9SvCBYqrSffXaxWeD6zKt81S13IEzyEALySudhBaHUHclKR1jX7+Gz7jsrBBg9Y+U8gKL6NUAI4JwQfz5BFTjpMJt4uVYwgMGLfZUwoNlmXK5nygMlq4K2+lc1863232tX+KoUnvY2XYR0WJ8Bu55dvdpHEaoUYTz1kOAAB05lwZYb0raobjIbQXXqHB3OqqNpiWRQMMk0OAWUCOZfWHsyP6NasF43pPq7icpVtBOpzVPbqhMEanhX55Pr93uUhmR4Z0/1/a7KokwNooGuJkF5+vTxplGi+n6ftoHybf2wr/w0V+O9IQWrbPQ3KUBEB3qA7IHEBsonFdOofCbZNgWCWEEg9hVt81K3fQOnnw8fJb89xwRsB324L9cvkNs9JkpQ/XjCxOZh2x2C98m+tGEYHKrCd1Tuxf2EufoxHQAiN6cFQgAbgAEHJgaYJNj8wMoO+XsFvvLhl5SkqmtyvmFmCwLQQ/4qq4PkTssUaSgaLQrHr4JVW/gCea72vQPUY7u/2vYX3P3M9lpdLJvP307XwhG+ME3xbxjY8BnL4HcksYXCcfbsWaoaYgeG2IMm+wra+7GPX6smfApllwRXtWlSDXlZGkbpb52kT/OUKU0pfAKLf4m+TUuTsR+fUfqMe5/VvthHUP+hdUCodFoagzKo0ziY46X8dlYAid44s8qCcCAIQKuESKdo3L4nOvcdvl8P+yoexir1YyKjoR+qdJhSOhtsJyHlUZMMro7C5dfoMFBrmdzJc5UZPz6u3wuVL8h0ImWdqU/vX5M9rUoSN6IX09qpolFcM7td2j6CACKJLa9A1E0uF2ArTwbc9tr2fNt5Ol1Xg3mefVboOA8gT2aKkmxpRsvwcpTKxyRUh9rX6QSk9IH04bnAu11/2A04sdtyUTd7H/qvCoXJWzLPn+vz5h0mwdzH9SvPh4v2NFyfhY5vZry0Jr9oQxhb7VRBnIKLXXBoAk2JAfIsReMTht4IIYBzoORvZX0HFD5eGHwsZYYHccH9DVvx4I6MndyB7e3tYtDkTow7Pigg6PDY3FHne+o6Ru9fn1enT9n5LjloYzanoqGIM6qgHWDC3oTkS0jPEQeGaD9KOh8eCEyeQG3+NMqoSc5N5BUqHJJDgzziulP0BZ5FJo2GdIHw6StWVA6gdY1U6VNVDp2AGfum1DdIQwMCmBpFzxiXKC8hNmUqeWjT7zTal8ijc/WKfsJU71gW0+u3CgGqXq7ts/ubTkw9+0KpNk0EtbIN5dVWA1GpBYM4yCBXzRG/O8G87beqzWEyiSdVqRwzCUkD0wAhgM3Qzi3k615uZOzzAoXAnZnaSo7gcNE6AB7w/nm2aisNbBIuAg86naImKqe4sE3DvJ494dDflaOAZ85tDiKoff3QwGfNuQCORC9QVHezVtbRwKWI4SIba1ZoKHpb04oUZjnrHJi8wtfQEDUrwr6gULzz1JqA2VHLyBeIF5NOTMqwrYBzHOpoYqJd2karl6evpsEYdE3oXSt/REApZYtWJqdqHRVZLshisWMihiZwgRU653NdKbWpTxdfH9f8bl/D1dHm4zcPMaT+zqr44QZ9AEzmeSID0ocXIuX5b27XdgL0Q8B++eq5SuB+b19vrO0SrXoJG9a3Csjs5x5LsCe3tsBit1XX7cBDOoEsSzCfFjNwM4QAtoA7bNt/heGqgjaafhPcP3DdAAAMdFA7MOghzxlUEkQIw8QB1Q/r2O4GgOv3VxpQK0zA90RJMbkBOYBj5twpToGPber75yylVSjzPfvJESGlYjq6UgbIG77XOQONE7hRCWk9E0CSwyRrBY6Y4sO6fqpX5IilLM1ctjG3TetEiHVKFzq6xCJ7dPAm/Y45Rs3PdNk6+z6797wuytf28+TrcRhwyV8dCazq/6hv9Mp+fkwAda4+KtVniJ1PqjaneaFyXklSuEDYNbfZvcJtz/ZkSvrYw4Xr97vfsO9v1YTAtrDw8hRvn6skz0kBFD/ABggBbAFHEtmNzPVDEaVP0NB+KgM6+IWBkM2+iBAGCeTBkn1a7DZXHvB4e7Pm4UVNwYUSWHEGpeX4W8dHkPMHFmvpaA0rr6Be03eOCenv9HaNCZVKwM0SJqr6gW1RrVB9HaDIYbLPx1BWDX1NGIuDpthjE9aiw3FpOVOKzauKqiRzsHF0MqRvepF8j/wCWRnVbo8m/Qsfr/6OTdZVV7XYH5+ncRIuon3NX/ul+M1L/OqUP/e9IH3eNKCDSZxug9NSiEAUTYpAD0yAul3tK819qD3JdolelQvEqj6AFZjXd2/RDZ8UNaDt+tQpn0uB+0k7GKhqQlJWB2nYhmlOFMAWCAFsAUfvlb5z5Gj7e/uxkNnp4aOVBB2wSuYSOJsE8sDIJmEMiFADUTUEJBBqIFQSewB1CWDdOeyXP2Dd+qb1FybVVVHsp0hHw9s1tT/Nj+wPWDx/7nhj5eAkbmYPDCazE5M0Sjyd21HNTFitbRL5gwmYSTYH3+i/M/ggWnWPpyXbZglK+Vo2m+2LFDgr8ob2PqjZBOx+X2V+YwJYmOCs5Tggis28w+G4CPRgwuhOoF2XGsH9i1kFsBwUxN+X24wJ25JI4FYIAayHmdlrWJ/LkUqW6Ydhm0EEh4tWhUAdPAHk9mB3WGy65FyBPEByLjTkrIMaaA+ysx0eq3Y1JG2JQdSdviPIAXDNPFqRmppKMw5vN850rFhNo375c7EHixnBbGtIJPEvUw8EgcGm0+cKITM+dMXWrIARFRTHW/jQkbKI36YmXTq0IpCZn2c66+L6eZTFUKd5sZNk6+hHQzA5Z59JzTcliLaCaS6uqXAyTXbjgGsnM6E00bUuuCbzfjXfeRTAKgLIhM91kbEVb060jfY9mSRFxRy3jrb9XAAcGHXAJuD97gAO1OfvEOHNqQgemA+g/T5zEKXvachGLWBRAFsgBLAJxO+KmYT+iokfDX6aAJI8zc7gJv3EvKZhHqgOIaHnzP45N5v9juGn6vvDOt79J4D3Zv/cFtjcC9g+fuz3x0QQy0EJhFnYJoG8TfaPsisxuOe6HwpgG5r8f3RQraXkUUbkaeSwbkcVz0hRCQSBFRQWrBU4826lnp6WmqPUNRygZV2ToppKEW2iPxeJlll11H9A8ddBIhyxwsRzGrQyXXE68eOMiW3Xu/73qdG3tFzN9Z0+g/NkEqyDXleT3CnmIVVNgSIMnAP7+yGV1tSMh3e03aQU8GQTQCaTrKAfddC9X/D9JGBV/z9qwzqAv3bb/CgaT96Z9lblc4sx2ySFOiYj1eFACGA90JqyzOQS0m5EmZeywzv8EhQ8TfUgXpQB83UnxqYPd0bspl2gTpGFj5rEvkAd4VrVB0YPmNOHzH1PTEUDU9mKFBxWOubZfhva8pS1kWiOAq1DIUzVYtkBez50OhwFySWvdO666fanx6+T2urBeDhETjQkJ9a5Jbmigk+udRgckT/QN6kz/LL8ZJlBdXqO4kPj+VS5Ouj9VacbAeGibtlqAgVxModCMcBEvExwRkGV9L/k30OPmt2OdNTtdCOmnc6QDp2epVDCKAKYr6chErxOjkANVhRZf8PlDvW+iu/ZtMzlx2bvk32tqGqJzlI9PV7rijEBrRryyYjsBSatDBNOs7a57lU1oPn89DM5Jbuzy6jW7zkZ97Q/giI3VfymLgu67fFxsQkcVW3QtG1F257McDm3smqn12d1XB8bT5ztoKfpsvY2puezCuEuEjIWi9rfF1eqfn09ZTAXjlJQalJOrqL8mUv+cfoj+93e6bJoTSPkreoiU7/qfHuoB2Vn4kksnjUzt8MxYVxNslQF6D9NH8EuEXp5s3NfqTROVDc0eXiRBipO89D30zylRikEsAFCAOtBqVxJ/eMUEVULNZgh5iFHJUHhEGaG+YrvJ2Ume1SBNBkYZOEbyNVDAFZT7AmGayprQ9uybdvxLQWueUd23kD7nev/usfkqFpkb4UGZ9FQa9xmBcueJE2VV+v6WPsuCIkRmJxg3UZVzR403eCXRcHBN8uMU1oobZ/gNW6jpg252yj5+1mmXlROAemDvyoP5piUsMm3nmCcjAheu83x3/Z7XvO9QGPqy2uUUSuqmCaHRhWG8IIXfuT64WapiksJqx2naxc0QQjgLLQlx4heWQZXgsIRcDrsVOT+s7+3fWWOMtoUuMPG/e4MzqYzvhacV42jLQE2A7OiUtcu265r1eDffP21WbUUoWonerY69qqBz60/PKsSOXtriAJ0j7XKZ6jqXFwTo7uMrUDPpzYtnvvTPdY6Ir+oaXbefdcRPm5LdcEftIyn071w+4PJF20WJJADPVY9xn2G66u2Xwfjbufod/7L4UA7ZGqLRg22rWSFr2gRVd/QD5DzFknZVT6A9/eA4kAIYD2IBGZpRmZgEwhifigXJa8bhI5DephVTciCgwUHiWBQhaICAgi1BS/8TbNk00ECdsoZvn91yo79e93nZfKAWQEg+rP53t2qjpidrSBCy84cc15zvNXr2hMx+/vZZZvPb15CvBhx5oXKgT32ulX3xUbxuWWZtvOv3GZFeit7W/Z2wk5YED+8mPjNcw6Cg8dRn0C7/ZT9nd0G2yZ//Jm+Av3L8wQvIXzNEAJYD3JHQD3B1PgSkGuHQ/6qZi9VjfWoQgjg0QZ8SXGPOCcgB4iww7ybSoMJoW0idgdid3B2B/Y61bAOZdPr9G87oYrecHk9080bsuYq0ZxuxQRxsMuWRSP1OVT41hXZX8q/V59O/Tk2XYfZPqC6esWMi1kp6KX9+s6jAi7rA2gTZFfhsyPXq8y/hQk4Tcncy3n9tN/oNHnzqm4K+4g2ha7ugOpu0tHv3A8Gi16nhUBthtwDdG5OnuQW7c/Ki6n7PA7y4jZJ62e5UQAdM/DRZsOHACGAzaCC0pABteO9ZeY1C1SRQO7gjoMCeNRx1GewBw17Nszgsln4Dr6BQJV5zl7PVsWq1DFedzHFBgEMVik2B6YUb60yWJxfIWbV79tWAuuIWZsJu6ot2d6GVefbtL6/T211FRNw2zJV17TUVuBbWVFNwfbzY3eD2cwGPgV56PQuE/rGLmeIF7sstE0+BPcnXHcPuz9AO+Lgt6nLgVHNi3ZU3h61JwRv5igFxx6+gjoIAayDqQFMBuAUinJ59lA1+LjfH4fO7Tgc4/0MuxwWwMqfm0qGI4XtiYerVlf5e7aRqNb2kXMlkGKD+o07cYvtlWsBO4EkHMlcbJcTPvNKJtqVcsvYu7eiYE32mOlxOSZSl9DZvop2ihjrnDNnfb1Jc44mWtj+rtj2jOdR9WSwzQTskrbiWKzo5pnvKravfyuTPABNxSWA+nf+jicV+IwgD+OUb9IZQf2zVT/XbNx0zk3LHCDyJX0Bj2VHeYAWHve61Xl6LKcAWhMP+1lgC0eV64NRAHMrDyBMwEfbyf2QIQSwCZhJZCB/aHGWM3hNWoLpajK7FewPXHOamycNvoEgfpw02jaZuJhnQJ53nem6q9cNnVc5q1LF6lSzqgnZzH5Mig4bbepUkzm4/Hn/+MK8Jt6q9ew8kfb3BQF0cky6y9iTDyZ+UPuKIA9fly3k68a+qPgMP1V70lHnOiMQ2BOwuvZnw57cus8Euhmt/q0Yon8fQAhgLajxwP6bQAX0OwGJ0zB3+H6QB0FAf3Onh9kxmTw6Pvlt4Te8I5kvUnl01tdNJ5nRII3feXbT1qCb0D5A7+8McGawm3P5srqwf4Nj2/m1meEPejDaj3O1r6EbVckmNjvqktVAXtYemHk7/MI6eMGUjOU5bxvaLpz6eTu2z5ft4uBVOGnbZpxZ8uFec1PqLZ8myJ4SEhCYuHTcXDFkqmCVrwcUqvLn5jHAncy1Tercz6G1f1tl4+NLYt7/1Fewqk3YPpz29vh6l66BHYThd0p1Uu17he+3trao/wGQToi3wSlbAmNSs+9fUd/XvHAM3E7YB9VNQF71nNflMCwN1gte9wbMq+i5bqltPm11ypZ3L/qPtu0fgg93vsj1arrX3G6QFxXPLZbFRDZLJipNUtXr6nKY6NvQD6FvOrV12qynt50kcPOz7oW+ofDaStI0EwWwBUIAm0HqHxwKvCzL2Oegya/G/v6gSM9xwv163vcKbgdrp0zAgG0rg2w6tpfh320/LiYjXKcYy7nmZd43CJjrW8jHAtjE0037Qsm6YMSlU9CEwiYemvCWlbxcTQkR3kFS7fNfdAKAwafKf5GB87fh7iNLpoqXuSrl5TNXjS0TpW6nW1re7U+4UgZ/5/YrcE+2fTpdHzvcN0rWbKUKYpMtECWY0OpJq0v27TRETPrsSjY20RcI9gPu2MqBSG67dp+X8jZM/l5dckbk5gYIAWwG6F8CN0A79WRd+Lo9I2a1pk7Cvl/QNts/6dfmXs3QbdXHVmdcNYcJBJPFwWBQKEOsIPIAv729rfb29kp1rW0SSfs1+ycn2YoZvmcRx47Zjh9On4tev1vjB6eJFfavt58YpSso6m/jidxY69eqc3z+dQDxjONJySexyDNmAIWstG1HANEJAspBKvSvsXWz4jktt1Ze3yawVe3BjsR1l6F7iUTXJp1M0deQ97J2lL99626xfmrCtalvCrW6MtzdU74Xkik3DLQ5l4keXqNh5Cg2dFSFf+ARwry+fPNux4V3QPs76qjz9Wtbfl/IH/dHVSUvq9wLeP/5NAhECGADhAA2IkcECAhgSQawO0Sf5OvqMlF2io4qInQ/Q/wkD/a6cpuEgoN2yKZhboucXoYJCCs7IIMggpzXjckiK4FunkH7Ptp+O/SbP/VJJAIa6mOwJ0baSjM1B00J5nR/dD6G9NkpbvRx1ZM/Pq8mEIGqGHzsZ7hu25p0Vf/OBHCK6uCILE7qj62G9JVM5TlKTnLATPm+4AWSB5UXYJcV+wXTP9839u+zTb11rgPuYHyETJSCY4RpW9STq2n6Kj1hZXcqDobjPgBJYvR3Ff6x+IkUQPEBbIMQwHpA1EizNIuTJE2gU1AAo2PqAuiz5UtkDx5C/gQHCdf05w6oGMy5QgjVynQI2JkzZ4pE00wY0OmCCOA7fGYfMDsAhSc3REiszP0lgoDavCZ8HnU9s0mi8mhcHDcwmYwrTZ+sAOJ49TbSSqK2SCWPalQHjdQRHPez65PJxC83siIuWRXJKUzA/X7j0THxtvdvk7ws1vfWjsK1iTiidJns2/efFRXtf6XLt7GfH5uJbeXRbVv7OIldNnq0br1KX70FFDt3+ftF6avDoue9UjQwtzsEJ6Gdou2iDbMrRNH+iz7PUeg1sjyjKGCpBdwCIYDNyNIsTaACoknpDtDJpVZBAO2BsirFgksg70fcLzP/e6GAVPnFuCoNqzls5mUSiA4Wr1OnThEJgOqH3x544AEyAcPxmskg3m1TDO0jDFRQVaAex5Qak7HzzNhBCx0Ue69wD7B94PQXZaWRUafA8ee265s4qcJcPyNci6p7WGWG0j+4peOaEx+3EU1XgSyZ1ykoZjZwgwdOvOOebWxs0CDKZJC/xzbGUVRKMM5KC79sH8gqIlpV6k0gmBdum7KfC+6fuF1ywBu1fZ+V8Mo0TOS7Ty7GgkYIAWwGMoojCjhBdvG6hZgAar+k6QBnk7/7hfC4qBo879drcZCwyYGbxNf+nZU8vOM3EDtEqm9ubtLvIHxQ/c6fP6/Onj1LxMAOHrCjUonM4bNXfb+JCCqnMoiTTJgVPph8uaO3t4FFtV+bP5v3j8yasybe0jE0RgFnKux1Gk3Abm1ldx+JCQIp1rX/NlHBpd+LY9fnU0Ww7P3hXtSdG/1u/Pbs7dtE8JVXXiGz/uXLlwsFEAAZJDJvoqZdt5U683OVBWTFCdCyyl/d50W3V6fwzasUtm3nuCqIy57Pyj6APLmp8gG0215NiiMTp0lpYMQHsAVCAJuBaKIkhw8gVQOh+XyhAuJd1zMtE0C7ke4X+WOXIs6lVpdTbVFoTfPg4Co6JxV8HRd9X3m/zqDMPmJVyaAZdseJGfadO3co2ILztoEkoLQX0oeAAHKEMJthmGCi/aUgML6nBTofaZG16RcILOLIqiAHixTHRIRvGlnqKudJopWqafuZTVliw1Xb3EoULnQaam1K0hYjr/RZE7zpHdO75s+WidkQVJd4p5SloipLgE/PcBhOU/XY7+69qzTF5n4RRcyBG0zsmeTfunWL7uuVK1fodfr0aR0VHBvTstmemz6GybhLCJchgQJBGwp7O4QTk+KF2iUmYOgbslz3La2TCpqw6XFb+5GICtgAIYD1MxsIGyB/kzhO4m4nzMdkAstVGGBg0x0tOspe2CElRA9auer31mhAhVkNnS864kkYqF4Y6OUQBRkGKiU/VXuXZmixS9y4g7cpr8XpzuACYddinUHDw1L4bqnlwQpCHeDLoY9j9piYwDZtoS2PWxuxzNvWb/x1Hh+yamJevMMjuep7JvArmoi5vVSZ4uaZhMR5rHobPR39ifboKzWIBipKtSkYxI/MxV1dh9MOwsDOmWChHaQgX3i3ImO5fQU6t7/+33bcpt4e19hV2vQECwNAGdZ56kMoX6+Zzw33z8uUNmAbUxJdI9/6jPP0is80nhAxxLhiCDa3/9xcYzN48YGFFSZefU10CpUsnQZX8rUq7pU3NYHzfTYbKC7AJJnmScTyHOjDBPr6lasFGTyzfUqlcaIGk93SdXKVXUbTJILPo+35bIPOrlXphwkVx5xVcQnq+5caZYo3UveotyWysdZ3wQdd/jybLcKbp/90n895yXWdfurutU4saOi/aY2KfqPu+lYfR4MPbQoBBe4onVClUULtDf0NxsxoNFanH3tc9fxQDXb3VK/Tpb40iRPVDTvUnrV5WEfY25d5fX09u3XjOh4cUQBbIASwHmipNJPw8jSBLRh1T6cNOKO6hFk+NRfpAU//yg+OW8ZrFovRL27n/B6sMAl3a7UeRbQRoMNWFm3yzX8v8r4fKu6qsBUduy0X6p1RDO3gggImCpdm7vgDOQc5lUpNWTmecuTUeL2ZWrxV6zQd+9K/kwPdVPWrflcWOZ2+T7cxW0HD/dtVJcsqXvlY3eNt87FjtZf9Ou3EzkT84qScusc42NNZgcAdsorXZF6fx4dTcPxBbZXmhpZvL/oRoz5j8gjDLhl3G8ETFmO506XgRKZugBDAeqDhIJJokmbZxNQWnPUVsnxoymYa/Y7ZjOtHZJvrxIrSjPt9AGglOC3rtyuk1FC1sgxCivJotE87MbNebkr8LL9WqzLHTICCY8KsG9Bd4ldHnCrPr+0BavvdW9GHrcLsW+GXNGvK5X7CqtbC73WO8VXbhv+mvSxH8RYBHcZFpUivoe45GhW8KqXP+exup20/C6FCwfJW3H7d+R6UL+C8x3/gFrOlN2SNh/yscAAI9znT3KPl4LaKSSMHAkNgLPtvCBmcgRDARsCXIIszEwVcfOt00FWzfv4bObjsklyCxTCHE/mBXtJ2hel4E9g6slHk3zN+YNwpM7izhvsDr1vlG1Zl2iqeGVSxQKoYa+xY9Bk5UIVwjmXryJ8bfGNvo/xbubSdq7C6Znz7BcDky/n7KF9aMi3VZweh1PnuwQR3FOD2m/PeF+lTjz/soElA/x0UCerL7dZrU4pNOkGayor/XwuEADYAiSyyNJtkpABmaamRzQkmgPAZtGfgYt6YD6sO4PP68N2vIHM0BzQxYTABHrq9Itmw8RWyXSC0xK1SJw8XbbOCwNh/z3xn38NFJ0kr8utFCGSlemkdQJUCWEX+bFJHQTRO4Avug1sbuO444WtsB23AJ6wwB6OUX6TL+/E2FiFXK6JOGSqdiEVmS4qSqyDX7qTFB3CJ4637ftHtL6pgqn3az0Epe8sqsq2NbZr8edo+ERzFJQxL6rm1tdIzYZwAtVEOKWByKICs+uFhEvWlAkIAm4EUMJM0TScYAu0GWlIyLLgdPhPAJNFZ+EmLFiVw33DSr+VBm4BdQmCrSzwrbyIOXC1kai6eLTnnnsv0HXV4YaWpLqd4LwAPIzZjz72OTfAQF1Ln31dhznYJHVdKqbt+UPUAO/jGroQSJ9O8fRSsY64lRwRDZa1TGImArhjEsSrqCK5Llk+qheF+h77+5bGU+x0QQLsKCF4I+uB7ZtcJLpzvKVAfFVzJ4VUUwBYIAWxCrhD8EaVpMkZtQQTteTr1eFERBB+1L1R51m+SERU+gILlcNgd8Ek3AXPtV3dCU6XAuD59AKeGwYs7attM6bZ9lwTpihmzufaq1MLl0LC+h0AuHEu9GdSt/esSFsgMvMhUobDIllFIeTtlP2FPhX5nllRycgCVq2g8W77Nvg9ht1O63nk6TQeD+9GxEmW75PqAydVcvml1Ubpt0btz7NdbRImcA3XLtx3nsoreQfkMznu93OOpW8/Fwj6Buv8pPwPoNzB22snnqS+xotW576JtINwa7V+HduEBQQImTtJ5slWCFSAEsBloV8YEnCPvy6xvjwn2IO8E+q3cuXIerboBTnC8CdRxBxM0u/wX0KRy8++uWmirUww4cgM2IaxSwlyzKX9uTTNiSs0t135AjuZ7DquO037e687H9muq24593dxax5wGxt5eaV3LhMYmYDozrvZiDaxVJDJoyZN40KjrB/fLB1D6j+MDeyKJd7TfONJ5QKuyadQpxDoPICUXEAWwBUIAZ2E7JGGCH42RNl8pCilnkxc65k4nzNMs9zBL4dqF09mKrrJwanuTpOy9vV36HfmNYBYuTBxqNRx1Itl0fNr9rHkAXxVMINyBoM236qiYcA96/6mppIEcf3asHHzbAq8hQAC5Wa2E07Xbt2r1Vl1zCFQ2MSTSEvi15LL0cvJYVpmbK/32rO84tquufTSpZey/yMfgqp58PlXbKVQMyBQp0rXohNvcL7DJqxBUePfGZEbHDqnDOmy6hu5hVvjRudf2gDGXMmYdx7zKl9ZapzduXp+0uu/rlMjGjTak0ak7j9L3Vh7D8kGxY+TiPpC8dc/u//Ka/Xstx1ehxJLS1oDScdRN7HiTGCcDv6PyJKP2jwkjxliMkevr6+rGzVtUtabb1f6AGGsR+c45A832vE6n42G9ThAgsyaVby0KiB98vYNjCyGAzYAxBj6AERqU7/swAQf27KMwATsoZthmJm47us7j3CwQnFTYbR+VNmwTpm1SZgJlE0e3skeczZaCs4FBgde19z8lQDqVjTs48TGygll3Dv1er/jsKqj6/HTwl6uQ8itUXAqvXNbK7i+a4B2DXJ4CQRNmJkW+TySP6wC7frTu3/a6nuchcBOuW4n4ALZDCGAzkExylMQxXlGv30+DIOhQhLkFVgBcBQKNlwuz2/UMq7LuCwQnEVXO/eXPrIJrZYtLw05Nnkah5AhZx8fQzMdqiVLH9HCVCp+XlRScqm0UPnzOIMVLgn+65M4lebxe1XdpFlWaxrm/aEsEfQxQ53u3LG3dL9+4VbeT75OP3bzrtX1uW18tqZQu67u4ENj0y3+jihbGTQ6Ccq0Hdj9inhsA6mQcp3GUUeDmNMf8Msd0P0AIYDPQgMZxHA/jOJ70NzYzdjwtFEDUQSXn72l9YN2YNQHk2YybWw3Qy0vbFBwcWk1I97D9VZloq1LG2CTJNeHbJAmAIsimYHs5/ttNp2L/RoX6PArjqF2GzbLucRXHl0SV52W/V/kF8t/pZDrAFYEc1Qluq9U/u6zeAeCkT1TbFNaDPv+Tfn3bQGOlsaSxuwie6e3tbbo2bOa1nwvbUsCg35TKAj9I0iSF3z5ctsQHsAVCABuAxPqel4P8DSaTydj3vNj3dSEv46NRWQqx6NyN0re5uakHKipqrdWBwl+wqVapQHBPsGwbnL9/rSJJANf6tX1B2TeUjqzKx5DJFUzARiGoDtBQjZ/Jh65wE6pehlKp1JA/ck7Pyi4g7AvIWQHSLC1JP9paoP+j73zTBVPkr/5PL2vqCjcQ9CNq+i0pQW21cBvWX/b3ZVHnC1f3e6Pv3ALRs22+ict+3m/sW9TvzHOYZlQRh58xfIcxE+4btguH7XNcJKg31jgKAvZ95OqNkiSOsixDxyAEsAVCABuBzLfeOE2TYRxPRhhvuFHxLN42IenGW45mAgnc2tqiQBDMZkAAAYpwimMVCP8THCpWbYDN/tWzJt/Zz3UBEq6vrEvQ4ECfVASZNO3PXS6lPITzB4G4RNY20VaRXPd3NhEX51DULy2bh+9VkJJAcNjA8xCG0wAqmH5BABFEaecZZZ/76TphkX3DjL2Z56koSdKxUQDvb3l1DggBnIU9k8PoME7TdHcymQzyPIs8j7LG+kWjzMqBHeivdcJK3amD5G1sbBQEkM3HaLxECAWCQzUBm2ogSwAK2jL7LxEwi8BVLWeTpbaI3nn2vSxsQuaSNJf4NZHWGUJpjVGuefuYmgf323dtrmjaJeDVRNGWFLwKE89CUcptCt8CUb6LYtHrXrfevPtZCtMav9PURcj/hzHz5s2bNH7azxlnCLDNwcT8MqrTANI3TJNkmOdZ1eB6LB+og4QQwDmigPMsM40qnyBvRJ7nPimAlHW/WmUuzMCJTgbd7erUL7kZNX0vJAdyFSzvBwgfIGxu2QH8KOAYH/oJAdKp+NSGuC3N+z5PFGoTGWoCL2unUakKorDz2FWpdG507cx+oMhRPEhO/nR8fu5n+z1HihazC5iv7ON1SVybDyPS1dpBIHXnWgU7HGUm/cs+4QAJypEA69fLvB8/kHZhvR82fJWqVCWZUj3zDIQhxso1SgPD5JCr5Wjg2Gfz/+F59D2Mzdk4zdIhtJdDOaVjBiGA9dA+fkpFucqH49FgMI6GI9SuCry80+101XA8yn0/NC0TA43uMHXqB48aMWYw49FE9dc2VBh21DiC2bejhsMREUPT5et/2fnbqYvYeIQtSkxrB56v1pm3qUCN+78H7K8tTx35leQrrN96yZpP0l/BS0XngWvZQNPx5b7K6Ph0IETVi4prwrva+JzZ79NcePW7YBOnXth5p21VHyA3GyjspZOh52J6am0KY2sUbR7QHIy2lU0VUdqCKfPGn+3vi/Nruf+Ved5sUkyXJ1cZaspVeIc1PZL6mHO6H3UEcMbk7m6jLc1My+8ViboX8uFD5GbLeo3bq7j/pe019D/0QxAEOhwoR63PEtGnuXo++33x2dl+nU9enc+f9l2rSwQ4XahZAa3zsWSlwSxGx4u+ApKzfje/z/RvdYph8X3pmi7R/5cDpHy1uXVKB1spX42jifrJT59QYaer7u7sEvnTFrVYBQGUvkSlWaLWuqFC70UHkCs1jkZqba2XZEk6jKNoAOGm+cgElXdfMNNakVBykiTJyMvySRAG1OMVGfobL5hPfgzoRCFpY8Alx9UiO//xnEeeJBxn9XRl5ccijzyMLPJ+RIMQFoL9FC76flRw3NvwYQJKL6m9efW7fX3d9+OAIroczNV9PwIngkts8qkXkcA0VipVigBmTJV0HDuCKPEqfPKTNI2HUABN4QZBC0QBbAdk5ShJkiFI4Fq3n3qe73F0YBsGgwE12jNnztBnjv7lQtbH3IIiEBxptPrRnXAT5z3AQopfk7K05H7btte4XEPN4WV959qOt+6zu522+cZ++0S626n7vK+w0z2xWo+xEuMrxk43PybDcpfI4ZZPFYQ8P46i0U6aJDtKTMBzQQhgOyCTTJALMInjsR8Eic5DlChvjhBeTgVz+vRpHfiRTEjuJvOvDC6CY0+g1InGMQ3EODGQPHyroRhj6lwt1OHCTp4OEge3qbNnz5LljK1ndemdSr7AqBjke5N4MtlF0KZSufgAzgEhgLNwZ1Jwk4rSJBmMo2iwneex73l64jHHBeZ0Lwhrh7Q9Hu4VDdYtayU4hgOQkPgjff3miYI+TBz1IIs5CNh+KV9tiladL92822tbrk0JXFapWxT7fcPnjaI+FC7oRvqD/G1tbqpvL1wgEzCEkrqE6lxIAe96LM3HURTdSZPkLkSbI8RzjyzEB3A+TNI02RuNhntJmkz8IKCY83mAGc3e3h79/cADD8wkiRYIDg25PP5uxO28EbgCwXHAUW/fblWPRx55RHW6XUoBw78D7vHaSaMpPQxcqrJ8MplEO2mW7qCIyCGd0rGCjAD1sJ+OKEuzu6Ph6E48mYyCwEceGHeZSmBmcvfuXfJpOH/+PDVU9gM8Cg+g4LjD10Rumdd9gKM+AJ5guFFuRWC589n9vrS+da/wt/2Z0XZ/2/az6PHWLT8v6o6j7fjaUHc8/L17HY5EFCKXVuVsC48++iiRulu3bhXf1dzb3CiH1AY8L8/SNB5NJvGdLEt3lMolCGQOiA1yLuSTLM9A/u7AD7DT7VFN4LQmB6ANNGY4s8IMjALX5Kzq+0VSaCkFIjjKEB/A1UjiYZtwBUe7FvBBY3r8R/M8psGQ+j5gjMTn4XBYIoD8XqUImr/TLMtQtWsvz3NEAddnmBcUEAI4H6I0iW+PRsMbeZ7vJUmS5Hneg6oXhj5SK+F/mp3aQGNFBRAst7Ozo55//nn14IMPqh9//JHK3XDjr+tk7AZ/L3DcO7vDGABMKcoVtt/488r3f957WlexovX4Wyp1tOZRbBmY2o9/tevvHXL7Wbn9rbj9Ip1VSym8ZY/P3iSvUrN+W9Ru7hwb/WOl0av0dVshT+BcvoANlUQa9+t+uURTXHR/R2YmYlfyACCGwEf+4YcfprKp33//Pf0GsQRjZ5HKxsnvSTkc89xDjsA8746TJNmL48mOynOUbTVJAldWVk807g870IpAVvE8z+8mSXxrPB7vZWk68X2PVMA2cOOGHyAUPxBAdLpwbuVawfwwtBWwFwgE9xfswa/qJRAcJ7iCBwgexkJ81+/31fr6Ovn/cQ7ANnieh6pc2OgIBDDLMlQBGfPPB3gqJwJCAOthzaAoGfRukiS3hsPBnTzPRp7np/ZMtA4oZo1Zze7uLoW1P/nkk0V2c5cAuoRSOniB4HjjoAncESaIdb53XsvLXa5uPRdt37etvyratlvni7eob6SLNl/Ftu/vGarUVhBAWMPQVh966CEaGy9fvlwKDKnZlnbwzHMvCII4y9O9yWR8J8sypIDhABAhgC0QE3A7PCMnj7I03R2PRjtpmg79wIcZuNPWx3KEEsjenTt31JOPP0qh7iCEejY0TYBZVf7tqKeJEJxsrOoW0J4GZqXNr7z/4/78nHQfNsHJgzu+oQ2DBD7zzDPq9u3bNE7ic0WZwUqEYTBB4McknkCcgf/fCgU27y+IAtgO08PmUZZnu+Px6E6SJLt5lsdZpustgsfVrQxyBzkb6WAQ2QQ88cQTpAy6Pn7SWQsWBtVjW+XVsnmJoj1UYBBseh0jtClV+61cLaqk7fd2593vooqm+7urLLYpqvNe97kwb/9gB2zY67H4AVEEPoBfffUVqYLsO9+0azopXyk/8KPJJLoxGUfX8izbq1tWMAshgPMjVVk+jMbjO5NovJNlGfwCW1eC+geyBwII1Q/BIDADY4YD8APAHbptCj5mHbxAINhntA2wQtAFxw12m4XJF2Pj008/TWbf7777rgiQnGf8IxEmz6NoPL4eTaJrJgJYMCeEANYjr3A7GETR+Pp4PL6RZekoCILWGHubJEIJhLyNhNDnzp0jsocHgJNhcoNnU7AQQMFh47gTjMM+/lX33+bjd9jnV3XIKxr290uxOyifv3m3u+zvbestq2y6CuE9zwdY1R4hgKBM6osvvqAuXrxIIgmCQjBWzgOMkQmqdI3Hl+N4cjlXyiaAfH6CGggBXAC5yodpklyfROPrWZoOQx/qXaaUlzU2UJA8TrcwGI/U2sY6Sd50A4JQP4lWh+3mOjpiHfzJcu48Id2Dly/3ftCQ9ntigzxOBPD8cx+w6PuxAid+t9/3LRk8j3/tip09biGFEdowgiQfffQxSo/GZuHxeDxHCqcc42qepJO9ySS6mqXpdaiB+3JK9wkkCKQd0/xTSo3yLLuyc/fupe3t03e9wE/8MAg9Y7pFk0aXPR30iDSqMAhUNJmoja1NdePmbXq9+NOX1VfffkOdyRAm4rCjTp0+oy5fvkQzorDTUWN8b0zE7sPl5/PlATtorLp/K4/XwaDh+PiXpoyhnt98fH5bHsDGX7HvFdbXcXD0PwgdTXed9wBKsqdnelXvqVGd6y6TfXvcCQe1cStyvcEVth4tY8Y8qZaa0DaItNy+OSZZsyewCDFDHsXqGqfz5QH1Vmz/ZGlAnoPKX9t34M8u4G7Ka/rd+rFyT4jypB9rUmR5Kzx/dN7GgVtPwivfc+ezx5+BYEWBqe34G/L6EVKv+vvio+dM9Twzcsx2bI33qQ4BLgZ1Nta7RZKTJCZFL44znRFje5uyYVBA5JNPktL32huvq8F4qD769GO1vt5XcTxRvo88gL5K4QfI915PerADHDz9n+fpyFPZrXgSXc6zDPXjJhXR1oIaiAK4API8j/I8uxlPoiuTSXSXZhuGAVUlgXZNvHgQ8H7jxg116sxpdf7Bh0nyRu6jJM9IHcTfqBpil8cRCGof4Hw6GVj0ndrpCpdWFCjBSUG+xPvxYxY8nuy38kdMdvpuWcS46hXGQfj2QdnD35wb95HHH1OPP/44BX/gNwR+tBVH0LvJlZ9nmed5gyiKbiFFW67UrpUAWjAHhGG0w55hxXme3Y7jydXxaHQ9y7O9LEs5GMREBJcbLgd50AJmJnPlyhUies899xwRQiyD9fBAIBkmHgK87HUFgsM2wR5Fwicm5iMPlyu1+dDtdzTwvfL5O6ho47rv63z65vURvCfXGQQQggZIH14geQCPc88++yyVf/voo48K0YPHw0qLAw+2nuehIIPK85uj0egqCKCaBoAcvY7qiEII4PzQD1meD7I0vT0ej24lcbyTZVR02meTr6sAcqJnnv1ABQTRgwSOvEdIfolawVgWDwqbfXSZObHQCw4XJ706zf1MIE/WnazG/Xx/jwJwjTmil4MaoQjiewRCIvr38qVLlPwZqV9ADLlQQl0aGHPv/JRq/6bXx6PxlSzLdqT+7+IQAtgO18dinGXp7Wg8ujKZjBAMMrZ8dooehTsYbuwIdQfxwztmOBcuXFDb21vqpZdeosLXprZhIZGLCVhwVOAGHEgAwsl0I1jmtQDmVZaWjY49Kspm3XKLRt3W5fFrW75NsVxUeV0JEEAgfkDcwAvjH7s4vfDCC5QR4/0PPqBl8RtnvwABrPKBxRjLY2uapoNJFF2Mouj7PMvuVmXu2O/zOWkQArg40AD3omh8eTQcXsnybOAmc66bZXKDhgoIM/DOzi5J4Aj6QIPn8HfOBShpYARH2QR8FNRAUXgEgqMNHss47x9eiPx9/vnnKTDkm2++IZcoAGIIvgPaLGBZlg3G49GlNIkv5UoN7snJnDAIAZwftrq3E08mF4aDwYU0SW7nOZmBbQWwmKVwEAga9cbGRqnINZJe4ruf/exn9BkKIB4WzJqwXksmdIHgnuMokD7BsYSrPC3ro3bU0OZLV1ex46B88I7UdcOYBsUP71ACMSaC/KEa1rmzZ9Wnn35KLlAcIAkLGAsfjg98EWyJV5ZlE/j9jcfjH9I0vazyfGS1ryNz/kcdQgAXB2LPR1mWXo4iNL7ktsqp+HTJ/MvvaNgAhcBvbdE7GjpmPPB7QGN/8cUXi3VA/NhpVgig4LBx0gmfKIgnG3J/jwYBBPlj8y8igFH2rdPtUvAHJzQHMB5yEIgLsqAZEp1l2ShNk5tJHF/JshzpX+Ij5iJwLCBRBsv5AiKU6UY0Gv042Nu76oednbV+v+f7PnIA4lXMVtDgATi3wgeQS8Cxn8MXX3yhfvHGG+QP8cMPP6jxYEDrcRAIp4JxTclVfx/HYvH7tf868+Sq228zw7f5QbXtX2c5Oxr3r2pfVdu/l/WrV3WDaM2j5x0uKW66lveCfK+6hznuvqvK8GfOmlD63roGpfx/dcu1PX9N13DJy1t3vHMtP8dydest+qAtu9+VUIgfZrP4DCsXm3VB7uD396/+1b9Sf/7zn2lM5OhgjHUYJ0vRw8ihq0up5r7v+3t7e57v+5OO59+MouhyFEVX8iy7YwJAWDIUBXBOiAK4gh8gIpCiaHQ5TZNbvudNfB+lqXUjZ3NuG27duqV2dncpGARSOB4WPATIDwiyyNFTErkmEAgEguMEkDuMZbB+QQHE59dff13dvnVLffnll8U4aU/Y3TGPA0NgOQMJDHw/ipP4ehRFl/Isu22SPwuWgBDA+eEmJRrlWXpjNBhcGI+GF7MsHWRZ7pmGiwSVtQ73diknzIDgC/jE449TQkw0coTDc21gfncfCoFAIDhCWDZKd9mo2FWxrK+c68tXt915fR5X9YWcN+9f3Xns23WtGpeg4jGBwwu5b3/yk5+oTz79VF29epUIIUggj5fuOIe/zfo5rGK+7+ee7+2Ox+Pvo/H4QpbnIIAS/bskhACupgLejaLx96PB4LsoinZB1jjvX1u0JRNA+AiCAN6+c0f9/d//PX2HQBH4SbBDLJNAe1tCAgWCuR5SyQMnEBwwapI20xgG9e/69es01sH0C0UQvn+wds2zXY4iNgpgnmf53fFo9O1kMrmg8hzVP8T3b0kIAVwNO2kSXxiPRt9E4/GNNEkiNxq4bQOQxeHj8Nlnn6lHH32UTMFQBfGwtKXvEBIoEAiOCe5p/rkVjme/tlsXBXzQx3NPK5ZUpTqzP7PCBwKHbBdQAOH7x+5OVZYtToNmcgHC92/qL6pTsF0ajYZfpFl6Aa5YzrkJFoAQwOXhm1rAV+NJ9AOVhsuyge/7GVcGYWm7zrneJLMktQ95AZEc+je/+Q09GJC7QQ4FAoFAIDjqqBIkOPMFghwxtt24cYPUP+S+HY1GM75+7gswf4OrxEma3hwM9r6PJtF3Ks9vKKWQK03SvywJIYCLw27lSZ7nt5Ik/nE8Gn4fx5NrulKIntV4npe7jZk2YCl5MPdyZPDnn3+uOmGo3njjDbfxS/UFgWCZh1VMwAdVBWRVxcpVyA5aCdzv/Hr7Vct4v8+/bTsHcr3rTMAAUp6B/MG3/Q9/+AN9j79BAIuDcsY59v/DH9Pv1W48ib4dDYZfpEnyo6X+CQFcEkIAV0YeZWmKlDDfTsbjH7IUwSCZnyRJkQ6mCZnSJJDTxHz7w/fq5798gx4QCp0HESQyqG+V5+lI91R5KtNBx4cKb4V3cdw4XNgpNJa9j4L7u/2clOf/uB//4cBKUZabsSj3VWrltkJlj3PnH1DPPvecunT5snrvvffUuQfPq9EkUl44TfTskj9bFaTfaTfp7UkUfTmZjL/I8uyWNYEQLAnJA7g4XFKX5Vl6czwafLa3c+fJfn/tiU6vd8pTQVdlsANz+yyTNf2MZETuRtGYZklpnqnPvvhC9Tc21D/8u3+n/st/+S9FjqS7t++ohx56UHU6XXXr1k3V76+rNIm1r4Q5oipTc9vTkTkLzJOLzFUziZ7meltt716W07l7Dce8FGa4tskTVpMPcP79Ni+X8oksidZ6qmlzHrxVp/A4fL4fmZeXPuPdR95z67P73oa2OVDQkiqp7T615QlsWj+veQbawDnOiudOLY9V8zzieeI/i8NbACu0H1q1rl1QU6r+PuffnevOef/yRfIJVty7uvx3Xt1yi/Rffq5y/tx0XBX7qUTmHbjfWtv282XUPUboBSrwfJWkueqv9dXtnV2K/H3kkUfUnbt31frGlvrXf/v3qrfeV//vf/snNU5jFXY76tqtG2p9rU/9C64lET7zLJM8mafYCRwB88lknKs0GyVRdHl35+4nSRx/qfJ8xzp+8f1bEocvIR1/4BHezdL02/Fw+MV4PLoKMzA6Mvj3tSEMu8q3St5A9YOfhBf46vU3fq5u3rxJPoEPPvKwunH7NuUNBPnT6uCU/B0W7KLwi74LjgZWuX/38/SbJjSHfRDHuP0chX5A+i+10gQElqvxaEITsSiKKXjx7NmzahxFNLl5/RdvEBn8/X//Z7Wzs6MefPghdeXaVWR6JutXW5YMw1HSNIvvjMajH2ACzrLsssn9x/zlCLSk4wkhgMvDanT5OM+yHyfR+MvB3u43SRxfU142TrMYZmCKXspzpIdJa8Pc0dgRNALSiBJxiJJCiThEBsNEjAcLy8Fvgv0j5kk0LRAcZ4gP3/yX6pAHwnl931wftLrf66Jn23zYFs0r2JZHz/VVXPT3EwWXrGGc6vS6NHZBuOBqHhAokNf217/+NYkW77//Pi2DgEeMZ+traypPqwscEPmDYOx5eZ5lGDx3J9Hku9Fw9GUcxxeRfs1U/igO6x5eghMFYRCrAw89vFVRGeTH4d7gs9Fg8G2eU0QwooGRHBqtmBZ2G7tJblkQQTwkyJOEJJkge3/7t39LZO/27dvq3Llz9HDBrwKmYcHBQwhIPQrTTUu6osO8vo3bXnH785z/Qb8EgnuFKlMw3JMQxIhxjOv9cuWPf/iHf6Dl/vEf/5FIHSJ/7969q7a3t+etdU8yYJ5lyLf7ZRRFn2dZdt1E/gr2AUIAl4fb+yYqz65NovFHuzt3PxyPxld930+mCuBUCSS+6PgwwW+Ci2aDCN65c4cSRKNu4ssvv1zkUsIMCiqhXUBbIDhMeCu8jnMk7H2OeRW6ulu9aFNYNLq2brk2xdFdru782o77sBVZdS9y/cE9CSpgnKXqoUcfKSp//O53v1PPPPMM5fz75ptviPTh+8Hungr9gFTAGgsWXXPMrcy+xpPJ5NJoOPo4ieNPkXXjnp34fQAhgPt4LXOl9tIk+Xo0HHw63Nu7mCbJwKh/ftVDBASBJnKYDfHDgwhgANL5F198oX71q19R+Rw8aPgdKiBXHREITjJEARMIDvf5a/oMIgdhgpM6w1KFWr+o+PHWW2+pv/zlL+qxxx6jZWHRgoAB8zCLGXU7RN6/PM/jNE2uDweDr8fR+Issy36Ef/0RmjseewgBXB02qxvleXYlnkRfDfZ2PxsOBj9kWbyXK4po0pnMizau/R8AU+KGZPEpMQzo7++//54eHBBAPEh4cOAPiN/nkNAFRzePmqhIQvCOA8GtE2/bfPv2C64S535u882rO49Fj7PN57DNl/DYo6o9DsYjtbaxTuMRBIrnX3hBvfGLN9S1q1fVH//4Rxrbzpw5o5JJrNI4oWwXAFRA9n238+Rqr4qcfP/SJLkdjaPPh8PBB3GcfJPrur+Zdb+bUwAIWiEEcH+BXnsIX8BoPPpoONj7LEliKlYNX8CqTh0kDg8JTL9Q9vg7ujnGJxC5k06dOkUzKzb9ggRSwmmZC93vA/Sh4qhfn8P0MdwPH76jfn0F9y/Q/kDoMHbBtw8q4P/yv/wHtbGxqf6v//pfaRmQPwSHYEzD2MU+g8Bwb6AC7ebnbtqD2SxJkpvRePzJJIo+zrMMRRbE5LXPkEiC1ZE774nKsqtxFH2wc/fOWeX7D2+dPr29tra27XleprzM94Mgz3LlcQCI7QPIsyH284uTmB4umIKffPJJyqj+9ttv03d4uG7dvFE43wZhSKQQ28XDSTUVnWTRbXnH3N+rBhn7OzzAi8DdfhuBdffvrt+2/7pBct7Bc97r1Xacy+KgB/lVj7P1/rcc/qL3f9/P76C3vyLaj//gdj3nHnNn+dp8e3Pu193+vPn89AfKMmgtPM0ruOiNqsur6O5vwc02bOwQ2lcd7EkGZ6GAGAHzLcYbDlZc39hQkzimbIr//j/8B3X+/IPqP/2n/0SkD8t1wqnSpzesVJZoHsdihnFlyoMgoOIJSRKnk2h8dzwef7e7u/NhmiSfG/WvOLxDuSgnEEIA9x/wXRimafK9mkSfxJPo+TiKzne73Z7neXjpqGEv8HT0b/2kpiBxvq8uXbpEvoEggZDaP/zwQ3oIkXMJDygTSI4oPszOQyAQCATHEzaphbAA0sc160HqQPwgNOA3EEPkqv2P//E/qieeeEL98z//M/muY+zB7202WmyX3J2yLI/j2Pc9L/T9YJSr/OIkGn8aTyZfmsjfmOabogLuK4QA7h/sWUmSZ9mtLEm+Hg+H74WdzplOt7ve6XYfRmoYxIX4AYgdlL6KDVklcABI6/ADhD/gem+NoqtA+j777DMV+F4hqWMZfvBABJkQNm1bsBoKfcGZk84td8itECzZ9NymdI+229Zi2xTBuuXm3X4d6ipy1F2Xec/jRKNuPGASiDGF/faQfgyEDeQPpA3fI+EzXJNee+019cknn6h33nmH3JUgVpCyFzR7mWE/GKNSeP1lGQwKme/51+LJ5P1oPH43TdPvrZq/Nb2tYFmID+DBIc2z7PpkPP5ouLf7/nAw+C6J470sy1JjpqjsgPjBY/mdZ2DIq4QH5eOPP6YZGCeJRv1g9gnEQwkgmITTxlT5ConvkEAgEAjc8cAdG+Czh7EH4wtSk0F4QEoXEDwQwqefflr9+3//72lc+qd/+if6Dcuyb3sV7KAPnSqXQj/8IAiQ/HkwGo2+G+wN3ptMJh+ZtC9HKWvUiYIQwP0HP0HwY72bJvGX4+HoL4Nd5AYcfp9lGWYzlN4cU542/wuQOZTQAQnEw4VVLly4QA8isqw/9fTTKux01HA0Ij+MTrdLPhnRZELfc0gayhLj5X4+CsiXfAkE9zH263Foi6at+93d70FF/7Zh3ryDddtvu473BfmwhQL7HYGJGGsw/kCMgOoH8oZxCYUJUKggThP1L3/6oxpGY3XmgXNqZ7CnoiQm9Q+1qusyIEDuC4Igg6UqSdM8DILdNE0v7O3ufDAeDd9HeVWV5wM+ROn29x9CAA/22iIR9O00ib8aDQZ/Ge7tfTIZj29kaZpmWYYKIaXZUBU4czoeQuRYItl9PKbkmphlgQQiWTTL8ngw8bBimapqIUdJ/Vs1gvnonIlAIBAcP7QFyXGEL0galECMOfDxe+ihh9T/+r/9b6Ty/d//z/9D358/f56KF+A7kEOMWbytuv1g7DNjYR4n8Y3hYPD+cDh4O0ko7cuuk/ZFsM8QAniACqBJCxPlWXY5mUzeH+7tvT0c7H0VReM7SZJMwANNihgqFVf1wkME51uQOyiB7HwLMzB8AEHyEBjy/PPPE1EE8DteHA0sJmCB4MTmcZxXoaqraFGHRRW+efPx1eX1q8vbN+/xzbv8fuX/OzFoEgWYxNl5Z5966in105/+lMabP/3pT2SRgjCBsQljFMzDMAM3bRfR2SB/SZJgoTjL0juD3d0vd3fu/jGeTN7Js+yqledPfP8OCEIADxbokBCWO8zS9Ps4Gn80Hg4/mozGF9Jksuflue8phVctUD8Rvhd4+PA3RwVDmoeD7tdff6MefPBB9frrP6ffsyynmdqpU6fpd+4Tp8+i+3keZBXv/Foe9gDqLfEu00KBQHB/I2t4LQ6XtHH0LwkQu7vq4YcfVv/uf/6f1cOPPKL+83/+z+q7iz/Qd8hMgfHmueeeo3V+/PFHGoda4KVp4nt+vpvE8ZeDwe470Xj0Xp6l35uKH4E1SRAcAGQMPXhwA+76QfBYt9f7zcbm5t9tnTr1N/3+5tNBt7MeBEHq+35gXAJNephphRC9kaCUNZ3NxoPdXXXmzCn16quvU1m5P/zhT+q7775V/f4GpZi5ffuuOn16W3U6PTUYIHxfqX6/pxCHsre3o/prvTIRK8JarQ7By5TK/fI7/052XHOMFabseSKOsQkcw6Lv+4E2k3h7HsDm9dvUV88L5t5/1bGmK/aNi+ZxXBSuX9HMeQV+4xm03p8Vj2/VdnTYidjhY7Vk+22Lml00n9+8+fZKy2XewustGgXdGA3cdv8P2mWGJIClkSmvIY0Y+uppzXi/8pw4YANKH+WeDYMiqwS+XzPFCWAGfvKZp9X/9G//QU3SRL355puU/oXdjOqebztPKsY3BH2YfH9pnqR+lifDyWj05d7u7j8O9vb+P1L/8vyGZfoV8neAkDQw9waeiQq+EUfRp0PlbQdB+GAYhptK5Q/nnU4nDEOkh0mRJ1A/TO0JjvFwIeR+MBhRtZAXXnhB/fa3v6W0MZ9//jk9yFAH8fDu7OyRari21lGTCVIqKZqhZfR3wzPGZM99p+dzfwRk7oQXfRccbxCRP+yDEAiOParUPj1RzzFhbwCySAB6bFhTe6MhWZxADOHHh+BCkMOfvPwS1aRH6Te4Ht2+e0d5LSle7Dx/RTJoXegNY50fp9HYT/OLo+HwveFw8Ockjj9B4KRZVcSpewAhgPc2KngvzbLvJ1HUHw72zoWdsN/r5UFXqfOG+GXIE8jkrjR7B/Gi2dxUbcNyeLjwsCIkH7I70sO89NJL9BvyBmI5PNxUVSSOi2AR/I5Aka4fLJknUIZugeAQsGi+uzrUKW91D793wMe17PHv93aPOdrz7tlAXw+hAEQNQgEUSQQVgrAhmBDvyPP381/+gpb9y1/+Qj5/+B7jzgIEkNK9kN97nvtpmsZxHF9Jx9Hbw8HgX+JJ/HGm/f6ilS+BYG4IAby3T2aKsPYsy36YRNFfBrt7m3nubfudcC0Iw9NYxkQGIzHSTIdL5Mz6GwCJA+D/Bz8MJOKEg+7Pf/5zekC/+uormtnhIQdJZBKoo69SlVOpuDLpWyxZtBBBgUAgOOqockdBsCDeQfag9PXW+zRumAANIn+vvvoqKX/vvvsuZaLgAMNFQNqfUoGJ+k2zNL2TTeIvB7t7b2EszLLssqn2we7dqzmYC+aCEMB7B27QSZ5nN5I4/nQ4HKz5gX867ARrnRB5MIMNLw86eZ5mfqAg0ynfKHRF8AP54U2JFx5eRF7hwQLRg1/G119/TeZgvPD91atXKWoYzrxw1MVDrMvInVbJWE+4puXjeLtZmeBZfn8CgeDQkO+zwtXmO1e3XJvC13Zc95kyd5ComIRbpl/dt+eVRBD5+iAigNQ98NCDRARRxxcpXajCx+uvk2Xp/fffJ9Mw8vxhTMF4AnWvY8Yn11WSG0fo+XDZwZCGxLeU/Fbl2Z10Mvl8EkVvj8ejv6Q6398OH96+XhpBI4QA3ltwxESc5fmNPI4/H49GZ4MwXA/DsN9bW3vS97yO7/vGD7BIl1BgStTMBj2vKBWHv+G3AUL40UcfUXoYmIThJ4iHGOQQAFHEdoZDmIDL/byUihMIBILjAF8zr4bJeVsQGrsEAbAOQf3DuAHxAGMHzL1Q/kASUXd+MBzSskj7Av/BTrc5iM2YfvGPl6Yp8v2Nkzj+YTQYvDsaDt9Kk/Rbk+8PBya1fu8xhAAeXn7Aca7UJcjfnu93gyDYRAq/sNN5pNPpdHwdwQVTsHnCXKLG0V8+EUCW8PEwYzYHcy+SReMzCCC+Q8QW+wTigcaMrrOuo7ymJl+dN5CVwEK45BmlKIECwWFg3ijd/cK8Ub+Cw0ZjoEd19C8DhA/jApdte/zxx8mFCBWlLnz3HSl/GEsgLMCNaHTjBo0l3Y2wNQLdtJHMkD+YfaM0TS6OR6P3B4O9P06i8ft5nl2DVcws7+b9ExwwhAAeDrSfQ54PUex6Mh6vjcJw2/O87tr6ehgEwYNe6IXz+OHBGReZ2bk+I1Q+zM6QqR1OvR988AHN6PBCcAjMwMjWjtkeIoSHe7vURbjK31xKYEuEmUAgEAiOJpBCqmvUP2SEAPmD6odx5JNPP1Vvv/021Zs/c+YMkUAofvA1x5gDf3NOUVYDyj0zrfSRTuIkJsFjNBz8KZ5EH2VpiqAPZJrGQYiP0SFAQq0PD5zjCETvTBCGP13rr/12+9SZv9/e3n5lrd8/73tekOUekXTP8+hh8izfP5rRWVG8LmHjmo0wCYMUQtaHjH/t2jXyEwRZzJKYHmaYAvDgYx2ogxAAueyc3m7185knmihymH9V/qfDzNO3Ktq2P1Vilz0ff6X9r5qH7jBT6vCxN5aXaJ2ELJaHcWb77SrGSte/ZZBsRdvxr5rH7qCP72Dz4C1u8nRRzoE637HY21z1+lXl8bS3bx9T1fEhGMPufwH05VD0uNQ8lwjFMpj44zd85mCOM2fPqpdffpkqfFy/fp0ifTE2QFQoXI5qrqXOWau/5/3BcuX7fhYEgR/HMUreR5NJdHk0HL473Nv7xyga/zlLqdQb7MmS7+8QIQrg4cI8V/ndNEm+HI/Ggefd7SMCOEmTl8Ow80C3u4ZYeyqbowlgOclmWxJdzNxgIsaD/umnn9KM7plnniGzMNLEfPrxRxT2D/MxnH9hSsbyvW6P/oa5GOvGcaQThZrOpjiBGqI39VX0jjUBFDRD7o9AcG+eryqrjJ3I2a4Hj8k8+mku5YZ3LIff0L9zCpcXXnyRTL74DuMDcvxhOxgTsC2MH/Mcn/VOPn/ommH6BclL4vjSeDh8fzjY+x9RNH4rS5MLhvzpFBSCQ4MQwKPhE5jmeX4rTRIEhSDAI8Lz019ff8X3feQIDD0vQAh9jpRKRHuMGmg/PVUdBPv94WFGJ3DlyhXqCGD+ffbZZ9XWxialioFKCD8Prjm8tzsgn49BOige7jCEv4gmf9gGXh1fZ42fyVu4TwElbQRDCMjhQq6/QHDvnq+ZzxmUN6QH81VoEi7ju/FIT9iD0CfTLSbycAuCAgjXoPPnz5Hq9/wLP1HXb91U7334AbkGIWoX4wD6bfIRN5U+2o6RgxaRy9aYfRHwO0rTBAEf7w329n4fRaM3TcTvoPCFFwJ4qBD55OjcAzCr0PP9M51O56frGxv/emNz87fr6xuvdLrd80HQWUdEFVE/S/JP0mrTr00AoeSBzGFWiPB9PNjw5YAS+PSTT9Hn77+/QIogfuf1adaYxoXqh22h3Jx5wPVDb+2/qmzZqgSQzQrLl2o76Cae3dcm4FUI4Dwm4DZ4B2xCbUPb9T/oCdCqx3/Qx9e6vpiAF76m9u9Zqu8fjDI8JoD4oc8H2dvc2iB1jxP/w6yLer2PPfaI6q711PcXLxHxg8kXJuH13lphJiaV0FEgXUxLzZGVyriT516SJIN4MrkYjUdvDwZ7/xKNR3805E+XHpGAjyMBIYBHD13P85Aa5ie9tbXfnD5z9m+gBK6trT0UBEEHTn/GxwLwQAAZVUSQzbYAHlTuJPCQo5NAcAjMwjAJ6xyCX1LeQHQWpnYjvSdJTIqfXX2k2+moeBw1EsCTr0Dd3wRwFQgBbIcQwMVwkn0A3d90nfaw8PljiwuOCRN17Z+X0eQf/TWCOZ5/4Vnq7xE4+OWXXxIBxG9sMsa4QNkklPYft/dO40deSeBJ+YPPHxI+J2k6jsajH4bDwTuDvb1/mkTjt9M0vWCUP4xYUuP3iEAI4NEB+0PgHSTvjB8EL25sbv71+sbGbzc3t17ura09HASdDUiAhgBmaVbuIdwOg2dyPCtkHxA8zDANsN8IOoXnn39e9fs99cMPP1AKGSiDVB6IJP6MlmXlj02+XEquzgR80GhTCFftoOc4gvuaALYHydTvQAhgO4QA3t8EkLdf4WtHxaISmH+t4A/uz7vdkIjf+nqflD0EeED5iyYjyhF78eJFHSTYXSvWw2dOF5bFiR4vTJRwAwHkMQuiBKpL7Ubj6Ie9vV1E+/6PaDz6Q5am8PkbFNWwzKorXTjBvkAI4NFWAk8FQfh8r9f75dbW9r/a3Np8tdvtPxYEQd/3/VAFfqa8ENHBXD5npiPjKC0maOwMjAedK4OAHMLZF8uik0C08Hg8VN9++y35DKIjGI10GTlTz5G2g89rYafYdhUJPGgIAVzt+t3vCiCUjlWwKgE/aAJ40M+jmIDvjQJoE7/i99xTUZyoTtgjsqeDAvWEf2OjT1kcQPweeeQR1emElNT5y68+p74ePoFQ/Xb2hipTuQpReioICgVwrdPV44MVBFJBAHND6AItAqrBJIq+2RvsQvn7/WQSvZtl6feG/Em07xGEEMCjrQSC250KguDZfn/9Nxubm79ZX998rdftPR52Oqf8Thgoyg6DWRjUdzxj03QAtDHfL6UEsGeU3JGgw+CIMZh+0Tk8+eTjlBcKncLFy5fUd998q67euKbiOFG+D78PaP2JikYUr6JCL6C0gIhRwbufeyrzcvqMd/5sv88z9K8aBHLQaS7o0t/HCuCqJvi24191+/fCReAwCax9H3Et3XcQ3Krv94v4HxUCyOeFtD72ebqfm85/WQUw8zKFxP2Lv1dfP1b3qvZp99t57ikv8FXgd4qJfrcXUgQv+m8EfeCcMIm/cOFbcvFB5Q4QQ4gAsAD5YZf6e6h+7PtH20r0JH9jfb36vAsXbxT3SPMkSe8kcXxhNBrC5+8POuAj+0GpfCTK39GFEMCjj47neZue7z/V7fVe29ra/uut7a3Xu721Zz3P3w47XYThZjAKo//y/YAYBZM+PNiA55VL9hQPs5XHyQ3cwDtmkA898rA6tbWlrt+6rr74/Ct18cfv1WgYUQpCP4WviK/SOFOjaEi9a6cXKqTHG44Haq3bp94igK8K5rspaGqqfAxNXq7yNCGSiRd3YmyS4GPgTs8+vmlnvVqQyKoDkNfCYFoHyOCQFawVg2xwH1dB3lJZpkoBKdZFm7DyYC51/VuYUF2aIwqEqhnAF7m+Ha/TeAfb1qdjs5yqFnmfBwftQrFoHs2627fM+eeYrNL9W/YZyrX25WXKy33dljNPpXlS9HO9zlrxPT7zcnhuwPEyLJfpvk377un2jNvO/tvUB2bTfhDLdTo98vMD0iwmBRBuPEjkDOIHCw4IH3L6wYKTZTr3n30/sS+3fVW5EHHfTNcbgYg090+yOI4DpbLE9/278WTy+d7u7lvDwd6/xJPJh1me/6hyIn+i/B1hCAE8Pkrguuf7j3e7vTf66/1fbm5t/WJtrf90d239vO/7XTIJT8UIsvpywMYqBHAwGpLz8MMPP0yvze1NNZnE6tKlS+rKpcvq+tVrari3VySMZodkdEjwNURKGTtqmTsxTfISFAqiZDZFVLEZdLjTqeqg7KTTbQPIwStozQNkK0GYkwAtm8i49fxXjrI27cuIFgu/kwGqfqDGrCZDY+bGjfZjfs8MAWxa316+8t2vV4hsBc1Vkvh7as9L7h8IVdnRftH7s6qQ561IAFd1wWh7fucxgS9P39CPLP/8wpKhGeh0ssrv/IKqhmtgW17QP0KBS9Nc9dfgjz1V9vA8WZG1ygNRpN/0d5zSy/fx8sjXD4EdqPJ0+tQptbu3R647COa7fPkyJf7Xyl6yFAHk5QAOAkTwIQUgp+nEy9Nro9Hoq+Fg783RaPTnZDJ5P8vzqyh1Ksrf0YcQwOMD9Axrnuc9EoThi+vr67/a3Np+Y62/8XK313uo0+msm46DiB+UQPOgOg922amYv08rFA56D6YmZJgOzj/0IBFBlA4KfV/dvH5TXbl0iQgh/AnR2cDHBLNOMkmYABTbBD3tDFPVDTsqy/XvduZ6JoDYVlXHOq+5ZtUBbNU0M6uayFatRHLw+zekvYZArfpumzDhL+X+jkG8af02EyALiG1EFRMV+7OPSo6GAK60f13o58Du30EPAAdNQFsJ5oo+kLi82bLrFwSwbJq1+yj0ifwdJ2nG5BgvfN7bHdIxMCnk0+X+bxJpf2288B2UP6Twgl8fTL3PPvu0msQjdf36DSJ+SOfFqby4zq8mbjqjg90f2lU8ms4Zql+eZ3kcJ8jtl3c6HWiP4yRJrkTjwXt7O7tvjkbDd9I0/SLPqLYvsk9LabdjACGARx82c8ND1fM871zY6bzYW1t7vbe2/ov1jc2fbmxsPNHpdlFPeI2EDT/wgiDIucj3sgSw0+vSsiB26MySLCXnYHQ+Z0+fUc8+/bTa6K+rJI7VxR9/LHJK7RlVkLZtEUA7TxVe62s93ZE6++UOFR1l1XHNm2ewXYE4WB+xVX0UV/VBXF2haffBXEr526d3GNNWOf7OHLe3SSHn818aLQrygU8wVlg334cJ1qql/Bh1BByJjZsIepaudv0ydMlQ8XEfnXeoy+v9TTLRJnGm4iRSaZKrDCZiY9LFHeA0LCBrUPpsa8jmhi7Hxomcn3zyafXgg+fVWm+NJn9ffv0FVXDCBBypXfAdtsXbQ5+t78Fs2y0pjTW5ZI3qCEc//jv2PW8Qx5OLw8Hg4+Fg91+i8fjdNEm+yvP8jlIqtpS/g529CFaGEMDj6xd42veDx8Ju56W1fv/nW9vbb6xvbj7fCXswCfcCJGXy/TRNM+qhjRpY3G90NAD54VUMcKReGLJGs1HEmyDxtCk7BEKITuH01hn1+KOPUj7Bc2fPqt7aGv2OesPolGCGABlEOhkuK4QOj2fAw+GeZf6YzpztlDNVmHZYBxsE0koAW8e3FgJn/HiWXr9FAjl4gpuuqPTNr+DBX9P9HQNtEwFrOn+QSBDApktY5XtoPyOrgBTErHk7qxL0e5EGqOn4D7oWc7GdJV0AYEpdhcCir0PXyiZZvOORMrmR1WAwVGEI5Q59Xmj2B5cX3efZpdzQp4I7gewhLyssLkjWf/78efXoI49TEmf0oUjThVruyNd66fJFk+S/Syoh2gtvT6cAm1Zq0u4KU7/CqgmI1R+QYZrZbJblSPSMW303jiff7u7cfXO4N3grjqP38yy7iHKmsBIvfQMFhwIhgMfvfrESiKnmmh/4ZBLur6//or++/lq/v/FCt9d7uNdbO6MTR+vs7LM5+spBFDP5s4z1uJgl+tNOg3NGUb4pr0MzT6h58DfhxNIPnj+vTp85Qx0SCCBUQRQax2wVf4MQYnba63XUOJ6oJJqoOEtLAz2lSEgpdIQGCjYB4nfM7PHugSguSUD4/FZSYFZUEPIFo4hn4C1//m0mynkUFBDA1ZQ8f/HgBVMT2xifFzLd2u9AiLY1xy2oIoD6/i22nous5fjZ1Fx3/IdNAKkNLHn/92P/bQAZagII2bwuCFX9hx2o4VovAJC4qc9fOVmzDuboFP7SIH3nzz9ESh9Uvs3NLW1GHg7V1avaxItULvCrhrrXX+8RgdSpW8a0fd4Hm5th+sXfPKm2CSAdS0UQl9XneXobOQI+9pI4vpkk8Tej4fC9wd7uH5LJ5OM8z35USnGwB49NovwdEwgBPO5AcIjnnQ6C4Kmw2/3JWr//+vr6+ivr61svdnvds51OFyZhODtzUAnVkjMdlKUIVhNAdC7oBNDRUD3hJC6+ozxSN+/qEkLr69TB3L59m2apIIOPPfYYzV7hswKTMd6xH5A/KIRUgu7H79V4EqnRYKhG0VjF0UTvA4QwTahWMczOaZzQe55mxcBIpLTFBNlGAFaNol3V04VMSCsQUJDiVQhY0/VpIyAU3eg1B3G0vpOC5891fPp+T9+ZfNkjj/uO9lH3O11faBwNw5VtJqsyAbehiaCxD+EqBBDXZxWs4kNHJlS1+vGvQgLbVNjWIJqW5wP58ZqOH7XQXf8/JneuiZWJHpQ8+FCj/3z44QfpM/pLvGNijn6R+0ekcIHShxe2xcogJtzw9cM2kwQqpFYO0U/jnKNIE0J2o4HwqH0MtS8gE0KrLRvBFJWE9WfP81CQIEEev2g8/n64t/fJaDR6O55M3k+T5Ms8y24opaaJAgXHDkIAjydscy6pgiZVzINhh0zCP1tf33p9rd9/bmNz85EgCLaCIOzb61HaTgt1BBAdCswJRUoZX5uBaeabK9Xv9kumYSwDQoi/0UHhb52Rfp06PUQUgwzCXLy2saF6ax1NAIdDNRyNSC3EDBckcTAYkFqIbbPPIJueyyayfHkT1NSPeyl4KziA0UBCHfByx0+DX0saG/YBXdbE2Lx+Zva/CguePwiiini17bn9/re7EKxCAOdJ47KaAo0UJMtvv63tN7UPVv+WfQTouFsIYHsUfcs+2u7Rij6MsIAwMEFGf8dJltF3os9D34fJL0je1uYmuckwCcP7eDRQd+7epb7u5s3bZCWBVQV9IcA+fRxVjP6QLTBpqpPz87niN7yCwKd1sDyOA64iTQTQrG8LArBHjyaTybU8y34YD4cfDweD9ydR9F6eZd8Zfz+7c8BBiPJ3zCAE8OQAOj8CRB7wff+xbq/3016//8rGxtbPut3eM51u98EwDPue54cIDgkCHSQyHg1JEcQG6N0Z3Iq8VJU5z7yiC3A6kuJvTvnCs1HeJtWZNCXoev01mv1idssdJEfBMeFDkMk4GpNPDTpGqIyTeEzvTD4RdIKX7aPInR6bR2Y6dEtBqRos3HOxZ/t2GpgZAl3jO+bsvORDtYi/3tQEOV2nan2bwNlmKjeYpmof7WgngO71dvcXBL3aazcXQV0xiEDrl/VY1UWgDUG+IoE07bfp+as6zuJzi4JYQRJK76wAVm7bMYfax8P7DjiNkBOcUFXLvKn9NgUxNAG+ze569ovUM5OWimvqguRxhO3pjVOq1+2Tsgeyt7m5odbWtBLHJl70R3oCi/5qRBNjmuAOd0nZ47rsOl2LThvDmRDs4Lmqazp7ftPScNS35K4JvGhP5Bbk+2Fm+mhsiOrM69ue3U4mk4vj8fi98Wj04WQ8/gT1fLMsu6LyHKqf+PudAAgBPDn3j6UwBIj0Pd9/OAzD59b6G6/2+v2X+v3+c73e2kOdbvdcGIbrvh+ALMILfboxPPw19XzrZtp+Xu1EXVJpDAGzOzN0brkpTQcSwaTQ7mDxHdRC/I1ZNeparvfXiSByEAl5BpZya6VIUFUEkOzs7pYIIB8Hn1c0GpdIKv/OyzCBqup06btkdoCxO+U2BS41DNoml/bxsQ9TaZ/2sTQQwKoo6kaTZMVArR3T6wEPzSYjrM4TOP2sfU+nRliX3zSRwer9r2aC1alkmvMQ1voirhhkQznsoEAvuT79njcvzxO4ut/JlaIFteTSKyvZ/GKFySaQdb93TBqcKpLnfl/1O08Q6ggg1Dd3vZK/Hvz8HHLH9XChovmeNudS/9TpmO81OaNzST2K7MVzMh6NyIoBywX8m9G3QdWj38ZjInk8UeVUWadObzkmZO2/V6SBQf+4AgFE/1j8TcuWnhhvGgxICUmjPMvuxHF8czKZfD8Zjz8bDYfvJEnyaZ5SSTdIkhPrIZ/uVHAsIQTwZAI9XF9HCvuPhZ3OU71e/yfrGxvwEXyx2+s9GoadM0gg3QnDEOZgq4MmIRBJdinEwIzQdQQwtEwgNuyZOZMaN6oXBJBIVj5V6gB0fNzRoiPlz+wwzQlN8Tp77nTt7BzfQ1GcSSBtDUDw8bGP11Us3N/MH8VvWdyscLUBiaALUof/CoJXvX+387d9CKuOm5O3Vr3cZSu336JAwS+ziQDqBLZp6fvp51knffe4Wn24Vkh0TQQQZQ1XCGJoVZgaFEwceQARdcn1gcBKZFx1LFwJaFkCaO9/hoyaiZtLAG2CZSdtt82ehcJm5UGcJX8VBFCVP3d7vcbzy+37X0VkqaylDnjlSWSSwoyqJ4Jc/5ytDCBtTObwG3ygefKIz1xLly0Q2kyrt8X9GFk/OP2WUTinpHgalMcBI86htxBAc26oTjL1QaRsh5jgG6WPXIDg42f+xHd7aZJcnUwmX0Sj8WfROPo8SeKv0yS5kOfqptLkT4jeCYMQwJMD2yeQRQrPBImcCYLwyU63+3yvt/YyfAPX+n3kDXwgDMKzge/3/CDoceJoiwDmbSXTbAJY1SlxJ1RHPsJud6okVCzHPlguieRtUAUSXy9nO18zeCZtJ2G1Z/AUBGANUPY28AKhbFLJAhNFV9UR0++OAmMjszpr+3rVoUoZ0QSsXgVkAlRHAu0KBfZy8xwPAPLeBJvgVV0jm6AtSp5pfbU80O4oiKZpmTaCt4KJGAogCNgqiYqYANaZWdvcGtpMwE0EkNUz+/l1MZuH1DoOevZ0AJC7TJOJ1/6bc43WHaOr4Lt9EBE8495ikzi2JtD5Wf0Pf08TqzRTm/3ZCabdh6DPsV1g3AARJnn8QnUk2xLBCv6yBHAapazvkkUKYeaNPKXuJElyO4qiH+No8m0URR+hrFuapN/meX5D5fmuFdlbCN9CBk8GhADeH/eY6wmf9f3g8bDTeXKtv/7CWn/t+W6n+2yv030oDDunwzDsemGAZTEpJJMydy8oK1JsUPutUdsJkEijZvCxZ7BVvwFxOkvemOjxrNkd0KavqULFy/B6dsoFV5WwgUhjF/b+MNOvAi/TCXSi7Lr1m2HOr0Lp4L9tE+zMIEg1RvOFCKi73Cp55khBW4C01Q5WDabf1kTDLZVQGoMY9iGIpE1Ba1sfaSCbgjjmURirniv7eZiXzFehah13f0375/ZXr2LT7LJ2n03nj+tG1oCGY7b37+4b/qOcFoUniu6EiAMuAP7dXhZplOpUdfcaucRNP58dRxWd9pmadDoE2rIY0DJl0wzyZdl9SZ4mkxxl4s32SYZHpG+apgMofvEk/mI8HkP1+yJJ4u8ymHqz/Gae5ztS0ePkQwjgyVcD2a5AFidDBM+FYeepsNN5tt9be7HT7T7V66091u32Huis9c4GQbAeBAHSx/ip44Rs3vMiTyD9XO6Cm0hg6SARteaMwFU+Prb655qRucN0Z962DxIfhz2TL75z1IsZhdIxobkI/U4jgWkbdLlEsztwuutXDSB0fbzFyad9TLZCV0VC27ZHqXn0kVSagCkV5Yzpd/q5rhzVvCR6FQIItOlvbcfhrRwFvP9WNfuYmwhg3aRonu3yZ/v5bvPXq9ymzlO/FND0M9N+63wA69TQ6THqPJi2Isd9DJe/bAoisyOYq8zgUCjtCa7bP0VReYKH47GXQw3fBQggK3+F2mdNcSiqN00SKH534kl8NYnjC6PR6KNkEn+RJsm3WZ5fV5r4seJnp1gQ1e8EQgjg/Qf0LF1Pedue750Jg+CxIOw81u12n1nr9Z7trfef7fbWHg3D8CzKyvlh0K3o2OE/4lEVBjLjlMtZOOkEakkNqX1m/K4zPbY5sYedKUF0AzgAmFCqtk2H73kqiieNA1iVAlgaSCz1omqAbDIB0zKW+bfKrMMEtE5BCfzpIFS1/zYC2+aD15YGJCkSYS8TBGLKaDXsv42AmbRlS8NfyQC7eiWLpIXANhEoUmBBSBpSAdVNRApVa4EhoErpYx9ae5v2vrgWrvt9QdAqEhHb23fbX+k5RiUXuHI4JMxGFRmdPv9o/+UgC3f9qiAoe1l4zVRNHvmdXUjYxFzOiAAXk76jEJYVPy7nbir+sP8eT6byYv5VHFxGfTMjz2lnkxTBHZP40iSKvp5E0TfxZPJtmqY/pEnyg1H8UMkDnZ34+d1HEAJ4f6mB7vdQBLc8z0fVkEfDbufpXq/3fKfbe6rb6TwWhOHZtY11BItsQBX0PK/r+z5MxGYD8I/BXyW/u1LVkSrzR2kAyKojB23HaV5+RlHwtE8O78dezp5p2wqiSwCpM67wYWoyQZaOoSAA1QRnhvA470ijUTdI1Sl0DBq8vUxXR6khTk1pWPA3CDJXBOGKK/NUCKF3U8XCPn/33ffDhiAQY64yJHB+07l7Pg1m6rZtgj81LNKq4C5hVrWR5LZ71WLviADn9lubKNsk0nYTMjPxm16f6v1oqyEHJU3faf95pkK6v9rAgHcdTzH9HIadmfWmn0FsZicodardzG9WBHUpOMc5f3rGaoJ5Oh3t4+dum2FHMdvfcZ9SELQaNxPbhMywzcgINilbUMqKLU9wiueEKuekXoMCiBWQvHmk8nyQJJPbaZLeTpL4x3gSfxdF0edJHH+TJinKt3FwBzsS2xuzlT/BCYUQQIFRBNWG8rxTvu8/GIThQ2Gn83in03l0fWPjybDTeaTb7T7c6XTOhmEIE3KX4j+0BxOuYBFFzAmms0z3TEzAqI92SJpuf7NpHOy/eQZep9JRFKijItloNWG2lIpqQ3GsFcXgyVyj2VT17xU+Uu6xtx5/Opnv+GpARemXrgSiney1illPAOsJcH00bZM/1fTkyln8qtSupvMn/4gWE2SbeXrVWtMURFPXPtrajx08tGwlmOKkqrdPpcIa9k/Xr+F3Uvgb2n9r+5xzUlBXCSaAlaHh95VA198R4BrM7FUqvlWLuFD37M9YlTxVyOpCMz6dOyDTd48Iqk+iX+Z5XuopNcqybHcymVxBHr80Sb6OxtEPkyiC2nfV5PG7Y4hftYOz4L6BEMD79367sz2uKILSHhue553zfR95Ax8PwvCxTrf7RKfTebDT7Z7vdDpbYRhu+UHQ7wQ95BxEBDHUwQDBIzZxsU2w1qsoRKJNhPUdqKtgzfzeQP7mGUAOvFJDmxO/lQajavm245tN9LoY8hV94GwT9jLr2yb0tnUqSaLf7GLQdn/8BQngzLG1VGJp2397qbI2H8TsQO9/G9qqkLQe/z4RwGW3v9rG2dVk1nJQF0U921bLLiTIzmL/XpVGxwRyxFmWTrI0HWV5MsrSdDfLskGapHfSJLkVx5Mfkjj+Pp7EX2VpeinPsuso6WaSONuNhi9QaS61j1dJcIQhBFBQ1SaoqohSCrkEtzytDD7gB8EDoVYHHwg7HVQWeWBtbePBIAjPdDqd037g91FyzvO8EBFnNC3NMDGlYSI3aWZKpoU4xqS1vsM26Vq8tkTKdbA65MpttCVqbsOqA5hdjL3OBNW4/ZbzbyUgLXW8Wgn0/Ne/Er7jAzZPQEjJjF0MwssN/m0EsCkghgIg4IR5gARmVQLYSuAPmAAeNMG7RwSw2jxaRNyWSZ17Tlxn12lL9F2aah8SNqWYFXBT6LPx4aWuVAcu51GWpeM8y3YR0BHH8bUkjq7G8eRSmiTX0yS9nqbp7TxLb2RZfifPsltKgfiR2ifVOwQlCAG8v1GlCLokDZ0RMpeC2G0ip6Dn+/ALPA9S2O2tPRIE4QNh2AE5PN3pdk+FYbgBIhiEwVqapmtQB4Mg7ARB0IFKaO83TeujhOczsWUzbjCLDDCHTQCtFBiuCahufWugWNmIVZiA69BIQDkicYXzD1oU0Lrv6bM5/6xBAWzCPCbgNgLIaXwOheCAgLS5OLYp3PAp844uAWydQKxogt9HE3DtBNONDLZh8jLbbdZkJ6JavBNPeSMQPkrbkqbDJI53oPYhd1+WpjeTZHIlTZPLWZJezrL0Zp7lt4zSNzKEL7Wbe41vnyh+9ymEAAoWaSsgb0hc1fOUIlOx7/unPM/fBikM8ArDc1AEw054LvCD0721NXw+FYTBqcAP1n0dTALPcFQgCXrdtWK2a3WC3FHlppIFObkUdmMGnL21CTlfbgCcNeEsitUVDtcZf5F1iyWXOj4QZx6AarfccAxFFOoS148VD64FW7WvKmpZVv/K380SwDmOI/dag0BqA2y81fIo7ges4NBKNN1f46W7D/s/OLQRWJRrq0PL3GQuuD55BsVFy1IT5DF90DgKlz6kKVk4TJn1kj+gbv8BqkHnmMMgWjfJsmyc5fkoz9LdNM1uJ/HkepIk15MkvpYm6a00TW7Cxy/L0rt5lu/leXYXJdpMmbYIEb8m5YtA0AohgIKmNuG2D5ct+RYhXFdaIQQhPEVJpz3vTKfbeyAI/LNBGJ4Jg3A7DDvbQRjAVExRxYEfdD3fh8m443t+xw/8wPf8kL7TeQhJMTQmZX5xD+vllg/N4gOwjjY+CgSwbtl2H6rVji9ZUYGxaxEvs76dhmUh9W+6gUYTcNP+KYq0Rf5yHfhnjmFFE/CqJkp/xfuXrerDesA+gG0EsDXP44rXt/n487pLSkHCJLAjkzNCeT161FBXLsnyLFa5AtmLPc+bZFk2MSofXijJtpdlGRQ++PIhcOMafPjwXZ5nCOAY5UohyhdEDy87lLzuhKuUP8F9DiGAgv1CYEzFiChGlPAamY2Vt6E8ten7/pbn+5tBEGwbJXDb932YlTc8z+/7QbDhex7eKQk1fjOBJWue74Mc6hQ0vh/6SDwIgph7vheGCCskFZFUpan/DBFFx7R95AhgHUnZL+WonQAebhCMe1saFcdKE2w1QZt34F+UwMx8XjEIZFWCtKoC1+Q+sR8EsI3AHfT1WRVm/9bEl+wQ/DkLfB8JlLAU/PNA+MjsClIHgpYkyTjP8wnMslmaDhGoQS8O2khTqHdD8xm/7+ZZNjCqHt5Rim2EZSyFjwtwCwQrQQigYNF24raZKr8Sno2CjCGKAyZfEMOeUt668tQaiJ9SHkgelEBEEhMBpHcfBBA1jH0sx/kHe4g2JqWQSKDfQQRFEKCyOmQADxkf6N2QP3ovStgZW7HJOwOuiDpOXsg2JFMSAgzSIY1OXgf+XGTbbxvBWq6sMVdyPp365d1ovZrjql2v1kTY6MPWegLF7qu3Ms1dUaVOlHzfzf5mN0A/lI9yakKbVhIx78UtMeS6UREpCMzM9dMbKZmcKy6Fzr9Rs4fm9lHp87nA+vtmgnWOv7TFhuMrX7+6hYr1q+37FafXtMMSEStvlWhZrX+bXtf4e0wJHEDF3Ew0Ff7Qahp9pmwF2jyr18ff8M9Dysw0V3mKRMt6GTLfgvjFOkI3i/Isi5IkAXkDCYSqN8yzDO9E7IgUZtkeInPJb0+relD3JobosQ9fpfnZ6Xvrrp8ofoJaCAEU3EtoQogcgh55/5MvoFJeqDzVQV5W/Z0HcmeURK/nefQdKpIgCTXWDbC88rS52BC+0CS2tj6jBCZyJ5C3IBFCE3YLWoJ94mf+HsuweqhfRk2ckkYmihZJrIsyridkDgqCkrcQq6rt62zW5d9LERCm/ufs+sUOnUTRTkgjRzDOrMYfavZfMDtNAC3SXSynr+2UAHhzvjulITih4MzvJb/SCgJtzrNwknNJatN1tz7XXP/p/hvv7xLwamy4M8y5bb80S5vakDlPZ2n54v5bTM78Y5pPM4O12k/VctN8ULPErmpSSXs0H+k90/vPzBqZQxRBzKa/G2JHOcw1iQNjS2hbuSZbIHImkXI8/ZzDfEvv5oxj+jtHHmfK5GzWp+Xot5yibjURJDOt/jwhckefC/NtnOvPSQ3hEwgODEIABfvdhuoUQlcd5Hd7HXsQhnJIEciGQATTF7EKZKGGAGGiig3xo/VQboLesSCRO1YGpy8QScpK69cSwCnxswhgaRlVIw/DAAAEUUlEQVT7ZNuuQyUs/a2u0y8TqtL3pbDCagKkz6mGkFaYnmcIUnmAt37nzTYSIGRK0de2dE35d30O5eNrJpTF+sV6LsG1lVzEiFvXyz4vXR4CeXanv8+6DGhVuQF2IreG418+TcvsHu0P/jQRYSUBhAjatHX3frqfXeJnwZRvaTx8e4mqiQSrclXLmXebQDKZm1kOBIx/w0K87dL3hley+RQEjpQ7s6wmfpqsQf0DOUsyKjZNv2E9ficFkL4vonYpoqy0DMzC5jveJ/eDdh9YhaY2U0mkm26AQFAHIYCC44JKguOQNdI0iu9ZJat4FSVI6rdX9bd9LN7+PELzEcDaz7MExF1ujgOs3PWcitKMDa/8WRPAqutZ9bnqePk6V35vJbFpXK7+JKcKWPP+azBLXOuXnPfLRbbTlsOlfQeWjTafc45Q88t8+5n3c93+Su/m9IoJpqX+uWZg52WK7ppgjYJIagLHpK5EHk3hR6MkFjX83MntcmHxAsEhQAig4F63sXnbnDtDbhsg6tZzv1+0zTfN1A8D9vEvcz77sd8quETKXa/u93n307adZU2h9+p6egd01euux3zXe3p17nUbr7tPbcvNu133/OchnFWWimX7CndiMM95iLonEAgEAoFAIBAIDg6iAAqOGpaZdQtOHuS+ClbBvVA023z56tYRCAQCgUAgEAgEgnsPmWULBIKj2Me0KSXSd92fmFdB2y+fQoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCFQb/n+O3urXcCPr3wAAAABJRU5ErkJggg==" style="width: 84px; height: 84px; object-fit: contain; margin: -10px;">
                            <h4 style="margin: 0; color: ${isDarkMode ? '#60a5fa' : '#1e40af'}; font: 600 28px system-ui, sans-serif;">About PulseGrab</h4>
                          </div>
                          <p style="margin: 0 0 12px 0; color: ${isDarkMode ? '#e0e0e0' : '#1f2937'}; font: 14px system-ui, sans-serif; line-height: 1.6;">
                          <div style="margin: 0 0 12px 0; padding: 10px 14px; border-radius: 8px; background: ${isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'};font: 13px system-ui;"><div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:${isDarkMode ? '#9ca3af' : '#6b7280'};"> Detected Server</span><span style="font-weight:600;color:${getTheme().primary};">${(ServerThemes[SERVER_TYPE] || ServerThemes.emby).name}</span></div><div style="display:flex;justify-content:space-between;"><span style="color:${isDarkMode ? '#9ca3af' : '#6b7280'};"> Server Address</span><span style="font-weight:500;color:${isDarkMode ? '#e5e7eb' : '#374151'};"> ${getServerAndToken().server || 'Unknown'}</span></div></div>
                            PulseGrab is the ultimate download manager for Emby, Plex & Jellyfin media servers. Created for the high seas community,
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
                              <li>Dark mode with server-adaptive themed colors</li>
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
                            <strong>Important:</strong> PulseGrab is a tool designed to facilitate downloading content from <em>your own</em> media server.
                            The developers of PulseGrab are <strong>NOT responsible</strong> for any illegal downloads, copyright violations, or misuse of this tool.
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
                              <span><strong style="color: ${isDarkMode ? '#e0e0e0' : '#1f2937'};">Namespace:</strong> pulsegrab.manager</span>
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
                            PulseGrab Wiki & Help
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
                                <li>Navigate to a movie, TV show, season, or collection page on your media server.</li>
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
                              <p><strong>Whole Server:</strong> Go to the server home page (Home icon). The script will prompt you to scan all libraries, or specific libraries like "Movies" or "TV Shows".</p>
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
                              <p style="margin-top:0;">If the server administrator has disabled the "Allow media download" permission, PulseGrab natively bypasses this constraint by reconstructing the stream URLs used for DirectPlay.</p>
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
                              <p style="margin-top:0;"><strong>Subtitles:</strong> Select desired languages in Settings. PulseGrab will automatically extract internal subtitle tracks natively, or download external subtitles (SRT/ASS/VTT) if available on the server.</p>
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
                                <li><strong>Ctrl+D:</strong> Open PulseGrab main dialog/Generate links.</li>
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
    document.querySelectorAll('.pulse-dl-notification').forEach(n => n.remove());

    const notification = document.createElement('div');
    notification.className = 'pulse-dl-notification';

    const colors = {
      success: getTheme().primary,
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

    // Plex: no bypass needed, URL already works directly
    if (SERVER_TYPE === 'plex' || !url) return url;

    // Safety check - if we have no stream ext suffix, return raw url
    if (!url.includes('/stream.')) return url;

    // Directplay bypass trick: /stream.ext -> /the_actual_filename.ext
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
        '# PulseGrab Download Script',
        `# Generated: ${new Date().toISOString()}`,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a Wget script designed to download your media files.',
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
        '# PulseGrab Download Script (Aria2c)',
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
        '# PulseGrab Download Script (PowerShell)',
        `# Generated: ${new Date().toISOString()}`,
        '# Total items: ' + items.length,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a PowerShell script to download your media files.',
        '# Open Windows PowerShell as Administrator.',
        '# Navigate to the folder where you want to save the files (e.g., `cd ~/Downloads`).',
        '# Right-click to paste this entire text block and press Enter.',
        '# ==========================================================================',
        '',
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "Continue"',
        '',
        'function Download-PulseGrabItem {',
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
        lines.push(`Download-PulseGrabItem -Url "${url}" -OutFile '${escapedPath}'`);
        lines.push('');
      });

      lines.push('Write-Host "Download complete!"');
      return lines.join('\n');
    },

    python: (items, server, token) => {
      const lines = [
        '#!/usr/bin/env python3',
        '"""PulseGrab Download Script"""',
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
        '# PulseGrab Download Script (cURL)',
        `# Generated: ${new Date().toISOString()}`,
        '# Total items: ' + items.length,
        '',
        '# ==========================================================================',
        '# INSTRUCTIONS:',
        '# You have copied a Bash script designed to download your media files.',
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
        `# PulseGrab Downloads - Generated ${new Date().toISOString()}`,
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
        type: 'pulse-downloads',
        generated: new Date().toISOString(),
        total: urls.length,
        urls: urls
      });
    },

    email: (items, server, token) => {
      // Generate mailto: link with download links in body
      const urls = items.filter(item => item && item.Id)
        .map(item => getFullBypassUrl(item, server, token));

      const subject = encodeURIComponent(`PulseGrab Downloads (${items.length} items)`);
      const body = encodeURIComponent(
        `PulseGrab Download Links\n` +
        `Generated: ${new Date().toISOString()}\n` +
        `Total: ${items.length} items\n\n` +
        urls.join('\n')
      );

      return `mailto:?subject=${subject}&body=${body}`;
    }
  };

  // ---------- Server-Wide Download Functions ----------
  async function fetchAllLibraries(server, token) {
    if (SERVER_TYPE === 'plex') {
      const url = `${server}/library/sections?X-Plex-Token=${token}`;
      const data = await fetchWithRetry(url);
      return (data.MediaContainer?.Directory || []).map(dir => ({
        Id: String(dir.key),
        Name: dir.title,
        CollectionType: dir.type === 'movie' ? 'movies' : dir.type === 'show' ? 'tvshows' : dir.type === 'artist' ? 'music' : dir.type,
        Type: 'CollectionFolder',
        _plexType: dir.type
      }));
    }
    else if (SERVER_TYPE === 'jellyfin') {
      const { userId } = getServerAndToken();
      const url = `${server}/Users/${userId}/Views?api_key=${token}`;
      const data = await fetchWithRetry(url);
      return data.Items || [];
    } else {
      // Emby
      const prefix = apiPrefix();
      const url = `${server}${prefix}/Library/MediaFolders?api_key=${token}`;
      const data = await fetchWithRetry(url);
      return data.Items || [];
    }
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
          } else if (item.Type === 'MusicArtist') {
            // Expand music artist → albums → tracks
            console.log(`[Library] Expanding artist: ${item.Name}`);

            if (SERVER_TYPE === 'plex') {
              const albumUrl = `${server}/library/metadata/${item.Id}/children?X-Plex-Token=${token}`;
              const albumData = await fetchWithRetry(albumUrl);
              const albums = albumData.MediaContainer?.Metadata || [];

              for (const album of albums) {
                if (abortController?.signal.aborted) break;
                if (requestDelay > 0) await new Promise(r => setTimeout(r, requestDelay));

                const trackUrl = `${server}/library/metadata/${album.ratingKey}/children?X-Plex-Token=${token}`;
                const trackData = await fetchWithRetry(trackUrl);
                let tracks = (trackData.MediaContainer?.Metadata || []).map(normalizeItemPlex);
                if (skipWatched) tracks = tracks.filter(t => !t.UserData?.Played);
                allItems.push(...tracks);
                console.log(`[Library] Added ${tracks.length} tracks from ${album.title}`);
              }
            } else {
              // Emby/Jellyfin: fetch all audio items recursively under artist
              const prefix = apiPrefix();
              const params = new URLSearchParams({
                ParentId: item.Id, Recursive: 'true', IncludeItemTypes: 'Audio',
                Fields: 'Path,FileName,MediaSources,Container,MediaType', api_key: token
              });
              if (skipWatched) params.append('IsPlayed', 'false');
              const url = `${server}${prefix}/Items?${params.toString()}`;
              const data = await fetchWithRetry(url);
              const tracks = data?.Items || [];
              allItems.push(...tracks);
              console.log(`[Library] Added ${tracks.length} tracks from artist ${item.Name}`);
            }
          } else if (item.Type === 'MusicAlbum') {
            // Expand music album → tracks
            console.log(`[Library] Expanding album: ${item.Name}`);

            if (SERVER_TYPE === 'plex') {
              const trackUrl = `${server}/library/metadata/${item.Id}/children?X-Plex-Token=${token}`;
              const trackData = await fetchWithRetry(trackUrl);
              let tracks = (trackData.MediaContainer?.Metadata || []).map(normalizeItemPlex);
              if (skipWatched) tracks = tracks.filter(t => !t.UserData?.Played);
              allItems.push(...tracks);
              console.log(`[Library] Added ${tracks.length} tracks from album ${item.Name}`);
            } else {
              const prefix = apiPrefix();
              const params = new URLSearchParams({
                ParentId: item.Id, IncludeItemTypes: 'Audio',
                Fields: 'Path,FileName,MediaSources,Container,MediaType', api_key: token
              });
              if (skipWatched) params.append('IsPlayed', 'false');
              const url = `${server}${prefix}/Items?${params.toString()}`;
              const data = await fetchWithRetry(url);
              const tracks = data?.Items || [];
              allItems.push(...tracks);
              console.log(`[Library] Added ${tracks.length} tracks from album ${item.Name}`);
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
    showNotification('Scanning entire server...', 'info', 3000);

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

  // ---------- Helper Functions ----------
  function getApiClient() {
    try {
      const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
      if (SERVER_TYPE === 'jellyfin' && win.ServerConnections) {
        return win.ServerConnections.currentApiClient();
      }
      return win.ApiClient || null;
    } catch (error) {
      console.error('[PulseGrab] Failed to get API client:', error);
      return null;
    }
  }

  // --- Emby auth ---
  function getServerAndTokenEmby() {
    const apiClient = getApiClient();
    if (!apiClient) return { server: null, token: null, userId: null };
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

  // --- Jellyfin auth ---
  function getServerAndTokenJellyfin() {
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // Try ServerConnections (modern Jellyfin Web)
    if (win.ServerConnections) {
      try {
        const api = win.ServerConnections.currentApiClient();
        if (api && api.accessToken()) {
          return {
            server: normalizeServerAddress(api.serverAddress()),
            token: api.accessToken(),
            userId: api.getCurrentUserId()
          };
        }
      } catch (e) {}
    }

    // Try window.ApiClient (Emby heritage, some Jellyfin builds)
    if (win.ApiClient && win.ApiClient.accessToken && win.ApiClient.accessToken()) {
      return {
        server: normalizeServerAddress(win.ApiClient.serverAddress()),
        token: win.ApiClient.accessToken(),
        userId: typeof win.ApiClient.getCurrentUserId === 'function' ? win.ApiClient.getCurrentUserId() : null
      };
    }

    // Fallback: localStorage
    try {
      const creds = JSON.parse(localStorage.getItem('jellyfin_credentials'));
      if (creds?.Servers?.[0]) {
        const srv = creds.Servers[0];
        return {
          server: normalizeServerAddress(srv.ManualAddress || srv.LocalAddress || srv.Address || window.location.origin),
          token: srv.AccessToken,
          userId: srv.UserId
        };
      }
    } catch (e) {}

    return { server: null, token: null, userId: null };
  }

  // --- Plex auth ---

  // Recursively search a JSON structure for auth token fields
  function _extractPlexAuthToken(obj, depth) {
    if (depth > 3 || !obj || typeof obj !== 'object') return null;
    if (typeof obj.authToken === 'string' && obj.authToken.length >= 10) return obj.authToken;
    if (typeof obj.accessToken === 'string' && obj.accessToken.length >= 10) return obj.accessToken;
    if (typeof obj.token === 'string' && obj.token.length >= 15 && /^[a-zA-Z0-9_-]+$/.test(obj.token)) return obj.token;
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const val of vals) {
      const found = _extractPlexAuthToken(val, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function extractPlexServerUrl() {
    // For local access, server URL = origin
    if (window.location.hostname !== 'app.plex.tv') {
      return window.location.origin;
    }
    // For app.plex.tv, use captured server URL from fetch/XHR/WebSocket interception
    if (capturedPlexServer) return capturedPlexServer;

    // Fallback: try to find server URL in localStorage using machine ID from URL hash
    const machineMatch = window.location.hash.match(/\/server\/([^/?\s]+)/);
    if (machineMatch) {
      const machineId = machineMatch[1];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const raw = localStorage.getItem(key);
          if (raw && raw.includes(machineId) && raw.includes('plex.direct')) {
            const urlMatch = raw.match(/(https?:\/\/[^"'\s,]+plex\.direct[^"'\s,]*)/);
            if (urlMatch) {
              try {
                capturedPlexServer = new URL(urlMatch[1]).origin;
                return capturedPlexServer;
              } catch(e) {}
            }
          }
        }
      } catch(e) {}
    }
    return null;
  }

  // Discover Plex media servers via plex.tv resources API
  async function discoverPlexServers(token) {
    const headers = {
      'Accept': 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Client-Identifier': PLEX_CLIENT_ID || 'PulseGrab',
      'X-Plex-Product': 'PulseGrab'
    };
    const resp = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0', { headers });
    if (!resp.ok) throw new Error(`Plex resources API returned ${resp.status}`);
    const resources = await resp.json();
    // Filter to servers only (not players/clients)
    return resources
      .filter(r => r.provides && r.provides.includes('server'))
      .map(r => {
        // Prefer HTTPS connections, then local connections
        const conns = r.connections || [];
        const httpsConn = conns.find(c => c.protocol === 'https' && c.local === false) ||
                          conns.find(c => c.protocol === 'https') ||
                          conns[0];
        return {
          name: r.name,
          machineId: r.clientIdentifier,
          owned: r.owned,
          uri: httpsConn?.uri || null,
          connections: conns
        };
      })
      .filter(s => s.uri);
  }

  // Show a Plex server picker dialog (reuses existing dialog styling)
  function showPlexServerPicker(servers, onSelect, onCancel) {
    const theme = getTheme();
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;`;

    const dialog = document.createElement('div');
    dialog.style.cssText = `background:#1a1a2e;border-radius:12px;padding:24px;max-width:420px;width:90%;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.5);`;

    let html = `<h3 style="margin:0 0 16px;color:${theme.primary};font-size:18px;">Select Plex Server</h3>`;
    html += `<p style="margin:0 0 16px;color:#999;font-size:13px;">Choose which server to download from:</p>`;

    servers.forEach((s, i) => {
      const ownerBadge = s.owned ? ' (owned)' : ' (shared)';
      html += `<button data-idx="${i}" style="display:block;width:100%;padding:12px 16px;margin-bottom:8px;background:#252545;border:1px solid #333;border-radius:8px;color:#e0e0e0;cursor:pointer;text-align:left;font-size:14px;transition:border-color 0.2s;"
        onmouseover="this.style.borderColor='${theme.primary}'" onmouseout="this.style.borderColor='#333'">
        <strong>${s.name}</strong><span style="color:#888;font-size:12px;">${ownerBadge}</span>
      </button>`;
    });

    html += `<button data-cancel style="display:block;width:100%;padding:10px;margin-top:8px;background:transparent;border:1px solid #555;border-radius:8px;color:#999;cursor:pointer;font-size:13px;">Cancel</button>`;

    dialog.innerHTML = html;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.hasAttribute('data-cancel')) {
        overlay.remove();
        onCancel();
        return;
      }
      const idx = parseInt(btn.getAttribute('data-idx'));
      if (!isNaN(idx) && servers[idx]) {
        overlay.remove();
        onSelect(servers[idx]);
      }
    });
  }

  function getServerAndTokenPlex() {
    // Strategy 1: Captured from fetch/XHR/WebSocket interception
    if (capturedPlexToken) {
      return { server: extractPlexServerUrl(), token: capturedPlexToken, userId: null };
    }

    // Strategy 2: Well-known localStorage keys
    const lsKeys = ['myPlexAccessToken', 'plexServerToken'];
    for (const key of lsKeys) {
      try {
        const val = localStorage.getItem(key);
        if (val) {
          capturedPlexToken = val;
          return { server: extractPlexServerUrl(), token: val, userId: null };
        }
      } catch (e) {}
    }

    // Strategy 3: Scan localStorage for JSON values containing auth tokens
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        try {
          const raw = localStorage.getItem(key);
          if (raw && (raw.charAt(0) === '{' || raw.charAt(0) === '[')) {
            const json = JSON.parse(raw);
            const token = _extractPlexAuthToken(json, 0);
            if (token) {
              capturedPlexToken = token;
              return { server: extractPlexServerUrl(), token, userId: null };
            }
          }
        } catch(e) {}
      }
    } catch (e) {}

    // Strategy 4: Scan all localStorage for Plex token patterns (string values)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.toLowerCase().includes('token') || key.toLowerCase().includes('plex'))) {
          const val = localStorage.getItem(key);
          if (val && val.length >= 15 && val.length <= 30 && /^[a-zA-Z0-9_-]+$/.test(val)) {
            capturedPlexToken = val;
            return { server: extractPlexServerUrl(), token: val, userId: null };
          }
        }
      }
    } catch (e) {}

    // Strategy 5: URL extraction
    const urlMatch = (location.hash + location.search).match(/X-Plex-Token=([^&]+)/);
    if (urlMatch) {
      capturedPlexToken = urlMatch[1];
      return { server: extractPlexServerUrl(), token: urlMatch[1], userId: null };
    }

    return { server: null, token: null, userId: null };
  }

  // --- Router ---
  function getServerAndToken() {
    switch (SERVER_TYPE) {
      case 'plex':     return getServerAndTokenPlex();
      case 'jellyfin': return getServerAndTokenJellyfin();
      default:         return getServerAndTokenEmby();
    }
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

      if (SERVER_TYPE === 'plex') {
        // Plex: extract ratingKey from key=%2Flibrary%2Fmetadata%2F{id}
        const keyMatch = combined.match(/key=%2Flibrary%2Fmetadata%2F(\d+)/i)
          || combined.match(/key=\/library\/metadata\/(\d+)/i);
        return keyMatch ? keyMatch[1] : null;
      }

      // Emby & Jellyfin: id= parameter
      const idMatch = combined.match(/id=([^&#]+)/i);
      return idMatch ? idMatch[1] : null;
    } catch (error) {
      console.error('[PulseGrab] Error getting item ID from URL:', error);
      return null;
    }
  }

  // --- Emby page detection ---
  function detectPageTypeEmby() {
    const hash = window.location.hash;
    if (!hash) return 'unknown';
    if (hash === '#!/home' || hash === '#!/startup/home' || hash.endsWith('#!/')) return 'server-root';
    if (hash.includes('/collection?id=') || hash.includes('context=collections') ||
        (hash.includes('/item?id=') && hash.includes('context=collections'))) return 'collection';
    if (hash.includes('/list?id=') || hash.includes('/playlist?id=')) return 'collection';
    const folderMarkers = ['/movies', '/tv', '/music', '/shows', '/genres', '/tags', '/folders', 'parentId=', 'collectionType='];
    if (folderMarkers.some(m => hash.includes(m)) && !hash.includes('context=collections')) return 'folder';
    if (hash.includes('/item?id=') || hash.includes('/details?id=')) return 'item';
    return 'unknown';
  }

  // --- Jellyfin page detection ---
  function detectPageTypeJellyfin() {
    const hash = window.location.hash;
    if (!hash || hash === '#/' || hash.includes('#/home')) return 'server-root';
    if (hash.includes('#/details') && hash.includes('id=')) return 'item'; // could be collection too, resolved later by item Type
    if (hash.includes('#/movies') || hash.includes('#/tv') || hash.includes('#/music') ||
        hash.includes('#/shows') || hash.includes('topParentId=')) return 'folder';
    if (hash.includes('#/list') && hash.includes('parentId=')) return 'folder';
    if (hash.includes('/collection?id=') || hash.includes('context=collections')) return 'collection';
    if (hash.includes('/list?id=') || hash.includes('/playlist?id=')) return 'collection';
    return 'unknown';
  }

  // --- Plex page detection ---
  function detectPageTypePlex() {
    const hash = window.location.hash;
    if (!hash || hash === '#' || hash === '#!') {
      // On app.plex.tv with no hash, treat as home page
      if (window.location.hostname === 'app.plex.tv') return 'server-root';
      return 'unknown';
    }

    // Home / root
    if (hash === '#!/' || hash === '#!/home') return 'server-root';
    // Server-specific home: #!/server/{machineId} with no deeper path
    if (/^#!\/server\/[^/]+\/?$/.test(hash)) return 'server-root';

    // Item detail: any URL containing /details
    if (hash.includes('/details')) return 'item';

    // Library / folder views (modern and legacy patterns)
    if (hash.includes('com.plexapp.plugins.library') ||
        hash.includes('content.library') ||
        hash.includes('/section/')) {
      if (hash.includes('collectionKey=')) return 'collection';
      return 'folder';
    }

    // Hub views (recently added, on deck, etc.)
    if (hash.includes('/hub')) return 'folder';

    // Playlists / collections
    if (hash.includes('content.playlists') || hash.includes('/playlists') || hash.includes('/playlist/')) return 'collection';

    return 'unknown';
  }

  function detectPageType() {
    let pageType;
    switch (SERVER_TYPE) {
      case 'plex':     pageType = detectPageTypePlex(); break;
      case 'jellyfin': pageType = detectPageTypeJellyfin(); break;
      default:         pageType = detectPageTypeEmby(); break;
    }
    console.log(`[PulseGrab] Detected page type: ${pageType} (server: ${SERVER_TYPE})`);
    return pageType;
  }

  function getCurrentFolderId() {
    try {
      const hash = window.location.hash;
      const search = window.location.search;
      const combined = hash + search;

      console.log(`[Debug] Extracting folder ID from: ${combined}`);

      // Plex-specific: extract source= (section ID) from library URL
      if (SERVER_TYPE === 'plex') {
        let plexMatch = combined.match(/source=(\d+)/);
        if (plexMatch) {
          console.log(`[Debug] Found Plex source/sectionId: ${plexMatch[1]}`);
          return plexMatch[1];
        }
        plexMatch = combined.match(/key=%2Flibrary%2Fmetadata%2F(\d+)/i)
          || combined.match(/key=\/library\/metadata\/(\d+)/i);
        if (plexMatch) return plexMatch[1];
      }

      // Jellyfin: topParentId
      if (SERVER_TYPE === 'jellyfin') {
        let jfMatch = combined.match(/topParentId=([^&#]+)/i);
        if (jfMatch) {
          console.log(`[Debug] Found Jellyfin topParentId: ${jfMatch[1]}`);
          return jfMatch[1];
        }
      }

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

        // Add Plex-specific headers
        const headers = { ...(options.headers || {}) };
        if (SERVER_TYPE === 'plex') {
          headers['Accept'] = 'application/json';
          if (capturedPlexToken) headers['X-Plex-Token'] = capturedPlexToken;
          if (PLEX_CLIENT_ID) headers['X-Plex-Client-Identifier'] = PLEX_CLIENT_ID;
          headers['X-Plex-Product'] = 'PulseGrab';
        }

        const response = await fetch(url, {
          ...options,
          headers,
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
    // Rate limiting delay
    if (options.delay && options.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    }

    // Plex: single endpoint for collections
    if (SERVER_TYPE === 'plex') {
      const url = `${server}/library/collections/${collectionId}/children?X-Plex-Token=${token}`;
      const data = await fetchWithRetry(url);
      const items = (data.MediaContainer?.Metadata || []).map(normalizeItemPlex);
      return { Items: items, TotalRecordCount: items.length };
    }

    const fields = 'Path,FileName,OriginalTitle,ProductionYear,Container,MediaType,Type,MediaSources';
    const prefix = apiPrefix();

    // Jellyfin: use /Items?ParentId= (no /Collections/ endpoint)
    if (SERVER_TYPE === 'jellyfin') {
      const params = new URLSearchParams({
        ParentId: collectionId,
        StartIndex: startIndex.toString(),
        Limit: limit.toString(),
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        Fields: fields,
        api_key: token
      });
      if (options.skipWatched) params.append('IsPlayed', 'false');
      const url = `${server}/Items?${params.toString()}`;
      return await fetchWithRetry(url);
    }

    // Emby: try Collections, fallback to Items, then Playlists
    const params = new URLSearchParams({
      StartIndex: startIndex.toString(),
      Limit: limit.toString(),
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: fields,
      api_key: token
    });

    if (options.skipWatched) {
      params.append('IsPlayed', 'false');
    }

    const url = `${server}${prefix}/Collections/${encodeURIComponent(collectionId)}/Items?${params.toString()}`;

    try {
      const result = await fetchWithRetry(url);
      return result;
    } catch (error) {
      if (error.message && (error.message.includes('404') || error.message.includes('HTTP 404'))) {
        const itemsParams = new URLSearchParams({
          ParentId: collectionId,
          StartIndex: startIndex.toString(),
          Limit: limit.toString(),
          SortBy: 'SortName',
          SortOrder: 'Ascending',
          Recursive: 'false',
          Fields: fields,
          api_key: token
        });
        const itemsUrl = `${server}${prefix}/Items?${itemsParams.toString()}`;
        const result = await fetchWithRetry(itemsUrl);

        if (!result.Items || result.Items.length === 0) {
          const playlistUrl = `${server}${prefix}/Playlists/${encodeURIComponent(collectionId)}/Items?${params.toString()}`;
          try {
            const playlistResult = await fetchWithRetry(playlistUrl);
            if (playlistResult.Items && playlistResult.Items.length > 0) return playlistResult;
          } catch (e) {}
        }
        return result;
      }
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
    // Rate limiting delay
    if (options.delay && options.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, options.delay));
    }

    // Plex: /library/sections/{id}/all
    if (SERVER_TYPE === 'plex') {
      const url = `${server}/library/sections/${parentId}/all?X-Plex-Token=${token}&X-Plex-Container-Start=${startIndex}&X-Plex-Container-Size=${limit}`;
      const data = await fetchWithRetry(url);
      const metadata = data.MediaContainer?.Metadata || [];
      return {
        Items: metadata.map(normalizeItemPlex),
        TotalRecordCount: data.MediaContainer?.totalSize || metadata.length
      };
    }

    // Emby & Jellyfin
    const prefix = apiPrefix();
    const params = new URLSearchParams({
      ParentId: parentId,
      StartIndex: startIndex.toString(),
      Limit: limit.toString(),
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Recursive: SERVER_TYPE === 'jellyfin' ? 'true' : 'false',
      Fields: 'Path,FileName,OriginalTitle,ProductionYear,Container,MediaType,Type,MediaSources',
      api_key: token
    });

    if (options.skipWatched) {
      params.append('IsPlayed', 'false');
    }

    const url = `${server}${prefix}/Items?${params.toString()}`;
    return await fetchWithRetry(url);
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
    // Plex: /library/metadata/{id}/children
    if (SERVER_TYPE === 'plex') {
      const url = `${server}/library/metadata/${showId}/children?X-Plex-Token=${token}`;
      const cacheKey = RequestCache.makeKey(url);
      const cached = RequestCache.get(cacheKey);
      if (cached) return cached;
      const data = await fetchWithRetry(url);
      const seasons = (data.MediaContainer?.Metadata || []).map(s => ({
        Id: String(s.ratingKey),
        Name: s.title,
        IndexNumber: s.index,
        Type: 'Season'
      }));
      RequestCache.set(cacheKey, seasons);
      return seasons;
    }

    // Emby & Jellyfin
    const prefix = apiPrefix();
    const params = new URLSearchParams({
      Fields: 'Path,FileName,IndexNumber',
      api_key: token
    });
    if (SERVER_TYPE === 'jellyfin') {
      const { userId } = getServerAndToken();
      if (userId) params.append('UserId', userId);
    }
    const url = `${server}${prefix}/Shows/${encodeURIComponent(showId)}/Seasons?${params.toString()}`;

    const cacheKey = RequestCache.makeKey(url);
    const cached = RequestCache.get(cacheKey);
    if (cached) {
      return Array.isArray(cached.Items) ? cached.Items : [];
    }

    const data = await fetchWithRetry(url);
    RequestCache.set(cacheKey, data);
    return Array.isArray(data.Items) ? data.Items : [];
  }

  async function fetchEpisodesREST(server, token, showId, seasonId) {
    // Plex: /library/metadata/{seasonRatingKey}/children
    if (SERVER_TYPE === 'plex') {
      const url = `${server}/library/metadata/${seasonId}/children?X-Plex-Token=${token}`;
      const cacheKey = RequestCache.makeKey(url);
      const cached = RequestCache.get(cacheKey);
      if (cached) return cached;
      const data = await fetchWithRetry(url);
      const episodes = (data.MediaContainer?.Metadata || []).map(normalizeItemPlex);
      const result = { Items: episodes, TotalRecordCount: episodes.length };
      RequestCache.set(cacheKey, result);
      return result;
    }

    // Emby & Jellyfin
    const prefix = apiPrefix();
    const params = new URLSearchParams({
      SeasonId: seasonId,
      SortBy: 'IndexNumber,SortName',
      SortOrder: 'Ascending',
      Limit: '0',
      Fields: 'Path,FileName,OriginalTitle,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,Container,MediaType,Type,MediaSources',
      api_key: token
    });
    if (SERVER_TYPE === 'jellyfin') {
      const { userId } = getServerAndToken();
      if (userId) params.append('UserId', userId);
    }

    const url = `${server}${prefix}/Shows/${encodeURIComponent(showId)}/Episodes?${params.toString()}`;

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
      // Plex: get metadata by ratingKey
      if (SERVER_TYPE === 'plex') {
        const url = `${server}/library/metadata/${id}?X-Plex-Token=${token}`;
        const data = await fetchWithRetry(url);
        const plexItem = data.MediaContainer?.Metadata?.[0];
        if (!plexItem) throw new Error(`Item ${id} not found on Plex`);
        return normalizeItemPlex(plexItem);
      }

      // Emby & Jellyfin
      const prefix = apiPrefix();
      const params = new URLSearchParams({
        Fields: 'Path,FileName,OriginalTitle,ProductionYear,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,Container,MediaType,Type,MediaSources',
        api_key: token
      });

      const url = userId
        ? `${server}${prefix}/Users/${userId}/Items/${encodeURIComponent(id)}?${params.toString()}`
        : `${server}${prefix}/Items/${encodeURIComponent(id)}?${params.toString()}`;

      return await fetchWithRetry(url);
    } catch (error) {
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

      // Process Music Artists → Albums → Tracks
      const artistItems = items.filter(item => item.Type === 'MusicArtist');
      const albumItems = items.filter(item => item.Type === 'MusicAlbum');

      if (artistItems.length > 0) {
        updateProgress(0, artistItems.length, "Expanding Music Artists...");
        showNotification(`Found ${artistItems.length} artists, expanding to tracks...`, 'info', 3000);

        let totalTracksFromArtists = 0;
        let successfulArtists = 0;

        for (let i = 0; i < artistItems.length; i++) {
          if (abortController.signal.aborted) {
            console.log('[Debug] Artist expansion cancelled by user');
            throw new Error('Operation cancelled');
          }

          const artist = artistItems[i];
          try {
            updateProgress(i, artistItems.length, `Expanding ${artist.Name}...`);
            console.log(`[Debug] Expanding artist ${i + 1}/${artistItems.length}: ${artist.Name} (ID: ${artist.Id})`);

            let artistTracks = [];

            if (SERVER_TYPE === 'plex') {
              // Fetch albums from artist
              const albumUrl = `${server}/library/metadata/${artist.Id}/children?X-Plex-Token=${token}`;
              const albumData = await fetchWithRetry(albumUrl);
              const albums = albumData.MediaContainer?.Metadata || [];

              for (const album of albums) {
                if (abortController.signal.aborted) break;

                const trackUrl = `${server}/library/metadata/${album.ratingKey}/children?X-Plex-Token=${token}`;
                const trackData = await fetchWithRetry(trackUrl);
                const tracks = (trackData.MediaContainer?.Metadata || []).map(normalizeItemPlex);
                artistTracks.push(...tracks);
                console.log(`[Debug] Artist ${artist.Name}, Album ${album.title}: ${tracks.length} tracks`);

                await new Promise(resolve => setTimeout(resolve, 100));
              }
            } else {
              // Emby/Jellyfin: fetch all audio items recursively under artist
              const prefix = apiPrefix();
              const params = new URLSearchParams({
                ParentId: artist.Id, Recursive: 'true', IncludeItemTypes: 'Audio',
                Fields: 'Path,FileName,MediaSources,Container,MediaType', api_key: token
              });
              const url = `${server}${prefix}/Items?${params.toString()}`;
              const data = await fetchWithRetry(url);
              artistTracks = data?.Items || [];
            }

            if (artistTracks.length > 0) {
              downloadableItems.push(...artistTracks);
              totalTracksFromArtists += artistTracks.length;
              successfulArtists++;
              console.log(`[Debug] Artist ${artist.Name}: Added ${artistTracks.length} tracks (running total: ${totalTracksFromArtists})`);
            }

            if (i < artistItems.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (artistError) {
            const errorMsg = `Failed to expand artist ${artist.Name}: ${artistError.message}`;
            console.error(errorMsg);
            updateProgress(i, artistItems.length, `Expanding ${artist.Name}...`, errorMsg);
          }
        }

        console.log(`[Debug] Artist expansion complete: ${totalTracksFromArtists} tracks from ${successfulArtists}/${artistItems.length} artists`);
        if (totalTracksFromArtists > 0) {
          showNotification(`Expanded ${successfulArtists} artists into ${totalTracksFromArtists} tracks`, 'info', 3000);
        }
      }

      if (albumItems.length > 0) {
        updateProgress(0, albumItems.length, "Expanding Music Albums...");
        let totalTracksFromAlbums = 0;

        for (let i = 0; i < albumItems.length; i++) {
          if (abortController.signal.aborted) break;
          const album = albumItems[i];
          try {
            let albumTracks = [];

            if (SERVER_TYPE === 'plex') {
              const trackUrl = `${server}/library/metadata/${album.Id}/children?X-Plex-Token=${token}`;
              const trackData = await fetchWithRetry(trackUrl);
              albumTracks = (trackData.MediaContainer?.Metadata || []).map(normalizeItemPlex);
            } else {
              const prefix = apiPrefix();
              const params = new URLSearchParams({
                ParentId: album.Id, IncludeItemTypes: 'Audio',
                Fields: 'Path,FileName,MediaSources,Container,MediaType', api_key: token
              });
              const url = `${server}${prefix}/Items?${params.toString()}`;
              const data = await fetchWithRetry(url);
              albumTracks = data?.Items || [];
            }

            downloadableItems.push(...albumTracks);
            totalTracksFromAlbums += albumTracks.length;
            console.log(`[Debug] Album ${album.Name}: Added ${albumTracks.length} tracks`);
          } catch (albumError) {
            console.error(`Failed to expand album ${album.Name}:`, albumError);
          }
        }

        console.log(`[Debug] Album expansion complete: ${totalTracksFromAlbums} tracks from ${albumItems.length} albums`);
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
          `- Artists processed: ${artistItems.length}\n` +
          `- Albums processed: ${albumItems.length}\n` +
          `- Collections processed: ${boxSetItems.length}\n\n` +
          `This might be because the items have different types than expected, or expansion failed. Check the console for detailed logs of what was processed.`
        );
      }

      // Apply deduplication
      downloadableItems = deduplicateItems(downloadableItems);

      const autoConfirm = Settings.get('autoConfirm');
      if (!autoConfirm && downloadableItems.length > 50 && !window._pulseGrabLargeFolderConfirmed) {
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

          window._pulseGrabLargeFolderConfirmed = true;
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
              window._pulseGrabLargeFolderConfirmed = false;
              reject(new Error('User cancelled folder download'));
            }
          );
        });
      }
      window._pulseGrabLargeFolderConfirmed = false;

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

    // Plex: use allLeaves shortcut for whole show
    if (SERVER_TYPE === 'plex') {
      const itemId = getItemIdFromUrl();
      if (!itemId) throw new Error("Could not detect show ID from URL.");

      // Check if we're on a show page or season page
      const itemInfo = await getItemInfo(server, token, itemId);
      let episodes;

      if (itemInfo.Type === 'Series') {
        updateProgress(0, 0, "Fetching all episodes...");
        const url = `${server}/library/metadata/${itemId}/allLeaves?X-Plex-Token=${token}`;
        const data = await fetchWithRetry(url);
        episodes = (data.MediaContainer?.Metadata || []).map(normalizeItemPlex);
      } else if (itemInfo.Type === 'Season') {
        updateProgress(0, 0, "Fetching season episodes...");
        const url = `${server}/library/metadata/${itemId}/children?X-Plex-Token=${token}`;
        const data = await fetchWithRetry(url);
        episodes = (data.MediaContainer?.Metadata || []).map(normalizeItemPlex);
      } else {
        episodes = [itemInfo];
      }

      if (episodes.length > 0) {
        showNotification(`Found ${episodes.length} episodes`, 'info', 3000);
        const autoConfirm = Settings.get('autoConfirm');
        if (!autoConfirm && episodes.length > CONFIG.wholeShowConfirmThreshold) {
          return new Promise((resolve) => {
            showConfirmDialog(
              `Process ${episodes.length} episodes?`,
              [`${episodes.length} episodes found`, `Output: ${CONFIG.outputFormats[Settings.get('outputFormat')]}`],
              episodes,
              () => resolve(episodes),
              () => resolve([])
            );
          });
        }
      }
      return episodes;
    }

    // Emby & Jellyfin: existing season-by-season logic
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
        console.log(`[PulseGrab] API didn't provide movie name, extracted from page: ${itemInfo.Name}`);
      }
    }

    // Failsafe: If still no name, use filename or ID
    if (!itemInfo.Name || !itemInfo.Name.trim()) {
      itemInfo.Name = itemInfo.FileName?.split('.')[0] || `Movie_${itemInfo.Id}`;
      console.warn(`[PulseGrab] Could not find movie name from API or page. Using fallback: ${itemInfo.Name}`);
    }

    showNotification(`Found movie: ${itemInfo.Name}`, 'info', 2000);
    return [itemInfo];
  }

  // ---------- Main Logic ----------
  async function handleButtonClick() {
    console.log('[PulseGrab] Button clicked'); // debug log
    window._pulseGrabLargeFolderConfirmed = false; // Reset guard for new operation

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
      let { server, token, userId } = getServerAndToken();
      const api = getApiClient();

      // Plex on app.plex.tv: server URL may be null on the home page.
      // Use plex.tv resources API to discover available servers.
      if (SERVER_TYPE === 'plex' && !server && token) {
        updateButtonState(true, "Discovering servers...");
        try {
          const servers = await discoverPlexServers(token);
          if (servers.length === 0) {
            throw new Error('No Plex media servers found on your account.');
          } else if (servers.length === 1) {
            // Auto-select the only server
            server = servers[0].uri;
            capturedPlexServer = server;
            console.log(`[PulseGrab] Auto-selected Plex server: ${servers[0].name} (${server})`);
          } else {
            // Let the user pick
            const picked = await new Promise((resolve) => {
              showPlexServerPicker(servers, (s) => resolve(s), () => resolve(null));
            });
            if (!picked) {
              updateButtonState(false);
              return;
            }
            server = picked.uri;
            capturedPlexServer = server;
            console.log(`[PulseGrab] User selected Plex server: ${picked.name} (${server})`);
          }
        } catch (e) {
          throw new Error(`Could not discover Plex servers: ${e.message}`);
        }
      }

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
            // Some servers (especially through Emby Connect or remote servers) don't support /Items/{id}
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
                  console.log(`[PulseGrab] API didn't provide ${itemInfo.Type} name, extracted from page: ${itemInfo.Name}`);
                }
              }
              // Failsafe: If still no name, use filename or ID
              if (!itemInfo.Name || !itemInfo.Name.trim()) {
                itemInfo.Name = itemInfo.FileName?.split('.')[0] || `${itemInfo.Type}_${itemInfo.Id}`;
                console.warn(`[PulseGrab] Could not find ${itemInfo.Type} name. Using fallback: ${itemInfo.Name}`);
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
        console.info(`[PulseGrab] Operation: ${currentOperation}, Items: ${items.length}, Format: ${formatName}\n${text}`);
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
        console.info(`[PulseGrab] Operation: ${operationType}, Items: ${itemCount}, Format: ${formatName}\n${text}`);
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
    console.log('[PulseGrab] Dark mode setting:', darkMode);

    if (darkMode) {
      // Add dark mode class to body
      document.body.classList.add('pulsegrab-dark-mode');
      console.log('[PulseGrab] Applied dark mode class to body');

      // Apply dark mode to download manager and settings panel if they exist
      const applyToElements = () => {
        const manager = document.querySelector('#pulse-grab-manager');
        const settings = document.querySelector('#pulse-grab-settings');
        if (manager) {
          manager.setAttribute('data-dark-mode', 'true');
          console.log('[PulseGrab] Set data-dark-mode on manager:', manager.getAttribute('data-dark-mode'));
        }
        if (settings) {
          settings.setAttribute('data-dark-mode', 'true');
          console.log('[PulseGrab] Set data-dark-mode on settings:', settings.getAttribute('data-dark-mode'));
        }
      };

      // Apply immediately and watch for changes
      applyToElements();
      const observer = new MutationObserver(applyToElements);
      observer.observe(document.body, { childList: true, subtree: true });

      // Inject dark mode styles if not already present
      if (!document.getElementById('pulsegrab-dark-mode-styles')) {
        const style = document.createElement('style');
        style.id = 'pulsegrab-dark-mode-styles';
        console.log('[PulseGrab] Injecting dark mode CSS styles');
        style.textContent = `
                        /* ========== Server-Themed Dark Mode Colors ========== */
                        /* Server dark mode uses:
                           - Background: #101010 (very dark gray, almost black)
                           - Card/Panel: #1c1c1c (slightly lighter dark gray)
                           - Borders: #2a2a2a (subtle gray borders)
                           - Text: #e0e0e0 (light gray text)
                           - Accent: adaptive server theme color
                        */

                        body.pulsegrab-dark-mode {
                          background-color: #101010 !important;
                        color: #e0e0e0 !important;
          }

                        body.pulsegrab-dark-mode *::-webkit-scrollbar {
                          width: 10px;
                        height: 10px;
          }

                        body.pulsegrab-dark-mode *::-webkit-scrollbar-track {
                          background: #1c1c1c;
          }

                        body.pulsegrab-dark-mode *::-webkit-scrollbar-thumb {
                          background: #3a3a3a;
                        border-radius: 5px;
          }

                        body.pulsegrab-dark-mode *::-webkit-scrollbar-thumb:hover {
                          background: #4a4a4a;
          }

                        /* Server containers */
                        body.pulsegrab-dark-mode .emby-container,
                        body.pulsegrab-dark-mode .card,
                        body.pulsegrab-dark-mode .cardContent,
                        body.pulsegrab-dark-mode .itemsContainer,
                        body.pulsegrab-dark-mode .verticalSection {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
          }

                        body.pulsegrab-dark-mode .cardText,
                        body.pulsegrab-dark-mode .cardTextCentered,
                        body.pulsegrab-dark-mode .sectionTitle,
                        body.pulsegrab-dark-mode .itemName,
                        body.pulsegrab-dark-mode .detailPageTitle {
                          color: #e0e0e0 !important;
          }

                        body.pulsegrab-dark-mode .pageTitleWithLogo,
                        body.pulsegrab-dark-mode h1,
                        body.pulsegrab-dark-mode h2,
                        body.pulsegrab-dark-mode h3 {
                          color: #ffffff !important;
          }

                        body.pulsegrab-dark-mode .backgroundContainer,
                        body.pulsegrab-dark-mode .mainAnimatedPage {
                          background-color: #101010 !important;
          }

                        /* ========== PulseGrab Download Manager Dark Mode ========== */
                        #pulse-grab-manager[data-dark-mode="true"],
                        body.pulsegrab-dark-mode #pulse-grab-manager {
                          background-color: #1c1c1c !important;
          }

                        /* Main container backgrounds */
                        #pulse-grab-manager[data-dark-mode="true"] #list-view,
                        #pulse-grab-manager[data-dark-mode="true"] #stats-view,
                        body.pulsegrab-dark-mode #pulse-grab-manager #list-view,
                        body.pulsegrab-dark-mode #pulse-grab-manager #stats-view {
                          background-color: #151515 !important;
                        border-color: #2a2a2a !important;
          }

                        #pulse-grab-manager[data-dark-mode="true"] #download-info,
                        body.pulsegrab-dark-mode #pulse-grab-manager #download-info {
                          background-color: #1c1c1c !important;
                        border-color: #2a2a2a !important;
          }

                        /* Text colors - light gray for readability */
                        #pulse-grab-manager[data-dark-mode="true"],
                        #pulse-grab-manager[data-dark-mode="true"] *,
                        body.pulsegrab-dark-mode #pulse-grab-manager,
                        body.pulsegrab-dark-mode #pulse-grab-manager * {
                          color: #e0e0e0 !important;
          }

                        /* Headings - pure white for emphasis */
                        #pulse-grab-manager[data-dark-mode="true"] h3,
                        #pulse-grab-manager[data-dark-mode="true"] h4,
                        body.pulsegrab-dark-mode #pulse-grab-manager h3,
                        body.pulsegrab-dark-mode #pulse-grab-manager h4 {
                          color: #ffffff !important;
          }

                        /* Inputs and form elements */
                        #pulse-grab-manager[data-dark-mode="true"] input,
                        #pulse-grab-manager[data-dark-mode="true"] select,
                        #pulse-grab-manager[data-dark-mode="true"] textarea,
                        body.pulsegrab-dark-mode #pulse-grab-manager input,
                        body.pulsegrab-dark-mode #pulse-grab-manager select,
                        body.pulsegrab-dark-mode #pulse-grab-manager textarea {
                          background-color: #252525 !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #pulse-grab-manager[data-dark-mode="true"] input::placeholder,
                        body.pulsegrab-dark-mode #pulse-grab-manager input::placeholder {
                          color: #888888 !important;
          }

                        /* Buttons - dark gray with themed accent on hover */
                        #pulse-grab-manager[data-dark-mode="true"] button,
                        body.pulsegrab-dark-mode #pulse-grab-manager button {
                          background-color: #2a2a2a !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #pulse-grab-manager[data-dark-mode="true"] button:hover,
                        body.pulsegrab-dark-mode #pulse-grab-manager button:hover {
                          background-color: #3a3a3a !important;
                        border-color: #00a4dc !important;
          }

                        /* Primary action buttons - themed color */
                        #pulse-grab-manager[data-dark-mode="true"] #start-all,
                        #pulse-grab-manager[data-dark-mode="true"] #download-selected,
                        body.pulsegrab-dark-mode #pulse-grab-manager #start-all,
                        body.pulsegrab-dark-mode #pulse-grab-manager #download-selected {
                          background-color: #52b54b !important;
                        color: white !important;
                        border-color: #52b54b !important;
          }

                        #pulse-grab-manager[data-dark-mode="true"] #start-all:hover,
                        #pulse-grab-manager[data-dark-mode="true"] #download-selected:hover,
                        body.pulsegrab-dark-mode #pulse-grab-manager #start-all:hover,
                        body.pulsegrab-dark-mode #pulse-grab-manager #download-selected:hover {
                          background-color: #5ec556 !important;
                        border-color: #5ec556 !important;
          }

                        /* Pause button - themed blue */
                        #pulse-grab-manager[data-dark-mode="true"] #pause-all,
                        body.pulsegrab-dark-mode #pulse-grab-manager #pause-all {
                          background-color: #00a4dc !important;
                        color: white !important;
                        border-color: #00a4dc !important;
          }

                        #pulse-grab-manager[data-dark-mode="true"] #pause-all:hover,
                        body.pulsegrab-dark-mode #pulse-grab-manager #pause-all:hover {
                          background-color: #00b8f5 !important;
                        border-color: #00b8f5 !important;
          }

                        /* SVG icons inherit text color */
                        #pulse-grab-manager[data-dark-mode="true"] svg,
                        body.pulsegrab-dark-mode #pulse-grab-manager svg {
                          fill: currentColor !important;
          }

                        /* Settings panel - themed styling */
                        #pulse-grab-settings[data-dark-mode="true"],
                        body.pulsegrab-dark-mode #pulse-grab-settings {
                          background-color: rgba(28, 28, 28, 0.98) !important;
          }

          #pulse-grab-settings[data-dark-mode="true"] > div,
                        #pulse-grab-settings[data-dark-mode="true"] div,
          body.pulsegrab-dark-mode #pulse-grab-settings > div,
                        body.pulsegrab-dark-mode #pulse-grab-settings div {
                          background-color: #1c1c1c !important;
                        color: #e0e0e0 !important;
                        border-color: #2a2a2a !important;
          }

                        #pulse-grab-settings[data-dark-mode="true"] input,
                        #pulse-grab-settings[data-dark-mode="true"] select,
                        body.pulsegrab-dark-mode #pulse-grab-settings input,
                        body.pulsegrab-dark-mode #pulse-grab-settings select {
                          background-color: #252525 !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #pulse-grab-settings[data-dark-mode="true"] button,
                        body.pulsegrab-dark-mode #pulse-grab-settings button {
                          background-color: #2a2a2a !important;
                        color: #e0e0e0 !important;
                        border-color: #3a3a3a !important;
          }

                        #pulse-grab-settings[data-dark-mode="true"] button:hover,
                        body.pulsegrab-dark-mode #pulse-grab-settings button:hover {
                          background-color: #3a3a3a !important;
                        border-color: #00a4dc !important;
          }

                        /* Notifications */
                        body.pulsegrab-dark-mode .pulse-dl-notification {
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
                        body.pulsegrab-dark-mode input[type="checkbox"],
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

                        body.pulsegrab-dark-mode input[type="checkbox"]:hover,
                        [data-dark-mode="true"] input[type="checkbox"]:hover {
                          border-color: #6a6a6a !important;
                        background-color: #3a3a3a !important;
          }

                        body.pulsegrab-dark-mode input[type="checkbox"]:checked,
                        [data-dark-mode="true"] input[type="checkbox"]:checked {
                          background-color: ${getTheme().primary} !important;
                        border-color: ${getTheme().primary} !important;
          }

                        body.pulsegrab-dark-mode input[type="checkbox"]:checked::after,
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
      document.body.classList.remove('pulsegrab-dark-mode');
      const style = document.getElementById('pulsegrab-dark-mode-styles');
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

      console.log('PulseGrab v1.0.0 loaded! 🚀 Features: 10+ formats, built-in download manager, wget/curl scripts, JDownloader integration, selective downloads!');
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
          const cacheKey = RequestCache.makeKey(`${server}${apiPrefix()}/Items`, { ParentId: pageId });
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
    document.querySelectorAll('.pulse-dl-notification').forEach(n => n.remove());
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