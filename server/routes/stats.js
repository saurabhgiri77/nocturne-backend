const router = require('express').Router();
const { totalOnline } = require('../socket');
const { statsLimiter } = require('../middleware/rateLimit');

// Public, unauthenticated stats for the landing page.
//
// This exists because the socket requires a JWT, so an anonymous visitor has
// no way to learn whether anyone is here — and "is anyone here right now" is
// the single question a random-video-chat landing page has to answer. It was
// previously answered with a hardcoded number in the frontend.
//
// Exposes exactly one integer. Nothing here is user-identifying.
router.get('/online', statsLimiter, (_req, res) => {
  // 10s of shared caching absorbs a burst of landing-page loads without
  // making the number feel stale — visitors arrive over minutes, not ms.
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ online: totalOnline() });
});

module.exports = router;
