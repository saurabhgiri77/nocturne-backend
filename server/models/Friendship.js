const mongoose = require('mongoose');

// Directional schema. Friendship "exists" iff there's a row, regardless of
// status. Mutual-tap auto-merge happens in the request handler:
//  - If A→B with status=pending exists and B→A is requested, A→B flips to
//    accepted (no second row created).
//  - Otherwise a fresh A→B pending row is inserted.
//
// Querying friends of user X = `status: 'accepted', $or: [{requester: X}, {recipient: X}]`.
// Pending received = `status: 'pending', recipient: X`.
// Pending sent     = `status: 'pending', requester: X`.
const friendshipSchema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending', index: true },
  },
  { timestamps: true }
);

// One row per ordered pair. A→B and B→A are different rows (and the request
// handler ensures we never end up with both for long).
friendshipSchema.index({ requester: 1, recipient: 1 }, { unique: true });

module.exports = mongoose.model('Friendship', friendshipSchema);
