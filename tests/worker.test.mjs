// worker.js against a fake D1: what it accepts, what it refuses, what it stores.
//   node --test tests/worker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../example/worker.js';
import { PAGES, MAX_IMAGE } from '../example/rules.js';

function fakeDB(rows = []) {
  const db = { calls: [] };
  db.prepare = sql => ({
    bind: (...args) => {
      db.calls.push({ sql, args });
      return { run: async () => ({}), all: async () => ({ results: rows }), first: async () => rows[0] || null };
    },
  });
  return db;
}
const env = (db = fakeDB()) => ({ DB: db, ALLOWED_ORIGINS: 'https://notes.example.com', ASSETS: { fetch: () => new Response('asset') } });
const good = {
  page: 'desk', body: 'Make the desk walnut', link: 'https://notes.example.com/#cam=1,1,1,0,0,0',
  view: '1,1,1,0,0,0', viewport: '390x844', pins: [{ x: 0.1234567, y: 0.7, z: 0, id: 'desk', label: 'Desk' }],
  strokes: 1, image: 'data:image/jpeg;base64,/9j/AAAA', author: 'Sam',
};
const post = (body, e = env()) => worker.fetch(new Request('https://notes.example.com/api/comments', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), e);

test('the whitelist is the catalog', () => {
  assert.deepEqual([...PAGES].sort(), ['desk', 'landing']);
});

test('stores a good note, with pins numbered and rounded', async () => {
  const db = fakeDB(), r = await post(good, env(db));
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.match(id, /^c_[a-z0-9]+$/);
  const [{ sql, args }] = db.calls;
  assert.match(sql, /INSERT INTO comments/);
  assert.equal(args[2], 'desk');
  assert.equal(args[3], 'Sam');
  assert.deepEqual(JSON.parse(args[8]), [{ n: 1, x: 0.123, y: 0.7, z: 0, id: 'desk', label: 'Desk' }]);
  assert.equal(args[9], 1);
  assert.equal(args[10], good.image);
});

test('a 2D note: page pixels, a selector, no z', async () => {
  const db = fakeDB();
  const r = await post({ ...good, page: 'landing', view: '0,640', pins: [{ x: 120, y: 900, z: null, id: '[data-comment-id="hero"]' }] }, env(db));
  assert.equal(r.status, 201);
  assert.deepEqual(JSON.parse(db.calls[0].args[8]), [{ n: 1, x: 120, y: 900, z: null, id: '[data-comment-id="hero"]', label: null }]);
});

test('the honeypot answers ok and stores nothing', async () => {
  const db = fakeDB(), r = await post({ ...good, website: 'http://spam' }, env(db));
  assert.equal(r.status, 200);
  assert.equal(db.calls.length, 0);
});

test('refuses what it should', async () => {
  for (const [why, body] of [
    ['unknown page', { ...good, page: 'admin' }],
    ['empty note', { ...good, body: '  ', pins: [], strokes: 0 }],
    ['no view', { ...good, view: '' }],
    ['foreign link', { ...good, link: 'https://evil.example/' }],
    ['not a URL', { ...good, link: 'javascript:alert(1)' }],
    ['not JSON', '{nope'],
    ['null', 'null'],
  ]) {
    const db = fakeDB(), r = await post(body, env(db));
    assert.equal(r.status, 400, why);
    assert.equal(db.calls.length, 0, why);
  }
});

test('caps sizes: text trimmed, pins capped, oversized or non-JPEG image dropped', async () => {
  const db = fakeDB();
  const pins = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0, z: 0 }));
  await post({ ...good, body: 'x'.repeat(10_000), pins, image: 'data:image/png;base64,AAAA' }, env(db));
  const { args } = db.calls[0];
  assert.equal(args[4].length, 4000);
  assert.equal(JSON.parse(args[8]).length, 40);
  assert.equal(args[10], null);
  const db2 = fakeDB();
  await post({ ...good, image: 'data:image/jpeg;base64,' + 'A'.repeat(MAX_IMAGE) }, env(db2));
  assert.equal(db2.calls[0].args[10], null);
});

test('refuses a body over the size cap', async () => {
  const r = await worker.fetch(new Request('https://notes.example.com/api/comments', {
    method: 'POST', headers: { 'content-length': String(MAX_IMAGE + 300_000) }, body: '{}' }), env());
  assert.equal(r.status, 413);
});

test('lists a page without pictures, and serves a picture', async () => {
  const row = { id: 'c_1', pins: '[]', has_image: 1, status: 'done', reply: 'Walnut now.' };
  let r = await worker.fetch(new Request('https://notes.example.com/api/comments?page=desk'), env(fakeDB([row])));
  const { comments } = await r.json();
  assert.equal(comments[0].has_image, true);
  assert.deepEqual(comments[0].pins, []);
  r = await worker.fetch(new Request('https://notes.example.com/api/comments?page=nope'), env());
  assert.equal(r.status, 400);
  r = await worker.fetch(new Request('https://notes.example.com/api/comments/c_1.jpg'), env(fakeDB([{ image: 'data:image/jpeg;base64,/9j/' }])));
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xd8, 0xff]);
});

test('other paths go to the static assets', async () => {
  const r = await worker.fetch(new Request('https://notes.example.com/index.html'), env());
  assert.equal(await r.text(), 'asset');
});

test('behind Access, the author is the signed-in email, not the typed name', async () => {
  const db = fakeDB(), e = { ...env(db), AUTHOR_FROM_ACCESS: '1' };
  const r = await worker.fetch(new Request('https://notes.example.com/api/comments', {
    method: 'POST', body: JSON.stringify(good),
    headers: { 'content-type': 'application/json', 'cf-access-authenticated-user-email': 'sam@example.com' } }), e);
  assert.equal(r.status, 201);
  assert.equal(db.calls[0].args[3], 'sam@example.com');
});

test('/api/me says who is signed in, and nobody when Access authors are off', async () => {
  const req = () => new Request('https://notes.example.com/api/me', { headers: { 'cf-access-authenticated-user-email': 'sam@example.com' } });
  assert.deepEqual(await (await worker.fetch(req(), { ...env(), AUTHOR_FROM_ACCESS: '1' })).json(), { email: 'sam@example.com' });
  assert.deepEqual(await (await worker.fetch(req(), env())).json(), { email: null });
});
