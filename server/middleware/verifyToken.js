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
    // Per-user invalidation: tokens issued before the user's last password
    // change are rejected, so /reset effectively signs every existing session
    // out. JWT.iat is in seconds; passwordChangedAt is a Date.
    try {
      const user = await User.findById(payload.id).select('passwordChangedAt').lean();
      if (user?.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
        return res.status(401).json({ message: 'Session expired — please sign in again' });
      }
    } catch (err) {
      // DB lookup failed — don't kick the user out over a transient error.
      // Worst case: a recently-revoked session lingers until DB recovers.
      console.warn('[verifyToken] passwordChangedAt lookup failed:', err.message);
    }
  }

  req.user = payload;
  req.token = token; // exposed so /logout can blocklist it
  next();
};
