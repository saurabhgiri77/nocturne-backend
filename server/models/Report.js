const mongoose = require('mongoose');

const REASONS = [
  'inappropriate_behavior',
  'nudity',
  'harassment',
  'underage',
  'illegal_content',
  'other',
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
