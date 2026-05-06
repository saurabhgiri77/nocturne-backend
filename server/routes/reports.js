const router = require('express').Router();
const mongoose = require('mongoose');
const Report = require('../models/Report');
const User = require('../models/User');
const verifyToken = require('../middleware/verifyToken');

// Auto-suspension policy. ≥3 distinct reporters in 24h → 24h suspension.
// Permanent bans require manual review and aren't done here.
const SUSPENSION_REPORT_THRESHOLD = 3;
const SUSPENSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUSPENSION_DURATION_MS = 24 * 60 * 60 * 1000;

const asString = (v) => (typeof v === 'string' ? v : '');

router.post('/', verifyToken, async (req, res) => {
  try {
    const reportedUserId = asString(req.body.reportedUserId);
    const roomId = asString(req.body.roomId);
    const reason = asString(req.body.reason);
    const details = asString(req.body.details);

    if (!reason || !Report.REASONS.includes(reason)) {
      return res.status(400).json({ message: 'Invalid reason' });
    }
    if (reportedUserId && !mongoose.Types.ObjectId.isValid(reportedUserId)) {
      return res.status(400).json({ message: 'Invalid reportedUserId' });
    }
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

    // Auto-suspension check. Only runs when there's a real reportedUser
    // (anonymous / room-only reports never trigger).
    if (reportedUserId) {
      try {
        const since = new Date(Date.now() - SUSPENSION_WINDOW_MS);
        const distinctReporters = await Report.distinct('reporter', {
          reportedUser: reportedUserId,
          createdAt: { $gte: since },
        });
        if (distinctReporters.length >= SUSPENSION_REPORT_THRESHOLD) {
          const suspendedUntil = new Date(Date.now() + SUSPENSION_DURATION_MS);
          await User.updateOne(
            { _id: reportedUserId },
            { $set: { suspendedUntil } }
          );
          console.log(
            `[reports] auto-suspended user=${reportedUserId} until=${suspendedUntil.toISOString()} (${distinctReporters.length} reporters/24h)`
          );
        }
      } catch (suspErr) {
        // Suspension check failure shouldn't poison the report itself.
        console.error('[reports/auto-suspend]', suspErr);
      }
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[reports/create]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
