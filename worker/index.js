// Worker cho "Nhạc của tôi": phục vụ app + API thư viện nhạc chung.
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

async function deleteSong(env, st, id, user) {
  const meta = (await env.INDEX.getWithMetadata('song:' + id)).metadata;
  if (!meta) return err(404, 'Không tìm thấy.');
  if (meta.by !== user.name && !user.owner) return err(403, 'Chỉ người tải lên hoặc chủ thư viện mới xóa được.');
  await env.INDEX.delete('song:' + id);
  await st.del('songs/' + id);
  if (meta.cs) await st.del('covers/' + id);
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
