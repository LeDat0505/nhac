// Worker cho "Nhạc của tôi": phục vụ app + API thư viện nhạc chung lưu trên Cloudflare R2.
//
// Đăng nhập do Cloudflare Access lo (chỉ email được mời mới qua được). Worker vẫn tự kiểm tra
// chữ ký JWT của Access, nên nếu Access chưa bật/cấu hình sai thì API từ chối tất cả (an toàn).
//
// Biến môi trường (đặt bằng `wrangler secret put`, KHÔNG ghi vào repo):
//   TEAM_DOMAIN  – vd "ten-nhom.cloudflareaccess.com"
//   ACCESS_AUD   – mã "Application Audience (AUD) Tag" của ứng dụng Access
//   OWNER_EMAIL  – email chủ thư viện (được xóa mọi bài)
//   DEV_EMAIL    – CHỈ dùng khi chạy thử trên máy (file .dev.vars), bỏ qua kiểm tra Access

const MAX_SONG = 100 * 1024 * 1024;   // giới hạn mỗi lần tải lên của Workers gói miễn phí
const MAX_COVER = 3 * 1024 * 1024;
const FREE_QUOTA = 10 * 1024 ** 3;    // 10 GB miễn phí của R2
const ID_RE = /^[a-f0-9-]{36}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (status, msg) => json({ error: msg }, status);

// ---------- Kiểm tra đăng nhập (JWT của Cloudflare Access) ----------
let jwks = null;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const parse = s => JSON.parse(new TextDecoder().decode(b64u(s)));

async function accessKeys(env, force) {
  if (!force && jwks && jwks.exp > Date.now()) return jwks.keys;
  const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('certs ' + r.status);
  jwks = { keys: (await r.json()).keys, exp: Date.now() + 3600e3 };
  return jwks.keys;
}

async function userEmail(req, env) {
  if (env.DEV_EMAIL) return env.DEV_EMAIL.toLowerCase();
  if (!env.TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!s) return null;
  try {
    const header = parse(h), payload = parse(p);
    let jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env, true)).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p));
    const aud = [].concat(payload.aud);
    if (!ok || !aud.includes(env.ACCESS_AUD) || payload.iss !== `https://${env.TEAM_DOMAIN}` || payload.exp * 1000 < Date.now()) return null;
    return (payload.email || '').toLowerCase() || null;
  } catch { return null; }
}

// ---------- Thư viện ----------
const songKey = id => `songs/${id}`;
const coverKey = id => `covers/${id}`;
const readMeta = obj => { try { return JSON.parse(obj.customMetadata?.m || '{}'); } catch { return {}; } };

async function listLibrary(env) {
  const items = []; let cursor, total = 0;
  do {
    const page = await env.MUSIC.list({ prefix: 'songs/', cursor, include: ['customMetadata'] });
    for (const o of page.objects) {
      const m = readMeta(o);
      total += o.size;
      items.push({ id: o.key.slice(6), size: o.size, title: m.title || 'Không tên', artist: m.artist || 'Không rõ ca sĩ', album: m.album || '',
                   albumArtist: m.albumArtist || '', track: m.track || '', duration: m.duration || 0, cover: !!m.cover, by: m.by || '', at: m.at || 0 });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // tính cả ảnh bìa vào dung lượng đã dùng
  cursor = undefined;
  do {
    const page = await env.MUSIC.list({ prefix: 'covers/', cursor });
    for (const o of page.objects) total += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { items, totalBytes: total, quotaBytes: FREE_QUOTA };
}

const clean = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

async function putSong(req, env, id, email) {
  const size = +req.headers.get('content-length') || 0;
  const type = req.headers.get('content-type') || '';
  if (!size || size > MAX_SONG) return err(413, 'File phải nhỏ hơn 100 MB.');
  if (!/^audio\//.test(type)) return err(415, 'Chỉ nhận file âm thanh.');
  if (await env.MUSIC.head(songKey(id))) return err(409, 'Bài này đã có.');
  let m = {};
  try { m = JSON.parse(decodeURIComponent(req.headers.get('x-meta') || '%7B%7D')); } catch { return err(400, 'Thông tin bài hát không hợp lệ.'); }
  const meta = { title: clean(m.title), artist: clean(m.artist), album: clean(m.album), albumArtist: clean(m.albumArtist), track: clean(m.track, 10),
                 duration: Math.max(0, Math.min(+m.duration || 0, 86400)), cover: !!m.cover, by: email, at: Date.now() };
  await env.MUSIC.put(songKey(id), req.body, { httpMetadata: { contentType: type }, customMetadata: { m: JSON.stringify(meta) } });
  return json({ ok: true, id });
}

async function putCover(req, env, id) {
  const size = +req.headers.get('content-length') || 0;
  const type = req.headers.get('content-type') || '';
  if (!size || size > MAX_COVER) return err(413, 'Ảnh bìa quá lớn.');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return err(415, 'Ảnh bìa không hợp lệ.');
  await env.MUSIC.put(coverKey(id), req.body, { httpMetadata: { contentType: type } });
  return json({ ok: true });
}

function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m) return null;
  let start, end;
  if (m[1] === '') { const n = +m[2]; if (!n) return 'bad'; start = Math.max(size - n, 0); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  return start > end || start >= size ? 'bad' : { start, end };
}

async function getFile(req, env, key) {
  const head = await env.MUSIC.head(key);
  if (!head) return err(404, 'Không tìm thấy.');
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set('etag', head.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=31536000, immutable');   // file không bao giờ đổi nội dung
  if (req.headers.get('if-none-match') === head.httpEtag) return new Response(null, { status: 304, headers });
  const range = parseRange(req.headers.get('range'), head.size);
  if (range === 'bad') { headers.set('content-range', `bytes */${head.size}`); return new Response(null, { status: 416, headers }); }
  if (range) {
    const obj = await env.MUSIC.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
    headers.set('content-range', `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set('content-length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await env.MUSIC.get(key);
  headers.set('content-length', String(head.size));
  return new Response(obj.body, { headers });
}

async function deleteSong(env, id, email) {
  const head = await env.MUSIC.head(songKey(id));
  if (!head) return err(404, 'Không tìm thấy.');
  const owner = (env.OWNER_EMAIL || '').toLowerCase();
  if (readMeta(head).by !== email && email !== owner) return err(403, 'Chỉ người tải lên hoặc chủ thư viện mới xóa được.');
  await env.MUSIC.delete([songKey(id), coverKey(id)]);
  return json({ ok: true });
}

async function api(req, env, url) {
  const email = await userEmail(req, env);
  if (!email) return err(401, 'Chưa đăng nhập.');
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/');
  const [res, id] = parts;
  const method = req.method;
  if (res === 'me' && method === 'GET') return json({ email, owner: email === (env.OWNER_EMAIL || '').toLowerCase() });
  if (res === 'library' && method === 'GET') return json(await listLibrary(env));
  if ((res === 'songs' || res === 'covers') && id && ID_RE.test(id) && parts.length === 2) {
    if (res === 'songs') {
      if (method === 'GET' || method === 'HEAD') return getFile(req, env, songKey(id));
      if (method === 'PUT') return putSong(req, env, id, email);
      if (method === 'DELETE') return deleteSong(env, id, email);
    } else {
      if (method === 'GET' || method === 'HEAD') return getFile(req, env, coverKey(id));
      if (method === 'PUT') return putCover(req, env, id);
    }
    return err(405, 'Không hỗ trợ.');
  }
  return err(404, 'Không có API này.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { console.error(e); return err(500, 'Lỗi máy chủ.'); }
    }
    return env.ASSETS.fetch(req);
  },
};
