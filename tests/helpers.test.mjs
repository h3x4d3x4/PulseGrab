import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const H = load([
  'sanitizeFilename', 'shQuote', 'psQuote', 'pyQuote', 'escapeHtml', 'redactToken',
  'normalizeNetworkHost', 'longestCommonPathPrefix', 'destPathToRelative',
  'MEDIA_EXTENSIONS', 'titleTokens', 'looksLikeSameTitle', 'sanitizeFolderName',
  'applyDestinationOverrides', 'normalizeCollectionType',
  'VIDEO_CONTAINERS', 'AUDIO_CONTAINERS', 'CONTAINER_TYPES', 'isDownloadableItem', 'isContainerItem',
  'UpdateChecker',
]);

test('sanitizeFilename', () => {
  const s = H.sanitizeFilename;
  assert.equal(s('a<b>c:d"e/f\\g|h?i*j`k$l&m;n'), 'a_b_c_d_e_f_g_h_i_j_k_l_m_n');
  assert.equal(s('a\x00b\x1fc\x85d'), 'abcd');
  assert.equal(s('...hidden...'), 'hidden');
  assert.equal(s('a    b \t c'), 'a b c');
  assert.equal(s('x'.repeat(300)).length, 200);
  for (const v of ['', null, undefined]) assert.equal(s(v), 'Unknown');
});

test('shQuote / psQuote / pyQuote', () => {
  assert.equal(H.shQuote("it's"), `'it'\\''s'`);
  assert.equal(H.shQuote('$(rm -rf ~)'), "'$(rm -rf ~)'");
  assert.equal(H.shQuote('`id`'), "'`id`'");
  assert.equal(H.shQuote('a\\b'), "'a\\b'");
  assert.equal(H.shQuote(null), "''");
  assert.equal(H.psQuote("it's"), "'it''s'");
  assert.equal(H.psQuote('$(x) `y`'), "'$(x) `y`'");
  assert.equal(H.psQuote(null), "''");
  assert.equal(H.pyQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(H.pyQuote("it's $(x) `y`"), `"it's $(x) \`y\`"`);
  assert.equal(H.pyQuote(null), '""');
});

test('escapeHtml', () => {
  assert.equal(H.escapeHtml(`<a href="x">Tom & 'Jerry'</a>`),
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  assert.equal(H.escapeHtml(null), '');
  assert.equal(H.escapeHtml(undefined), '');
  assert.equal(H.escapeHtml(0), '0');
});

test('redactToken: MediaBrowser Token="..." header', () => {
  assert.ok(!H.redactToken('MediaBrowser Client="x", Token="abc123", Version="1"').includes('abc123'));
});

test('redactToken', () => {
  const r = H.redactToken;
  assert.equal(r('http://h/x?api_key=SECRET&a=1'), 'http://h/x?api_key=***&a=1');
  assert.equal(r('?apikey=SECRET'), '?apikey=***');
  assert.equal(r('?X-Plex-Token=abc123&b=2'), '?X-Plex-Token=***&b=2');
  assert.equal(r('?token=abc'), '?token=***');
  assert.equal(r('/video/t_0123abcd_/file'), '/video/t_***_/file');
  assert.equal(r('nothing to see /here?x=1'), 'nothing to see /here?x=1');
  assert.equal(r(42), 42);
});

test('normalizeNetworkHost', () => {
  const n = H.normalizeNetworkHost;
  assert.equal(n('truenas.local'), 'truenas.local');
  assert.equal(n('192.168.1.50:6800'), '192.168.1.50');
  assert.equal(n('http://nas/'), 'nas');
  assert.equal(n('https://nas:6800/jsonrpc'), 'nas');
  assert.equal(n('[fd00::1]:6800'), '[fd00::1]');
  assert.equal(n('fd00::1'), '[fd00::1]');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
  assert.equal(n('  nas  '), 'nas');
});

test('longestCommonPathPrefix', () => {
  const p = H.longestCommonPathPrefix;
  assert.equal(p(['/media/Movies']), '/media');
  assert.equal(p(['/media/Movies/', ]), '/media');
  assert.equal(p(['/media/Movies', '/media/TV']), '/media');
  assert.equal(p(['/media/a/Movies', '/media/a/TV/']), '/media/a');
  assert.equal(p(['/x/Movies', '/y/TV']), '');
  assert.equal(p([]), '');
  assert.equal(p(null), '');
  assert.equal(p(['', null, '/media/Movies']), '/media');
});

test('destPathToRelative', () => {
  const d = H.destPathToRelative;
  assert.equal(d('/media/Anime Series', '/media'), 'Anime Series');
  assert.equal(d('/media/Anime Series/', '/media/'), 'Anime Series');
  assert.equal(d('/media/a/b', '/media'), 'a/b');
  assert.equal(d('/media', '/media'), '');
  assert.equal(d('/other/place/Films', '/media'), 'Films');
  assert.equal(d('/mediaX/Films', '/media'), 'Films');
  assert.equal(d('/a/b', ''), 'b');
  assert.equal(d(null, '/media'), '');
});

test('titleTokens / looksLikeSameTitle', () => {
  assert.deepEqual([...H.titleTokens('Dune.2021.1080p.BluRay.x264.mkv')], ['dune', '2021']);
  assert.ok(H.looksLikeSameTitle('Dune (2021)', 'Dune.2021.1080p.BluRay.x264.mkv'));
  assert.ok(H.looksLikeSameTitle('Dune 2021', 'Dune (2021)'));
  assert.ok(!H.looksLikeSameTitle('Dune 2021', 'Dune Part Two 2024'));
  assert.ok(!H.looksLikeSameTitle('Dune Part Two 2024', 'Dune 2021'));
  assert.ok(!H.looksLikeSameTitle('', 'Dune'));
  // one-letter title guard: "M" must not match everything containing an m token
  assert.ok(!H.looksLikeSameTitle('M', 'M Is For Murder'));
  assert.ok(H.looksLikeSameTitle('M', 'M.mkv'));
});

test('sanitizeFolderName', () => {
  const s = H.sanitizeFolderName;
  assert.equal(s('Anime/Series'), 'Anime/Series');
  assert.equal(s('/Movies/'), 'Movies');
  assert.equal(s('  Movies  '), 'Movies');
  assert.equal(s('..'), null);
  assert.equal(s('a/../b'), null);
  assert.equal(s('../x'), null);
  assert.equal(s('a//b'), null);
  assert.equal(s(''), null);
  assert.equal(s('///'), null);
  assert.equal(s(null), null);
});

test('applyDestinationOverrides', () => {
  const task = (kind, rel) => ({ contentKind: kind, relativePath: rel, options: { out: rel, dir: '/d' } });
  const tasks = [task('movie', 'Movies/Dune (2021)/Dune.mkv'), task('episode', 'TV Shows/X/S1/e1.mkv'), task('audio', 'Music/A/B/t.mp3')];
  const out = H.applyDestinationOverrides(tasks, { movie: 'Filmes', episode: 'Series/Anime' });
  assert.equal(out[0].relativePath, 'Filmes/Dune (2021)/Dune.mkv');
  assert.equal(out[0].options.out, 'Filmes/Dune (2021)/Dune.mkv');
  assert.equal(out[0].options.dir, '/d');
  assert.equal(out[1].relativePath, 'Series/Anime/X/S1/e1.mkv');
  assert.equal(out[2], tasks[2]);
  assert.equal(tasks[0].relativePath, 'Movies/Dune (2021)/Dune.mkv', 'input not mutated');
  const bare = [task('movie', 'file.mkv')];
  assert.equal(H.applyDestinationOverrides(bare, { movie: 'Filmes' })[0], bare[0]);
  assert.equal(H.applyDestinationOverrides(tasks, null), tasks);
});

test('normalizeCollectionType', () => {
  const n = H.normalizeCollectionType;
  assert.equal(n('movies'), 'movie');
  assert.equal(n('Movie'), 'movie');
  assert.equal(n('tvshows'), 'episode');
  assert.equal(n('show'), 'episode');
  assert.equal(n('series'), 'episode');
  assert.equal(n('music'), 'audio');
  assert.equal(n('artist'), 'audio');
  assert.equal(n('musicvideos'), 'other');
  assert.equal(n('homevideos'), 'other');
  assert.equal(n(null), 'other');
});

test('UpdateChecker.isNewer', () => {
  const n = (a, b) => H.UpdateChecker.isNewer(a, b);
  assert.ok(n('1.10.0', '1.9.9'));
  assert.ok(!n('1.9.9', '1.10.0'));
  assert.ok(!n('1.3.0', '1.3.0'));
  assert.ok(!n('1.3', '1.3.0'));
  assert.ok(!n('1.3.0', '1.3'));
  assert.ok(n('1.3.1', '1.3'));
  assert.ok(n('2.0.0', '1.99.99'));
});

test('isDownloadableItem / isContainerItem', () => {
  const d = H.isDownloadableItem, c = H.isContainerItem;
  for (const it of [{ Type: 'Movie' }, { Type: 'Episode' }, { Type: 'Audio' }, { Type: 'Photo' },
    { Type: 'Whatever', MediaType: 'Video' }, { Type: 'Whatever', Container: 'MKV' }, { Type: 'X', Container: 'flac' }]) {
    assert.ok(d(it), JSON.stringify(it));
    assert.ok(!c(it), JSON.stringify(it));
  }
  assert.ok(!d({ Type: 'Movie', IsFolder: true }));
  for (const t of ['Series', 'Season', 'BoxSet', 'Folder']) {
    assert.ok(!d({ Type: t }));
    assert.ok(c({ Type: t }), t);
  }
  assert.ok(c({ Type: 'Mystery', IsFolder: true }));
  assert.ok(!c({ Type: 'Mystery' }));
  assert.ok(!d(null) && !c(null) && !d(undefined));
});

const names = ['sanitizeFilename', 'buildDownloadInfo', 'EXTRACT_SUBTITLES'];
const settings = {
  filenameTemplateEpisode: '{Series} - S{season}E{episode} - {Title}',
  filenameTemplateMovie: '{Title} ({Year})',
  libraryFolderShows: 'TV Shows', libraryFolderMovies: 'Movies', libraryFolderMusic: 'Music',
  movieFolderPerFilm: true, dlExternalSubtitles: false,
};
const info = (item, over = {}) => load(names, { settings: { ...settings, ...over } }).buildDownloadInfo(item);

test('buildDownloadInfo: episode', () => {
  const r = info({ Type: 'Episode', Name: 'Pilot', SeriesName: 'Show', ParentIndexNumber: 2, IndexNumber: 5, Container: 'mkv' });
  assert.equal(r.filename, 'Show - S02E05 - Pilot.mkv');
  assert.equal(r.folderPath, 'TV Shows/Show/Season 2');
  assert.equal(r.fullPath, 'TV Shows/Show/Season 2/Show - S02E05 - Pilot.mkv');
  assert.deepEqual([...r.subtitles], []);
});

test('buildDownloadInfo: season 0 stays 00', () => {
  const r = info({ Type: 'Episode', Name: 'Special', SeriesName: 'Show', ParentIndexNumber: 0, IndexNumber: 1, Container: 'mp4' });
  assert.equal(r.filename, 'Show - S00E01 - Special.mp4');
  assert.equal(r.folderPath, 'TV Shows/Show/Season 0');
});

test('buildDownloadInfo: movie with and without year', () => {
  const a = info({ Type: 'Movie', Name: 'Dune', ProductionYear: 2021, Container: 'mkv' });
  assert.equal(a.filename, 'Dune (2021).mkv');
  assert.equal(a.folderPath, 'Movies/Dune (2021)');
  const b = info({ Type: 'Movie', Name: 'Dune', Container: 'mkv' });
  assert.equal(b.filename, 'Dune.mkv', 'empty year must not leave "()"');
  assert.equal(b.folderPath, 'Movies/Dune');
});

test('buildDownloadInfo: movieFolderPerFilm false', () => {
  const r = info({ Type: 'Movie', Name: 'Dune', ProductionYear: 2021, Container: 'mkv' }, { movieFolderPerFilm: false });
  assert.equal(r.folderPath, 'Movies');
  assert.equal(r.fullPath, 'Movies/Dune (2021).mkv');
});

test('buildDownloadInfo: audio track with IndexNumber', () => {
  const r = info({ Type: 'Audio', Name: 'Song', AlbumArtist: 'Band', Album: 'LP', IndexNumber: 3, Container: 'flac' });
  assert.equal(r.filename, '03 - Song.flac');
  assert.equal(r.folderPath, 'Music/Band/LP');
});

test('buildDownloadInfo: slash and colon in title never create path segments', () => {
  const r = info({ Type: 'Movie', Name: 'Face/Off: Redux', ProductionYear: 1997, Container: 'mkv' });
  assert.equal(r.filename, 'Face_Off_ Redux (1997).mkv');
  assert.equal(r.folderPath, 'Movies/Face_Off_ Redux (1997)');
  assert.equal(r.fullPath.split('/').length, 3);
});
