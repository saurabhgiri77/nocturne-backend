const mongoose = require('mongoose');
const Message = require('../models/Message');
const Friendship = require('../models/Friendship');

const MAX_DM_LENGTH = 2000;

const userRoom = (userId) => `user:${userId}`;

const handleMessages = (io, socket) => {
  // Client → server. Payload: { to, body }. Optional ack callback so the
  // sender's UI can resolve cleanly with the persisted message.
  socket.on('dm_message', async (payload, ack) => {
    try {
      const to = typeof payload?.to === 'string' ? payload.to : '';
      const body = typeof payload?.body === 'string' ? payload.body : '';
      if (!mongoose.Types.ObjectId.isValid(to)) {
        return typeof ack === 'function' && ack({ ok: false, error: 'invalid_recipient' });
      }
      if (String(to) === String(socket.user.id)) {
        return typeof ack === 'function' && ack({ ok: false, error: 'cannot_message_self' });
      }
      const trimmed = body.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_DM_LENGTH) {
        return typeof ack === 'function' && ack({ ok: false, error: 'invalid_body' });
      }

      // Friends-only send. History stays visible after unfriending, but no
      // new sends are allowed unless currently accepted on either direction.
      const friendship = await Friendship.findOne({
        status: 'accepted',
        $or: [
          { requester: socket.user.id, recipient: to },
          { requester: to, recipient: socket.user.id },
        ],
      }).lean();
      if (!friendship) {
        return typeof ack === 'function' && ack({ ok: false, error: 'not_friends' });
      }

      const msg = await Message.create({ from: socket.user.id, to, body: trimmed });
      const wire = {
        id: msg._id,
        from: String(msg.from),
        to: String(msg.to),
        body: msg.body,
        createdAt: msg.createdAt,
        readAt: msg.readAt,
      };

      // Push to recipient's user room.
      io.to(userRoom(to)).emit('dm_message_received', { message: wire });
      // Echo to sender's other tabs (sender's own tab uses the ack for
      // immediate optimistic state; this keeps multi-tab in sync).
      io.to(userRoom(socket.user.id)).emit('dm_message_sent', { message: wire });

      if (typeof ack === 'function') ack({ ok: true, message: wire });
    } catch (err) {
      console.error('[socket/dm_message]', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });
};

module.exports = { handleMessages };
