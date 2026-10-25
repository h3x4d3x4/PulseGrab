// Minimal fake Plex Media Server (port 32400 so the userscript detects Plex).
import http from 'node:http';

const part = (id, h = 1080) => [{ id: Number(id.replace(/\D/g, '')) || 1, container: 'mkv', height: h, bitrate: 5000,
  Part: [{ key: `/library/parts/${id}/file.mkv`, size: 51200, container: 'mkv', file: `/media/${id}.mkv`, Stream: [] }] }];
const episodes = [1, 2, 3].map(n => ({ ratingKey: `10${n}`, type: 'episode', title: `Episode ${n}`,
  grandparentTitle: 'Plex Show', parentTitle: 'Season 1', parentIndex: 1, index: n, Media: part(`10${n}`) }));
const show = { ratingKey: '100', type: 'show', title: 'Plex Show' };
const movie = { ratingKey: '200', type: 'movie', title: 'Plex Movie', year: 2020, Media: part('200') };
// Search hubs return the movie without Media, like some real servers do.
const movieNoMedia = { ratingKey: '200', type: 'movie', title: 'Plex Movie', year: 2020 };
const person = { ratingKey: '900', type: 'tag', title: 'Some Actor' };

export function startPlexMock(port = 32400) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (p.startsWith('/web')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Plex</title><body>plex</body>'); }
    const token = url.searchParams.get('X-Plex-Token') || req.headers['x-plex-token'];
    if (token !== 'PLEXTOKEN') { res.writeHead(401); return res.end(); }
    if (p === '/hubs/search') {
      const q = (url.searchParams.get('query') || '').toLowerCase();
      if (!q.includes('plex')) return json({ MediaContainer: { Hub: [] } });
      return json({ MediaContainer: { Hub: [
        { type: 'show', Metadata: [show] }, { type: 'movie', Metadata: [movieNoMedia] }, { type: 'actor', Metadata: [person] }
      ] } });
    }
    if (p === '/library/metadata/100/allLeaves') return json({ MediaContainer: { Metadata: episodes } });
    if (p === '/library/metadata/100') return json({ MediaContainer: { Metadata: [show] } });
    if (p === '/library/metadata/200') return json({ MediaContainer: { Metadata: [movie] } });
    if (p.startsWith('/library/parts/')) { res.writeHead(200, { 'Content-Length': 51200 }); return res.end(Buffer.alloc(51200, 1)); }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
