// Per-label GIF cache, so Giphy traffic scales with the number of labels
// rather than the number of reactions. A beta key allows 100 calls/hour; at a
// 6h TTL, eight labels cost roughly eight calls every six hours.
//
// pick() is SYNCHRONOUS and never waits on the network. A reaction is a
// moment, and a GIF that arrives two seconds late is worse than the emoji the
// client shows for `gif: null`. A miss or a stale entry kicks a background
// refresh for next time, and a stale entry keeps being served meanwhile.
//
// NO TIMERS (same rule as socket/games.js): refresh happens on access, so
// nothing keeps the test process alive.

const HOUR = 60 * 60 * 1000;

const createGifPool = ({
  search,
  apiKey,
  queryFor,
  ttlMs = 6 * HOUR,
  backoffMs = 5 * 60 * 1000,
  now = Date.now,
  random = Math.random,
  blocklist = new Set(),
  log = console,
}) => {
  // label → { items, fetchedAt, inflight, retryAt }
  const entries = new Map();

  const refresh = (label, entry) => {
    const query = queryFor(label);
    if (!query) return;
    // Promise.resolve().then() so a synchronous throw inside search() lands
    // in the same catch as a rejected fetch.
    entry.inflight = Promise.resolve()
      .then(() => search({ query, apiKey }))
      .then((items) => {
        const kept = items.filter((g) => !blocklist.has(g.id));
        if (kept.length === 0) throw new Error('no usable results');
        entry.items = kept;
        entry.fetchedAt = now();
        entry.retryAt = 0;
      })
      .catch((err) => {
        entry.retryAt = now() + backoffMs;
        log.warn(`[reactions] refresh "${label}" failed, retrying in ${Math.round(backoffMs / 1000)}s: ${err.message}`);
      })
      .finally(() => { entry.inflight = null; });
  };

  const pick = (label) => {
    if (!apiKey) return null;
    let entry = entries.get(label);
    if (!entry) {
      entry = { items: [], fetchedAt: 0, inflight: null, retryAt: 0 };
      entries.set(label, entry);
    }
    const t = now();
    const stale = entry.items.length === 0 || t - entry.fetchedAt >= ttlMs;
    if (stale && !entry.inflight && t >= entry.retryAt) refresh(label, entry);
    if (entry.items.length === 0) return null;
    return entry.items[Math.floor(random() * entry.items.length)];
  };

  // Fill every label up front (called once at boot), so the first reactions
  // after a deploy or a Render restart get GIFs rather than the emoji. Same
  // single-flight and backoff rules as a cold pick().
  const warm = (labels) => {
    for (const label of labels) pick(label);
  };

  // Test hook: resolves once every in-flight refresh has landed.
  const settle = () => Promise.all([...entries.values()].map((e) => e.inflight).filter(Boolean));

  return { pick, warm, settle };
};

module.exports = { createGifPool };
