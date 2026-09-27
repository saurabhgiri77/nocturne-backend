#!/usr/bin/env node
// Giphy adapter + GIF pool assertions. Plain node, zero dependencies, no
// network (fetch and search are faked), non-zero exit on failure:
//   npm run test:reactions
//
// The socket relay itself is covered in socket/__check.js.
const assert = require('node:assert/strict');
const { search, clean, safeUrl, MAX_WEBP_BYTES } = require('./giphy');
const { createGifPool } = require('./pool');
const { LABELS, isLabel, queryFor } = require('./catalog');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── fixtures ─────────────────────────────────────────────────────────────
const gifObj = (id, fw = {}) => ({
  id,
  title: 'untrusted <b>title</b>',
  images: {
    fixed_width: {
      webp: `https://media1.giphy.com/media/${id}/200w.webp`,
      webp_size: '120000',
      width: '200',
      height: '150',
      ...fw,
    },
    fixed_width_still: { url: `https://media1.giphy.com/media/${id}/200w_s.gif` },
  },
});

const fakeFetch = (respond) => {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    return respond(url);
  };
  f.calls = calls;
  return f;
};
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

const item = (id) => ({ id, url: `https://media1.giphy.com/media/${id}/200w.webp`, stillUrl: null, width: 200, height: 150 });

// A controllable fake search() for the pool: counts calls, resolves to
// whatever `next` holds at call time.
const fakeSearch = (next) => {
  const s = async (args) => {
    s.calls.push(args);
    const v = typeof s.next === 'function' ? s.next(args) : s.next;
    if (v instanceof Error) throw v;
    return v;
  };
  s.calls = [];
  s.next = next;
  return s;
};

const quiet = { warn: () => {} };
const clock = (start = 1_000_000) => {
  const c = () => c.t;
  c.t = start;
  return c;
};

// ── catalog ──────────────────────────────────────────────────────────────
test('catalog: every label has a query, and prototype keys are not labels', () => {
  for (const l of LABELS) assert.ok(queryFor(l), `no query for ${l}`);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'THUMBS_UP', 'thumbs_up ', 42, null, undefined, {}]) {
    assert.equal(isLabel(bad), false, `accepted ${String(bad)}`);
  }
});

// ── adapter ──────────────────────────────────────────────────────────────
test('giphy: request asks for G rating, the label query and the key', async () => {
  const f = fakeFetch(() => okJson({ data: [] }));
  await search({ query: 'thumbs up', apiKey: 'KEY123', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.giphy.com/v1/gifs/search');
  assert.equal(u.searchParams.get('rating'), 'g');
  assert.equal(u.searchParams.get('q'), 'thumbs up');
  assert.equal(u.searchParams.get('api_key'), 'KEY123');
  assert.ok(f.calls[0].opts.signal, 'request must carry a timeout signal');
});

test('giphy: a good object projects to the wire shape with numbers and no title', () => {
  const g = clean(gifObj('abc'));
  assert.deepEqual(g, {
    id: 'abc',
    url: 'https://media1.giphy.com/media/abc/200w.webp',
    stillUrl: 'https://media1.giphy.com/media/abc/200w_s.gif',
    width: 200,
    height: 150,
  });
  assert.ok(!JSON.stringify(g).includes('untrusted'));
});

test('giphy: unsafe or unusable renditions are dropped', () => {
  const bad = [
    gifObj('a', { webp: 'http://media1.giphy.com/x.webp' }),
    gifObj('b', { webp: 'javascript:alert(1)' }),
    gifObj('c', { webp: 'https://evil.example/x.webp' }),
    gifObj('d', { webp: 'https://giphy.com.evil.example/x.webp' }),
    gifObj('e', { webp: 'https://evil.example/?u=media.giphy.com' }),
    gifObj('f', { webp: undefined }),
    gifObj('g', { webp_size: String(MAX_WEBP_BYTES + 1) }),
    gifObj('h', { webp_size: undefined }),
    gifObj('i', { width: '0' }),
    { ...gifObj('j'), id: '' },
    { id: 'k' },
    null,
    'x',
  ];
  for (const b of bad) assert.equal(clean(b), null, `kept ${JSON.stringify(b)?.slice(0, 80)}`);
});

test('giphy: a bad still URL is nulled without dropping the GIF', () => {
  const o = gifObj('s');
  o.images.fixed_width_still.url = 'http://insecure.example/s.gif';
  assert.equal(clean(o).stillUrl, null);
  assert.equal(clean(o).id, 's');
});

test('giphy: safeUrl accepts the bare domain and subdomains only', () => {
  assert.ok(safeUrl('https://giphy.com/x'));
  assert.ok(safeUrl('https://i.giphy.com/x.webp'));
  assert.equal(safeUrl('https://notgiphy.com/x'), null);
  assert.equal(safeUrl('not a url'), null);
});

test('giphy: HTTP errors, bad JSON and malformed bodies throw without the URL', async () => {
  const cases = [
    () => ({ ok: false, status: 500, json: async () => ({}) }),
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }),
    () => okJson({ nope: true }),
    () => { throw new TypeError('fetch failed'); },
  ];
  for (const respond of cases) {
    await assert.rejects(
      search({ query: 'q', apiKey: 'SECRETKEY', fetchImpl: fakeFetch(respond) }),
      (err) => !err.message.includes('SECRETKEY'),
    );
  }
});

test('giphy: mixed results keep only the clean ones', async () => {
  const f = fakeFetch(() => okJson({ data: [gifObj('ok1'), gifObj('bad', { webp: 'http://x' }), gifObj('ok2')] }));
  const out = await search({ query: 'q', apiKey: 'k', fetchImpl: f });
  assert.deepEqual(out.map((g) => g.id), ['ok1', 'ok2']);
});

// ── pool ─────────────────────────────────────────────────────────────────
test('pool: no API key means no fetches and no GIFs', async () => {
  const s = fakeSearch([item('x')]);
  const pool = createGifPool({ search: s, apiKey: '', queryFor, log: quiet });
  assert.equal(pool.pick('wave'), null);
  await pool.settle();
  assert.equal(s.calls.length, 0);
});

test('pool: a cold pick returns null and fetches exactly once, even when concurrent', async () => {
  const s = fakeSearch([item('x1'), item('x2')]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet });
  assert.equal(pool.pick('wave'), null);
  assert.equal(pool.pick('wave'), null);
  assert.equal(pool.pick('wave'), null);
  await pool.settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].query, queryFor('wave'));
});

test('pool: after the refresh lands, picks come from the fetched items', async () => {
  const s = fakeSearch([item('x1'), item('x2')]);
  let r = 0;
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet, random: () => r });
  pool.pick('wave');
  await pool.settle();
  assert.equal(pool.pick('wave').id, 'x1');
  r = 0.99;
  assert.equal(pool.pick('wave').id, 'x2');
});

test('pool: labels are cached independently', async () => {
  const s = fakeSearch((args) => [item(args.query)]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet });
  pool.pick('wave');
  pool.pick('laugh');
  await pool.settle();
  assert.equal(pool.pick('wave').id, queryFor('wave'));
  assert.equal(pool.pick('laugh').id, queryFor('laugh'));
  assert.equal(s.calls.length, 2);
});

test('pool: no refetch inside the TTL; a stale entry is served while one refetch runs', async () => {
  const now = clock();
  const s = fakeSearch([item('old')]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet, now, ttlMs: 1000 });
  pool.pick('wave');
  await pool.settle();
  now.t += 999;
  assert.equal(pool.pick('wave').id, 'old');
  await pool.settle();
  assert.equal(s.calls.length, 1, 'refetched inside the TTL');

  now.t += 1;
  s.next = [item('new')];
  assert.equal(pool.pick('wave').id, 'old', 'stale entry should still be served');
  assert.equal(pool.pick('wave').id, 'old');
  await pool.settle();
  assert.equal(s.calls.length, 2, 'expected exactly one refetch');
  assert.equal(pool.pick('wave').id, 'new');
});

test('pool: a failed fetch never throws, and backs off before retrying', async () => {
  const now = clock();
  const s = fakeSearch(new Error('boom'));
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet, now, backoffMs: 5000 });
  assert.equal(pool.pick('wave'), null);
  await pool.settle();
  now.t += 4999;
  assert.equal(pool.pick('wave'), null);
  await pool.settle();
  assert.equal(s.calls.length, 1, 'retried inside the backoff window');
  now.t += 1;
  s.next = [item('ok')];
  pool.pick('wave');
  await pool.settle();
  assert.equal(s.calls.length, 2);
  assert.equal(pool.pick('wave').id, 'ok');
});

test('pool: a synchronous throw from search is contained', async () => {
  const s = () => { throw new Error('sync'); };
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet });
  assert.doesNotThrow(() => pool.pick('wave'));
  await pool.settle();
  assert.equal(pool.pick('wave'), null);
});

test('pool: a failed refresh keeps serving the stale items', async () => {
  const now = clock();
  const s = fakeSearch([item('keep')]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet, now, ttlMs: 10 });
  pool.pick('wave');
  await pool.settle();
  now.t += 10;
  s.next = new Error('down');
  pool.pick('wave');
  await pool.settle();
  assert.equal(pool.pick('wave').id, 'keep');
});

test('pool: blocklisted ids are never served; all-blocked counts as a failure', async () => {
  const s = fakeSearch([item('bad1'), item('good'), item('bad2')]);
  const pool = createGifPool({
    search: s, apiKey: 'k', queryFor, log: quiet, blocklist: new Set(['bad1', 'bad2']),
  });
  pool.pick('wave');
  await pool.settle();
  for (let i = 0; i < 20; i += 1) assert.equal(pool.pick('wave').id, 'good');

  const s2 = fakeSearch([item('bad1')]);
  const pool2 = createGifPool({ search: s2, apiKey: 'k', queryFor, log: quiet, blocklist: new Set(['bad1']) });
  pool2.pick('wave');
  await pool2.settle();
  assert.equal(pool2.pick('wave'), null);
});

test('pool: warm() fetches every label once, so first reactions get GIFs', async () => {
  const s = fakeSearch((args) => [item(args.query)]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet });
  pool.warm(LABELS);
  pool.warm(LABELS); // a second call while in flight must not double up
  await pool.settle();
  assert.equal(s.calls.length, LABELS.length);
  for (const l of LABELS) assert.equal(pool.pick(l).id, queryFor(l));
  assert.equal(s.calls.length, LABELS.length, 'picks after warm-up refetched');
});

test('pool: warm() without a key does nothing', async () => {
  const s = fakeSearch([item('x')]);
  const pool = createGifPool({ search: s, apiKey: '', queryFor, log: quiet });
  pool.warm(LABELS);
  await pool.settle();
  assert.equal(s.calls.length, 0);
});

test('pool: an unknown label never reaches search', async () => {
  const s = fakeSearch([item('x')]);
  const pool = createGifPool({ search: s, apiKey: 'k', queryFor, log: quiet });
  assert.equal(pool.pick('not_a_label'), null);
  await pool.settle();
  assert.equal(s.calls.length, 0);
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      console.error(`\n  ✗ ${name}\n    ${err.message}\n`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) console.error(`reactions: FAILED (${passed} passed)`);
  else console.log(`reactions: ${passed} checks passed`);
})();
