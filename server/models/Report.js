const mongoose = require('mongoose');

const REASONS = [
  'inappropriate_behavior',
  'nudity',
  'harassment',
  'underage',
  'illegal_content',
  'other',
  // AI-detected — emitted by the frontend's NSFW scanner on the receiving
  // side. Counts toward auto-suspension same as a user report. Deduped
  // per (reporter, roomId, 'auto_nsfw') in routes/reports.js so one bad
  // actor can't be racked up to suspension from a single call.
  'auto_nsfw',
];

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    roomId: { type: String },
    reason: { type: String, enum: REASONS, required: true },
    details: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
module.exports.REASONS = REASONS;
