const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isBlocked } = require('../lib/tokenBlocklist');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ message: 'No token provided' });
  const token = header.split(' ')[1];
  if (isBlocked(token)) {
    return res.status(401).json({ message: 'Token revoked' });
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }

  // Guest tokens skip the User-record checks entirely (there is no User
  // row to query). They expire on their own short clock; route-level
  // requireRegistered handles the "guests can't do X" gating.
  if (!payload.guest) {
    // Per-user invalidation checks:
    //   • passwordChangedAt: tokens issued before the last password
    //     change are rejected, so /reset signs every session out.
    //   • activeSessionId: single-device policy — a token whose `sid`
    //     doesn't match the User's current activeSessionId is stale
    //     (user signed in on another device). Legacy tokens with no sid
    //     are allowed when the User has never had a fresh login (no
    //     activeSessionId stored yet), so this rollout doesn't force an
    //     immediate mass sign-out.
    try {
      const user = await User.findById(payload.id)
        .select('passwordChangedAt activeSessionId')
        .lean();
      if (user?.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
        return res.status(401).json({ message: 'Session expired — please sign in again' });
      }
      if (user?.activeSessionId && payload.sid !== user.activeSessionId) {
        return res.status(401).json({
          message: 'Signed in on another device',
          reason: 'session_replaced',
        });
      }
    } catch (err) {
      // DB lookup failed — don't kick the user out over a transient error.
      // Worst case: a recently-revoked session lingers until DB recovers.
      console.warn('[verifyToken] user lookup failed:', err.message);
    }
  }

  req.user = payload;
  req.token = token; // exposed so /logout can blocklist it
  next();
};
