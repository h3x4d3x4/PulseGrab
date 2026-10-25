// Minimal aria2 JSON-RPC daemon: enough for PulseGrab's health check, duplicate
// check, preflight probe and batch queueing.
import http from 'node:http';

export const aria2Calls = [];
export function startAria2Mock(port, { secret = 'SECRET' } = {}) {
  let gid = 0;
  const call = (method, params) => {
    aria2Calls.push(method);
    const auth = params[0];
    if (auth !== `token:${secret}`) return { error: { code: 1, message: 'Unauthorized' } };
    if (method === 'aria2.getVersion') return { result: { version: '1.36.0' } };
    if (method === 'aria2.getGlobalOption') return { result: { 'on-download-complete': '/config/script/pulsegrab-move.sh' } };
    if (method === 'aria2.addUri') return { result: String(++gid).padStart(16, '0') };
    if (method === 'aria2.tellStatus') return { result: { gid: params[1], status: 'active', completedLength: '1024', totalLength: '51200', downloadSpeed: '1000' } };
    if (method === 'aria2.tellActive' || method === 'aria2.tellWaiting') return { result: [] };
    return { result: 'OK' };
  };
  const server = http.createServer((req, res) => {
    // The test stub emulates GM_xmlhttpRequest with page fetch(), which preflights.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST' });
      return res.end();
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      let reply;
      if (msg.method === 'system.multicall') {
        reply = { result: msg.params[0].map(c => { const r = call(c.methodName, c.params); return r.error ? { faultCode: 1, faultString: r.error.message } : [r.result]; }) };
      } else {
        reply = call(msg.method, msg.params || []);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
