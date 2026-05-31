const User = require('../models/User');

// Blocks outbound social actions once an unverified account is past its
// grace deadline. Layer AFTER verifyToken (needs req.user.id). The socket
// auth gate covers matchmaking/DMs/presence; this covers the REST surface
// (e.g. sending friend requests) so a gated user can't act there either.
// The `code` lets the frontend distinguish this from a generic 403.
module.exports = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select(
      'emailVerified verificationDeadline'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isVerificationRequired()) {
      return res.status(403).json({
        message: 'Verify your email to keep using Bump.',
        code: 'EMAIL_UNVERIFIED',
      });
    }
    next();
  } catch (err) {
    console.error('[requireVerified]', err.message);
    return res.status(500).json({ message: 'Server error' });
  }
};
