// Static assets, plus comments under /api/ (wrangler.jsonc: run_worker_first ["/api/*"]).
//   POST /api/comments            a note from the Comment panel (public/comments.js)
//   GET  /api/comments?page=NAME  notes for one page, newest first, without their pictures
//   GET  /api/comments/ID.jpg     the picture sent with a note
//   GET  /api/me                  {email} of the signed-in person, or {email: null}
// Notes are read and answered from the repo with scripts/comments.py.
//
// The endpoint is public: no login, so it checks everything and keeps it small. A hidden
// honeypot field catches dumb bots; if real spam shows up, put Turnstile or Cloudflare Access
// in front of /api/*. Replies are public too: they show on the page.
import { PAGES, MAX_BODY, MAX_IMAGE, MAX_PINS, MAX_VIEW } from './rules.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const text = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const num = v => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

// A note's link must point back at this site (ALLOWED_ORIGINS, comma-separated) or at
// localhost for `wrangler dev`.
function linkOK(link, env) {
  try {
    const u = new URL(link);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(u.origin);
  } catch { return false; }
}

// Behind Cloudflare Access (AUTHOR_FROM_ACCESS = "1"), the author is the email Access signed
// in, not a typed name. Access sets this header on every request it lets through; trust it
// only when Access covers the whole hostname and workers.dev / preview URLs are off (or verify
// the Cf-Access-Jwt-Assertion token instead, as a stricter site should).
const signedIn = (request, env) =>
  env.AUTHOR_FROM_ACCESS === '1' ? text(request.headers.get('cf-access-authenticated-user-email'), 200) || null : null;

async function create(request, env) {
  if (Number(request.headers.get('content-length') || 0) > MAX_IMAGE + 200_000) return json({ error: 'too big' }, 413);
  let c;
  try { c = await request.json(); } catch { return json({ error: 'not JSON' }, 400); }
  if (!c || typeof c !== 'object') return json({ error: 'not JSON' }, 400);
  if (c.website) return json({ ok: true }); // honeypot: people never see this field
  if (!PAGES.has(c.page)) return json({ error: 'unknown page' }, 400);
  const body = text(c.body, MAX_BODY);
  const pins = (Array.isArray(c.pins) ? c.pins : []).slice(0, MAX_PINS).map((p, i) => ({
    n: i + 1, x: num(p?.x), y: num(p?.y), z: num(p?.z), id: text(p?.id, 200) || null, label: text(p?.label, 200) || null }));
  const strokes = Math.max(0, Math.min(500, Number(c.strokes) | 0));
  const image = typeof c.image === 'string' && c.image.startsWith('data:image/jpeg;base64,') && c.image.length <= MAX_IMAGE ? c.image : null;
  if (!body && !pins.length && !strokes) return json({ error: 'write a note, tap something, or draw' }, 400);
  const view = text(c.view, MAX_VIEW);
  if (!view) return json({ error: 'no view' }, 400);
  const viewport = /^\d{2,5}x\d{2,5}$/.test(c.viewport) ? c.viewport : null;
  const link = text(c.link, 500);
  if (!linkOK(link, env)) return json({ error: 'bad link' }, 400);
  const id = 'c_' + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 4);
  await env.DB.prepare(
    `INSERT INTO comments (id, created, page, author, body, link, view, viewport, pins, strokes, image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, new Date().toISOString(), c.page, signedIn(request, env) || text(c.author, 60) || null, body, link, view, viewport,
      JSON.stringify(pins), strokes, image)
    .run();
  return json({ ok: true, id }, 201);
}

async function list(url, env) {
  const page = url.searchParams.get('page');
  if (!PAGES.has(page)) return json({ error: 'unknown page' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT id, created, author, body, link, view, viewport, pins, strokes, image IS NOT NULL AS has_image,
            status, reply, replied
       FROM comments WHERE page = ? ORDER BY created DESC LIMIT 100`).bind(page).all();
  return json({ comments: results.map(r => ({ ...r, pins: JSON.parse(r.pins), has_image: !!r.has_image })) });
}

async function picture(id, env) {
  const row = await env.DB.prepare('SELECT image FROM comments WHERE id = ?').bind(id).first();
  if (!row?.image) return new Response('not found', { status: 404 });
  const bytes = Uint8Array.from(atob(row.image.split(',')[1]), ch => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/me' && request.method === 'GET') return json({ email: signedIn(request, env) });
    if (url.pathname === '/api/comments') {
      if (request.method === 'POST') return create(request, env);
      if (request.method === 'GET') return list(url, env);
      return json({ error: 'method' }, 405);
    }
    const m = url.pathname.match(/^\/api\/comments\/(c_[a-z0-9]+)\.jpg$/);
    if (m && request.method === 'GET') return picture(m[1], env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
