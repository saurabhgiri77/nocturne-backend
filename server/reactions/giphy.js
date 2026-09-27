// Giphy search adapter — the ONLY file that knows Giphy's URL and response
// shape. Swapping provider (Tenor's public API shut down on 2026-06-30; Klipy
// is the other candidate) means replacing this file and nothing else.
//
// The request URL carries the API key, so errors are rethrown with our own
// message and callers only ever log err.message — never the URL.

const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const TIMEOUT_MS = 5000;

// The GIF lands mid-call on both peers' connections, competing with WebRTC.
// Giphy's fixed_width webp is usually 50-300KB; anything bigger is dropped.
const MAX_WEBP_BYTES = 800 * 1024;

// Only https URLs on giphy.com or a subdomain of it. Checked on the parsed
// hostname, so 'giphy.com.evil.example' and 'evil.example/?giphy.com' fail.
const safeUrl = (raw) => {
  if (typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== 'giphy.com' && !u.hostname.endsWith('.giphy.com')) return null;
  return u.href;
};

// Giphy sends every dimension and size as a string ("200").
const positiveInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Project one Giphy GIF object to our wire shape, or null if unusable.
// Everything else — title, username, source URL — is untrusted text we have
// no reason to relay, so it is dropped here.
const clean = (gif) => {
  const id = typeof gif?.id === 'string' && gif.id ? gif.id : null;
  const fw = gif?.images?.fixed_width;
  const url = safeUrl(fw?.webp);
  if (!id || !url) return null;
  const bytes = positiveInt(fw.webp_size);
  if (!bytes || bytes > MAX_WEBP_BYTES) return null;
  const width = positiveInt(fw.width);
  const height = positiveInt(fw.height);
  if (!width || !height) return null;
  return { id, url, stillUrl: safeUrl(gif.images.fixed_width_still?.url), width, height };
};

const search = async ({ query, apiKey, fetchImpl = globalThis.fetch, limit = 25 }) => {
  const params = new URLSearchParams({
    api_key: apiKey,
    q: query,
    limit: String(limit),
    rating: 'g',
    lang: 'en',
  });
  let res;
  try {
    res = await fetchImpl(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`giphy request failed (${err.name})`);
  }
  if (!res.ok) throw new Error(`giphy search failed: HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new Error('giphy search failed: invalid JSON'); }
  if (!Array.isArray(body?.data)) throw new Error('giphy search failed: malformed response');
  return body.data.map(clean).filter(Boolean);
};

module.exports = { search, clean, safeUrl, MAX_WEBP_BYTES };
