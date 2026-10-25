// Minimal fake Emby server + web page for headless smoke tests.
import http from 'node:http';

const ms = (id, height, size = 51200) => [{ Id: `ms-${id}`, Container: 'mkv', Size: size,
  MediaStreams: [{ Type: 'Video', Height: height, Width: height === 1080 ? 1920 : 1280, Codec: 'h264' },
    { Type: 'Audio', Codec: 'aac' }] }];
const ep = (series, seriesName, season, n, height) => ({
  Id: `${series}-s${season}e${n}`, Name: `Episode ${n}`, Type: 'Episode', MediaType: 'Video', Container: 'mkv',
  SeriesId: series, SeriesName: seriesName, SeasonId: `${series}-s${season}`, SeasonName: `Season ${season}`,
  ParentIndexNumber: season, IndexNumber: n, Size: 51200, MediaSources: ms(`${series}-${season}-${n}`, height)
});
const SERIES = {
  series1: { Id: 'series1', Name: 'Show One', Type: 'Series', IsFolder: true,
    seasons: { 1: [1, 2, 3].map(n => ep('series1', 'Show One', 1, n, 1080)), 2: [1, 2, 3].map(n => ep('series1', 'Show One', 2, n, 720)) } },
  series2: { Id: 'series2', Name: 'Show Two', Type: 'Series', IsFolder: true,
    seasons: { 1: [1, 2].map(n => ep('series2', 'Show Two', 1, n, 1080)) } }
};
const MOVIES = {
  m1: { Id: 'm1', Name: 'Dune', Type: 'Movie', MediaType: 'Video', ProductionYear: 2021, Container: 'mkv', Size: 51200, MediaSources: ms('m1', 1080) },
  m3: { Id: 'm3', Name: '<img src=x onerror="window.__xss=1">Evil', Type: 'Movie', MediaType: 'Video', ProductionYear: 2020, Container: 'mkv', Size: 51200, MediaSources: ms('m3', 1080) },
  m2: { Id: 'm2', Name: 'Arrival', Type: 'Movie', MediaType: 'Video', ProductionYear: 2016, Container: 'mkv', Size: 51200, MediaSources: ms('m2', 1080) }
};
const BOXSET = { Id: 'bs1', Name: 'Mixed Box', Type: 'BoxSet', IsFolder: true };
const LIB = { Id: 'lib1', Name: 'Everything', Type: 'CollectionFolder', IsFolder: true, CollectionType: 'movies' };
const strip = s => { const { seasons, ...rest } = s; return rest; };
const seasonsOf = id => Object.keys(SERIES[id].seasons).map(n => ({ Id: `${id}-s${n}`, Name: `Season ${n}`, Type: 'Season', IndexNumber: +n, SeriesId: id, IsFolder: true }));
const byId = id => MOVIES[id] || (SERIES[id] && strip(SERIES[id])) || (id === 'bs1' && BOXSET) || (id === 'lib1' && LIB)
  || Object.values(SERIES).flatMap(s => Object.values(s.seasons).flat()).find(e => e.Id === id)
  || Object.values(SERIES).flatMap(s => seasonsOf(s.Id)).find(s => s.Id === id);

export const requests = [];
const PAGE = `<!doctype html><html><head><title>Emby</title></head><body><div id="app">fake emby</div></body></html>`;

export function startMock(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;
    requests.push(p + url.search);
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (p === '/web/index.html' || p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (url.searchParams.get('api_key') !== 'TESTTOKEN' && p.startsWith('/emby/')) { res.writeHead(401); return res.end('no'); }
    let m;
    if ((m = p.match(/^\/emby\/Users\/u1\/Items\/([^/]+)$/)) || (m = p.match(/^\/emby\/Items\/([^/]+)$/))) {
      const item = byId(decodeURIComponent(m[1])); if (!item) { res.writeHead(404); return res.end(); } return json(item);
    }
    if ((m = p.match(/^\/emby\/Shows\/([^/]+)\/Seasons$/))) return json({ Items: seasonsOf(m[1]), TotalRecordCount: 2 });
    if ((m = p.match(/^\/emby\/Shows\/([^/]+)\/Episodes$/))) {
      const season = url.searchParams.get('SeasonId').split('-s')[1];
      const items = SERIES[m[1]].seasons[season] || []; return json({ Items: items, TotalRecordCount: items.length });
    }
    if ((m = p.match(/^\/emby\/Collections\/([^/]+)\/Items$/))) {
      const items = m[1] === 'bs1' ? [MOVIES.m2, strip(SERIES.series2)] : [];
      return json({ Items: items, TotalRecordCount: items.length });
    }
    if (p === '/emby/Library/MediaFolders') return json({ Items: [LIB] });
    if (p === '/emby/Items') {
      const term = url.searchParams.get('SearchTerm');
      if (term) { const items = Object.values(SERIES).filter(s => s.Name.toLowerCase().includes(term.toLowerCase())).map(strip); return json({ Items: items, TotalRecordCount: items.length }); }
      const parent = url.searchParams.get('ParentId');
      const start = +(url.searchParams.get('StartIndex') || 0);
      let items = [];
      if (parent === 'lib1') items = [strip(SERIES.series1), MOVIES.m1, BOXSET];
      else if (SERIES[parent]) items = seasonsOf(parent);
      else if (/-s\d+$/.test(parent || '')) { const [sid, n] = parent.split('-s'); items = SERIES[sid].seasons[n]; }
      return json({ Items: items.slice(start), TotalRecordCount: items.length });
    }
    if (p.startsWith('/emby/Videos/') || p.startsWith('/emby/Audio/')) {
      const total = 51200; const buf = Buffer.alloc(total, 7);
      const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-/);
      if (range) { const from = +range[1]; res.writeHead(206, { 'Content-Length': total - from, 'Content-Range': `bytes ${from}-${total - 1}/${total}`, 'Content-Type': 'video/x-matroska' }); return res.end(buf.subarray(from)); }
      res.writeHead(200, { 'Content-Length': total, 'Content-Type': 'video/x-matroska' }); return res.end(buf);
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
