const router = require('express').Router();
const Report = require('../models/Report');
const verifyToken = require('../middleware/verifyToken');

router.post('/', verifyToken, async (req, res) => {
  try {
    const { reportedUserId, roomId, reason, details } = req.body;
    if (!reason || !Report.REASONS.includes(reason)) {
      return res.status(400).json({ message: 'Invalid reason' });
    }
    await Report.create({
      reporter: req.user.id,
      reportedUser: reportedUserId,
      roomId,
      reason,
      details: details ? String(details).slice(0, 1000) : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
