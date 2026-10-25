// Pulls named helpers out of the userscript IIFE (declared at 2-space indent) and
// evaluates only them in a node:vm sandbox. The script itself is never modified.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../releases/PulseGrab.user.js', import.meta.url));
const lines = readFileSync(SCRIPT, 'utf8').split('\n');

function extract(name) {
  const start = lines.findIndex(l =>
    l.startsWith(`  function ${name}(`) || l.startsWith(`  async function ${name}(`) || l.startsWith(`  const ${name} =`));
  if (start < 0) throw new Error(`load.mjs: '${name}' not found in userscript (renamed?)`);
  const isFn = lines[start].includes('function ');
  const end = isFn
    ? lines.findIndex((l, i) => i >= start && l === '  }')
    : endByBalance(start);
  if (end < 0) throw new Error(`load.mjs: end of '${name}' not found`);
  return lines.slice(start, end + 1).join('\n');
}

// Bracket balance is enough for the plain consts/object literals we extract.
function endByBalance(start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) depth += '[{('.includes(ch) ? 1 : ']})'.includes(ch) ? -1 : 0;
    if (depth === 0 && /;\s*$/.test(lines[i])) return i;
  }
  return -1;
}

export function load(names, { settings = {}, serverType = 'emby' } = {}) {
  const store = new Map();
  const sandbox = {
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, v),
    Settings: { get: key => settings[key] },
    SERVER_TYPE: serverType,
    apiPrefix: '',
    logDebug() {},
    CONFIG: { remote: { stagingDir: '.pulsegrab-incoming' } },
    TextEncoder, btoa, console,
  };
  vm.createContext(sandbox);
  // getApiClient is only probed defensively; null keeps those paths inert.
  const src = ['  const getApiClient = () => null;', ...names.map(extract)].join('\n');
  return vm.runInContext(`${src}\n({ ${names.join(', ')} })`, sandbox);
}
