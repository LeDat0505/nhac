// Worker cho "Vinyl": phục vụ app + API thư viện nhạc chung.
//
//   • File nhạc & ảnh bìa: Backblaze B2 (bucket riêng tư, gọi qua API tương thích S3)
//   • Mục lục thư viện:     Cloudflare KV (mỗi bài một khóa "song:<id>", thông tin nằm ở metadata)
//   • Đăng nhập:            mã mời riêng cho từng người, lưu trong cookie HttpOnly
//
// Bí mật (đặt bằng `wrangler secret put`, KHÔNG ghi vào repo):
//   B2_KEY_ID, B2_APP_KEY   – Application Key của Backblaze (chỉ quyền trên bucket nhạc)
//   B2_ENDPOINT             – vd "s3.us-east-005.backblazeb2.com"
//   B2_BUCKET               – tên bucket
//   ACCESS_KEYS             – JSON {"<sha256 của mã mời>": {"name": "Đạt", "owner": true}, ...}
// Chỉ khi chạy thử: DEV_USER = '{"name":"...","owner":true}' bỏ qua đăng nhập.

import { AwsClient } from 'aws4fetch';

const MAX_SONG = 95 * 1024 * 1024;     // Workers gói miễn phí nhận tối đa 100 MB mỗi lần gửi
const MAX_COVER = 3 * 1024 * 1024;
const FREE_QUOTA = 10 * 1024 ** 3;     // 10 GB miễn phí của Backblaze B2
const ID_RE = /^[a-f0-9-]{36}$/;
const COOKIE = 'nhac_key';

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const err = (status, msg) => json({ error: msg }, status);

// ---------- Lưu trữ file: Backblaze B2 qua S3 API ----------
export function b2Store(env) {
  const region = (/^s3\.([^.]+)\./.exec(env.B2_ENDPOINT || '') || [])[1] || 'us-east-005';
  // keyID của B2 luôn là chuỗi hex bắt đầu bằng "00"; nếu lỡ nhập đảo hai khóa thì tự đổi lại
  let keyId = (env.B2_KEY_ID || '').trim(), appKey = (env.B2_APP_KEY || '').trim();
  const isKeyId = s => /^00[0-9a-f]{20,}$/i.test(s);
  if (!isKeyId(keyId) && isKeyId(appKey)) [keyId, appKey] = [appKey, keyId];
  const aws = new AwsClient({ accessKeyId: keyId, secretAccessKey: appKey, service: 's3', region });
  const url = key => `https://${env.B2_ENDPOINT}/${env.B2_BUCKET}/${key}`;
  return {
    // Trả nguyên Response của B2 (hỗ trợ Range / If-None-Match)
    get: (key, headers = {}) => aws.fetch(url(key), { headers }),
    async put(key, body, size, type) {
      let stream = body;
      if (typeof FixedLengthStream !== 'undefined' && body instanceof ReadableStream) {   // gửi thẳng, không nạp cả file vào bộ nhớ
        const { readable, writable } = new FixedLengthStream(size);
        body.pipeTo(writable);
        stream = readable;
      }
      const r = await aws.fetch(url(key), { method: 'PUT', body: stream, headers: { 'content-type': type, 'content-length': String(size) } });
      if (!r.ok) throw new Error(`B2 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
    async del(key) {
      const r = await aws.fetch(url(key), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`B2 DELETE ${r.status}`);
    },
  };
}

// ---------- Mục lục: Cloudflare KV ----------
// metadata của KV tối đa 1024 byte → rút gọn chuỗi cho vừa
const enc = new TextEncoder();
function fitMeta(m) {
  const keys = ['t', 'al', 'a', 'aa'];
  while (enc.encode(JSON.stringify(m)).length > 1000) {
    const k = keys.reduce((x, y) => ((m[y] || '').length > (m[x] || '').length ? y : x));
    if (!m[k]) break;
    m[k] = m[k].slice(0, Math.floor(m[k].length * 0.8));
  }
  return m;
}
const toItem = (id, m) => ({ id, size: m.s || 0, coverSize: m.cs || 0, title: m.t || 'Không tên', artist: m.a || 'Không rõ ca sĩ', album: m.al || '',
                             albumArtist: m.aa || '', track: m.tr || '', duration: m.d || 0, cover: !!m.cs, by: m.by || '', at: m.at || 0 });

async function listLibrary(env) {
  const items = []; let cursor;
  do {
    const page = await env.INDEX.list({ prefix: 'song:', cursor });
    for (const k of page.keys) items.push(toItem(k.name.slice(5), k.metadata || {}));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const totalBytes = items.reduce((s, i) => s + i.size + i.coverSize, 0);
  return { items, totalBytes, quotaBytes: FREE_QUOTA };
}

// ---------- Đăng nhập bằng mã mời ----------
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const readCookie = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === name)?.[1];

async function whoIs(key, env) {
  if (!key || key.length < 16 || key.length > 200) return null;
  let keys = {};
  try { keys = JSON.parse(env.ACCESS_KEYS || '{}'); } catch { return null; }
  const u = keys[await sha256(key)];
  return u && u.name ? { name: String(u.name), owner: !!u.owner } : null;
}
async function currentUser(req, env) {
  if (env.DEV_USER) return JSON.parse(env.DEV_USER);
  const key = readCookie(req, COOKIE);
  return key ? whoIs(decodeURIComponent(key), env) : null;
}
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function login(req, env) {
  let key = '';
  try { key = String((await req.json()).key || '').trim(); } catch { }
  const user = await whoIs(key, env);
  if (!user) { await new Promise(r => setTimeout(r, 800)); return err(401, 'Mã mời không đúng.'); }   // làm chậm đoán mò
  return json({ name: user.name, owner: user.owner }, 200, { 'set-cookie': cookie(encodeURIComponent(key), 400 * 86400) });
}

// ---------- Bài hát ----------
const clean = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

async function putSong(req, env, st, id, user) {
  const size = +req.headers.get('content-length') || 0;
  const type = req.headers.get('content-type') || '';
  if (!size || size > MAX_SONG) return err(413, 'File phải nhỏ hơn 95 MB.');
  if (!/^audio\//.test(type)) return err(415, 'Chỉ nhận file âm thanh.');
  if (await env.INDEX.get('song:' + id) !== null) return err(409, 'Bài này đã có.');
  let m = {};
  try { m = JSON.parse(decodeURIComponent(req.headers.get('x-meta') || '%7B%7D')); } catch { return err(400, 'Thông tin bài hát không hợp lệ.'); }
  const lib = await listLibrary(env);
  if (lib.totalBytes + size > FREE_QUOTA) return err(507, 'Thư viện chung đã hết 10 GB miễn phí.');
  await st.put('songs/' + id, req.body, size, type);
  const coverSize = Math.max(0, Math.min(+m.coverSize || 0, MAX_COVER));
  const meta = fitMeta({ t: clean(m.title), a: clean(m.artist), al: clean(m.album), aa: clean(m.albumArtist), tr: clean(m.track, 10),
                         d: Math.round(Math.max(0, Math.min(+m.duration || 0, 86400))), s: size, cs: m.cover ? coverSize || 1 : 0, by: clean(user.name, 40), at: Date.now() });
  await env.INDEX.put('song:' + id, '', { metadata: meta });
  return json({ ok: true, id, item: toItem(id, meta) });
}

async function putCover(req, env, st, id) {
  const size = +req.headers.get('content-length') || 0;
  const type = req.headers.get('content-type') || '';
  if (!size || size > MAX_COVER) return err(413, 'Ảnh bìa quá lớn.');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return err(415, 'Ảnh bìa không hợp lệ.');
  await st.put('covers/' + id, req.body, size, type);
  return json({ ok: true, size });
}

async function getFile(req, st, key) {
  const fwd = {};
  const range = req.headers.get('range');
  if (range && /^bytes=\d*-\d*$/.test(range)) fwd.range = range;
  const inm = req.headers.get('if-none-match');
  if (inm) fwd['if-none-match'] = inm;
  const r = await st.get(key, fwd);
  if (r.status === 404 || r.status === 403) return err(404, 'Không tìm thấy.');
  const headers = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) { const v = r.headers.get(h); if (v) headers.set(h, v); }
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=31536000, immutable');     // file không bao giờ đổi nội dung
  return new Response(r.status === 304 ? null : r.body, { status: r.status, headers });
}

// ---------- Lời bài hát (lưu chung trong KV "lyr:<id>") ----------
// Định dạng lưu: { lrc: "<chuỗi LRC hoặc lời thường>", synced: bool, src: "file"|"lrclib"|"user", at }
// hoặc { none: true, at } khi đã tìm mà không có (hết hạn sau 7 ngày để thử lại).
const LYRICS_MAX = 60 * 1024;
const LRCLIB = 'https://lrclib.net/api/';
const LRCLIB_UA = 'nhac-app/1.0 (ung dung nghe nhac ca nhan)';

async function lookupLrclib(m) {
  const q = p => fetch(LRCLIB + p, { headers: { 'user-agent': LRCLIB_UA } });
  const pick = r => r && !r.instrumental && (r.syncedLyrics || r.plainLyrics)
    ? { lrc: r.syncedLyrics || r.plainLyrics, synced: !!r.syncedLyrics, src: 'lrclib' } : null;
  const base = new URLSearchParams({ track_name: m.t || '', artist_name: m.a || '' });
  if (m.d) {
    const exact = new URLSearchParams(base); exact.set('duration', String(Math.round(m.d)));
    if (m.al) exact.set('album_name', m.al);
    const r = await q('get?' + exact);
    if (r.ok) { const hit = pick(await r.json()); if (hit) return hit; }
  }
  const r = await q('search?' + base);
  if (!r.ok) return null;
  const list = (await r.json()).filter(x => !x.instrumental && (x.syncedLyrics || x.plainLyrics));
  // ưu tiên bài có thời lượng gần nhất (lệch ≤ 5 giây), có lời chạy theo nhạc
  list.sort((x, y) => (Math.abs((x.duration || 0) - (m.d || 0)) - Math.abs((y.duration || 0) - (m.d || 0))) || (!!y.syncedLyrics - !!x.syncedLyrics));
  const best = list[0];
  if (!best || (m.d && Math.abs((best.duration || 0) - m.d) > 5)) return null;
  return pick(best);
}

async function getLyrics(env, id, cachedOnly) {
  const saved = await env.INDEX.get('lyr:' + id, 'json');
  if (saved) return json(saved);
  if (cachedOnly) return json({ none: true, notFetched: true });   // người dùng tắt "tự tìm lời"
  const meta = (await env.INDEX.getWithMetadata('song:' + id)).metadata;
  if (!meta) return err(404, 'Không tìm thấy.');
  let found = null;
  try { found = await lookupLrclib(meta); } catch { return err(502, 'Không kết nối được kho lời bài hát.'); }
  const data = found ? { ...found, at: Date.now() } : { none: true, at: Date.now() };
  await env.INDEX.put('lyr:' + id, JSON.stringify(data), found ? {} : { expirationTtl: 7 * 86400 });
  return json(data);
}

async function putLyrics(req, env, id, user) {
  const meta = (await env.INDEX.getWithMetadata('song:' + id)).metadata;
  if (!meta) return err(404, 'Không tìm thấy.');
  if (meta.by !== user.name && !user.owner) return err(403, 'Chỉ người tải lên hoặc chủ thư viện mới sửa được lời.');
  let body = {};
  try { body = await req.json(); } catch { return err(400, 'Dữ liệu không hợp lệ.'); }
  const lrc = String(body.lrc || '').replace(/\r\n?/g, '\n').trim();
  if (!lrc) { await env.INDEX.delete('lyr:' + id); return json({ ok: true, deleted: true }); }
  if (new TextEncoder().encode(lrc).length > LYRICS_MAX) return err(413, 'Lời bài hát quá dài.');
  const data = { lrc, synced: /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(lrc), src: body.src === 'file' ? 'file' : 'user', at: Date.now() };
  await env.INDEX.put('lyr:' + id, JSON.stringify(data));
  return json(data);
}

// ---------- Ảnh bìa tự tìm (iTunes Search) — lưu lên B2 một lần cho cả nhóm ----------
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b(feat|ft)\b.*$/, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const UNKNOWN_ARTIST = 'khong ro ca si';
// Chấm điểm một kết quả iTunes so với bài hát (title, artist, album, duration giây)
export function scoreArt(r, t) {
  const rt = normName(r.trackName), tt = normName(t.title), ra = normName(r.artistName), ta = normName(t.artist);
  const titleOk = rt && tt && (rt === tt ? 3 : (rt.includes(tt) || tt.includes(rt)) ? 2 : 0);
  if (!titleOk) return 0;
  const artistKnown = ta && ta !== UNKNOWN_ARTIST;
  const artistOk = artistKnown && (ra.includes(ta) || ta.includes(ra));
  const dur = r.trackTimeMillis ? Math.abs(r.trackTimeMillis / 1000 - (t.duration || 0)) : 99;
  const durOk = t.duration && dur <= 5;
  if (!artistOk && !durOk) return 0;                  // không chắc là đúng bài → bỏ
  if (artistKnown && !artistOk) return 0;             // biết ca sĩ mà không khớp → bỏ
  let s = titleOk + (artistOk ? 2 : 0) + (durOk ? 1 : 0) - (t.duration && dur > 20 ? 2 : 0);
  if (t.album && normName(r.collectionName) === normName(t.album)) s += 2;
  return s;
}
// Bỏ dấu câu trong từ khóa (vd. "Vũ." làm iTunes tìm lệch); thử "ca sĩ + tên bài" rồi tới "tên bài"
const cleanTerm = s => String(s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}\s'&]+/gu, ' ').replace(/\s+/g, ' ').trim();
const deaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const pickBest = (list, t) => list.map(x => ({ x, s: scoreArt(x, t) })).filter(o => o.s > 0).sort((a, b) => b.s - a.s)[0]?.x;
// Nguồn ảnh (đều gọi được từ máy chủ Cloudflare — Deezer thì KHÔNG, vì Deezer chặn bài hát theo khu vực):
//   1) iTunes kho Mỹ   2) iTunes kho Việt Nam, tìm KHÔNG DẤU (ra nhạc Việt tốt hơn)   3) MusicBrainz + Cover Art Archive
const MB_UA = 'nhac-app/1.0 (ung dung nghe nhac ca nhan)';
async function itunesSearch(term, country, fetchFn, limit = 15) {
  const p = new URLSearchParams({ term, entity: 'song', limit: String(limit) });
  if (country) p.set('country', country);
  const r = await fetchFn('https://itunes.apple.com/search?' + p);
  if (!r.ok) throw new Error('itunes ' + r.status);
  return (await r.json()).results || [];
}
const itunesArt = x => x?.artworkUrl100 ? x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
export async function findArtUrl(t, fetchFn = fetch) {
  const artist = normName(t.artist) === UNKNOWN_ARTIST ? '' : cleanTerm(t.artist), title = cleanTerm(t.title);
  if (!title) return null;
  const terms = [...new Set([[artist, title].filter(Boolean).join(' '), title])];
  const tries = [...terms.map(term => [term, '']), ...[...new Set(terms.map(deaccent))].map(term => [term, 'VN'])];
  for (const [term, country] of tries) {
    try { const best = pickBest(await itunesSearch(term, country, fetchFn), t); if (best) return itunesArt(best); }
    catch { break; }
  }
  // MusicBrainz: tìm bản thu → các bản phát hành → ảnh bìa trên Cover Art Archive
  try {
    const q = `recording:"${title.replace(/"/g, '')}"` + (artist ? ` AND artist:"${artist.replace(/"/g, '')}"` : '');
    const r = await fetchFn('https://musicbrainz.org/ws/2/recording?' + new URLSearchParams({ query: q, fmt: 'json', limit: '5' }), { headers: { 'user-agent': MB_UA } });
    if (!r.ok) return null;
    const recs = ((await r.json()).recordings || []).map(x => ({ trackName: x.title, artistName: (x['artist-credit'] || []).map(a => a.name).join(', '),
      trackTimeMillis: x.length || 0, collectionName: x.releases?.[0]?.title, releases: (x.releases || []).map(rel => rel.id) }));
    const best = pickBest(recs, t);
    for (const rel of (best?.releases || []).slice(0, 3)) {
      const c = await fetchFn(`https://coverartarchive.org/release/${rel}/front-500`, { method: 'HEAD', redirect: 'follow' });
      if (c.ok) return `https://coverartarchive.org/release/${rel}/front-500`;
    }
  } catch { }
  return null;
}

// App (trên máy người dùng) tự tìm ảnh — iTunes/MusicBrainz chặn bớt khi gọi từ IP dùng chung của Cloudflare —
// rồi gửi link ảnh lên đây; máy chủ tải ảnh về và lưu lên B2 một lần cho cả nhóm.
const ART_HOSTS = /^(is\d+-ssl\.mzstatic\.com|coverartarchive\.org|([a-z0-9-]+\.)*archive\.org|[a-z0-9-]+\.dzcdn\.net)$/;
async function saveArt(req, env, st, id) {
  const { metadata: meta } = await env.INDEX.getWithMetadata('song:' + id);
  if (!meta) return err(404, 'Không tìm thấy.');
  if (meta.cs) return json({ cover: true });
  let src = '';
  try { src = String((await req.json()).url || ''); } catch { }
  let u;
  try { u = new URL(src); } catch { return json({ none: true }); }
  if (u.protocol !== 'https:' || !ART_HOSTS.test(u.hostname)) return err(400, 'Nguồn ảnh không được phép.');
  const img = await fetch(u.href, { redirect: 'follow' });
  const finalHost = new URL(img.url || u.href).hostname;
  if (!ART_HOSTS.test(finalHost)) return err(400, 'Nguồn ảnh không được phép.');
  const type = (img.headers.get('content-type') || '').split(';')[0];
  const buf = img.ok && /^image\/(jpeg|png|webp)$/.test(type) ? await img.arrayBuffer() : null;
  if (!buf || !buf.byteLength || buf.byteLength > MAX_COVER) return err(422, 'Không tải được ảnh bìa.');
  await st.put('covers/' + id, buf, buf.byteLength, type);
  await env.INDEX.put('song:' + id, '', { metadata: { ...meta, cs: buf.byteLength, art: u.hostname.includes('mzstatic') ? 'itunes' : 'coverart' } });
  return json({ cover: true, coverSize: buf.byteLength });
}

// ---------- Khám phá bài mới: ca sĩ tương tự (Deezer) + bài nổi bật và nghe thử 30 giây (iTunes) ----------
// Deezer không cho trình duyệt gọi trực tiếp (không có CORS) nên đi qua đây.
// Từ Cloudflare, Deezer chỉ trả được phần ca sĩ (tìm ca sĩ, ca sĩ tương tự); bài hát lấy từ iTunes.
async function deezer(path) {
  const r = await fetch('https://api.deezer.com/' + path);
  if (!r.ok) throw new Error('deezer ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('deezer ' + (j.error.message || j.error.type || 'error'));
  return j;
}
async function discover(req, env) {
  let body = {};
  try { body = await req.json(); } catch { return err(400, 'Dữ liệu không hợp lệ.'); }
  const seeds = [...new Set((body.artists || []).map(a => clean(a, 80)).filter(a => a && normName(a) !== UNKNOWN_ARTIST))].slice(0, 4);
  if (!seeds.length) return json({ artists: [], at: Date.now() });
  const key = 'disc3:' + (await sha256(seeds.map(normName).sort().join('|'))).slice(0, 32);
  if (!body.refresh) { const saved = await env.INDEX.get(key, 'json'); if (saved) return json(saved); }
  let found;
  try {
    // 1) tìm đúng ca sĩ trên Deezer
    found = (await Promise.all(seeds.map(async name => {
      const x = (await deezer('search/artist?limit=3&q=' + encodeURIComponent(name))).data?.find(a => {
        const n1 = normName(a.name), n2 = normName(name); return n1 === n2 || n1.includes(n2) || n2.includes(n1);
      });
      return x ? { id: x.id, name } : null;
    }))).filter(Boolean);
  } catch { return err(502, 'Không kết nối được Deezer.'); }
  // 2) ca sĩ tương tự của từng ca sĩ bạn hay nghe
  const pool = found.map(s => ({ id: s.id, name: s.name, because: s.name, own: true }));
  for (const s of found) {
    try { for (const r of ((await deezer(`artist/${s.id}/related?limit=6`)).data || []).slice(0, 5)) pool.push({ id: r.id, name: r.name, because: s.name }); } catch { }
  }
  const seen = new Set();
  // Chỉ trả danh sách ca sĩ; app tự lấy bài + nghe thử 30 giây từ iTunes (iTunes giới hạn IP dùng chung của Cloudflare)
  const artists = pool.filter(p => !seen.has(p.id) && seen.add(p.id)).slice(0, 14).map(p => ({ name: p.name, because: p.because, own: !!p.own }));
  const data = { artists, at: Date.now() };
  if (artists.length) await env.INDEX.put(key, JSON.stringify(data), { expirationTtl: 24 * 3600 });
  return json(data);
}

async function deleteSong(env, st, id, user) {
  const meta = (await env.INDEX.getWithMetadata('song:' + id)).metadata;
  if (!meta) return err(404, 'Không tìm thấy.');
  if (meta.by !== user.name && !user.owner) return err(403, 'Chỉ người tải lên hoặc chủ thư viện mới xóa được.');
  await env.INDEX.delete('song:' + id);
  await env.INDEX.delete('lyr:' + id);
  await env.INDEX.delete('art:' + id);
  await env.INDEX.delete('art2:' + id);
  await st.del('songs/' + id);
  if (meta.cs) await st.del('covers/' + id);
  return json({ ok: true });
}

// ---------- Playlist chung: mỗi playlist một khóa "pl:<id>" = {name, by, items:[id bài], at} ----------
const MAX_PL_ITEMS = 2000;
async function listPlaylists(env) {
  const keys = [];
  let cursor;
  do { const r = await env.INDEX.list({ prefix: 'pl:', cursor }); keys.push(...r.keys); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  const items = (await Promise.all(keys.map(k => env.INDEX.get(k.name, 'json'))))
    .map((p, i) => p && { id: keys[i].name.slice(3), ...p }).filter(Boolean);
  return json({ items });
}
async function putPlaylist(req, env, id, user) {
  let b; try { b = await req.json(); } catch { return err(400, 'Dữ liệu không hợp lệ.'); }
  const name = String(b?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return err(400, 'Playlist cần có tên.');
  if (!Array.isArray(b.items) || b.items.length > MAX_PL_ITEMS || !b.items.every(x => typeof x === 'string' && ID_RE.test(x)))
    return err(400, 'Danh sách bài không hợp lệ.');
  const old = await env.INDEX.get('pl:' + id, 'json');
  const pl = { name, by: old?.by || user.name, items: [...new Set(b.items)], at: Date.now(), editedBy: user.name };
  await env.INDEX.put('pl:' + id, JSON.stringify(pl));
  return json({ item: { id, ...pl } });
}
async function deletePlaylist(env, id, user) {
  const old = await env.INDEX.get('pl:' + id, 'json');
  if (!old) return json({ ok: true });
  if (old.by !== user.name && !user.owner) return err(403, 'Chỉ người tạo hoặc chủ thư viện mới xóa được playlist này.');
  await env.INDEX.delete('pl:' + id);
  return json({ ok: true });
}

async function api(req, env, url) {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/');
  const [res, id] = parts;
  const method = req.method;
  if (res === 'login' && method === 'POST') return login(req, env);
  if (res === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  if (res === 'health' && method === 'GET') {
    // Chỉ báo kho lưu trữ có kết nối được không (không lộ dữ liệu). File này không tồn tại → 404 nghĩa là khóa B2 đúng.
    let storage = 'chưa cấu hình';
    if (env.TEST_STORE || (env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET && env.B2_ENDPOINT)) {
      try { const r = await (env.TEST_STORE || b2Store(env)).get('health/ping'); storage = r.ok || r.status === 404 ? 'ok' : 'lỗi ' + r.status; }
      catch { storage = 'lỗi kết nối'; }
    }
    let keys = 0; try { keys = Object.keys(JSON.parse(env.ACCESS_KEYS || '{}')).length; } catch { }
    return json({ storage, index: !!env.INDEX, inviteCodes: keys });
  }

  const user = await currentUser(req, env);
  if (!user) return err(401, 'Chưa đăng nhập.');
  const st = env.TEST_STORE || b2Store(env);
  if (res === 'me' && method === 'GET') return json(user);
  if (res === 'library' && method === 'GET') return json(await listLibrary(env));
  if (res === 'discover' && method === 'POST') return discover(req, env);
  if (res === 'playlists' && !id && method === 'GET') return listPlaylists(env);
  if (res === 'playlists' && id && ID_RE.test(id) && parts.length === 2) {
    if (method === 'PUT') return putPlaylist(req, env, id, user);
    if (method === 'DELETE') return deletePlaylist(env, id, user);
    return err(405, 'Không hỗ trợ.');
  }
  if (res === 'preview') return err(410, 'Hãy tải lại app để dùng bản mới.');   // bản cũ dùng link Deezer (đã bỏ)
  if (res === 'art' && id && ID_RE.test(id) && parts.length === 2 && method === 'POST')
    return saveArt(req, env, st, id);
  if (res === 'lyrics' && id && ID_RE.test(id) && parts.length === 2) {
    if (method === 'GET') return getLyrics(env, id, url.searchParams.get('cached') === '1');
    if (method === 'PUT') return putLyrics(req, env, id, user);
    return err(405, 'Không hỗ trợ.');
  }
  if ((res === 'songs' || res === 'covers') && id && ID_RE.test(id) && parts.length === 2) {
    const key = res + '/' + id;
    if (method === 'GET' || method === 'HEAD') return getFile(req, st, key);
    if (res === 'songs' && method === 'PUT') return putSong(req, env, st, id, user);
    if (res === 'songs' && method === 'DELETE') return deleteSong(env, st, id, user);
    if (res === 'covers' && method === 'PUT') return putCover(req, env, st, id);
    return err(405, 'Không hỗ trợ.');
  }
  return err(404, 'Không có API này.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      // Chặn gửi yêu cầu ghi từ trang web khác (ngoài cookie SameSite=Strict)
      const origin = req.headers.get('origin');
      if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== url.origin) return err(403, 'Sai nguồn gửi.');
      try { return await api(req, env, url); }
      catch (e) { console.error(e); return err(500, 'Lỗi máy chủ.'); }
    }
    return env.ASSETS.fetch(req);
  },
};
