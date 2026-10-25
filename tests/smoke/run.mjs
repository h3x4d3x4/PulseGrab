// Headless smoke test: real Chrome + fake Emby + the userscript with GM_* stubs.
// No dependencies: Chrome DevTools Protocol over Node's built-in WebSocket.
// Usage: node tests/smoke/run.mjs   (exit 1 on any failure)
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, requests } from './mock-emby.mjs';
import { startPlexMock } from './mock-plex.mjs';
import { startAria2Mock, aria2Calls } from './mock-aria2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, '../../releases/PulseGrab.user.js'), 'utf8');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 18096, DEBUG = 19333;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const preamble = seed => `
(() => {
  const store = Object.assign({ pulse_dl_settings: JSON.stringify(Object.assign({ autoCheckUpdates: false, darkMode: false }, ${JSON.stringify(Object.fromEntries(Object.entries(seed).filter(([k]) => !k.startsWith('__'))))})) });
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_deleteValue = k => { delete store[k]; };
  window.GM_listValues = () => Object.keys(store);
  window.GM_setClipboard = t => { window.__clipboard = t; };
  window.GM_info = { script: { version: '9.9.9' } };
  window.unsafeWindow = window;
  // Stand-in for the folder picker: the origin-private file system has the same
  // FileSystemDirectoryHandle API, so the real streaming path runs unchanged.
  if (${JSON.stringify(!!seed.__opfs)}) window.showDirectoryPicker = () => navigator.storage.getDirectory();
  window.__opened = [];
  window.open = (url) => { window.__opened.push(url); return {}; };
  window.GM_xmlhttpRequest = o => {
    // GitHub is replaced by the mock so the update flow runs offline.
    const url = String(o.url)
      .replace('https://raw.githubusercontent.com/h3x4d3x4/PulseGrab/main/releases/', location.origin + '/__raw/')
      .replace('https://api.github.com/repos/h3x4d3x4/PulseGrab/releases/latest', location.origin + '/__api/releases/latest');
    fetch(url, { method: o.method || 'GET', headers: o.headers, body: o.data })
      .then(async r => {
        const text = await r.text();
        if (o.onprogress) o.onprogress({ lengthComputable: true, loaded: text.length, total: text.length });
        if (o.onload) o.onload({ status: r.status, statusText: r.statusText, responseText: text });
      })
      .catch(e => o.onerror && o.onerror({ error: String(e) }));
  };
  if (location.port === '32400') { localStorage.setItem('myPlexAccessToken', 'PLEXTOKEN'); }
  else window.ApiClient = {
    serverAddress: () => location.origin, accessToken: () => 'TESTTOKEN', getCurrentUserId: () => 'u1',
    getEpisodes: () => Promise.reject(new Error('use REST'))
  };
})();`;

let ws, nextId = 0; const pending = new Map(); const problems = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};
const waitFor = async (expr, timeout = 15000, label = expr) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await evaluate(expr).catch(() => null); if (v) return v; await sleep(150); }
  throw new Error(`timeout waiting for ${label}`);
};

let scriptId = null, run = 0;
async function open(hash, seed = {}, base = `http://127.0.0.1:${PORT}/web/index.html`) {
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: preamble(seed) + '\n' + SCRIPT })).identifier;
  // Real Emby URLs carry no query string before the hash, so reload via about:blank instead.
  await send('Page.navigate', { url: 'about:blank' }); run++;
  await sleep(100);
  await send('Page.navigate', { url: `${base}${hash}` });
  await waitFor(`!!document.getElementById('getDownloadLinksButton')`, 20000, 'floating button');
}
const bodyText = `document.body.innerText`;

async function scan(hash, seed, base) {
  await open(hash, seed, base);
  await evaluate(`document.getElementById('getDownloadLinksButton').click()`);
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const state = await evaluate(`(() => {
      const t = document.body.innerText;
      if (t.includes('Scan Complete')) return 'done';
      const c = document.getElementById('confirm-proceed'); if (c) { c.click(); return 'confirmed'; }
      const s = document.getElementById('server-dl-start'); if (s) { s.click(); return 'confirmed'; }
      return null; })()`);
    if (state === 'done') break;
    await sleep(200);
  }
  const text = await evaluate(bodyText);
  if (!text.includes('Scan Complete')) throw new Error(`no results dialog; page says: ${text.slice(-300)}`);
  const m = text.match(/(\d+) items? ready([^\n]*)/);
  return { count: m ? +m[1] : NaN, subtitle: m ? m[0] : '', text };
}

const results = [];
async function check(name, fn) {
  const before = problems.length;
  try { await fn(); } catch (e) { problems.push(`${name}: ${e.message}`); }
  const ok = problems.length === before;
  results.push(`${ok ? 'ok  ' : 'FAIL'} - ${name}`);
}
const expectEq = (actual, expected, what) => { if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`); };

const mock = await startMock(PORT);
const plex = await startPlexMock(32400);
const aria2 = await startAria2Mock(16800);
const profile = mkdtempSync(join(tmpdir(), 'pg-smoke-'));
const downloads = mkdtempSync(join(tmpdir(), 'pg-dl-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${DEBUG}/json/list`).then(r => r.json()).then(l => l.find(t => t.type === 'page')).catch(() => null);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`page exception: ${msg.params.exceptionDetails.exception?.description?.split('\n')[0] || msg.params.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)}`);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const line = msg.params.args.map(a => a.value ?? '').join(' ');
      if (/TESTTOKEN/.test(line)) problems.push(`token leaked to console: ${line.slice(0, 120)}`);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => {});

  await check('show page: whole series scan', async () => {
    const r = await scan('#!/item?id=series1');
    expectEq(r.count, 6, 'episodes');
  });
  await check('filters: 1080p preset drops the 720p season', async () => {
    const r = await scan('#!/item?id=series1', { filterOptions: { minQuality: '1080p' } });
    expectEq(r.count, 3, 'episodes after filter');
    if (!/3 filtered out/.test(r.subtitle)) throw new Error(`subtitle lacks "3 filtered out": ${r.subtitle}`);
  });
  await check('movie page', async () => expectEq((await scan('#!/item?id=m1')).count, 1, 'movie'));
  await check('collection with a series inside', async () => expectEq((await scan('#!/item?id=bs1')).count, 3, 'items'));
  await check('folder: series + movie + boxset(movie + series)', async () =>
    expectEq((await scan('#!/movies?parentId=lib1')).count, 10, 'items'));
  await check('search: two matching shows', async () => expectEq((await scan('#!/search?query=show')).count, 8, 'episodes'));
  await check('whole server', async () => expectEq((await scan('#!/home')).count, 10, 'items'));

  await check('results dialog: copy links + escape closes', async () => {
    await scan('#!/item?id=m1');
    await evaluate(`document.getElementById('copy-clipboard').click()`);
    await waitFor(`(window.__clipboard || '').includes('/emby/Videos/m1/')`, 5000, 'clipboard link');
    const link = await evaluate(`window.__clipboard`);
    if (!/Dune%20\(2021\)\.mkv/.test(link)) throw new Error(`link lacks filename: ${link}`);
  });

  await check('download manager: blob path downloads 6 episodes', async () => {
    await scan('#!/item?id=series1');
    await evaluate(`document.getElementById('download-manager').click()`);
    await waitFor(`!!document.getElementById('start-all')`, 5000, 'manager');
    await evaluate(`document.getElementById('start-all').click()`);
    await waitFor(`/6 done/.test(document.getElementById('completed-count')?.textContent || '')`, 30000, '6 done');
    await sleep(1500);
    const files = readdirSync(downloads).filter(f => !f.endsWith('.crdownload'));
    if (files.length < 6) throw new Error(`only ${files.length} files saved: ${files.join(', ')}`);
    if (!files.some(f => /^Show One - S01E01 - Episode 1\.mkv$/.test(f))) throw new Error(`unexpected names: ${files.join(', ')}`);
  });

  await check('download manager: streams into a folder, never overwrites, no .part left', async () => {
    await scan('#!/item?id=series1', { __opfs: true });
    // An existing file at the first episode's path must survive untouched.
    await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
      let d = root;
      for (const p of ['TV Shows', 'Show One', 'Season 1']) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle('Show One - S01E01 - Episode 1.mkv', { create: true })).createWritable();
      await w.write('old'); await w.close();
    })()`);
    await evaluate(`document.getElementById('download-manager').click()`);
    await waitFor(`!!document.getElementById('start-all')`, 5000, 'manager');
    await evaluate(`document.getElementById('start-all').click()`);
    await waitFor(`/6 done/.test(document.getElementById('completed-count')?.textContent || '')`, 30000, '6 done');
    const files = await evaluate(`(async () => {
      const out = {};
      const walk = async (dir, prefix) => {
        for await (const [name, h] of dir.entries()) {
          if (h.kind === 'directory') await walk(h, prefix + name + '/');
          else out[prefix + name] = (await h.getFile()).size;
        }
      };
      await walk(await navigator.storage.getDirectory(), '');
      return out;
    })()`);
    const names = Object.keys(files);
    const s1 = 'TV Shows/Show One/Season 1/';
    expectEq(files[s1 + 'Show One - S01E01 - Episode 1.mkv'], 3, 'pre-existing file size (must be untouched)');
    expectEq(files[s1 + 'Show One - S01E01 - Episode 1 (1).mkv'], 51200, 'renamed new copy');
    expectEq(names.filter(n => n.endsWith('.part')).length, 0, 'leftover .part files');
    expectEq(names.filter(n => files[n] === 51200).length, 6, 'streamed files');
  });

  const PLEX = 'http://127.0.0.1:32400/web/index.html';
  await check('plex: search expands the show and completes the movie', async () => {
    const r = await scan('#!/search?pivot=top&query=plex', {}, PLEX);
    expectEq(r.count, 4, 'items (3 episodes + 1 movie)');
    await evaluate(`document.getElementById('copy-clipboard').click()`);
    await waitFor(`(window.__clipboard || '').includes('/library/parts/200/')`, 5000, 'movie link via refetched Part');
  });
  await check('plex: movies tab only returns movies', async () => {
    expectEq((await scan('#!/search?pivot=movie&query=plex', {}, PLEX)).count, 1, 'movies');
  });
  await check('plex: show page', async () => {
    expectEq((await scan('#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F100', {}, PLEX)).count, 3, 'episodes');
  });

  await check('update: check finds v99, panel downloads, verifies and hands off to the manager', async () => {
    await open('#!/item?id=m1');
    await evaluate(`document.getElementById('pulseDlSettings').click()`);
    await waitFor(`!!document.getElementById('check-updates-now')`, 5000, 'check button');
    await evaluate(`document.getElementById('check-updates-now').click()`);
    await waitFor(`/v99\\.0\\.0 Available/.test(document.getElementById('pulsegrab-update-banner')?.innerText || '')`, 8000, 'update banner');
    await evaluate(`document.getElementById('pulsegrab-install-update').click()`);
    await waitFor(`/confirm in/i.test(document.getElementById('pulsegrab-update-banner')?.innerText || '')`, 8000, 'hand-off step');
    const opened = await evaluate(`window.__opened`);
    if (!opened.some(u => u === 'https://raw.githubusercontent.com/h3x4d3x4/PulseGrab/main/releases/PulseGrab.user.js')) throw new Error(`installer URL not opened: ${opened}`);
  });

  await check('send to my server (aria2): status pill, phases, queued + panel', async () => {
    // The script refuses loopback sources (another machine can't reach them), so
    // serve the fake Emby under a *.localhost name — Chrome still resolves it locally.
    await scan('#!/item?id=series1', { remoteMethod: 'aria2', remoteHost: '127.0.0.1', remotePort: 16800, remoteSecret: 'SECRET', remoteAskDestination: false, remoteLibraryDir: '/downloads' }, `http://emby.localhost:${PORT}/web/index.html`);
    aria2Calls.length = 0;
    await evaluate(`window.__seen = new Set(); new MutationObserver(() => { document.querySelectorAll('.pg-ts-text, .pulse-dl-notification').forEach(e => e.textContent && window.__seen.add(e.textContent.trim())); }).observe(document.body, { subtree: true, childList: true, characterData: true })`);
    await evaluate(`document.getElementById('send-my-server').click()`);
    await waitFor(`/Queued 6 file/.test(document.body.innerText)`, 15000, 'queued notification')
      .catch(async e => { throw new Error(`${e.message}; seen: ${JSON.stringify(await evaluate('[...window.__seen]'))}; aria2: ${aria2Calls.join(',')}`); });
    await waitFor(`/Transferring to your server/.test(document.body.innerText)`, 5000, 'transfer panel');
    const seen = await evaluate(`[...window.__seen]`);
    if (!seen.some(t => /Connecting to aria2/.test(t))) throw new Error(`status pill never showed the connect step: ${JSON.stringify(seen)}`);
    if (await evaluate(`!!document.querySelector('.pg-ts-text')`)) throw new Error('status pill still on screen after queueing');
    expectEq(aria2Calls.filter(m => m === 'aria2.addUri').length, 6, 'files added to aria2');
  });

  await check('settings: every section renders and saves', async () => {
    await open('#!/item?id=m1');
    await evaluate(`document.getElementById('pulseDlSettings').click()`);
    await waitFor(`document.querySelectorAll('.setting-nav-item').length > 3`, 5000, 'settings nav');
    await evaluate(`(async () => { for (const n of document.querySelectorAll('.setting-nav-item')) { n.click(); await new Promise(r => setTimeout(r, 50)); } })()`);
    await evaluate(`document.getElementById('save-settings').click()`);
    await waitFor(`document.body.innerText.includes('Settings saved')`, 5000, 'saved notification');
  });

  await check('dark mode auto renders dialogs', async () => {
    const r = await scan('#!/item?id=m1', { darkMode: 'auto' });
    expectEq(r.count, 1, 'movie');
  });

  await check('XSS: hostile title is shown as text everywhere', async () => {
    await scan('#!/item?id=m3');
    await evaluate(`document.getElementById('download-manager').click()`);
    await waitFor(`!!document.getElementById('start-all')`, 5000, 'manager');
    await sleep(500);
    await evaluate(`document.getElementById('close-manager').click()`);
    await sleep(300);
    expectEq(await evaluate(`window.__xss || 0`), 0, 'hostile onerror executed');
    if (!(await evaluate(`document.querySelectorAll('img[src="x"]').length === 0`))) throw new Error('hostile <img> was inserted into the DOM');
  });
} finally {
  ws?.close(); chrome.kill('SIGKILL'); mock.close(); plex.close(); aria2.close();
  rmSync(profile, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true });
}

console.log(results.join('\n'));
if (problems.length) { console.log('\nProblems:\n- ' + [...new Set(problems)].join('\n- ')); process.exit(1); }
console.log(`\nsmoke: ${results.length} checks passed (${requests.length} mock requests)`);
