const mongoose = require('mongoose');

// Records every device signal we've decided to keep out of the guest queue
// (most often: a guest who got reported above threshold). Storing fpHash,
// uuid and ip separately lets the guest-token endpoint apply a "two of
// three match → ban" policy without paying for a real fingerprint service.
// A null `until` means "permanent"; a future date means "rate-limited until".
const bannedGuestSchema = new mongoose.Schema(
  {
    fpHash: { type: String, index: true },
    uuid:   { type: String, index: true },
    ip:     { type: String, index: true },
    reason: { type: String },
    until:  { type: Date }, // null = permanent
  },
  { timestamps: true }
);

bannedGuestSchema.statics.matchesAny = async function (fpHash, uuid, ip) {
  // Pull any record where ≥1 of the three signals matches, then apply the
  // two-of-three policy in app code. Doing the count in JS keeps the query
  // a simple indexed OR rather than a slow aggregation.
  const now = new Date();
  const rows = await this.find({
    $and: [
      { $or: [{ until: null }, { until: { $gt: now } }] },
      { $or: [{ fpHash }, { uuid }, { ip }] },
    ],
  }).lean();
  for (const r of rows) {
    const hits = (r.fpHash === fpHash) + (r.uuid === uuid) + (r.ip === ip);
    if (hits >= 2) return r;
  }
  return null;
};

module.exports = mongoose.model('BannedGuest', bannedGuestSchema);
