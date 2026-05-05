const router = require('express').Router();
const mongoose = require('mongoose');
const Report = require('../models/Report');
const verifyToken = require('../middleware/verifyToken');

const asString = (v) => (typeof v === 'string' ? v : '');

router.post('/', verifyToken, async (req, res) => {
  try {
    const reportedUserId = asString(req.body.reportedUserId);
    const roomId = asString(req.body.roomId);
    const reason = asString(req.body.reason);
    const details = asString(req.body.details);

    // Reason must be in the allowlist
    if (!reason || !Report.REASONS.includes(reason)) {
      return res.status(400).json({ message: 'Invalid reason' });
    }

    // ObjectId validation: reject malformed IDs with a clean 400 instead of
    // letting Mongoose throw a CastError (500).
    if (reportedUserId && !mongoose.Types.ObjectId.isValid(reportedUserId)) {
      return res.status(400).json({ message: 'Invalid reportedUserId' });
    }

    // Self-report block. req.user.id is a string from the JWT; reportedUserId
    // came in as a string. Compare directly.
    if (reportedUserId && reportedUserId === String(req.user.id)) {
      return res.status(400).json({ message: 'You cannot report yourself' });
    }

    await Report.create({
      reporter: req.user.id,
      reportedUser: reportedUserId || undefined,
      roomId: roomId || undefined,
      reason,
      details: details ? details.slice(0, 1000) : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[reports/create]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
