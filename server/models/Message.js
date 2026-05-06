const mongoose = require('mongoose');

// Direct messages between accepted-friends. Persisted (unlike in-call chat,
// which is ephemeral). Friendship is enforced at the SEND boundary —
// pre-existing history stays visible if a friendship is later removed.
const messageSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 2000 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Fast unread count: `Message.countDocuments({ to: meId, readAt: null })`.
messageSchema.index({ to: 1, readAt: 1 });
// Fast conversation fetch: `Message.find({ $or: [{from,to}, {from:to,to:from}] }).sort('-createdAt')`
// — covered by these two compound indexes.
messageSchema.index({ from: 1, to: 1, createdAt: -1 });
messageSchema.index({ to: 1, from: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
