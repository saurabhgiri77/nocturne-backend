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

// Forgot-password: 5 / hour / IP. Tighter than register because the route
// triggers an email and we don't want a single client spamming inboxes or
// using us to enumerate registered emails.
const forgotPasswordLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { message: 'Too many password-reset requests — try again later.' },
});

// Reset-password: 10 / hour / IP. Tighter cap on token submission so a
// brute-forcer can't blast our 64-hex-char token space (still astronomical,
// but defense in depth).
const resetPasswordLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { message: 'Too many reset attempts — wait a bit and try again.' },
});

module.exports = {
  loginLimiter,
  registerLimiter,
  googleLimiter,
  reportLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
};
