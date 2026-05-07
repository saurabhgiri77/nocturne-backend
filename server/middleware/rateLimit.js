const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Sensible defaults shared across limiters. Express trust-proxy is set in
// server/index.js so the IP key reflects the real client.
const baseConfig = {
  standardHeaders: true,   // RateLimit-* headers
  legacyHeaders: false,    // suppress deprecated X-RateLimit-*
  message: { message: 'Too many requests — slow down.' },
};

// Login: 8 / minute / IP. Tighter than register because the password gate
// is the obvious brute-force surface.
const loginLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 8,
  message: { message: 'Too many login attempts — wait a minute and try again.' },
});

// Register: 5 / hour / IP. Throttles signup-bot rings + helps Gmail's daily
// cap stay sane (we send a verification email per signup).
const registerLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { message: 'Too many signups from this network — try again later.' },
});

// Google OAuth: 15 / minute / IP. Looser than /login because users sometimes
// retry the popup; not a brute-force surface (Google does the gating).
const googleLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 1000,
  max: 15,
});

// Reports: 10 / hour / user. We key by user (req.user.id) since the route
// is auth-required. Keys-per-user means a single user can't ddos the
// suspension threshold from one IP.
const reportLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 10,
  // Use ipKeyGenerator for the fallback so IPv6 users can't bypass by
  // varying the low bits of their address.
  keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
  message: { message: 'Too many reports filed — wait a bit before more.' },
});

module.exports = {
  loginLimiter,
  registerLimiter,
  googleLimiter,
  reportLimiter,
};
