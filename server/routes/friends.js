const router = require('express').Router();
const mongoose = require('mongoose');
const Friendship = require('../models/Friendship');
const User = require('../models/User');
const verifyToken = require('../middleware/verifyToken');

const PROFILE_FIELDS = 'username displayName';

const userRoom = (userId) => `user:${userId}`;

// Shape a Friendship row + the OTHER user's basic profile into the
// envelope the frontend renders. `me` is the current user; we return
// the side that's NOT them.
const serializeFriendship = (friendship, me) => {
  const meStr = String(me);
  const isRequester = String(friendship.requester._id || friendship.requester) === meStr;
  const peer = isRequester ? friendship.recipient : friendship.requester;
  return {
    id: friendship._id,
    status: friendship.status,
    direction: isRequester ? 'sent' : 'received',
    createdAt: friendship.createdAt,
    user: {
      id: peer._id || peer,
      username: peer.username || null,
      displayName: peer.displayName || null,
    },
  };
};

// GET /api/friends → buckets the current user's friendships into three
// lists for the /friends page UI.
router.get('/', verifyToken, async (req, res) => {
  try {
    const me = req.user.id;
    const all = await Friendship.find({
      $or: [{ requester: me }, { recipient: me }],
    })
      .populate('requester', PROFILE_FIELDS)
      .populate('recipient', PROFILE_FIELDS)
      .sort({ updatedAt: -1 })
      .lean();

    const friends = [];
    const pendingReceived = [];
    const pendingSent = [];
    for (const f of all) {
      const shaped = serializeFriendship(f, me);
      if (f.status === 'accepted') friends.push(shaped);
      else if (shaped.direction === 'received') pendingReceived.push(shaped);
      else pendingSent.push(shaped);
    }
    res.json({ friends, pendingReceived, pendingSent });
  } catch (err) {
    console.error('[friends/list]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/friends/:userId/request — send (or auto-accept on mutual) a
// friend request. Idempotent: re-tapping while a row already exists just
// returns the current state.
router.post('/:userId/request', verifyToken, async (req, res) => {
  try {
    const me = req.user.id;
    const target = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(target)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    if (String(target) === String(me)) {
      return res.status(400).json({ message: "You can't add yourself" });
    }
    const peer = await User.findById(target).select(PROFILE_FIELDS);
    if (!peer) return res.status(404).json({ message: 'User not found' });

    // Mutual-tap auto-merge. If the peer already has a pending request out
    // to me, flip it to accepted instead of creating a duplicate row.
    const peerOutgoing = await Friendship.findOne({
      requester: target,
      recipient: me,
      status: 'pending',
    });
    if (peerOutgoing) {
      peerOutgoing.status = 'accepted';
      await peerOutgoing.save();
      const io = req.app.get('io');
      const event = { user: { id: me }, friendshipId: peerOutgoing._id };
      io?.to(userRoom(target)).emit('friend_accepted', event);
      io?.to(userRoom(me)).emit('friend_accepted', { user: { id: target, username: peer.username, displayName: peer.displayName }, friendshipId: peerOutgoing._id });
      return res.json({ status: 'accepted', friendshipId: peerOutgoing._id });
    }

    // Idempotent: my own existing row → return its current state.
    const existing = await Friendship.findOne({ requester: me, recipient: target });
    if (existing) {
      return res.json({ status: existing.status, friendshipId: existing._id });
    }

    const created = await Friendship.create({ requester: me, recipient: target, status: 'pending' });
    const io = req.app.get('io');
    io?.to(userRoom(target)).emit('friend_request_received', {
      user: { id: me },
      friendshipId: created._id,
    });
    res.status(201).json({ status: 'pending', friendshipId: created._id });
  } catch (err) {
    if (err.code === 11000) {
      // Race: dup-key on (requester, recipient). Re-fetch + return state.
      const existing = await Friendship.findOne({ requester: req.user.id, recipient: req.params.userId });
      return res.json({ status: existing?.status || 'pending', friendshipId: existing?._id });
    }
    console.error('[friends/request]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/friends/:userId/accept — accept a pending request from `:userId`
// (i.e. a row where requester=:userId and recipient=me, status=pending).
router.post('/:userId/accept', verifyToken, async (req, res) => {
  try {
    const me = req.user.id;
    const target = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(target)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    const friendship = await Friendship.findOne({
      requester: target,
      recipient: me,
      status: 'pending',
    });
    if (!friendship) return res.status(404).json({ message: 'No pending request' });
    friendship.status = 'accepted';
    await friendship.save();

    const io = req.app.get('io');
    io?.to(userRoom(target)).emit('friend_accepted', { user: { id: me }, friendshipId: friendship._id });
    io?.to(userRoom(me)).emit('friend_accepted', { user: { id: target }, friendshipId: friendship._id });

    res.json({ status: 'accepted', friendshipId: friendship._id });
  } catch (err) {
    console.error('[friends/accept]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/friends/:userId — removes any friendship row between me and
// `:userId`, regardless of status (accepted=remove friend; pending received
// =decline; pending sent=cancel). Idempotent.
router.delete('/:userId', verifyToken, async (req, res) => {
  try {
    const me = req.user.id;
    const target = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(target)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    await Friendship.deleteOne({
      $or: [
        { requester: me, recipient: target },
        { requester: target, recipient: me },
      ],
    });

    const io = req.app.get('io');
    io?.to(userRoom(target)).emit('friend_removed', { userId: String(me) });

    res.json({ ok: true });
  } catch (err) {
    console.error('[friends/delete]', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
