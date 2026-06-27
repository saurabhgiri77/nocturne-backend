const router = require('express').Router();
const mongoose = require('mongoose');
const Message = require('../models/Message');
const verifyToken = require('../middleware/verifyToken');
const requireRegistered = require('../middleware/requireRegistered');

const HISTORY_LIMIT = 50;

const validId = (s) => mongoose.Types.ObjectId.isValid(s);
const oid = (s) => new mongoose.Types.ObjectId(s);

// GET /api/messages — conversation list (one row per peer). Returns latest
// message per peer + unread count + minimal peer profile, newest first.
router.get('/', verifyToken, requireRegistered, async (req, res) => {
  try {
    const meId = oid(req.user.id);
    const conversations = await Message.aggregate([
      { $match: { $or: [{ from: meId }, { to: meId }] } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$from', meId] }, '$to', '$from'] },
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$to', meId] }, { $eq: ['$readAt', null] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          user: { id: '$user._id', username: '$user.username', displayName: '$user.displayName' },
          lastMessage: {
            id: '$lastMessage._id',
            from: '$lastMessage.from',
            body: '$lastMessage.body',
            createdAt: '$lastMessage.createdAt',
            mine: { $eq: ['$lastMessage.from', meId] },
          },
          unreadCount: 1,
        },
      },
      { $sort: { 'lastMessage.createdAt': -1 } },
    ]);
    res.json({ conversations });
  } catch (err) {
    console.error('[messages/list]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/messages/:userId — last 50 messages between me and `:userId`,
// ordered oldest → newest (frontend renders top-to-bottom and scrolls to
// bottom).
router.get('/:userId', verifyToken, requireRegistered, async (req, res) => {
  try {
    const me = req.user.id;
    const peer = req.params.userId;
    if (!validId(peer)) return res.status(400).json({ message: 'Invalid userId' });

    const docs = await Message.find({
      $or: [
        { from: me, to: peer },
        { from: peer, to: me },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean();

    docs.reverse(); // oldest first
    const messages = docs.map((m) => ({
      id: m._id,
      from: String(m.from),
      to: String(m.to),
      body: m.body,
      createdAt: m.createdAt,
      readAt: m.readAt,
      mine: String(m.from) === String(me),
    }));
    res.json({ messages });
  } catch (err) {
    console.error('[messages/history]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/messages/:userId/read — mark all messages from `:userId` to me
// as read. Idempotent (only updates the unread ones).
router.patch('/:userId/read', verifyToken, requireRegistered, async (req, res) => {
  try {
    const me = req.user.id;
    const peer = req.params.userId;
    if (!validId(peer)) return res.status(400).json({ message: 'Invalid userId' });
    const result = await Message.updateMany(
      { from: peer, to: me, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error('[messages/mark-read]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
