const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
  userA: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userB: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  durationSeconds: { type: Number },
  endedBy: { type: String, enum: ['userA', 'userB', 'disconnect'] },
});

module.exports = mongoose.model('CallLog', callLogSchema);
