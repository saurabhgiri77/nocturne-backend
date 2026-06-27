// Drop-in middleware after verifyToken. Rejects guest tokens with 403 so
// account-bound routes (friends, DMs, profile edits) don't have to repeat
// the check. The frontend interprets this status to surface the "Sign up
// to use this feature" CTA without a generic error toast.
module.exports = (req, res, next) => {
  if (req.user?.guest) {
    return res.status(403).json({
      message: 'Sign up to use this feature.',
      reason: 'guest_required_registration',
    });
  }
  next();
};
