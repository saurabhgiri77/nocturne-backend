// In-memory JWT blocklist. When a user logs out we add their token's
// fingerprint here; verifyToken middleware refuses any token that matches.
//
// Caveats:
//  - Lost on backend restart (a logged-out token would become valid again
//    until its natural 7d expiry). Acceptable for current single-instance
//    deployment; swap for Redis if you go multi-instance or care about
//    survivability.
//  - Stores only a SHA-256 prefix of the token (16 bytes / 32 hex chars)
//    rather than the full JWT — collision-resistant enough for blocklist
//    purposes, ~half the memory.
//
// Self-cleaning: each entry stores its expiry; we sweep expired entries
// every 10 minutes so the Map doesn't grow forever.

const crypto = require('crypto');

const blocklist = new Map(); // hashHex → expiryMs

const fingerprint = (token) =>
  crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);

const block = (token, expiresAtMs) => {
  if (!token) return;
  blocklist.set(fingerprint(token), expiresAtMs);
};

const isBlocked = (token) => {
  if (!token) return false;
  const fp = fingerprint(token);
  const expiry = blocklist.get(fp);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    blocklist.delete(fp);
    return false;
  }
  return true;
};

// Periodic sweep. setInterval keeps the process alive in tests, so we
// .unref() it — Node's event loop ignores the timer when nothing else
// is pending.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweep = () => {
  const now = Date.now();
  for (const [fp, expiry] of blocklist) {
    if (expiry < now) blocklist.delete(fp);
  }
};
const interval = setInterval(sweep, SWEEP_INTERVAL_MS);
interval.unref?.();

module.exports = { block, isBlocked };
